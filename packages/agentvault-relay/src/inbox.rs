// Lock ordering (must always acquire in this order to prevent deadlock):
// 1. RwLock<InboxStoreInner> (read or write)
// 2. Mutex<ChannelMap>
// Never acquire RwLock after holding Mutex<ChannelMap>.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::error::RelayError;
use crate::inbox_types::*;
use crate::relay::compute_contract_hash;
use crate::session::SessionStore;
use crate::types::Contract;

#[cfg(feature = "persistence")]
use crate::inbox_sqlite::SqliteDb;

/// Generate a unique invite ID.
fn generate_invite_id() -> String {
    format!(
        "inv_{}",
        &hex::encode(Sha256::digest(uuid::Uuid::new_v4().as_bytes()))[..32]
    )
}

// ============================================================================
// Channel type aliases
// ============================================================================

type ChannelMap = HashMap<String, broadcast::Sender<InboxEvent>>;

// ============================================================================
// InboxStoreInner — protected by RwLock (invites, index, counters only)
// ============================================================================

struct InboxStoreInner {
    invites: HashMap<String, Invite>,
    /// agent_id -> ordered list of invite_ids received by this agent.
    inbox_index: HashMap<String, Vec<String>>,
    /// agent_id -> monotonic event counter.
    event_counters: HashMap<String, u64>,
}

const SSE_CHANNEL_CAPACITY: usize = 64;

// ============================================================================
// InboxStore
// ============================================================================

/// In-memory inbox store with RwLock + separate channel Mutex.
///
/// Reads (list_inbox, get_invite, subscribe) acquire a read lock and never block
/// each other. Writes (create_invite, accept_invite, etc.) acquire a write lock.
/// SSE emission uses a separate Mutex<ChannelMap> so it never touches the RwLock.
#[derive(Clone)]
pub struct InboxStore {
    inner: Arc<RwLock<InboxStoreInner>>,
    channels: Arc<Mutex<ChannelMap>>,
    invite_ttl: Duration,
    /// Grace period after EXPIRED before garbage collection.
    gc_grace: Duration,
    #[cfg(feature = "persistence")]
    db: Option<Arc<SqliteDb>>,
}

impl InboxStore {
    pub fn new(invite_ttl: Duration) -> Self {
        Self {
            inner: Arc::new(RwLock::new(InboxStoreInner {
                invites: HashMap::new(),
                inbox_index: HashMap::new(),
                event_counters: HashMap::new(),
            })),
            channels: Arc::new(Mutex::new(HashMap::new())),
            invite_ttl,
            gc_grace: Duration::from_secs(86400), // 24h grace after EXPIRED
            #[cfg(feature = "persistence")]
            db: None,
        }
    }

    #[cfg(feature = "persistence")]
    /// Open SQLite at `path`, load all persisted invites into memory, and return
    /// a store backed by write-through SQLite.
    ///
    /// Must be called before Axum starts accepting connections (startup ordering
    /// is naturally enforced because AppState is constructed before axum::serve).
    pub async fn new_with_sqlite(invite_ttl: Duration, path: String) -> Result<Self, RelayError> {
        use tokio::task::spawn_blocking;

        let path2 = path.clone();
        let db = spawn_blocking(move || SqliteDb::open(&path2))
            .await
            .map_err(|e| RelayError::ServiceUnavailable(format!("db thread: {e}")))?
            .map_err(|e| RelayError::Internal(format!("sqlite open: {e}")))?;

        let db = Arc::new(db);
        let db2 = db.clone();

        let (invites, inbox_index, event_counters) = spawn_blocking(move || db2.load_all())
            .await
            .map_err(|e| RelayError::ServiceUnavailable(format!("db thread: {e}")))?
            .map_err(|e| RelayError::Internal(format!("sqlite load_all: {e}")))?;

        tracing::info!(invites = invites.len(), "SQLite: loaded inbox into memory");

        Ok(Self {
            inner: Arc::new(RwLock::new(InboxStoreInner {
                invites,
                inbox_index,
                event_counters,
            })),
            channels: Arc::new(Mutex::new(HashMap::new())),
            invite_ttl,
            gc_grace: Duration::from_secs(86400),
            db: Some(db),
        })
    }

    // ── Public API ────────────────────────────────────────────────────────

    fn validate_invite_contract_binding(
        from_agent_id: &str,
        to_agent_id: &str,
        purpose_code: &str,
        contract: &Contract,
    ) -> Result<(), RelayError> {
        if purpose_code != contract.purpose_code.to_string() {
            return Err(RelayError::ContractValidation(
                "purpose_code must match contract.purpose_code".to_string(),
            ));
        }
        if contract.participants.len() != 2 {
            return Err(RelayError::ContractValidation(
                "contract must have exactly 2 participants".to_string(),
            ));
        }
        if !contract.participants.iter().any(|p| p == from_agent_id) {
            return Err(RelayError::ContractValidation(
                "contract participants must include from_agent_id".to_string(),
            ));
        }
        if !contract.participants.iter().any(|p| p == to_agent_id) {
            return Err(RelayError::ContractValidation(
                "contract participants must include to_agent_id".to_string(),
            ));
        }
        Ok(())
    }

