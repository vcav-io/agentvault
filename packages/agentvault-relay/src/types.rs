use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::session::{AbortReason, SessionState};

// ============================================================================
// Core types (shared between single-shot and bilateral)
// ============================================================================

// Contract is now defined in vault-family-types. Re-export for use within crate.
pub use vault_family_types::Contract;

/// One party's input to the relay.
#[derive(Debug, Clone, Deserialize)]
pub struct RelayInput {
    pub role: String,
    pub context: serde_json::Value,
}

/// Tier 2 model profile — describes the provider + model configuration
/// consented to by both parties. Hash is bound into the receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelProfile {
    pub profile_version: String,
    pub profile_id: String,
    pub provider: String,
    pub model_family: String,
    pub reasoning_mode: String,
    pub structured_output: bool,
}

// ============================================================================
// Single-shot relay endpoint (POST /relay)
// ============================================================================

/// Relay request: contract + both party inputs (single-shot).
#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    pub contract: Contract,
    pub input_a: RelayInput,
    pub input_b: RelayInput,
    pub provider: String,
}

/// Relay response: structured output + signed receipt.
#[derive(Debug, Serialize)]
pub struct RelayResponse {
    pub output: serde_json::Value,
    pub receipt: receipt_core::Receipt,
    pub receipt_signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_v2: Option<receipt_core::ReceiptV2>,
}

// ============================================================================
// Bilateral session endpoints
// ============================================================================

/// POST /sessions request body.
#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub contract: Contract,
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
    pub role: String,
    pub context: serde_json::Value,
    /// If provided, the relay verifies this matches the session's contract_hash
    /// before accepting input. Prevents a malicious initiator from creating a
    /// session with a permissive contract while advertising a different hash.
    #[serde(default)]
    pub expected_contract_hash: Option<String>,
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
    pub output: Option<serde_json::Value>,
    pub receipt: Option<receipt_core::Receipt>,
    pub receipt_signature: Option<String>,
    pub receipt_v2: Option<receipt_core::ReceiptV2>,
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
}

// ============================================================================
// Session metadata (dev-only diagnostic endpoint)
// ============================================================================

/// Timing data for session phases. Only populated when AV_ENV=dev.
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
