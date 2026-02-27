use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, Mutex};

use crate::error::RelayError;
use crate::inbox_types::*;
use crate::relay::compute_contract_hash;
use crate::session::SessionStore;

/// Generate a unique invite ID.
fn generate_invite_id() -> String {
    format!(
        "inv_{}",
        &hex::encode(Sha256::digest(uuid::Uuid::new_v4().as_bytes()))[..32]
    )
}

/// In-memory inbox store, parallel to SessionStore.
#[derive(Clone)]
pub struct InboxStore {
    inner: Arc<Mutex<InboxStoreInner>>,
    invite_ttl: Duration,
    /// Grace period after EXPIRED before garbage collection.
    gc_grace: Duration,
}

struct InboxStoreInner {
    invites: HashMap<String, Invite>,
    /// agent_id -> ordered list of invite_ids received by this agent.
    inbox_index: HashMap<String, Vec<String>>,
    /// agent_id -> monotonic event counter.
    event_counters: HashMap<String, u64>,
    /// agent_id -> broadcast sender for SSE events.
    event_channels: HashMap<String, broadcast::Sender<InboxEvent>>,
}

const SSE_CHANNEL_CAPACITY: usize = 64;

impl InboxStore {
    pub fn new(invite_ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(InboxStoreInner {
                invites: HashMap::new(),
                inbox_index: HashMap::new(),
                event_counters: HashMap::new(),
                event_channels: HashMap::new(),
            })),
            invite_ttl,
            gc_grace: Duration::from_secs(86400), // 24h grace after EXPIRED
        }
    }

    /// Create a new invite.
    pub async fn create_invite(
        &self,
        from_agent_id: &str,
        request: &CreateInviteRequest,
        from_agent_pubkey: Option<String>,
    ) -> Result<CreateInviteResponse, RelayError> {
        let contract_hash = compute_contract_hash(&request.contract)?;
        let now = Utc::now();
        let invite_ttl_chrono =
            chrono::Duration::from_std(self.invite_ttl).unwrap_or(chrono::Duration::days(7));
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
            purpose_code: request.purpose_code.clone(),
            status: InviteStatus::Pending,
            created_at: now,
            updated_at: now,
            expires_at,
            session_id: None,
            session_tokens: None,
            decline_reason_code: None,
        };

        let mut store = self.inner.lock().await;

        // Add to recipient's inbox index
        store
            .inbox_index
            .entry(request.to_agent_id.clone())
            .or_default()
            .push(invite_id.clone());

        // Emit event to recipient
        let event = self.build_event_locked(
            &mut store,
            &request.to_agent_id,
            InboxEventType::InviteCreated,
            &invite_id,
            from_agent_id,
        );
        self.emit_event_locked(&store, &request.to_agent_id, event);

        store.invites.insert(invite_id.clone(), invite);

        Ok(CreateInviteResponse {
            invite_id,
            contract_hash,
            status: InviteStatus::Pending,
            expires_at,
        })
    }

    /// List inbox for an agent with optional filters.
    pub async fn list_inbox(&self, agent_id: &str, query: &InboxQuery) -> InboxResponse {
        let store = self.inner.lock().await;

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
        let store = self.inner.lock().await;
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

    /// Accept an invite. Creates a session and returns responder tokens.
    ///
    /// Idempotent: re-accept returns same session_id + same tokens.
    pub async fn accept_invite(
        &self,
        invite_id: &str,
        caller_agent_id: &str,
        expected_contract_hash: Option<&str>,
        session_store: &SessionStore,
    ) -> Result<AcceptInviteResponse, RelayError> {
        let mut store = self.inner.lock().await;
        let invite = store
            .invites
            .get_mut(invite_id)
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
            let session_id = invite
                .session_id
                .clone()
                .ok_or_else(|| RelayError::Internal("accepted invite missing session_id".into()))?;
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

        // Create session (reuse existing SessionStore::create)
        let (session_id, tokens) = session_store
            .create(
                invite.contract.clone(),
                invite.contract_hash.clone(),
                invite.provider.clone(),
            )
            .await;

        // Update invite (immutable after this point)
        invite.status = InviteStatus::Accepted;
        invite.updated_at = Utc::now();
        invite.session_id = Some(session_id.clone());
        invite.session_tokens = Some(tokens.clone());
        let from_agent_id = invite.from_agent_id.clone();
        let contract_hash = invite.contract_hash.clone();

        // Drop mutable borrow on invite before building event
        let event = self.build_event_locked(
            &mut store,
            &from_agent_id,
            InboxEventType::InviteAccepted,
            invite_id,
            caller_agent_id,
        );
        self.emit_event_locked(&store, &from_agent_id, event);

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
        let mut store = self.inner.lock().await;
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

        // Drop mutable borrow on invite before building event
        let event = self.build_event_locked(
            &mut store,
            &from_agent_id,
            InboxEventType::InviteDeclined,
            invite_id,
            caller_agent_id,
        );
        self.emit_event_locked(&store, &from_agent_id, event);

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
        let mut store = self.inner.lock().await;
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

        // Drop mutable borrow on invite before building event
        let event = self.build_event_locked(
            &mut store,
            &to_agent_id,
            InboxEventType::InviteCanceled,
            invite_id,
            caller_agent_id,
        );
        self.emit_event_locked(&store, &to_agent_id, event);

        Ok(response)
    }

    /// Subscribe to SSE events for an agent. Returns a broadcast receiver.
    pub async fn subscribe(&self, agent_id: &str) -> broadcast::Receiver<InboxEvent> {
        let mut store = self.inner.lock().await;
        let sender = store
            .event_channels
            .entry(agent_id.to_string())
            .or_insert_with(|| broadcast::channel(SSE_CHANNEL_CAPACITY).0);
        sender.subscribe()
    }

    /// Reap expired invites. Two-phase:
    /// 1. PENDING → EXPIRED (emits INVITE_EXPIRED event, keeps invite visible)
    /// 2. EXPIRED for > gc_grace → deleted
    pub async fn reap_expired(&self) -> usize {
        let now = Utc::now();
        let gc_grace_chrono =
            chrono::Duration::from_std(self.gc_grace).unwrap_or(chrono::Duration::hours(24));

        let mut store = self.inner.lock().await;
        let mut expired_count = 0;
        let mut gc_ids = Vec::new();

        for (id, invite) in store.invites.iter_mut() {
            // Phase 1: expire pending invites that are past their TTL
            if invite.status == InviteStatus::Pending && now > invite.expires_at {
                invite.status = InviteStatus::Expired;
                invite.updated_at = now;
                expired_count += 1;

                // We'll emit events after the mutable borrow ends
            }

            // Phase 2: garbage-collect invites that have been EXPIRED for > gc_grace
            if invite.status == InviteStatus::Expired {
                let expired_duration = now.signed_duration_since(invite.updated_at);
                if expired_duration > gc_grace_chrono {
                    gc_ids.push(id.clone());
                }
            }
        }

        // Emit INVITE_EXPIRED events for newly expired invites
        // (We need to collect them first since we can't borrow mutably and immutably at once)
        let newly_expired: Vec<(String, String, String)> = store
            .invites
            .values()
            .filter(|inv| inv.status == InviteStatus::Expired && inv.updated_at == now)
            .map(|inv| {
                (
                    inv.invite_id.clone(),
                    inv.to_agent_id.clone(),
                    inv.from_agent_id.clone(),
                )
            })
            .collect();

        for (invite_id, to_agent_id, from_agent_id) in newly_expired {
            let event = self.build_event_locked(
                &mut store,
                &to_agent_id,
                InboxEventType::InviteExpired,
                &invite_id,
                &from_agent_id,
            );
            self.emit_event_locked(&store, &to_agent_id, event);
        }

        // Phase 2: remove garbage-collected invites
        for id in &gc_ids {
            store.invites.remove(id);
            // Clean up inbox index entries
            for index in store.inbox_index.values_mut() {
                index.retain(|iid| iid != id);
            }
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

    fn build_event_locked(
        &self,
        store: &mut InboxStoreInner,
        recipient_agent_id: &str,
        event_type: InboxEventType,
        invite_id: &str,
        from_agent_id: &str,
    ) -> InboxEvent {
        let counter = store
            .event_counters
            .entry(recipient_agent_id.to_string())
            .or_insert(0);
        *counter += 1;

        InboxEvent {
            event_id: *counter,
            event_type,
            invite_id: invite_id.to_string(),
            from_agent_id: from_agent_id.to_string(),
            timestamp: Utc::now(),
        }
    }

    fn emit_event_locked(&self, store: &InboxStoreInner, agent_id: &str, event: InboxEvent) {
        if let Some(sender) = store.event_channels.get(agent_id) {
            // Best-effort: if no subscribers or buffer full, event is dropped (SSE is lossy)
            let _ = sender.send(event);
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
}
