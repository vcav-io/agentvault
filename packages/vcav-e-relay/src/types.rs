use guardian_core::Purpose;
use serde::{Deserialize, Serialize};

/// Relay request: contract + both party inputs.
#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    pub contract: Contract,
    pub input_a: RelayInput,
    pub input_b: RelayInput,
    pub provider: String,
}

/// One party's input to the relay.
#[derive(Debug, Deserialize)]
pub struct RelayInput {
    pub role: String,
    pub context: serde_json::Value,
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
}

/// Relay response: structured output + signed receipt.
#[derive(Debug, Serialize)]
pub struct RelayResponse {
    pub output: serde_json::Value,
    pub receipt: receipt_core::Receipt,
    pub receipt_signature: String,
}

/// Health check response.
#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
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
