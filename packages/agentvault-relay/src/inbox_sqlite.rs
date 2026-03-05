// SQLite persistence layer for InboxStore (feature = "persistence").
//
// Write-through cache: all writes go to SQLite first, then update in-memory.
// Reads always serve from in-memory RwLock (no SQLite reads at request time).
// On startup, load_all() is called to populate memory from SQLite.
//
// Connection is wrapped in std::sync::Mutex because rusqlite::Connection is !Send.
// Blocking ops use tokio::task::spawn_blocking to avoid blocking the async runtime.

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};

use crate::inbox_types::{DeclineReasonCode, Invite, InviteStatus};
use crate::session::SessionTokens;
use crate::types::Contract;

/// Return type of `SqliteDb::load_all`.
pub type LoadAllResult = (
    HashMap<String, Invite>,
    HashMap<String, Vec<String>>,
    HashMap<String, u64>,
);

// ============================================================================
// SqliteDb
// ============================================================================

pub struct SqliteDb {
    conn: Mutex<Connection>,
}

impl SqliteDb {
    /// Open (or create) the SQLite database at `path` and initialize schema.
    pub fn open(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Insert a new invite. Called during create_invite, before memory update.
    pub fn insert_invite(&self, invite: &Invite) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "INSERT INTO invites (
                invite_id, from_agent_id, to_agent_id, status,
                contract_json, contract_hash, provider, purpose_code,
                created_at, updated_at, expires_at,
                session_id, session_tokens_json, decline_reason_code
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                invite.invite_id,
                invite.from_agent_id,
                invite.to_agent_id,
                status_to_str(invite.status),
                serde_json::to_string(&invite.contract).unwrap_or_default(),
                invite.contract_hash,
                invite.provider,
                invite.purpose_code,
                invite.created_at.to_rfc3339(),
                invite.updated_at.to_rfc3339(),
                invite.expires_at.to_rfc3339(),
                invite.session_id.as_deref(),
                invite
                    .session_tokens
                    .as_ref()
                    .and_then(|t| serde_json::to_string(t).ok())
                    .as_deref(),
                invite.decline_reason_code.map(decline_to_str),
            ],
        )?;
        Ok(())
    }

    /// Update invite status + mutable fields. Called during accept/decline/cancel/expire.
    pub fn update_invite(
        &self,
        invite_id: &str,
        status: InviteStatus,
        updated_at: DateTime<Utc>,
        session_id: Option<&str>,
        session_tokens: Option<&SessionTokens>,
        decline_reason_code: Option<DeclineReasonCode>,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "UPDATE invites SET status=?1, updated_at=?2, session_id=?3,
             session_tokens_json=?4, decline_reason_code=?5
             WHERE invite_id=?6",
            params![
                status_to_str(status),
                updated_at.to_rfc3339(),
                session_id,
                session_tokens
                    .and_then(|t| serde_json::to_string(t).ok())
                    .as_deref(),
                decline_reason_code.map(decline_to_str),
                invite_id,
            ],
        )?;
        Ok(())
    }

    /// Batch-update status for a list of invite_ids (expire PENDING → EXPIRED).
    pub fn batch_expire(
        &self,
        invite_ids: &[String],
        now: DateTime<Utc>,
    ) -> Result<(), rusqlite::Error> {
        if invite_ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        for id in invite_ids {
            conn.execute(
                "UPDATE invites SET status='EXPIRED', updated_at=?1 WHERE invite_id=?2",
                params![now.to_rfc3339(), id],
            )?;
        }
        Ok(())
    }

    /// Batch-delete GC'd invite_ids.
    pub fn batch_delete(&self, invite_ids: &[String]) -> Result<(), rusqlite::Error> {
        if invite_ids.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        for id in invite_ids {
            conn.execute("DELETE FROM invites WHERE invite_id=?1", params![id])?;
        }
        Ok(())
    }

    /// Upsert event counter for an agent.
    pub fn upsert_event_counter(
        &self,
        agent_id: &str,
        counter: u64,
    ) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "INSERT INTO event_counters (agent_id, counter) VALUES (?1, ?2)
             ON CONFLICT(agent_id) DO UPDATE SET counter=excluded.counter",
            params![agent_id, counter as i64],
        )?;
        Ok(())
    }

    /// Load all invites and event_counters from SQLite into memory.
    /// Returns `(invites_map, inbox_index_map, event_counters_map)`.
    pub fn load_all(&self) -> Result<LoadAllResult, rusqlite::Error> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");

        // Load invites
        let mut stmt = conn.prepare(
            "SELECT invite_id, from_agent_id, to_agent_id, status,
                    contract_json, contract_hash, provider, purpose_code,
                    created_at, updated_at, expires_at,
                    session_id, session_tokens_json, decline_reason_code
             FROM invites",
        )?;

        let rows: Vec<Invite> = stmt
            .query_map([], |row| {
                let status_str: String = row.get(3)?;
                let contract_json: String = row.get(4)?;
                let created_at_str: String = row.get(8)?;
                let updated_at_str: String = row.get(9)?;
                let expires_at_str: String = row.get(10)?;
                let session_tokens_json: Option<String> = row.get(12)?;
                let decline_str: Option<String> = row.get(13)?;

                let contract: Contract = serde_json::from_str(&contract_json).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;

                let status = str_to_status(&status_str).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;

                let created_at = DateTime::parse_from_rfc3339(&created_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            8,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;

                let updated_at = DateTime::parse_from_rfc3339(&updated_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            9,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;

                let expires_at = DateTime::parse_from_rfc3339(&expires_at_str)
                    .map(|dt| dt.with_timezone(&Utc))
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            10,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;

                let session_tokens: Option<SessionTokens> = session_tokens_json
                    .as_deref()
                    .and_then(|j| serde_json::from_str(j).ok());

                let decline_reason_code =
                    decline_str.as_deref().and_then(|s| str_to_decline(s).ok());

                Ok(Invite {
                    version: "1".to_string(),
                    invite_id: row.get(0)?,
                    from_agent_id: row.get(1)?,
                    to_agent_id: row.get(2)?,
                    status,
                    contract,
                    contract_hash: row.get(5)?,
                    provider: row.get(6)?,
                    purpose_code: row.get(7)?,
                    created_at,
                    updated_at,
                    expires_at,
                    session_id: row.get(11)?,
                    session_tokens,
                    decline_reason_code,
                    from_agent_pubkey: None, // not persisted (registry-owned)
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut invites: HashMap<String, Invite> = HashMap::new();
        let mut inbox_index: HashMap<String, Vec<String>> = HashMap::new();
        for invite in rows {
            inbox_index
                .entry(invite.to_agent_id.clone())
                .or_default()
                .push(invite.invite_id.clone());
            invites.insert(invite.invite_id.clone(), invite);
        }

        // Load event counters
        let mut stmt2 = conn.prepare("SELECT agent_id, counter FROM event_counters")?;
        let event_counters: HashMap<String, u64> = stmt2
            .query_map([], |row| {
                let agent_id: String = row.get(0)?;
                let counter: i64 = row.get(1)?;
                Ok((agent_id, counter as u64))
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok((invites, inbox_index, event_counters))
    }
}

// ============================================================================
// Schema
// ============================================================================

fn init_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;

        CREATE TABLE IF NOT EXISTS invites (
            invite_id TEXT PRIMARY KEY,
            from_agent_id TEXT NOT NULL,
            to_agent_id TEXT NOT NULL,
            status TEXT NOT NULL,
            contract_json TEXT NOT NULL,
            contract_hash TEXT NOT NULL,
            provider TEXT NOT NULL,
            purpose_code TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            session_id TEXT,
            session_tokens_json TEXT,
            decline_reason_code TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_invites_to_agent ON invites(to_agent_id, status);
        CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status, expires_at);

        CREATE TABLE IF NOT EXISTS event_counters (
            agent_id TEXT PRIMARY KEY,
            counter INTEGER NOT NULL DEFAULT 0
        );",
    )
}

// ============================================================================
// Enum <-> string helpers
// ============================================================================

fn status_to_str(s: InviteStatus) -> &'static str {
    match s {
        InviteStatus::Pending => "PENDING",
        InviteStatus::Accepted => "ACCEPTED",
        InviteStatus::Declined => "DECLINED",
        InviteStatus::Expired => "EXPIRED",
        InviteStatus::Canceled => "CANCELED",
    }
}

fn str_to_status(s: &str) -> Result<InviteStatus, StringConvertError> {
    match s {
        "PENDING" => Ok(InviteStatus::Pending),
        "ACCEPTED" => Ok(InviteStatus::Accepted),
        "DECLINED" => Ok(InviteStatus::Declined),
        "EXPIRED" => Ok(InviteStatus::Expired),
        "CANCELED" => Ok(InviteStatus::Canceled),
        other => Err(StringConvertError(format!("unknown status: {other}"))),
    }
}

fn decline_to_str(d: DeclineReasonCode) -> &'static str {
    match d {
        DeclineReasonCode::Busy => "BUSY",
        DeclineReasonCode::NotInterested => "NOT_INTERESTED",
        DeclineReasonCode::Invalid => "INVALID",
        DeclineReasonCode::Other => "OTHER",
    }
}

fn str_to_decline(s: &str) -> Result<DeclineReasonCode, StringConvertError> {
    match s {
        "BUSY" => Ok(DeclineReasonCode::Busy),
        "NOT_INTERESTED" => Ok(DeclineReasonCode::NotInterested),
        "INVALID" => Ok(DeclineReasonCode::Invalid),
        "OTHER" => Ok(DeclineReasonCode::Other),
        other => Err(StringConvertError(format!("unknown decline code: {other}"))),
    }
}

// ============================================================================
// Error helper
// ============================================================================

#[derive(Debug)]
struct StringConvertError(String);

impl std::fmt::Display for StringConvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for StringConvertError {}

// ============================================================================
// Tests (feature-gated)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::compute_contract_hash;
    use crate::types::Contract;

    fn test_contract() -> Contract {
        Contract {
            purpose_code: vault_family_types::Purpose::Compatibility,
            output_schema_id: "test".to_string(),
            output_schema: serde_json::json!({"type": "object"}),
            participants: vec!["alice".to_string(), "bob".to_string()],
            prompt_template_hash: "a".repeat(64),
            entropy_budget_bits: None,
            timing_class: None,
            metadata: serde_json::Value::Null,
            model_profile_id: None,
            enforcement_policy_hash: None,
            output_schema_hash: None,
            model_constraints: None,
            max_completion_tokens: None,
            session_ttl_secs: None,
            invite_ttl_secs: None,
            entropy_enforcement: None,
            relay_verifying_key_hex: None,
        }
    }

    fn test_invite() -> Invite {
        let contract = test_contract();
        let contract_hash = compute_contract_hash(&contract).unwrap();
        let now = Utc::now();
        Invite {
            version: "1".to_string(),
            invite_id: "inv_test123".to_string(),
            from_agent_id: "alice".to_string(),
            to_agent_id: "bob".to_string(),
            from_agent_pubkey: None,
            contract,
            contract_hash,
            provider: "anthropic".to_string(),
            purpose_code: "COMPATIBILITY".to_string(),
            status: InviteStatus::Pending,
            created_at: now,
            updated_at: now,
            expires_at: now + chrono::Duration::days(7),
            session_id: None,
            session_tokens: None,
            decline_reason_code: None,
        }
    }

    fn open_temp_db() -> SqliteDb {
        SqliteDb::open(":memory:").expect("failed to open in-memory SQLite")
    }

    #[test]
    fn test_insert_and_load_roundtrip() {
        let db = open_temp_db();
        let invite = test_invite();
        db.insert_invite(&invite).unwrap();

        let (invites, inbox_index, _) = db.load_all().unwrap();
        assert_eq!(invites.len(), 1);
        let loaded = &invites["inv_test123"];
        assert_eq!(loaded.invite_id, "inv_test123");
        assert_eq!(loaded.from_agent_id, "alice");
        assert_eq!(loaded.to_agent_id, "bob");
        assert_eq!(loaded.status, InviteStatus::Pending);
        assert_eq!(loaded.provider, "anthropic");

        // inbox_index populated
        let bob_index = &inbox_index["bob"];
        assert!(bob_index.contains(&"inv_test123".to_string()));
    }

    #[test]
    fn test_update_invite_status() {
        let db = open_temp_db();
        let invite = test_invite();
        db.insert_invite(&invite).unwrap();

        let now = Utc::now();
        let tokens = SessionTokens {
            initiator_submit: "is".to_string(),
            initiator_read: "ir".to_string(),
            responder_submit: "rs".to_string(),
            responder_read: "rr".to_string(),
        };
        db.update_invite(
            "inv_test123",
            InviteStatus::Accepted,
            now,
            Some("sess_abc"),
            Some(&tokens),
            None,
        )
        .unwrap();

        let (invites, _, _) = db.load_all().unwrap();
        let loaded = &invites["inv_test123"];
        assert_eq!(loaded.status, InviteStatus::Accepted);
        assert_eq!(loaded.session_id.as_deref(), Some("sess_abc"));
        let t = loaded.session_tokens.as_ref().unwrap();
        assert_eq!(t.initiator_submit, "is");
        assert_eq!(t.responder_read, "rr");
    }

    #[test]
    fn test_event_counter_persisted() {
        let db = open_temp_db();
        db.upsert_event_counter("alice", 5).unwrap();
        db.upsert_event_counter("alice", 7).unwrap(); // upsert should update
        db.upsert_event_counter("bob", 3).unwrap();

        let (_, _, counters) = db.load_all().unwrap();
        assert_eq!(counters["alice"], 7);
        assert_eq!(counters["bob"], 3);
    }

    #[test]
    fn test_batch_expire() {
        let db = open_temp_db();
        let invite = test_invite();
        db.insert_invite(&invite).unwrap();

        let now = Utc::now();
        db.batch_expire(&["inv_test123".to_string()], now).unwrap();

        let (invites, _, _) = db.load_all().unwrap();
        assert_eq!(invites["inv_test123"].status, InviteStatus::Expired);
    }

    #[test]
    fn test_batch_delete_removes_from_db() {
        let db = open_temp_db();
        let invite = test_invite();
        db.insert_invite(&invite).unwrap();

        db.batch_delete(&["inv_test123".to_string()]).unwrap();

        let (invites, inbox_index, _) = db.load_all().unwrap();
        assert!(invites.is_empty());
        // inbox_index should also be empty (derived from invite rows)
        assert!(inbox_index.is_empty());
    }

    #[test]
    fn test_decline_reason_persisted() {
        let db = open_temp_db();
        let invite = test_invite();
        db.insert_invite(&invite).unwrap();

        let now = Utc::now();
        db.update_invite(
            "inv_test123",
            InviteStatus::Declined,
            now,
            None,
            None,
            Some(DeclineReasonCode::Busy),
        )
        .unwrap();

        let (invites, _, _) = db.load_all().unwrap();
        assert_eq!(
            invites["inv_test123"].decline_reason_code,
            Some(DeclineReasonCode::Busy)
        );
    }
}
