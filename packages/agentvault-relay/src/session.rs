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
    pub receipt: Option<receipt_core::Receipt>,
    pub receipt_signature: Option<String>,
    pub receipt_v2: Option<receipt_core::ReceiptV2>,
    pub tokens: SessionTokens,
    pub initiator_submitted: bool,
    pub responder_submitted: bool,
    pub created_at: DateTime<Utc>,
    pub metadata: Option<SessionMetadata>,
}

impl Session {
    /// Validate a token against this session. Returns the role if valid.
    pub fn validate_token(&self, token: &str) -> Option<TokenRole> {
        if token == self.tokens.initiator_submit {
            Some(TokenRole::InitiatorSubmit)
        } else if token == self.tokens.initiator_read {
            Some(TokenRole::InitiatorRead)
        } else if token == self.tokens.responder_submit {
            Some(TokenRole::ResponderSubmit)
        } else if token == self.tokens.responder_read {
            Some(TokenRole::ResponderRead)
        } else {
            None
        }
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
}

impl SessionStore {
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            ttl,
        }
    }

    /// Create a new session with generated tokens. Returns session ID and tokens.
    pub async fn create(
        &self,
        contract: Contract,
        contract_hash: String,
        provider: String,
    ) -> (String, SessionTokens) {
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
            receipt_signature: None,
            receipt_v2: None,
            tokens: tokens.clone(),
            initiator_submitted: false,
            responder_submitted: false,
            created_at: Utc::now(),
            metadata: None,
        };

        let mut store = self.inner.lock().await;
        store.insert(session_id.clone(), session);

        (session_id, tokens)
    }

    /// Lock the store and apply a function to a session.
    pub async fn with_session<F, R>(&self, session_id: &str, f: F) -> Option<R>
    where
        F: FnOnce(&mut Session) -> R,
    {
        let mut store = self.inner.lock().await;
        store.get_mut(session_id).map(f)
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
    pub async fn reap_expired(&self) -> usize {
        let now = Utc::now();
        let ttl_chrono =
            chrono::Duration::from_std(self.ttl).unwrap_or(chrono::Duration::seconds(600));
        let mut store = self.inner.lock().await;
        let before = store.len();
        store.retain(|_, session| {
            // Don't reap sessions with inference in flight — the background task
            // needs the session to exist when it writes the result back.
            session.state == SessionState::Processing
                || now.signed_duration_since(session.created_at) < ttl_chrono
        });
        before - store.len()
    }

    /// Start the background reaper task.
    pub fn start_reaper(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                let reaped = self.reap_expired().await;
                if reaped > 0 {
                    tracing::info!(reaped, "session reaper: expired sessions removed");
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
            enforcement_policy_hash: None,
            output_schema_hash: None,
            model_constraints: None,
            max_completion_tokens: None,
            session_ttl_secs: None,
            invite_ttl_secs: None,
            entropy_enforcement: None,
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
    async fn test_unknown_session_returns_none() {
        let store = SessionStore::new(Duration::from_secs(600));
        assert!(store.get_state("nonexistent").await.is_none());
    }
}
