use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::session::{AbortReason, SessionState};

// ============================================================================
// Core types (shared between single-shot and bilateral)
// ============================================================================

/// Serialise released output as its receipt v3 canonical (RFC 8785) text, so
/// the delivered bytes are exactly the bytes the receipt's `output_hash`
/// commits to.
fn serialize_canonical_output<S: serde::Serializer>(
    value: &serde_json::Value,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::Error;
    let text = receipt_core::canonicalize_v3(value).map_err(S::Error::custom)?;
    let raw = serde_json::value::RawValue::from_string(text).map_err(S::Error::custom)?;
    raw.serialize(serializer)
}

fn serialize_canonical_output_opt<S: serde::Serializer>(
    value: &Option<serde_json::Value>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(v) => serialize_canonical_output(v, serializer),
        None => serializer.serialize_none(),
    }
}

// Contract is now defined in vault-family-types. Re-export for use within crate.
pub use vault_family_types::Contract;

/// Client-generated input commitment nonce (32 bytes).
///
/// Sent as `commitment_nonce`: exactly 64 lowercase hex characters. The relay
/// uses it only to compute the participant's input commitment; it is never
/// written to receipts, logs or responses, and its bytes are zeroed when the
/// input is cleared.
#[derive(Clone)]
pub struct CommitmentNonce([u8; receipt_core::commitment_v3::COMMITMENT_NONCE_LEN]);

impl CommitmentNonce {
    /// Parse the wire form (64 lowercase hex characters).
    pub fn parse(hex_nonce: &str) -> Result<Self, receipt_core::CommitmentError> {
        receipt_core::parse_commitment_nonce(hex_nonce).map(Self)
    }

    pub fn as_bytes(&self) -> &[u8; receipt_core::commitment_v3::COMMITMENT_NONCE_LEN] {
        &self.0
    }
}

impl std::fmt::Debug for CommitmentNonce {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CommitmentNonce(<redacted>)")
    }
}

impl Drop for CommitmentNonce {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.0);
    }
}

impl<'de> Deserialize<'de> for CommitmentNonce {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut hex_nonce = String::deserialize(deserializer)?;
        let parsed = CommitmentNonce::parse(&hex_nonce).map_err(|_| {
            serde::de::Error::custom(
                "commitment_nonce must be 64 lowercase hex characters (32 bytes)",
            )
        });
        zeroize::Zeroize::zeroize(&mut hex_nonce);
        parsed
    }
}

/// A fixed, well-formed nonce for unit tests.
#[cfg(test)]
pub(crate) fn test_nonce() -> CommitmentNonce {
    CommitmentNonce::parse(&"11".repeat(32)).expect("valid test nonce")
}

/// One party's input to the relay.
#[derive(Debug, Clone, Deserialize)]
pub struct RelayInput {
    pub role: String,
    pub context: serde_json::Value,
    /// Required. Salts this party's input commitment in the receipt.
    pub commitment_nonce: CommitmentNonce,
}

/// Tier 2 model profile — describes the cognitive class consented to by both
/// parties. Hash is bound into the receipt.
///
/// A profile is more than provider + SKU: it declares reasoning mode,
/// structured-output capability, and the concrete model binding. `model_id`
/// is what the relay dispatches to the provider API; the other fields
/// describe the cognitive class the parties agreed on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelProfile {
    pub profile_version: String,
    pub profile_id: String,
    pub provider: String,
    /// Concrete model identifier dispatched to the provider API.
    /// e.g. "claude-sonnet-4-6", "gpt-5", "gemini-3-flash".
    pub model_id: String,
    pub model_family: String,
    pub reasoning_mode: String,
    pub structured_output: bool,
}

// ============================================================================
// Single-shot relay endpoint (POST /relay)
// ============================================================================

/// Relay request: contract + both party inputs (single-shot).
///
/// The single caller supplies both inputs, each with its own
/// `commitment_nonce`. The contract is kept as received: its contract hash v2
/// is computed from this JSON.
#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    pub contract: serde_json::Value,
    pub input_a: RelayInput,
    pub input_b: RelayInput,
    pub provider: String,
}

/// Relay response: structured output + signed receipt.
#[derive(Debug, Serialize)]
pub struct RelayResponse {
    #[serde(serialize_with = "serialize_canonical_output")]
    pub output: serde_json::Value,
    /// Signed v3 receipt.
    pub receipt: receipt_core::ReceiptV3,
}

// ============================================================================
// Bilateral session endpoints
// ============================================================================

/// POST /sessions request body.
#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    /// The contract as received; its contract hash v2 is computed from this JSON.
    pub contract: serde_json::Value,
    #[serde(default = "default_provider")]
    pub provider: String,
}

fn default_provider() -> String {
    String::new() // empty = auto-select first configured provider
}

