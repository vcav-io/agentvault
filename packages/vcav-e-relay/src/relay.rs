use chrono::Utc;
use guardian_core::{calculate_schema_entropy_upper_bound, generate_pair_id, BudgetTier};
use receipt_core::{
    BudgetUsageRecord, ExecutionLane, Receipt, ReceiptStatus, SignalClass,
};
use sha2::{Digest, Sha256};

use crate::error::RelayError;
use crate::prompt_program::load_prompt_program;
use crate::provider::anthropic::AnthropicProvider;
use crate::provider::ProviderRequest;
use crate::session::AbortReason;
use crate::types::{Contract, RelayInput, RelayRequest, RelayResponse};
use crate::AppState;

const MAX_TOKENS: u32 = 256;

/// Compute SHA-256 hash of canonical contract JSON for receipt binding.
pub fn compute_contract_hash(contract: &Contract) -> Result<String, RelayError> {
    let canonical = receipt_core::canonicalize_serializable(contract)
        .map_err(|e| RelayError::ContractValidation(format!("contract canonicalization: {e}")))?;
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

/// Validate JSON output against the contract's output schema.
fn validate_output_schema(
    output: &serde_json::Value,
    schema: &serde_json::Value,
) -> Result<(), RelayError> {
    let compiled = jsonschema::JSONSchema::compile(schema)
        .map_err(|e| RelayError::OutputValidation(format!("schema compilation: {e}")))?;

    let result = compiled.validate(output);
    if let Err(errors) = result {
        let msgs: Vec<String> = errors.map(|e| e.to_string()).collect();
        return Err(RelayError::OutputValidation(msgs.join("; ")));
    }
    Ok(())
}

/// Result of core relay execution.
pub struct RelayResult {
    pub output: serde_json::Value,
    pub receipt: Receipt,
    pub receipt_signature: String,
}

/// Core relay logic: validate → assemble → call → check → sign → return.
///
/// Extracted from the single-shot `relay()` function so it can be reused by
/// bilateral session processing.
pub async fn relay_core(
    contract: &Contract,
    input_a: &RelayInput,
    input_b: &RelayInput,
    provider_name: &str,
    state: &AppState,
) -> Result<RelayResult, RelayError> {
    let session_start = Utc::now();

    // 1. Validate provider selection
    if provider_name != "anthropic" {
        return Err(RelayError::ContractValidation(format!(
            "unsupported provider: {provider_name}"
        )));
    }

    // 2. Validate contract has exactly 2 participants
    if contract.participants.len() != 2 {
        return Err(RelayError::ContractValidation(
            "contract must have exactly 2 participants".to_string(),
        ));
    }

    // 3. Compute contract hash
    let contract_hash = compute_contract_hash(contract)?;

    // 4. Load and validate prompt program
    let program =
        load_prompt_program(&state.prompt_program_dir, &contract.prompt_template_hash)?;

    // 5. Assemble provider request
    let assembled = program.assemble(contract, input_a, input_b)?;

    // 6. Call provider
    let provider = AnthropicProvider::new(
        state.anthropic_api_key.clone(),
        state.anthropic_model_id.clone(),
        state.anthropic_base_url.clone(),
    )?;

    let provider_response = provider
        .call(ProviderRequest {
            system: assembled.system,
            user_message: assembled.user_message,
            output_schema: Some(contract.output_schema.clone()),
            max_tokens: MAX_TOKENS,
        })
        .await?;

    // 7. Parse output
    let output: serde_json::Value = serde_json::from_str(&provider_response.text)
        .map_err(|e| RelayError::OutputValidation(format!("output is not valid JSON: {e}")))?;

    // 8. Validate output against schema
    validate_output_schema(&output, &contract.output_schema)?;

    // 9. Compute entropy (advisory — logged but not enforced)
    let entropy_bits = calculate_schema_entropy_upper_bound(&contract.output_schema)
        .map(|v| v as u32)
        .unwrap_or_else(|e| {
            tracing::warn!("entropy calculation failed: {e}; recording 0");
            0
        });

    if let Some(budget) = contract.entropy_budget_bits {
        if entropy_bits > budget {
            tracing::warn!(
                entropy_bits,
                budget,
                "schema entropy exceeds contract budget (advisory only)"
            );
        }
    }

    let session_end = Utc::now();

    // 10. Generate session ID
    let session_id = hex::encode(Sha256::digest(uuid::Uuid::new_v4().as_bytes()));

    // 11. Build budget usage record
    let pair_id = generate_pair_id(
        &contract.participants[0],
        &contract.participants[1],
    );

    let budget_usage = BudgetUsageRecord {
        pair_id,
        window_start: session_start,
        bits_used_before: 0,
        bits_used_after: entropy_bits,
        budget_limit: contract.entropy_budget_bits.unwrap_or(128),
        budget_tier: BudgetTier::Default,
        budget_enforcement: Some("disabled".to_string()),
        compartment_id: None,
    };

    // 12. Build and sign receipt
    let prompt_template_hash = program.content_hash()?;
    let relay_hash = hex::encode(Sha256::digest(b"vcav-e-relay-v0.1.0"));

    let unsigned = Receipt::builder()
        .session_id(session_id)
        .purpose_code(contract.purpose_code)
        .participant_ids(contract.participants.clone())
        .runtime_hash(&relay_hash)
        .guardian_policy_hash(&relay_hash)
        .model_weights_hash(&relay_hash)
        .llama_cpp_version("n/a")
        .inference_config_hash(&relay_hash)
        .output_schema_version("1.0.0")
        .session_start(session_start)
        .session_end(session_end)
        .fixed_window_duration_seconds(0)
        .status(ReceiptStatus::Completed)
        .execution_lane(ExecutionLane::ApiMediated)
        .output(Some(output.clone()))
        .output_entropy_bits(entropy_bits)
        .budget_usage(budget_usage)
        .contract_hash(Some(contract_hash))
        .output_schema_id(Some(contract.output_schema_id.clone()))
        .signal_class(Some(SignalClass::SessionCompleted))
        .entropy_budget_bits_opt(contract.entropy_budget_bits)
        .prompt_template_hash(Some(prompt_template_hash))
        .contract_timing_class(contract.timing_class.clone())
        .model_identity(Some(receipt_core::ModelIdentity {
            provider: "anthropic".to_string(),
            model_id: provider_response.model_id,
            model_version: None,
        }))
        .build_unsigned()
        .ok_or_else(|| {
            RelayError::ReceiptSigning("receipt builder missing required fields".to_string())
        })?;

    let signature = receipt_core::sign_receipt(&unsigned, &state.signing_key)
        .map_err(|e| RelayError::ReceiptSigning(format!("signing failed: {e}")))?;

    let receipt_signature = signature.clone();
    let receipt = unsigned.sign(signature);

    Ok(RelayResult {
        output,
        receipt,
        receipt_signature,
    })
}

/// Map a RelayError to an AbortReason for session state.
pub fn error_to_abort_reason(error: &RelayError) -> AbortReason {
    match error {
        RelayError::OutputValidation(_) => AbortReason::SchemaValidation,
        RelayError::Provider(_) => AbortReason::ProviderError,
        RelayError::ContractValidation(_) => AbortReason::ContractMismatch,
        _ => AbortReason::ProviderError,
    }
}

/// Single-shot relay endpoint handler (POST /relay).
/// Delegates to `relay_core`.
pub async fn relay(request: RelayRequest, state: &AppState) -> Result<RelayResponse, RelayError> {
    let result = relay_core(
        &request.contract,
        &request.input_a,
        &request.input_b,
        &request.provider,
        state,
    )
    .await?;

    Ok(RelayResponse {
        output: result.output,
        receipt: result.receipt,
        receipt_signature: result.receipt_signature,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_contract_hash_deterministic() {
        let contract = Contract {
            purpose_code: guardian_core::Purpose::Mediation,
            output_schema_id: "vault_result_mediation".to_string(),
            output_schema: serde_json::json!({"type": "object"}),
            participants: vec!["alice".to_string(), "bob".to_string()],
            prompt_template_hash: "a".repeat(64),
            entropy_budget_bits: None,
            timing_class: None,
            metadata: serde_json::Value::Null,
        };

        let h1 = compute_contract_hash(&contract).unwrap();
        let h2 = compute_contract_hash(&contract).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn test_validate_output_schema_valid() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "decision": { "type": "string", "enum": ["PROCEED", "DECLINE"] }
            },
            "required": ["decision"],
            "additionalProperties": false
        });

        let output = serde_json::json!({"decision": "PROCEED"});
        assert!(validate_output_schema(&output, &schema).is_ok());
    }

    #[test]
    fn test_validate_output_schema_invalid() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "decision": { "type": "string", "enum": ["PROCEED", "DECLINE"] }
            },
            "required": ["decision"],
            "additionalProperties": false
        });

        let output = serde_json::json!({"decision": "INVALID"});
        assert!(validate_output_schema(&output, &schema).is_err());
    }
}
