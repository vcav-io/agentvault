use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::types::{Contract, RelayInput, SessionMetadata};

/// Fixed enum for session state — no variable strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SessionState {
    Created,
    Partial,
    Processing,
    Completed,
    Aborted,
}

/// Fixed enum for abort reasons — no variable strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AbortReason {
    Timeout,
    SchemaValidation,
    ProviderError,
    ContractMismatch,
    PolicyGate,
}

/// Token set for a session. Split by capability (submit vs read) and role.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionTokens {
    pub initiator_submit: String,
    pub initiator_read: String,
    pub responder_submit: String,
    pub responder_read: String,
}

/// Which role a validated token belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenRole {
    InitiatorSubmit,
    InitiatorRead,
    ResponderSubmit,
    ResponderRead,
}

impl TokenRole {
    pub fn is_initiator(self) -> bool {
        matches!(self, TokenRole::InitiatorSubmit | TokenRole::InitiatorRead)
    }
}

/// A bilateral relay session.
pub struct Session {
    pub id: String,
    pub state: SessionState,
    pub abort_reason: Option<AbortReason>,
    pub contract: Contract,
    pub contract_hash: String,
    pub provider: String,
    pub initiator_input: Option<RelayInput>,
    pub responder_input: Option<RelayInput>,
    pub output: Option<serde_json::Value>,
    /// Signed v3 receipt (success or failure).
    pub receipt: Option<receipt_core::ReceiptV3>,
    pub tokens: SessionTokens,
    pub initiator_submitted: bool,
    pub responder_submitted: bool,
    pub created_at: DateTime<Utc>,
    /// When inference started (set as the session enters `Processing`).
    pub processing_started_at: Option<DateTime<Utc>>,
    pub metadata: Option<SessionMetadata>,
    /// Session lifetime: the contract's `session_ttl_secs` if set (never
    /// above the relay TTL), otherwise the relay TTL.
    pub ttl: Duration,
    /// Handle to the running inference task, aborted if the session times out.
    pub inference_abort: Option<tokio::task::AbortHandle>,
    /// Approximate memory held by the contract (see
    /// [`crate::limits::approx_heap_bytes`]).
    pub contract_bytes: usize,
    /// Approximate memory held by submitted inputs, counted until the
    /// session reaches a terminal state (inputs are cleared by then).
    pub input_bytes: usize,
}

impl Session {
    /// Approximate memory this session counts against the store budget.
    pub fn held_bytes(&self) -> usize {
        let inputs = match self.state {
            SessionState::Created | SessionState::Partial | SessionState::Processing => {
                self.input_bytes
            }
            SessionState::Completed | SessionState::Aborted => 0,
        };
        self.contract_bytes.saturating_add(inputs)
    }

    /// Validate a token against this session. Returns the role if valid.
    ///
    /// The presented token is compared with all four session tokens in
    /// constant time, so timing reveals neither how much of a token matched
    /// nor which role it belongs to.
    pub fn validate_token(&self, token: &str) -> Option<TokenRole> {
        let candidates = [
            (&self.tokens.initiator_submit, TokenRole::InitiatorSubmit),
            (&self.tokens.initiator_read, TokenRole::InitiatorRead),
            (&self.tokens.responder_submit, TokenRole::ResponderSubmit),
            (&self.tokens.responder_read, TokenRole::ResponderRead),
        ];
        let mut matched = None;
        for (expected, role) in candidates {
            if crate::auth::tokens_equal(token, expected) {
                matched = Some(role);
            }
        }
        matched
    }
}

/// Generate a cryptographically random token (32 bytes, hex-encoded).
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Generate a session ID from a random UUID.
pub fn generate_session_id() -> String {
    hex::encode(Sha256::digest(uuid::Uuid::new_v4().as_bytes()))
}

/// In-memory ephemeral session store.
#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<Mutex<HashMap<String, Session>>>,
    ttl: Duration,
    max_sessions: usize,
    max_held_bytes: usize,
}