/// POST /sessions response body.
#[derive(Debug, Serialize)]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub contract_hash: String,
    pub initiator_submit_token: String,
    pub initiator_read_token: String,
    pub responder_submit_token: String,
    pub responder_read_token: String,
}

/// POST /sessions/:id/input request body.
#[derive(Debug, Deserialize)]
pub struct SubmitInputRequest {
    /// Deprecated/ignored: the relay derives the participant role from the
    /// authenticated submit token (initiator → participants[0], responder →
    /// participants[1]). This field is accepted for backward compatibility
    /// but its value is not used.
    pub role: String,
    pub context: serde_json::Value,
    /// If provided, the relay verifies this matches the session's contract_hash
    /// before accepting input. Prevents a malicious initiator from creating a
    /// session with a permissive contract while advertising a different hash.
    #[serde(default)]
    pub expected_contract_hash: Option<String>,
    /// Required. Client-generated nonce that salts this party's input
    /// commitment (64 lowercase hex characters).
    pub commitment_nonce: CommitmentNonce,
}

/// Constant-shape status response (same structure regardless of state).
#[derive(Debug, Serialize)]
pub struct SessionStatusResponse {
    pub state: SessionState,
    pub abort_reason: Option<AbortReason>,
}

/// Constant-shape output response (same structure regardless of state).
#[derive(Debug, Serialize)]
pub struct SessionOutputResponse {
    pub state: SessionState,
    pub abort_reason: Option<AbortReason>,
    #[serde(serialize_with = "serialize_canonical_output_opt")]
    pub output: Option<serde_json::Value>,
    /// Signed v3 receipt (success or failure), once the session is terminal.
    pub receipt: Option<receipt_core::ReceiptV3>,
}

// ============================================================================
// Health and capabilities
// ============================================================================

/// Summary of the relay's enforcement policy, exposed via /health.
#[derive(Debug, Clone, Serialize)]
pub struct PolicySummary {
    pub policy_id: String,
    pub policy_hash: String,
    pub model_profile_allowlist: Vec<String>,
    pub enforcement_rules: Vec<String>,
}

/// Health check response.
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub git_sha: &'static str,
    pub execution_lane: &'static str,
    pub provider: String,
    pub model_id: String,
    pub verifying_key_hex: String,
    /// Key id of the signing key: `ed25519:` + hex(SHA-256(raw public key)).
    pub verifying_key_id: String,
    /// Summary of the **default** enforcement policy (for backward compat).
    pub policy_summary: PolicySummary,
    /// All loaded policy hashes (operator-facing, monitoring).
    pub loaded_policy_hashes: Vec<String>,
}

/// Capabilities response.
#[derive(Debug, Serialize)]
pub struct CapabilitiesResponse {
    pub execution_lane: &'static str,
    pub providers: Vec<&'static str>,
    pub purposes: Vec<String>,
    pub entropy_enforcement: &'static str,
    pub receipt_schema_version: &'static str,
    pub enforcement_capabilities: Vec<String>,
    /// All available output schema hashes (client-facing discovery).
    pub available_schema_hashes: Vec<String>,
    /// All available enforcement policy hashes (client-facing discovery).
    pub available_policy_hashes: Vec<String>,
}

// ============================================================================
// Session metadata (dev-only diagnostic endpoint)
// ============================================================================

/// Timing data for session phases. Only populated when SELKEY_ENV=dev.
/// inference_start_at = immediately before provider.call()
/// inference_end_at = full response received (non-streaming)
#[derive(Debug, Clone, Serialize)]
pub struct SessionTiming {
    pub session_created_at: DateTime<Utc>,
    pub initiator_input_at: Option<DateTime<Utc>>,
    pub responder_input_at: Option<DateTime<Utc>>,
    pub inference_start_at: Option<DateTime<Utc>>,
    pub inference_end_at: Option<DateTime<Utc>>,
    pub output_ready_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SessionSizes {
    pub initiator_input_bytes: Option<usize>,
    pub responder_input_bytes: Option<usize>,
    pub output_bytes: Option<usize>,
    pub receipt_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMetadata {
    pub session_id: String,
    pub timing: SessionTiming,
    pub sizes: SessionSizes,
}

impl SessionMetadata {
    pub fn new(session_id: String, created_at: DateTime<Utc>) -> Self {
        Self {
            session_id,
            timing: SessionTiming {
                session_created_at: created_at,
                initiator_input_at: None,
                responder_input_at: None,
                inference_start_at: None,
                inference_end_at: None,
                output_ready_at: None,
            },
            sizes: SessionSizes::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_metadata_serializes() {
        let meta = SessionMetadata::new("test-123".to_string(), Utc::now());
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("test-123"));
        // Verify top-level keys exist
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed.get("timing").is_some());
        assert!(parsed.get("sizes").is_some());
    }
}
