use serde::{Deserialize, Serialize};
use vault_family_types::Purpose;

use crate::session::{AbortReason, SessionState};

// ============================================================================
// Core types (shared between single-shot and bilateral)
// ============================================================================

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

/// Contract describing the session terms.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contract {
    pub purpose_code: Purpose,
    pub output_schema_id: String,
    pub output_schema: serde_json::Value,
    pub participants: Vec<String>,
    pub prompt_template_hash: String,
    #[serde(default)]
    pub entropy_budget_bits: Option<u32>,
    #[serde(default)]
    pub timing_class: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub model_profile_id: Option<String>,
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
    "anthropic".to_string()
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
}

// ============================================================================
// Health and capabilities
// ============================================================================

/// Health check response.
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub git_sha: &'static str,
    pub execution_lane: &'static str,
}

/// Capabilities response.
#[derive(Debug, Serialize)]
pub struct CapabilitiesResponse {
    pub execution_lane: &'static str,
    pub providers: Vec<&'static str>,
    pub purposes: Vec<String>,
    pub entropy_enforcement: &'static str,
    pub receipt_schema_version: &'static str,
}