impl SessionStore {
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            ttl,
            max_sessions: crate::limits::DEFAULT_MAX_SESSIONS,
            max_held_bytes: crate::limits::DEFAULT_MAX_STORE_BYTES,
        }
    }

    /// Set the maximum number of sessions held at once (see [`Self::try_create`]).
    pub fn with_max_sessions(mut self, max_sessions: usize) -> Self {
        self.max_sessions = max_sessions;
        self
    }

    /// Set the memory budget for contracts and inputs held at once (see
    /// [`Session::held_bytes`]).
    pub fn with_max_held_bytes(mut self, max_held_bytes: usize) -> Self {
        self.max_held_bytes = max_held_bytes;
        self
    }

    fn held_bytes(store: &HashMap<String, Session>) -> usize {
        store
            .values()
            .fold(0usize, |sum, s| sum.saturating_add(s.held_bytes()))
    }

    /// Create a session unless the store is at capacity.
    ///
    /// Request handlers use this; at capacity (session count or memory
    /// budget) it returns `ServiceUnavailable` and nothing is created.
    pub async fn try_create(
        &self,
        contract: Contract,
        contract_hash: String,
        provider: String,
    ) -> Result<(String, SessionTokens), crate::error::RelayError> {
        let mut store = self.inner.lock().await;
        if store.len() >= self.max_sessions {
            tracing::warn!(
                max_sessions = self.max_sessions,
                "session store at capacity"
            );
            return Err(crate::error::RelayError::ServiceUnavailable(
                "session capacity reached".to_string(),
            ));
        }
        let (session_id, tokens, session) = self.new_session(contract, contract_hash, provider);
        if Self::held_bytes(&store).saturating_add(session.held_bytes()) > self.max_held_bytes {
            tracing::warn!(
                max_held_bytes = self.max_held_bytes,
                "session store memory budget reached"
            );
            return Err(crate::error::RelayError::ServiceUnavailable(
                "session capacity reached".to_string(),
            ));
        }
        store.insert(session_id.clone(), session);
        Ok((session_id, tokens))
    }

    /// Create a new session with generated tokens, without a capacity check.
    /// Returns session ID and tokens.
    pub async fn create(
        &self,
        contract: Contract,
        contract_hash: String,
        provider: String,
    ) -> (String, SessionTokens) {
        let (session_id, tokens, session) = self.new_session(contract, contract_hash, provider);
        let mut store = self.inner.lock().await;
        store.insert(session_id.clone(), session);
        (session_id, tokens)
    }

    fn new_session(
        &self,
        contract: Contract,
        contract_hash: String,
        provider: String,
    ) -> (String, SessionTokens, Session) {
        let contract_bytes = crate::limits::contract_heap_bytes(&contract);
        let ttl = contract
            .session_ttl_secs
            .map(|secs| Duration::from_secs(u64::from(secs)).min(self.ttl))
            .unwrap_or(self.ttl);
        let session_id = generate_session_id();
        let tokens = SessionTokens {
            initiator_submit: generate_token(),
            initiator_read: generate_token(),
            responder_submit: generate_token(),
            responder_read: generate_token(),
        };

        let session = Session {
            id: session_id.clone(),
            state: SessionState::Created,
            abort_reason: None,
            contract,
            contract_hash,
            provider,
            initiator_input: None,
            responder_input: None,
            output: None,
            receipt: None,
            tokens: tokens.clone(),
            initiator_submitted: false,
            responder_submitted: false,
            created_at: Utc::now(),
            processing_started_at: None,
            metadata: None,
            ttl,
            inference_abort: None,
            contract_bytes,
            input_bytes: 0,
        };

        (session_id, tokens, session)
    }

    /// Lock the store and apply a function to a session.
    pub async fn with_session<F, R>(&self, session_id: &str, f: F) -> Option<R>
    where
        F: FnOnce(&mut Session) -> R,
    {
        let mut store = self.inner.lock().await;
        store.get_mut(session_id).map(f)
    }

    /// As [`Self::with_session`], but only if the store can hold
    /// `extra_bytes` more within its memory budget; otherwise returns
    /// `ServiceUnavailable` without calling `f`. `f` should add what it
    /// stores to [`Session::input_bytes`].
    pub async fn with_session_within_budget<F, R>(
        &self,
        session_id: &str,
        extra_bytes: usize,
        f: F,
    ) -> Option<Result<R, crate::error::RelayError>>
    where
        F: FnOnce(&mut Session) -> R,
    {
        let mut store = self.inner.lock().await;
        let held = Self::held_bytes(&store);
        let session = store.get_mut(session_id)?;
        if held.saturating_add(extra_bytes) > self.max_held_bytes {
            tracing::warn!(
                max_held_bytes = self.max_held_bytes,
                "session store memory budget reached"
            );
            return Some(Err(crate::error::RelayError::ServiceUnavailable(
                "session capacity reached".to_string(),
            )));
        }
        Some(Ok(f(session)))
    }

    /// Get a read-only snapshot of session state.
    pub async fn get_state(&self, session_id: &str) -> Option<(SessionState, Option<AbortReason>)> {
        let store = self.inner.lock().await;
        store.get(session_id).map(|s| (s.state, s.abort_reason))
    }

    /// Validate a token for a given session. Returns None for unknown sessions
    /// (constant-shape: caller cannot distinguish unknown from invalid token).
    pub async fn validate_token(&self, session_id: &str, token: &str) -> Option<TokenRole> {
        let store = self.inner.lock().await;
        store.get(session_id).and_then(|s| s.validate_token(token))
    }

    /// Reap expired sessions. Returns number of sessions removed.
    ///
    /// Each session expires after its own TTL (see [`Session::ttl`]).
    /// Sessions with inference in flight are kept so the background task can
    /// write its result back. A session that stays in `Processing` for longer
    /// than one TTL after inference started is treated as stuck: its
    /// inference task is aborted, it moves to `Aborted` with `Timeout`, its
    /// raw inputs are cleared, and it is removed by a later pass once past
    /// its TTL.
    pub async fn reap_expired(&self) -> usize {
        let now = Utc::now();
        let ttl_of = |session: &Session| {
            chrono::Duration::from_std(session.ttl).unwrap_or(chrono::Duration::seconds(600))
        };
        let mut store = self.inner.lock().await;
        let mut timed_out = std::collections::HashSet::new();
        for session in store.values_mut() {
            if session.state != SessionState::Processing {
                continue;
            }
            let started = session.processing_started_at.unwrap_or(session.created_at);
            if now.signed_duration_since(started) >= ttl_of(session) {
                tracing::warn!(session_id = %session.id, "session processing timed out");
                if let Some(handle) = session.inference_abort.take() {
                    handle.abort();
                }
                session.state = SessionState::Aborted;
                session.abort_reason = Some(AbortReason::Timeout);
                session.initiator_input = None;
                session.responder_input = None;
                timed_out.insert(session.id.clone());
            }
        }
        let before = store.len();
        store.retain(|id, session| {
            // Sessions timed out in this pass stay until the next pass so
            // participants can observe the TIMEOUT status.
            timed_out.contains(id)
                || session.state == SessionState::Processing
                || now.signed_duration_since(session.created_at) < ttl_of(session)
        });
        before - store.len()
    }

    /// Number of sessions currently held.
    pub async fn len(&self) -> usize {
        self.inner.lock().await.len()
    }

    /// Whether the store holds no sessions.
    pub async fn is_empty(&self) -> bool {
        self.inner.lock().await.is_empty()
    }

    /// Start the background reaper, restarted by a supervisor if it exits.
    pub fn start_reaper(self) -> tokio::task::JoinHandle<()> {
        crate::supervise("session reaper", move || {
            let store = self.clone();
            async move {
                let mut interval = tokio::time::interval(Duration::from_secs(60));
                loop {
                    interval.tick().await;
                    let reaped = store.reap_expired().await;
                    if reaped > 0 {
                        tracing::info!(reaped, "session reaper: expired sessions removed");
                    }
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_contract() -> Contract {
        Contract {
            purpose_code: vault_family_types::Purpose::Mediation,
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

    #[tokio::test]
    async fn test_create_session() {
        let store = SessionStore::new(Duration::from_secs(600));
        let (session_id, tokens) = store
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;

        assert_eq!(session_id.len(), 64); // SHA-256 hex
        assert_eq!(tokens.initiator_submit.len(), 64); // 32 bytes hex
        assert_eq!(tokens.initiator_read.len(), 64);
        assert_eq!(tokens.responder_submit.len(), 64);
        assert_eq!(tokens.responder_read.len(), 64);

        // All tokens are unique
        let all = [
            &tokens.initiator_submit,
            &tokens.initiator_read,
            &tokens.responder_submit,
            &tokens.responder_read,
        ];
        for (i, a) in all.iter().enumerate() {
            for (j, b) in all.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b, "tokens {i} and {j} should differ");
                }
            }
        }
    }

    #[tokio::test]
    async fn test_validate_token() {
        let store = SessionStore::new(Duration::from_secs(600));
        let (session_id, tokens) = store
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;

        assert_eq!(
            store
                .validate_token(&session_id, &tokens.initiator_submit)
                .await,
            Some(TokenRole::InitiatorSubmit)
        );
        assert_eq!(
            store
                .validate_token(&session_id, &tokens.responder_read)
                .await,
            Some(TokenRole::ResponderRead)
        );
        assert_eq!(
            store.validate_token(&session_id, "invalid-token").await,
            None
        );
        // Unknown session returns None (constant-shape)
        assert_eq!(
            store
                .validate_token("unknown-session", &tokens.initiator_submit)
                .await,
            None
        );
    }

    #[tokio::test]
    async fn test_session_state_lifecycle() {
        let store = SessionStore::new(Duration::from_secs(600));
        let (session_id, _) = store
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;

        let (state, _) = store.get_state(&session_id).await.unwrap();
        assert_eq!(state, SessionState::Created);

        // Transition to Partial
        store
            .with_session(&session_id, |s| {
                s.state = SessionState::Partial;
            })
            .await;
        let (state, _) = store.get_state(&session_id).await.unwrap();
        assert_eq!(state, SessionState::Partial);
    }

    #[tokio::test]
    async fn test_reap_expired() {
        let store = SessionStore::new(Duration::from_millis(1));
        store
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;

        // Wait for TTL to expire
        tokio::time::sleep(Duration::from_millis(10)).await;

        let reaped = store.reap_expired().await;
        assert_eq!(reaped, 1);
    }

    #[tokio::test]
    async fn test_reaper_times_out_stuck_processing_session() {
        let store = SessionStore::new(Duration::from_millis(1));
        let (session_id, _) = store
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;
        store
            .with_session(&session_id, |session| {
                session.initiator_input = Some(RelayInput {
                    role: "alice".to_string(),
                    context: serde_json::json!({"text": "initiator input"}),
                    commitment_nonce: crate::types::test_nonce(),
                });
                session.responder_input = Some(RelayInput {
                    role: "bob".to_string(),
                    context: serde_json::json!({"text": "responder input"}),
                    commitment_nonce: crate::types::test_nonce(),
                });
                session.state = SessionState::Processing;
            })
            .await;

        tokio::time::sleep(Duration::from_millis(10)).await;
        store.reap_expired().await;

        // First pass: session is terminal with inputs cleared, still observable.
        let snapshot = store
            .with_session(&session_id, |session| {
                (
                    session.state,
                    session.abort_reason,
                    session.initiator_input.is_none() && session.responder_input.is_none(),
                )
            })
            .await
            .expect("timed-out session should remain visible for one reaper pass");
        assert_eq!(snapshot.0, SessionState::Aborted);
        assert_eq!(snapshot.1, Some(AbortReason::Timeout));
        assert!(
            snapshot.2,
            "inputs should be cleared when processing times out"
        );

        // Second pass removes it.
        assert_eq!(store.reap_expired().await, 1);
        assert!(store.get_state(&session_id).await.is_none());
    }

    #[tokio::test]
    async fn test_reaper_keeps_processing_session_within_ttl() {
        let store = SessionStore::new(Duration::from_secs(600));
        let (session_id, _) = store
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;
        store
            .with_session(&session_id, |session| {
                session.state = SessionState::Processing;
            })
            .await;
        assert_eq!(store.reap_expired().await, 0);
        let (state, _) = store.get_state(&session_id).await.unwrap();
        assert_eq!(state, SessionState::Processing);
    }

    #[tokio::test]
    async fn test_unknown_session_returns_none() {
        let store = SessionStore::new(Duration::from_secs(600));
        assert!(store.get_state("nonexistent").await.is_none());
    }

    #[tokio::test]
    async fn test_inputs_cleared_after_inference() {
        let store = SessionStore::new(Duration::from_secs(600));
        let (session_id, _) = store
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;

        // Simulate both inputs submitted
        store
            .with_session(&session_id, |session| {
                session.initiator_input = Some(RelayInput {
                    role: "initiator".to_string(),
                    context: serde_json::json!({"text": "secret initiator input"}),
                    commitment_nonce: crate::types::test_nonce(),
                });
                session.responder_input = Some(RelayInput {
                    role: "responder".to_string(),
                    context: serde_json::json!({"text": "secret responder input"}),
                    commitment_nonce: crate::types::test_nonce(),
                });
                session.state = SessionState::Processing;
            })
            .await;

        // Verify inputs are present
        let has_inputs = store
            .with_session(&session_id, |session| {
                session.initiator_input.is_some() && session.responder_input.is_some()
            })
            .await
            .unwrap();
        assert!(has_inputs);

        // Simulate post-inference clearing (mirrors spawn_inference Ok arm)
        store
            .with_session(&session_id, |session| {
                session.state = SessionState::Completed;
                session.initiator_input = None;
                session.responder_input = None;
            })
            .await;

        // Assert inputs are cleared
        let (initiator_cleared, responder_cleared) = store
            .with_session(&session_id, |session| {
                (
                    session.initiator_input.is_none(),
                    session.responder_input.is_none(),
                )
            })
            .await
            .unwrap();
        assert!(
            initiator_cleared,
            "initiator_input should be None after inference"
        );
        assert!(
            responder_cleared,
            "responder_input should be None after inference"
        );
    }

    #[tokio::test]
    async fn test_inputs_cleared_on_inference_error() {
        let store = SessionStore::new(Duration::from_secs(600));
        let (session_id, _) = store
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;

        // Simulate both inputs submitted
        store
            .with_session(&session_id, |session| {
                session.initiator_input = Some(RelayInput {
                    role: "initiator".to_string(),
                    context: serde_json::json!({"text": "secret initiator input"}),
                    commitment_nonce: crate::types::test_nonce(),
                });
                session.responder_input = Some(RelayInput {
                    role: "responder".to_string(),
                    context: serde_json::json!({"text": "secret responder input"}),
                    commitment_nonce: crate::types::test_nonce(),
                });
                session.state = SessionState::Processing;
            })
            .await;

        // Simulate post-inference clearing on error (mirrors spawn_inference Err arm)
        store
            .with_session(&session_id, |session| {
                session.state = SessionState::Aborted;
                session.abort_reason = Some(AbortReason::ProviderError);
                session.initiator_input = None;
                session.responder_input = None;
            })
            .await;

        // Assert inputs are cleared even on error
        let (initiator_cleared, responder_cleared) = store
            .with_session(&session_id, |session| {
                (
                    session.initiator_input.is_none(),
                    session.responder_input.is_none(),
                )
            })
            .await
            .unwrap();
        assert!(
            initiator_cleared,
            "initiator_input should be None after error"
        );
        assert!(
            responder_cleared,
            "responder_input should be None after error"
        );
    }

    #[tokio::test]
    async fn test_reaper_honours_contract_session_ttl() {
        let store = SessionStore::new(Duration::from_secs(600));
        let mut short = test_contract();
        short.session_ttl_secs = Some(1);
        let (short_id, _) = store
            .create(short, "hash".to_string(), "anthropic".to_string())
            .await;
        let (default_id, _) = store
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;
        store
            .with_session(&short_id, |s| {
                s.created_at -= chrono::Duration::seconds(2);
            })
            .await;
        assert_eq!(store.reap_expired().await, 1);
        assert!(store.get_state(&short_id).await.is_none());
        assert!(store.get_state(&default_id).await.is_some());
    }

    #[tokio::test]
    async fn test_contract_session_ttl_never_exceeds_relay_ttl() {
        let store = SessionStore::new(Duration::from_secs(60));
        let mut long = test_contract();
        long.session_ttl_secs = Some(3600);
        let (id, _) = store
            .create(long, "hash".to_string(), "anthropic".to_string())
            .await;
        let ttl = store.with_session(&id, |s| s.ttl).await.unwrap();
        assert_eq!(ttl, Duration::from_secs(60));
    }

    #[tokio::test]
    async fn test_try_create_refuses_at_capacity() {
        let store = SessionStore::new(Duration::from_secs(600)).with_max_sessions(2);
        for _ in 0..2 {
            store
                .try_create(test_contract(), "hash".to_string(), "anthropic".to_string())
                .await
                .unwrap();
        }
        let err = store
            .try_create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            crate::error::RelayError::ServiceUnavailable(_)
        ));
        assert_eq!(store.len().await, 2);
    }

    #[tokio::test]
    async fn test_try_create_refuses_over_memory_budget() {
        let probe = SessionStore::new(Duration::from_secs(600));
        let (id, _) = probe
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;
        let one = probe.with_session(&id, |s| s.held_bytes()).await.unwrap();
        assert!(one > 0);

        // Room for two contracts, not three.
        let store = SessionStore::new(Duration::from_secs(600)).with_max_held_bytes(one * 2);
        for _ in 0..2 {
            store
                .try_create(test_contract(), "hash".to_string(), "anthropic".to_string())
                .await
                .unwrap();
        }
        let err = store
            .try_create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            crate::error::RelayError::ServiceUnavailable(_)
        ));
        assert_eq!(store.len().await, 2);
    }

    #[tokio::test]
    async fn test_input_refused_over_memory_budget_until_released() {
        let probe = SessionStore::new(Duration::from_secs(600));
        let (id, _) = probe
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;
        let contract_bytes = probe.with_session(&id, |s| s.held_bytes()).await.unwrap();

        let store = SessionStore::new(Duration::from_secs(600))
            .with_max_held_bytes(contract_bytes * 2 + 1000);
        let (a, _) = store
            .try_create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await
            .unwrap();
        let (b, _) = store
            .try_create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await
            .unwrap();

        // Session a holds a 1000-byte input; b cannot add another.
        store
            .with_session_within_budget(&a, 1000, |s| {
                s.input_bytes += 1000;
                s.state = SessionState::Partial;
            })
            .await
            .unwrap()
            .unwrap();
        let refused = store
            .with_session_within_budget(&b, 1000, |s| s.input_bytes += 1000)
            .await
            .unwrap();
        assert!(matches!(
            refused,
            Err(crate::error::RelayError::ServiceUnavailable(_))
        ));
        assert_eq!(store.with_session(&b, |s| s.input_bytes).await, Some(0));

        // Once a finishes (its inputs are cleared), the budget is released.
        store
            .with_session(&a, |s| s.state = SessionState::Completed)
            .await;
        store
            .with_session_within_budget(&b, 1000, |s| s.input_bytes += 1000)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn test_processing_timeout_aborts_inference_task() {
        let store = SessionStore::new(Duration::from_millis(1));
        let (session_id, _) = store
            .create(test_contract(), "hash".to_string(), "anthropic".to_string())
            .await;
        let task = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        });
        let abort = task.abort_handle();
        store
            .with_session(&session_id, |s| {
                s.state = SessionState::Processing;
                s.inference_abort = Some(abort);
            })
            .await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        store.reap_expired().await;
        let err = task.await.unwrap_err();
        assert!(err.is_cancelled(), "inference task should be aborted");
    }
}