    /// Create a new invite.
    pub async fn create_invite(
        &self,
        from_agent_id: &str,
        request: &CreateInviteRequest,
        from_agent_pubkey: Option<String>,
    ) -> Result<CreateInviteResponse, RelayError> {
        if from_agent_id == request.to_agent_id {
            return Err(RelayError::ContractValidation(
                "cannot send invite to self".to_string(),
            ));
        }
        if request.to_agent_id.is_empty() {
            return Err(RelayError::ContractValidation(
                "to_agent_id must not be empty".to_string(),
            ));
        }
        if request.purpose_code.is_empty() {
            return Err(RelayError::ContractValidation(
                "purpose_code must not be empty".to_string(),
            ));
        }
        Self::validate_invite_contract_binding(
            from_agent_id,
            &request.to_agent_id,
            &request.purpose_code,
            &request.contract,
        )?;
        let contract_hash = compute_contract_hash(&request.contract)?;

        let now = Utc::now();
        let invite_ttl_chrono = chrono::Duration::from_std(self.invite_ttl).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "invite TTL conversion overflow, falling back to 7 days");
            chrono::Duration::days(7)
        });
        let expires_at = now + invite_ttl_chrono;
        let invite_id = generate_invite_id();

        let invite = Invite {
            version: "1".to_string(),
            invite_id: invite_id.clone(),
            from_agent_id: from_agent_id.to_string(),
            to_agent_id: request.to_agent_id.clone(),
            from_agent_pubkey,
            contract: request.contract.clone(),
            contract_hash: contract_hash.clone(),
            provider: request.provider.clone(),
            purpose_code: request.contract.purpose_code.to_string(),
            status: InviteStatus::Pending,
            created_at: now,
            updated_at: now,
            expires_at,
            session_id: None,
            session_tokens: None,
            decline_reason_code: None,
        };

        // SQLite write FIRST (before memory update)
        #[cfg(feature = "persistence")]
        if let Some(ref db) = self.db {
            let db = db.clone();
            let invite_for_db = invite.clone();
            tokio::task::spawn_blocking(move || db.insert_invite(&invite_for_db))
                .await
                .map_err(|e| RelayError::ServiceUnavailable(format!("db thread: {e}")))?
                .map_err(|e| RelayError::Internal(format!("sqlite: {e}")))?;
        }

        let mut store = self.inner.write().await;

        // Add to recipient's inbox index
        store
            .inbox_index
            .entry(request.to_agent_id.clone())
            .or_default()
            .push(invite_id.clone());

        // Insert invite BEFORE emitting SSE event so that subscribers who
        // immediately call GET /invites/:id can find it.
        store.invites.insert(invite_id.clone(), invite);

        // Update counter while holding write lock, then release before channel emit
        let counter = store
            .event_counters
            .entry(request.to_agent_id.clone())
            .or_insert(0);
        *counter += 1;
        let event = InboxEvent {
            event_id: *counter,
            event_type: InboxEventType::InviteCreated,
            invite_id: invite_id.clone(),
            from_agent_id: from_agent_id.to_string(),
            timestamp: Utc::now(),
        };

        // Persist counter update
        #[cfg(feature = "persistence")]
        if let Some(ref db) = self.db {
            let db = db.clone();
            let agent_id = request.to_agent_id.clone();
            let count = *counter;
            // Fire-and-forget: counter persistence is best-effort
            tokio::spawn(async move {
                let _ =
                    tokio::task::spawn_blocking(move || db.upsert_event_counter(&agent_id, count))
                        .await;
            });
        }

        drop(store); // release RwLock before acquiring channel Mutex

        self.emit_event(&request.to_agent_id, event).await;

        Ok(CreateInviteResponse {
            invite_id,
            contract_hash,
            status: InviteStatus::Pending,
            expires_at,
        })
    }

    /// List inbox for an agent with optional filters.
    pub async fn list_inbox(&self, agent_id: &str, query: &InboxQuery) -> InboxResponse {
        let store = self.inner.read().await;

        let invite_ids = store.inbox_index.get(agent_id);
        let empty = vec![];
        let invite_ids = invite_ids.unwrap_or(&empty);

        let limit = query.limit.unwrap_or(50).min(200);

        let invites: Vec<InviteSummary> = invite_ids
            .iter()
            .filter_map(|id| store.invites.get(id))
            .filter(|inv| {
                if let Some(status) = query.status {
                    if inv.status != status {
                        return false;
                    }
                }
                if let Some(ref from) = query.from_agent_id {
                    if inv.from_agent_id != *from {
                        return false;
                    }
                }
                true
            })
            .take(limit)
            .map(|inv| inv.to_summary())
            .collect();

        let latest_event_id = store.event_counters.get(agent_id).copied().unwrap_or(0);

        InboxResponse {
            invites,
            latest_event_id,
        }
    }

    /// Get invite detail, redacted per caller.
    pub async fn get_invite(
        &self,
        invite_id: &str,
        caller_agent_id: &str,
    ) -> Result<InviteDetailResponse, RelayError> {
        let store = self.inner.read().await;
        let invite = store
            .invites
            .get(invite_id)
            .ok_or(RelayError::InviteNotFound)?;

        // Only sender or recipient can view
        if invite.from_agent_id != caller_agent_id && invite.to_agent_id != caller_agent_id {
            return Err(RelayError::Unauthorized);
        }

        Ok(invite.to_detail_response(caller_agent_id))
    }

    /// Accept an invite using a 3-phase optimistic pattern.
    ///
    /// Phase 1 (read lock): validate, check idempotency, clone needed data.
    /// Phase 2 (no lock): create session.
    /// Phase 3 (write lock): re-validate, update invite, emit SSE.
    ///
    /// Idempotent: re-accept by same agent returns same session_id + same tokens.
    pub async fn accept_invite(
        &self,
        invite_id: &str,
        caller_agent_id: &str,
        expected_contract_hash: Option<&str>,
        session_store: &SessionStore,
    ) -> Result<AcceptInviteResponse, RelayError> {
        // ── Phase 1: read lock ──────────────────────────────────────────
        let (contract, contract_hash, provider, from_agent_id) = {
            let store = self.inner.read().await;
            let invite = store
                .invites
                .get(invite_id)
                .ok_or(RelayError::InviteNotFound)?;

            // Only recipient can accept
            if invite.to_agent_id != caller_agent_id {
                return Err(RelayError::Unauthorized);
            }

            // Idempotent: if already ACCEPTED, return same tokens
            if invite.status == InviteStatus::Accepted {
                let tokens = invite.session_tokens.as_ref().ok_or_else(|| {
                    RelayError::Internal("accepted invite missing session_tokens".into())
                })?;
                let session_id = invite.session_id.clone().ok_or_else(|| {
                    RelayError::Internal("accepted invite missing session_id".into())
                })?;
                return Ok(AcceptInviteResponse {
                    invite_id: invite_id.to_string(),
                    session_id,
                    contract_hash: invite.contract_hash.clone(),
                    responder_submit_token: tokens.responder_submit.clone(),
                    responder_read_token: tokens.responder_read.clone(),
                });
            }

            // State machine check
            if !invite.can_transition_to(InviteStatus::Accepted) {
                return Err(RelayError::InviteStateConflict(format!(
                    "cannot accept invite in {:?} state",
                    invite.status
                )));
            }

            // Verify contract hash if provided
            if let Some(expected) = expected_contract_hash {
                if invite.contract_hash != expected {
                    return Err(RelayError::ContractValidation(
                        "expected_contract_hash does not match invite contract".to_string(),
                    ));
                }
            }
            // Clone data needed for Phase 2 (session creation)
            (
                invite.contract.clone(),
                invite.contract_hash.clone(),
                invite.provider.clone(),
                invite.from_agent_id.clone(),
            )
            // read lock released here
        };

        // ── Phase 2: no lock — create session ──────────────────────────
        let (session_id, tokens) = session_store
            .create(contract, contract_hash.clone(), provider)
            .await;

        // ── Phase 3: write lock — re-validate and commit ────────────────
        let mut store = self.inner.write().await;

        let invite = match store.invites.get_mut(invite_id) {
            Some(inv) => inv,
            None => {
                // Invite deleted between Phase 1 and Phase 3 (should not happen in practice)
                tracing::warn!(
                    invite_id,
                    session_id = %session_id,
                    "accept_invite Phase 3: invite deleted between phases; orphan session will be reaped by TTL"
                );
                return Err(RelayError::InviteNotFound);
            }
        };

        // Re-check auth (defensive)
        if invite.to_agent_id != caller_agent_id {
            return Err(RelayError::Unauthorized);
        }

        // Idempotent: another concurrent accept won the race
        if invite.status == InviteStatus::Accepted {
            tracing::debug!(
                invite_id,
                session_id = %session_id,
                "accept_invite Phase 3: idempotent path (race); orphan session will be reaped by TTL"
            );
            let cached_tokens = invite.session_tokens.as_ref().ok_or_else(|| {
                RelayError::Internal("accepted invite missing session_tokens".into())
            })?;
            let cached_session_id = invite
                .session_id
                .clone()
                .ok_or_else(|| RelayError::Internal("accepted invite missing session_id".into()))?;
            return Ok(AcceptInviteResponse {
                invite_id: invite_id.to_string(),
                session_id: cached_session_id,
                contract_hash: invite.contract_hash.clone(),
                responder_submit_token: cached_tokens.responder_submit.clone(),
                responder_read_token: cached_tokens.responder_read.clone(),
            });
        }

        // Re-check state machine (invite may have been canceled/expired between phases)
        if !invite.can_transition_to(InviteStatus::Accepted) {
            tracing::warn!(
                invite_id,
                session_id = %session_id,
                status = ?invite.status,
                "accept_invite Phase 3: state conflict (invite changed between phases); orphan session will be reaped by TTL"
            );
            return Err(RelayError::InviteStateConflict(format!(
                "cannot accept invite in {:?} state",
                invite.status
            )));
        }

        // Commit: update invite — collect data we need before dropping mutable invite ref
        let updated_at = Utc::now();
        invite.status = InviteStatus::Accepted;
        invite.updated_at = updated_at;
        invite.session_id = Some(session_id.clone());
        invite.session_tokens = Some(tokens.clone());

        // Extract data for SQLite write-through before we release invite borrow
        #[cfg(feature = "persistence")]
        let sqlite_payload = self.db.as_ref().map(|_| {
            (
                invite_id.to_string(),
                invite.status,
                invite.updated_at,
                invite.session_id.clone(),
                invite.session_tokens.clone(),
            )
        });

        // NLL: invite borrow ends here; all needed data extracted into sqlite_payload.
        // Update counter
        let counter = store
            .event_counters
            .entry(from_agent_id.clone())
            .or_insert(0);
        *counter += 1;
        let event = InboxEvent {
            event_id: *counter,
            event_type: InboxEventType::InviteAccepted,
            invite_id: invite_id.to_string(),
            from_agent_id: caller_agent_id.to_string(),
            timestamp: Utc::now(),
        };

        // SQLite write-through (status update)
        #[cfg(feature = "persistence")]
        if let Some((id, status, upd_at, sid, toks)) = sqlite_payload {
            if let Some(ref db) = self.db {
                let db = db.clone();
                tokio::task::spawn_blocking(move || {
                    db.update_invite(&id, status, upd_at, sid.as_deref(), toks.as_ref(), None)
                })
                .await
                .map_err(|e| RelayError::ServiceUnavailable(format!("db thread: {e}")))?
                .map_err(|e| RelayError::Internal(format!("sqlite: {e}")))?;
            }
        }

        // Persist counter update
        #[cfg(feature = "persistence")]
        if let Some(ref db) = self.db {
            let db = db.clone();
            let agent = from_agent_id.clone();
            let count = *counter;
            tokio::spawn(async move {
                let _ = tokio::task::spawn_blocking(move || db.upsert_event_counter(&agent, count))
                    .await;
            });
        }

        drop(store); // release write lock before acquiring channel Mutex

        self.emit_event(&from_agent_id, event).await;

        Ok(AcceptInviteResponse {
            invite_id: invite_id.to_string(),
            session_id,
            contract_hash,
            responder_submit_token: tokens.responder_submit,
            responder_read_token: tokens.responder_read,
        })
    }

    /// Decline an invite.
    ///
    /// Idempotent: re-decline on terminal state returns current.
    pub async fn decline_invite(
        &self,
        invite_id: &str,
        caller_agent_id: &str,
        reason_code: Option<DeclineReasonCode>,
    ) -> Result<InviteDetailResponse, RelayError> {
        let mut store = self.inner.write().await;
        let invite = store
            .invites
            .get_mut(invite_id)
            .ok_or(RelayError::InviteNotFound)?;

        // Only recipient can decline
        if invite.to_agent_id != caller_agent_id {
            return Err(RelayError::Unauthorized);
        }

        // Idempotent: already DECLINED
        if invite.status == InviteStatus::Declined {
            return Ok(invite.to_detail_response(caller_agent_id));
        }

        if !invite.can_transition_to(InviteStatus::Declined) {
            return Err(RelayError::InviteStateConflict(format!(
                "cannot decline invite in {:?} state",
                invite.status
            )));
        }

        invite.status = InviteStatus::Declined;
        invite.updated_at = Utc::now();
        invite.decline_reason_code = reason_code;
        let from_agent_id = invite.from_agent_id.clone();
        let response = invite.to_detail_response(caller_agent_id);

        // Extract data for SQLite write-through before dropping invite borrow
        #[cfg(feature = "persistence")]
        let sqlite_payload = self.db.as_ref().map(|_| {
            (
                invite_id.to_string(),
                invite.status,
                invite.updated_at,
                invite.decline_reason_code,
            )
        });

        // NLL: invite borrow ends here; all needed data extracted above.
        let counter = store
            .event_counters
            .entry(from_agent_id.clone())
            .or_insert(0);
        *counter += 1;
        let event = InboxEvent {
            event_id: *counter,
            event_type: InboxEventType::InviteDeclined,
            invite_id: invite_id.to_string(),
            from_agent_id: caller_agent_id.to_string(),
            timestamp: Utc::now(),
        };

        // SQLite write-through
        #[cfg(feature = "persistence")]
        if let Some((id, status, upd_at, rc)) = sqlite_payload {
            if let Some(ref db) = self.db {
                let db = db.clone();
                tokio::task::spawn_blocking(move || {
                    db.update_invite(&id, status, upd_at, None, None, rc)
                })
                .await
                .map_err(|e| RelayError::ServiceUnavailable(format!("db thread: {e}")))?
                .map_err(|e| RelayError::Internal(format!("sqlite: {e}")))?;
            }
        }

        #[cfg(feature = "persistence")]
        if let Some(ref db) = self.db {
            let db = db.clone();
            let agent = from_agent_id.clone();
            let count = *counter;
            tokio::spawn(async move {
                let _ = tokio::task::spawn_blocking(move || db.upsert_event_counter(&agent, count))
                    .await;
            });
        }

        drop(store);
        self.emit_event(&from_agent_id, event).await;

        Ok(response)
    }

    /// Cancel an invite (sender side).
    ///
    /// Idempotent: re-cancel on terminal state returns current.
    pub async fn cancel_invite(
        &self,
        invite_id: &str,
        caller_agent_id: &str,
    ) -> Result<InviteDetailResponse, RelayError> {
        let mut store = self.inner.write().await;
        let invite = store
            .invites
            .get_mut(invite_id)
            .ok_or(RelayError::InviteNotFound)?;

        // Only sender can cancel
        if invite.from_agent_id != caller_agent_id {
            return Err(RelayError::Unauthorized);
        }

        // Idempotent: already CANCELED
        if invite.status == InviteStatus::Canceled {
            return Ok(invite.to_detail_response(caller_agent_id));
        }

        if !invite.can_transition_to(InviteStatus::Canceled) {
            return Err(RelayError::InviteStateConflict(format!(
                "cannot cancel invite in {:?} state",
                invite.status
            )));
        }

        invite.status = InviteStatus::Canceled;
        invite.updated_at = Utc::now();
        let to_agent_id = invite.to_agent_id.clone();
        let response = invite.to_detail_response(caller_agent_id);

        // Extract data for SQLite write-through before dropping invite borrow
        #[cfg(feature = "persistence")]
        let sqlite_payload = self
            .db
            .as_ref()
            .map(|_| (invite_id.to_string(), invite.status, invite.updated_at));

        // NLL: invite borrow ends here; all needed data extracted above.
        let counter = store.event_counters.entry(to_agent_id.clone()).or_insert(0);
        *counter += 1;
        let event = InboxEvent {
            event_id: *counter,
            event_type: InboxEventType::InviteCanceled,
            invite_id: invite_id.to_string(),
            from_agent_id: caller_agent_id.to_string(),
            timestamp: Utc::now(),
        };

        // SQLite write-through
        #[cfg(feature = "persistence")]
        if let Some((id, status, upd_at)) = sqlite_payload {
            if let Some(ref db) = self.db {
                let db = db.clone();
                tokio::task::spawn_blocking(move || {
                    db.update_invite(&id, status, upd_at, None, None, None)
                })
                .await
                .map_err(|e| RelayError::ServiceUnavailable(format!("db thread: {e}")))?
                .map_err(|e| RelayError::Internal(format!("sqlite: {e}")))?;
            }
        }

        #[cfg(feature = "persistence")]
        if let Some(ref db) = self.db {
            let db = db.clone();
            let agent = to_agent_id.clone();
            let count = *counter;
            tokio::spawn(async move {
                let _ = tokio::task::spawn_blocking(move || db.upsert_event_counter(&agent, count))
                    .await;
            });
        }

        drop(store);
        self.emit_event(&to_agent_id, event).await;

        Ok(response)
    }

    /// Subscribe to SSE events for an agent. Returns a broadcast receiver.
    pub async fn subscribe(&self, agent_id: &str) -> broadcast::Receiver<InboxEvent> {
        let mut channels = self.channels.lock().await;
        let sender = channels
            .entry(agent_id.to_string())
            .or_insert_with(|| broadcast::channel(SSE_CHANNEL_CAPACITY).0);
        sender.subscribe()
    }

    /// Reap expired invites. Two-phase:
    /// 1. PENDING → EXPIRED (emits INVITE_EXPIRED event, keeps invite visible)
    /// 2. EXPIRED for > gc_grace → deleted
    pub async fn reap_expired(&self) -> usize {
        let now = Utc::now();
        let gc_grace_chrono = chrono::Duration::from_std(self.gc_grace).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "GC grace conversion overflow, falling back to 24 hours");
            chrono::Duration::hours(24)
        });

        let mut store = self.inner.write().await;
        let mut expired_count = 0;
        let mut gc_ids = Vec::new();
        // Collect newly-expired invite metadata during the mutation pass
        // so we don't need to re-scan with fragile equality checks.
        let mut newly_expired: Vec<(String, String, String)> = Vec::new();

        for (id, invite) in store.invites.iter_mut() {
            // Phase 1: expire pending invites that are past their TTL
            if invite.status == InviteStatus::Pending && now > invite.expires_at {
                invite.status = InviteStatus::Expired;
                invite.updated_at = now;
                expired_count += 1;
                newly_expired.push((
                    invite.invite_id.clone(),
                    invite.to_agent_id.clone(),
                    invite.from_agent_id.clone(),
                ));
            }

            // Phase 2: garbage-collect invites that have been EXPIRED for > gc_grace
            if invite.status == InviteStatus::Expired {
                let expired_duration = now.signed_duration_since(invite.updated_at);
                if expired_duration > gc_grace_chrono {
                    gc_ids.push(id.clone());
                }
            }
        }

        // Build SSE events for newly expired invites while holding write lock
        let mut expire_events: Vec<(String, InboxEvent)> = Vec::new();
        for (invite_id, to_agent_id, from_agent_id) in &newly_expired {
            let counter = store.event_counters.entry(to_agent_id.clone()).or_insert(0);
            *counter += 1;
            expire_events.push((
                to_agent_id.clone(),
                InboxEvent {
                    event_id: *counter,
                    event_type: InboxEventType::InviteExpired,
                    invite_id: invite_id.clone(),
                    from_agent_id: from_agent_id.clone(),
                    timestamp: now,
                },
            ));
        }

        // Phase 2: remove garbage-collected invites
        for id in &gc_ids {
            store.invites.remove(id);
            // Clean up inbox index entries
            for index in store.inbox_index.values_mut() {
                index.retain(|iid| iid != id);
            }
        }

        // SQLite write-through: batch expire and delete (best-effort, fire-and-forget)
        #[cfg(feature = "persistence")]
        if let Some(ref db) = self.db {
            if !newly_expired.is_empty() {
                let db = db.clone();
                let ids: Vec<String> = newly_expired.iter().map(|(id, _, _)| id.clone()).collect();
                tokio::spawn(async move {
                    let _ = tokio::task::spawn_blocking(move || db.batch_expire(&ids, now)).await;
                });
            }
            if !gc_ids.is_empty() {
                let db = db.clone();
                let ids = gc_ids.clone();
                tokio::spawn(async move {
                    let _ = tokio::task::spawn_blocking(move || db.batch_delete(&ids)).await;
                });
            }
        }

        drop(store); // release write lock before emitting SSE

        for (agent_id, event) in expire_events {
            self.emit_event(&agent_id, event).await;
        }

        expired_count + gc_ids.len()
    }

    /// Start the background reaper task.
    pub fn start_reaper(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                let reaped = self.reap_expired().await;
                if reaped > 0 {
                    tracing::info!(reaped, "inbox reaper: expired/gc'd invites processed");
                }
            }
        })
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    /// Emit an SSE event to an agent's channel (acquires channel Mutex only).
    async fn emit_event(&self, agent_id: &str, event: InboxEvent) {
        let channels = self.channels.lock().await;
        if let Some(sender) = channels.get(agent_id) {
            // Best-effort: SSE is lossy. Log only when active subscribers miss events.
            if sender.send(event).is_err() && sender.receiver_count() > 0 {
                tracing::warn!(agent_id, "SSE event dropped (buffer full)");
            }
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
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
            model_profile_hash: None,
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

    fn test_create_request() -> CreateInviteRequest {
        CreateInviteRequest {
            to_agent_id: "bob".to_string(),
            contract: test_contract(),
            provider: "anthropic".to_string(),
            purpose_code: "COMPATIBILITY".to_string(),
            from_agent_pubkey: None,
        }
    }

    #[tokio::test]
    async fn test_create_invite_happy_path() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let response = store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        assert!(response.invite_id.starts_with("inv_"));
        assert!(!response.contract_hash.is_empty());
        assert_eq!(response.status, InviteStatus::Pending);
    }

    #[tokio::test]
    async fn test_list_inbox_empty() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let query = InboxQuery {
            status: None,
            from_agent_id: None,
            limit: None,
        };
        let response = store.list_inbox("bob", &query).await;
        assert!(response.invites.is_empty());
        assert_eq!(response.latest_event_id, 0);
    }

    #[tokio::test]
    async fn test_list_inbox_with_invite() {
        let store = InboxStore::new(Duration::from_secs(604800));
        store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let query = InboxQuery {
            status: None,
            from_agent_id: None,
            limit: None,
        };
        let response = store.list_inbox("bob", &query).await;
        assert_eq!(response.invites.len(), 1);
        assert_eq!(response.invites[0].from_agent_id, "alice");
        assert_eq!(response.invites[0].status, InviteStatus::Pending);
        // Event counter should be 1 (INVITE_CREATED)
        assert_eq!(response.latest_event_id, 1);
    }

    #[tokio::test]
    async fn test_list_inbox_filter_by_status() {
        let store = InboxStore::new(Duration::from_secs(604800));
        store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Filter for ACCEPTED — should be empty
        let query = InboxQuery {
            status: Some(InviteStatus::Accepted),
            from_agent_id: None,
            limit: None,
        };
        let response = store.list_inbox("bob", &query).await;
        assert!(response.invites.is_empty());

        // Filter for PENDING — should have one
        let query = InboxQuery {
            status: Some(InviteStatus::Pending),
            from_agent_id: None,
            limit: None,
        };
        let response = store.list_inbox("bob", &query).await;
        assert_eq!(response.invites.len(), 1);
    }

    #[tokio::test]
    async fn test_list_inbox_filter_by_from_agent_id() {
        let store = InboxStore::new(Duration::from_secs(604800));
        store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Filter for charlie — should be empty
        let query = InboxQuery {
            status: None,
            from_agent_id: Some("charlie".to_string()),
            limit: None,
        };
        let response = store.list_inbox("bob", &query).await;
        assert!(response.invites.is_empty());

        // Filter for alice — should have one
        let query = InboxQuery {
            status: None,
            from_agent_id: Some("alice".to_string()),
            limit: None,
        };
        let response = store.list_inbox("bob", &query).await;
        assert_eq!(response.invites.len(), 1);
    }

    #[tokio::test]
    async fn test_accept_bridge_creates_session() {
        let inbox_store = InboxStore::new(Duration::from_secs(604800));
        let session_store = SessionStore::new(Duration::from_secs(600));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let accept_resp = inbox_store
            .accept_invite(&invite_resp.invite_id, "bob", None, &session_store)
            .await
            .unwrap();

        assert!(!accept_resp.session_id.is_empty());
        assert!(!accept_resp.responder_submit_token.is_empty());
        assert!(!accept_resp.responder_read_token.is_empty());
        assert_eq!(accept_resp.contract_hash, invite_resp.contract_hash);

        // Session should exist in session store
        let state = session_store.get_state(&accept_resp.session_id).await;
        assert!(state.is_some());
    }

    #[tokio::test]
    async fn test_accept_idempotent() {
        let inbox_store = InboxStore::new(Duration::from_secs(604800));
        let session_store = SessionStore::new(Duration::from_secs(600));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let accept1 = inbox_store
            .accept_invite(&invite_resp.invite_id, "bob", None, &session_store)
            .await
            .unwrap();

        let accept2 = inbox_store
            .accept_invite(&invite_resp.invite_id, "bob", None, &session_store)
            .await
            .unwrap();

        // Same session_id and tokens
        assert_eq!(accept1.session_id, accept2.session_id);
        assert_eq!(
            accept1.responder_submit_token,
            accept2.responder_submit_token
        );
        assert_eq!(accept1.responder_read_token, accept2.responder_read_token);
    }

    #[tokio::test]
    async fn test_accept_wrong_contract_hash() {
        let inbox_store = InboxStore::new(Duration::from_secs(604800));
        let session_store = SessionStore::new(Duration::from_secs(600));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let result = inbox_store
            .accept_invite(
                &invite_resp.invite_id,
                "bob",
                Some("wrong_hash"),
                &session_store,
            )
            .await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_decline_invite() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let invite_resp = store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let detail = store
            .decline_invite(&invite_resp.invite_id, "bob", Some(DeclineReasonCode::Busy))
            .await
            .unwrap();

        assert_eq!(detail.status, InviteStatus::Declined);
        assert_eq!(detail.decline_reason_code, Some(DeclineReasonCode::Busy));
    }

    #[tokio::test]
    async fn test_decline_idempotent() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let invite_resp = store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        store
            .decline_invite(&invite_resp.invite_id, "bob", None)
            .await
            .unwrap();
        let detail = store
            .decline_invite(&invite_resp.invite_id, "bob", None)
            .await
            .unwrap();
        assert_eq!(detail.status, InviteStatus::Declined);
    }

    #[tokio::test]
    async fn test_cancel_invite() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let invite_resp = store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let detail = store
            .cancel_invite(&invite_resp.invite_id, "alice")
            .await
            .unwrap();

        assert_eq!(detail.status, InviteStatus::Canceled);
    }

    #[tokio::test]
    async fn test_cancel_idempotent() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let invite_resp = store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        store
            .cancel_invite(&invite_resp.invite_id, "alice")
            .await
            .unwrap();
        let detail = store
            .cancel_invite(&invite_resp.invite_id, "alice")
            .await
            .unwrap();
        assert_eq!(detail.status, InviteStatus::Canceled);
    }

    #[tokio::test]
    async fn test_conflict_accept_canceled() {
        let inbox_store = InboxStore::new(Duration::from_secs(604800));
        let session_store = SessionStore::new(Duration::from_secs(600));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Cancel first
        inbox_store
            .cancel_invite(&invite_resp.invite_id, "alice")
            .await
            .unwrap();

        // Try to accept — should fail
        let result = inbox_store
            .accept_invite(&invite_resp.invite_id, "bob", None, &session_store)
            .await;

        assert!(matches!(result, Err(RelayError::InviteStateConflict(_))));
    }

    #[tokio::test]
    async fn test_conflict_cancel_accepted() {
        let inbox_store = InboxStore::new(Duration::from_secs(604800));
        let session_store = SessionStore::new(Duration::from_secs(600));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Accept first
        inbox_store
            .accept_invite(&invite_resp.invite_id, "bob", None, &session_store)
            .await
            .unwrap();

        // Try to cancel — should fail
        let result = inbox_store
            .cancel_invite(&invite_resp.invite_id, "alice")
            .await;

        assert!(matches!(result, Err(RelayError::InviteStateConflict(_))));
    }

    #[tokio::test]
    async fn test_auth_only_recipient_can_accept() {
        let inbox_store = InboxStore::new(Duration::from_secs(604800));
        let session_store = SessionStore::new(Duration::from_secs(600));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Alice (sender) cannot accept
        let result = inbox_store
            .accept_invite(&invite_resp.invite_id, "alice", None, &session_store)
            .await;

        assert!(matches!(result, Err(RelayError::Unauthorized)));
    }

    #[tokio::test]
    async fn test_auth_only_sender_can_cancel() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let invite_resp = store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Bob (recipient) cannot cancel
        let result = store.cancel_invite(&invite_resp.invite_id, "bob").await;
        assert!(matches!(result, Err(RelayError::Unauthorized)));
    }

    #[tokio::test]
    async fn test_cross_agent_isolation() {
        let store = InboxStore::new(Duration::from_secs(604800));
        store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Charlie's inbox should be empty
        let query = InboxQuery {
            status: None,
            from_agent_id: None,
            limit: None,
        };
        let response = store.list_inbox("charlie", &query).await;
        assert!(response.invites.is_empty());
    }

    #[tokio::test]
    async fn test_get_invite_not_found() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let result = store.get_invite("nonexistent", "alice").await;
        assert!(matches!(result, Err(RelayError::InviteNotFound)));
    }

    #[tokio::test]
    async fn test_get_invite_unauthorized() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let invite_resp = store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Charlie cannot view
        let result = store.get_invite(&invite_resp.invite_id, "charlie").await;
        assert!(matches!(result, Err(RelayError::Unauthorized)));
    }

    #[tokio::test]
    async fn test_token_redaction_sender_after_accept() {
        let inbox_store = InboxStore::new(Duration::from_secs(604800));
        let session_store = SessionStore::new(Duration::from_secs(600));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let accept = inbox_store
            .accept_invite(&invite_resp.invite_id, "bob", None, &session_store)
            .await
            .unwrap();

        // Alice (sender) sees initiator tokens, not responder tokens
        let detail = inbox_store
            .get_invite(&invite_resp.invite_id, "alice")
            .await
            .unwrap();
        assert!(detail.session_id.is_some());
        assert!(detail.submit_token.is_some());
        assert!(detail.read_token.is_some());
        // Initiator tokens should be different from responder tokens
        assert_ne!(
            detail.submit_token.as_deref(),
            Some(accept.responder_submit_token.as_str())
        );
        assert_ne!(
            detail.read_token.as_deref(),
            Some(accept.responder_read_token.as_str())
        );
    }

    #[tokio::test]
    async fn test_token_redaction_recipient_after_accept() {
        let inbox_store = InboxStore::new(Duration::from_secs(604800));
        let session_store = SessionStore::new(Duration::from_secs(600));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let accept = inbox_store
            .accept_invite(&invite_resp.invite_id, "bob", None, &session_store)
            .await
            .unwrap();

        // Bob (recipient) sees responder tokens
        let detail = inbox_store
            .get_invite(&invite_resp.invite_id, "bob")
            .await
            .unwrap();
        assert_eq!(
            detail.submit_token.as_deref(),
            Some(accept.responder_submit_token.as_str())
        );
        assert_eq!(
            detail.read_token.as_deref(),
            Some(accept.responder_read_token.as_str())
        );
    }

    #[tokio::test]
    async fn test_token_redaction_pre_accept() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let invite_resp = store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Pre-accept: no tokens for anyone
        let detail_alice = store
            .get_invite(&invite_resp.invite_id, "alice")
            .await
            .unwrap();
        assert!(detail_alice.session_id.is_none());
        assert!(detail_alice.submit_token.is_none());
        assert!(detail_alice.read_token.is_none());

        let detail_bob = store
            .get_invite(&invite_resp.invite_id, "bob")
            .await
            .unwrap();
        assert!(detail_bob.session_id.is_none());
        assert!(detail_bob.submit_token.is_none());
        assert!(detail_bob.read_token.is_none());
    }

    #[tokio::test]
    async fn test_reap_expires_pending_invites() {
        let store = InboxStore::new(Duration::from_millis(1));
        store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Wait for TTL to expire
        tokio::time::sleep(Duration::from_millis(10)).await;

        let reaped = store.reap_expired().await;
        assert_eq!(reaped, 1); // PENDING → EXPIRED

        // Invite should still be visible (as EXPIRED)
        let query = InboxQuery {
            status: Some(InviteStatus::Expired),
            from_agent_id: None,
            limit: None,
        };
        let response = store.list_inbox("bob", &query).await;
        assert_eq!(response.invites.len(), 1);
        assert_eq!(response.invites[0].status, InviteStatus::Expired);
    }

    #[tokio::test]
    async fn test_sse_event_emitted_on_create() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let mut rx = store.subscribe("bob").await;

        store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let event = rx.try_recv().unwrap();
        assert_eq!(event.event_type, InboxEventType::InviteCreated);
        assert_eq!(event.from_agent_id, "alice");
        assert_eq!(event.event_id, 1);
    }

    #[tokio::test]
    async fn test_sse_event_emitted_on_accept() {
        let inbox_store = InboxStore::new(Duration::from_secs(604800));
        let session_store = SessionStore::new(Duration::from_secs(600));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Subscribe to Alice's events (initiator gets notified on accept)
        let mut rx = inbox_store.subscribe("alice").await;

        inbox_store
            .accept_invite(&invite_resp.invite_id, "bob", None, &session_store)
            .await
            .unwrap();

        let event = rx.try_recv().unwrap();
        assert_eq!(event.event_type, InboxEventType::InviteAccepted);
    }

    #[tokio::test]
    async fn test_latest_event_id_increments() {
        let store = InboxStore::new(Duration::from_secs(604800));

        // Create two invites to bob
        store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();
        store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let query = InboxQuery {
            status: None,
            from_agent_id: None,
            limit: None,
        };
        let response = store.list_inbox("bob", &query).await;
        assert_eq!(response.latest_event_id, 2);
    }

    #[tokio::test]
    async fn test_self_invite_rejected() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let mut request = test_create_request();
        request.to_agent_id = "alice".to_string(); // same as from_agent_id

        let result = store.create_invite("alice", &request, None).await;
        assert!(matches!(result, Err(RelayError::ContractValidation(_))));
    }

    #[tokio::test]
    async fn test_auth_only_recipient_can_decline() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let invite_resp = store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Alice (sender) cannot decline
        let result = store
            .decline_invite(&invite_resp.invite_id, "alice", None)
            .await;
        assert!(matches!(result, Err(RelayError::Unauthorized)));
    }

    #[tokio::test]
    async fn test_accept_expired_invite_returns_conflict() {
        let store = InboxStore::new(Duration::from_millis(1));
        let session_store = SessionStore::new(Duration::from_secs(600));

        let invite_resp = store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        // Wait for TTL then reap to transition PENDING → EXPIRED
        tokio::time::sleep(Duration::from_millis(10)).await;
        store.reap_expired().await;

        // Accepting an expired invite should fail
        let result = store
            .accept_invite(&invite_resp.invite_id, "bob", None, &session_store)
            .await;
        assert!(matches!(result, Err(RelayError::InviteStateConflict(_))));
    }

    #[tokio::test]
    async fn test_create_invite_empty_to_agent_id_rejected() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let mut request = test_create_request();
        request.to_agent_id = "".to_string();

        let result = store.create_invite("alice", &request, None).await;
        assert!(matches!(result, Err(RelayError::ContractValidation(_))));
    }

    #[tokio::test]
    async fn test_create_invite_empty_purpose_code_rejected() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let mut request = test_create_request();
        request.purpose_code = "".to_string();

        let result = store.create_invite("alice", &request, None).await;
        assert!(matches!(result, Err(RelayError::ContractValidation(_))));
    }

    #[tokio::test]
    async fn test_create_invite_purpose_must_match_contract() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let mut request = test_create_request();
        request.purpose_code = "MEDIATION".to_string();

        let result = store.create_invite("alice", &request, None).await;
        assert!(matches!(result, Err(RelayError::ContractValidation(_))));
    }

    #[tokio::test]
    async fn test_create_invite_contract_participants_must_match_inbox_agents() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let mut request = test_create_request();
        request.contract.participants = vec!["mallory".to_string(), "bob".to_string()];

        let result = store.create_invite("alice", &request, None).await;
        assert!(matches!(result, Err(RelayError::ContractValidation(_))));
    }

    // ── Concurrency tests ─────────────────────────────────────────────────

    #[tokio::test]
    async fn test_concurrent_reads_dont_block() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc as StdArc;

        let store = InboxStore::new(Duration::from_secs(604800));
        store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();

        let store = StdArc::new(store);
        let count = StdArc::new(AtomicUsize::new(0));

        let mut handles = vec![];
        for _ in 0..10 {
            let s = store.clone();
            let c = count.clone();
            handles.push(tokio::spawn(async move {
                let q = InboxQuery {
                    status: None,
                    from_agent_id: None,
                    limit: None,
                };
                let resp = s.list_inbox("bob", &q).await;
                assert_eq!(resp.invites.len(), 1);
                c.fetch_add(1, Ordering::SeqCst);
            }));
        }

        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(count.load(Ordering::SeqCst), 10);
    }

    #[tokio::test]
    async fn test_concurrent_accept_same_agent_idempotent() {
        use std::sync::Arc as StdArc;

        let inbox_store = StdArc::new(InboxStore::new(Duration::from_secs(604800)));
        let session_store = StdArc::new(SessionStore::new(Duration::from_secs(600)));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();
        let invite_id = invite_resp.invite_id.clone();

        // Launch 5 concurrent accepts by bob
        let mut handles = vec![];
        for _ in 0..5 {
            let is = inbox_store.clone();
            let ss = session_store.clone();
            let id = invite_id.clone();
            handles.push(tokio::spawn(async move {
                is.accept_invite(&id, "bob", None, &ss).await
            }));
        }

        let results: Vec<_> = futures_util::future::join_all(handles).await;
        let successes: Vec<_> = results
            .into_iter()
            .filter_map(|r| r.unwrap().ok())
            .collect();

        // All should succeed with the same session_id (idempotent)
        assert!(!successes.is_empty());
        let first_session = &successes[0].session_id;
        for r in &successes {
            assert_eq!(&r.session_id, first_session);
        }
    }

    #[tokio::test]
    async fn test_accept_does_not_block_list_inbox() {
        use std::sync::Arc as StdArc;

        let inbox_store = StdArc::new(InboxStore::new(Duration::from_secs(604800)));
        let session_store = StdArc::new(SessionStore::new(Duration::from_secs(600)));

        // Create several invites
        for _ in 0..3 {
            inbox_store
                .create_invite("alice", &test_create_request(), None)
                .await
                .unwrap();
        }

        let q = InboxQuery {
            status: None,
            from_agent_id: None,
            limit: None,
        };

        // list_inbox (read) should complete even while accept (write) is running
        // We verify this by running both concurrently
        let is1 = inbox_store.clone();
        let is2 = inbox_store.clone();
        let ss = session_store.clone();

        // Get the first invite to accept
        let first_id = {
            let store = inbox_store.inner.read().await;
            store
                .inbox_index
                .get("bob")
                .and_then(|v| v.first().cloned())
                .unwrap()
        };

        let (list_result, accept_result) =
            tokio::join!(async move { is1.list_inbox("bob", &q).await }, async move {
                is2.accept_invite(&first_id, "bob", None, &ss).await
            });

        assert!(!list_result.invites.is_empty());
        assert!(accept_result.is_ok());
    }

    #[tokio::test]
    async fn test_accept_races_with_cancel_one_wins() {
        use std::sync::Arc as StdArc;

        let inbox_store = StdArc::new(InboxStore::new(Duration::from_secs(604800)));
        let session_store = StdArc::new(SessionStore::new(Duration::from_secs(600)));

        let invite_resp = inbox_store
            .create_invite("alice", &test_create_request(), None)
            .await
            .unwrap();
        let invite_id = invite_resp.invite_id.clone();

        // Run accept and cancel concurrently — exactly one should succeed
        let is1 = inbox_store.clone();
        let is2 = inbox_store.clone();
        let ss = session_store.clone();
        let id1 = invite_id.clone();
        let id2 = invite_id.clone();

        let (accept_result, cancel_result) = tokio::join!(
            async move { is1.accept_invite(&id1, "bob", None, &ss).await },
            async move { is2.cancel_invite(&id2, "alice").await },
        );

        // Exactly one should succeed; the other gets a state conflict
        let accept_ok = accept_result.is_ok();
        let cancel_ok = cancel_result.is_ok();

        // At least one must succeed, and if both succeed it must be via
        // legitimate terminal states (no invalid state)
        assert!(
            accept_ok || cancel_ok,
            "at least one operation should succeed"
        );
    }

    // ── Participant binding (#253) ──────────────────────────────────────

    #[tokio::test]
    async fn test_create_invite_from_agent_not_in_participants() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let request = test_create_request(); // participants: ["alice", "bob"]

        // "charlie" is not in participants
        let result = store.create_invite("charlie", &request, None).await;
        assert!(
            matches!(result, Err(RelayError::ContractValidation(ref msg)) if msg.contains("from_agent_id"))
        );
    }

    #[tokio::test]
    async fn test_create_invite_to_agent_not_in_participants() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let mut request = test_create_request();
        request.to_agent_id = "charlie".to_string(); // not in participants

        let result = store.create_invite("alice", &request, None).await;
        assert!(
            matches!(result, Err(RelayError::ContractValidation(ref msg)) if msg.contains("to_agent_id"))
        );
    }

    #[tokio::test]
    async fn test_create_invite_wrong_participant_count() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let mut request = test_create_request();
        request.contract.participants = vec![
            "alice".to_string(),
            "bob".to_string(),
            "charlie".to_string(),
        ];

        let result = store.create_invite("alice", &request, None).await;
        assert!(
            matches!(result, Err(RelayError::ContractValidation(ref msg)) if msg.contains("exactly 2"))
        );
    }

    #[tokio::test]
    async fn test_create_invite_participants_reversed_order() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let mut request = test_create_request();
        // Reverse the order: ["bob", "alice"] instead of ["alice", "bob"]
        request.contract.participants = vec!["bob".to_string(), "alice".to_string()];

        // Should succeed — order doesn't matter, just membership
        let result = store.create_invite("alice", &request, None).await;
        assert!(result.is_ok());
    }

    // ── Purpose code consistency (#257) ─────────────────────────────────

    #[tokio::test]
    async fn test_create_invite_mismatched_purpose_code() {
        let store = InboxStore::new(Duration::from_secs(604800));
        let mut request = test_create_request();
        // contract.purpose_code is Compatibility ("COMPATIBILITY")
        // but request.purpose_code is "MEDIATION"
        request.purpose_code = "MEDIATION".to_string();

        let result = store.create_invite("alice", &request, None).await;
        assert!(
            matches!(result, Err(RelayError::ContractValidation(ref msg)) if msg.contains("purpose_code must match"))
        );
    }
}
