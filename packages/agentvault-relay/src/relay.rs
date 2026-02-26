use crate::entropy::calculate_schema_entropy_upper_bound;
use chrono::Utc;
use receipt_core::{BudgetUsageRecord, ExecutionLane, Receipt, ReceiptStatus, SignalClass};
use sha2::{Digest, Sha256};
use vault_family_types::{generate_pair_id, BudgetTier};

use crate::error::RelayError;
use crate::prompt_program::{load_model_profile, load_prompt_program};
use crate::provider::anthropic::AnthropicProvider;
use crate::provider::openai::OpenAIProvider;
use crate::provider::ProviderRequest;
use crate::session::AbortReason;
use crate::types::{Contract, RelayInput, RelayRequest, RelayResponse};
use crate::AppState;

const MAX_TOKENS: u32 = 256;

/// Git commit SHA embedded at build time by build.rs.
/// Falls back to "unknown" in environments where .git/ is not present.
const GIT_SHA: &str = env!("VCAV_GIT_SHA");

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

/// Returns true if the character is a Unicode currency symbol (general category Sc).
///
/// Inline check to avoid adding a dependency for ~60 codepoints.
/// Source: Unicode 15.1 Sc category. Covers common currency signs used in
/// financial contexts (£, $, €, ¥, ₹, etc.).
fn is_currency_symbol(c: char) -> bool {
    matches!(c,
        '\u{0024}'          // $ DOLLAR SIGN
        | '\u{00A2}'..='\u{00A5}' // ¢ £ ¤ ¥
        | '\u{058F}'        // ֏ ARMENIAN DRAM
        | '\u{060B}'        // ﷋ AFGHANI SIGN
        | '\u{07FE}'..='\u{07FF}' // NKO DOROME / TAMAN signs
        | '\u{09F3}'        // ৳ BENGALI RUPEE
        | '\u{09FB}'        // ৻ BENGALI GANDA
        | '\u{0AF1}'        // ૱ GUJARATI RUPEE
        | '\u{0BF9}'        // ௹ TAMIL RUPEE
        | '\u{0E3F}'        // ฿ THAI BAHT
        | '\u{17DB}'        // ៛ KHMER CURRENCY
        | '\u{20A0}'..='\u{20C0}' // Currency Symbols block (₠ through ⃀)
        | '\u{A838}'        // ꠸ NORTH INDIC RUPEE
        | '\u{FDFC}'        // ﷼ RIAL SIGN
        | '\u{FE69}'        // ﹩ SMALL DOLLAR
        | '\u{FF04}'        // ＄ FULLWIDTH DOLLAR
        | '\u{FFE0}'..='\u{FFE1}' // ￠ ￡ FULLWIDTH CENT/POUND
        | '\u{FFE5}'..='\u{FFE6}' // ￥ ￦ FULLWIDTH YEN/WON
        | '\u{11FDD}'..='\u{11FE0}' // Tamil fraction/cash signs
        | '\u{1E2FF}'       // WANCHO NGUN
        | '\u{1ECB0}'       // INDIC SIYAQ RUPEE
    )
}

/// GATE rule: reject output if any string value contains Unicode numeric characters
/// (category Nd) or currency symbols (category Sc).
///
/// **Threat model**: This is a defense-in-depth backstop / schema regression detector,
/// not the primary privacy control. The primary control is the all-enum schema with
/// `additionalProperties: false`. This guard fires only if the schema is misconfigured,
/// weakened, or a provider structured-output bug bypasses enum constraints.
///
/// **Scope**: Scans JSON string values only. JSON number literals (e.g. `{"confidence": 3}`)
/// are NOT checked — schema validation runs first and rejects non-string types where
/// string enums are expected. If the schema is later weakened to allow numeric types,
/// this guard will NOT catch numeric-typed values. The `test_schema_rejects_numeric_literal_before_gate`
/// test regression-proofs this assumption.
///
/// **Phase 1 only**: Scoped to `vcav_e_compatibility_signal_v2` via hardcoded schema ID.
/// Will migrate to PolicyBundle configuration in Phase 2.
fn validate_output_policy_gate(
    output: &serde_json::Value,
    output_schema_id: &str,
) -> Result<(), RelayError> {
    if output_schema_id != "vcav_e_compatibility_signal_v2" {
        return Ok(());
    }

    // At the top level, skip `schema_version` — it is a structural metadata field
    // constrained to a single-value enum (e.g. ["2"]) with 0 bits of entropy.
    // This matches the verify.sh post-hoc check behavior (line 406).
    if let serde_json::Value::Object(map) = output {
        for (key, value) in map {
            if key == "schema_version" {
                continue;
            }
            if json_strings_contain_forbidden(value) {
                tracing::warn!(
                    gate = "digit_currency",
                    output_schema_id,
                    "policy gate rejected output"
                );
                return Err(RelayError::PolicyGate("digit_currency_gate".into()));
            }
        }
    }

    Ok(())
}

/// Recursively check if any string value in the JSON contains forbidden characters
/// (Unicode numeric or currency symbols).
fn json_strings_contain_forbidden(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(s) => s.chars().any(|c| c.is_numeric() || is_currency_symbol(c)),
        serde_json::Value::Array(arr) => arr.iter().any(json_strings_contain_forbidden),
        serde_json::Value::Object(map) => map.values().any(json_strings_contain_forbidden),
        _ => false,
    }
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

    // 1. Validate contract has exactly 2 participants
    if contract.participants.len() != 2 {
        return Err(RelayError::ContractValidation(
            "contract must have exactly 2 participants".to_string(),
        ));
    }

    // 2. Compute contract hash
    let contract_hash = compute_contract_hash(contract)?;

    // 3. Load and validate prompt program
    let program = load_prompt_program(&state.prompt_program_dir, &contract.prompt_template_hash)?;

    // 4. Assemble provider request
    let assembled = program.assemble(contract, input_a, input_b)?;

    let provider_request = ProviderRequest {
        system: assembled.system,
        user_message: assembled.user_message,
        output_schema: Some(contract.output_schema.clone()),
        max_tokens: MAX_TOKENS,
    };

    // 5. Call provider
    let provider_response = match provider_name {
        "anthropic" => {
            let provider = AnthropicProvider::new(
                state.anthropic_api_key.clone(),
                state.anthropic_model_id.clone(),
                state.anthropic_base_url.clone(),
            )?;
            provider.call(provider_request).await?
        }
        "openai" => {
            let api_key = state.openai_api_key.clone().ok_or_else(|| {
                RelayError::ContractValidation("OpenAI API key not configured".to_string())
            })?;
            let provider = OpenAIProvider::new(
                api_key,
                state.openai_model_id.clone(),
                state.openai_base_url.clone(),
            )?;
            provider.call(provider_request).await?
        }
        _ => {
            return Err(RelayError::ContractValidation(format!(
                "unsupported provider: {provider_name}"
            )));
        }
    };

    // 7. Parse output
    let output: serde_json::Value = serde_json::from_str(&provider_response.text)
        .map_err(|e| RelayError::OutputValidation(format!("output is not valid JSON: {e}")))?;

    // 8. Validate output against schema
    validate_output_schema(&output, &contract.output_schema)?;

    // 8b. Policy gate: reject forbidden characters in string values (GATE rule)
    validate_output_policy_gate(&output, &contract.output_schema_id)?;

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
    let pair_id = generate_pair_id(&contract.participants[0], &contract.participants[1]);

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
    // runtime_hash: real git SHA embedded at build time by build.rs
    let runtime_hash = hex::encode(Sha256::digest(GIT_SHA.as_bytes()));
    // model_weights_hash: honest "n/a" — relay is API-mediated; no local weights
    let model_weights_hash = hex::encode(Sha256::digest(b"api-mediated-no-local-weights"));
    // inference_config_hash: honest "n/a" — relay is API-mediated; no local inference
    let inference_config_hash = hex::encode(Sha256::digest(b"api-mediated-no-local-inference"));
    let guardian_policy_hash = hex::encode(Sha256::digest(b"guardian-core-v0.1.0"));

    // Load model profile hash if contract specifies one
    let model_profile_hash = match &contract.model_profile_id {
        Some(profile_id) => {
            let profile = load_model_profile(&state.prompt_program_dir, profile_id)?;
            Some(profile.content_hash()?)
        }
        None => None,
    };

    let unsigned = Receipt::builder()
        .session_id(session_id)
        .purpose_code(contract.purpose_code)
        .participant_ids(contract.participants.clone())
        .runtime_hash(&runtime_hash)
        .guardian_policy_hash(&guardian_policy_hash)
        .model_weights_hash(&model_weights_hash)
        .llama_cpp_version("n/a")
        .inference_config_hash(&inference_config_hash)
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
        .model_profile_hash(model_profile_hash)
        .model_identity(Some(receipt_core::ModelIdentity {
            provider: provider_name.to_string(),
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
        RelayError::PolicyGate(_) => AbortReason::PolicyGate,
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
            purpose_code: vault_family_types::Purpose::Mediation,
            output_schema_id: "vault_result_mediation".to_string(),
            output_schema: serde_json::json!({"type": "object"}),
            participants: vec!["alice".to_string(), "bob".to_string()],
            prompt_template_hash: "a".repeat(64),
            entropy_budget_bits: None,
            timing_class: None,
            metadata: serde_json::Value::Null,
            model_profile_id: None,
        };

        let h1 = compute_contract_hash(&contract).unwrap();
        let h2 = compute_contract_hash(&contract).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn test_model_profile_hash_deterministic() {
        use crate::prompt_program::load_model_profile;
        use crate::types::ModelProfile;

        let dir = std::env::temp_dir().join("vcav-e-relay-test-profile-hash");
        std::fs::create_dir_all(&dir).unwrap();

        let profile = ModelProfile {
            profile_version: "1".to_string(),
            profile_id: "test-profile-v1".to_string(),
            provider: "anthropic".to_string(),
            model_family: "claude-sonnet".to_string(),
            reasoning_mode: "unconstrained".to_string(),
            structured_output: true,
        };

        let path = dir.join("test-profile-v1.json");
        std::fs::write(&path, serde_json::to_string(&profile).unwrap()).unwrap();

        let loaded = load_model_profile(dir.to_str().unwrap(), "test-profile-v1").unwrap();
        let h1 = loaded.content_hash().unwrap();
        let h2 = loaded.content_hash().unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_model_profile_bound_in_receipt() {
        use crate::types::ModelProfile;
        use chrono::Utc;
        use receipt_core::{BudgetUsageRecord, ExecutionLane, Receipt, ReceiptStatus};
        use sha2::{Digest, Sha256};
        use vault_family_types::BudgetTier;

        let profile = ModelProfile {
            profile_version: "1".to_string(),
            profile_id: "receipt-test-profile-v1".to_string(),
            provider: "anthropic".to_string(),
            model_family: "claude-sonnet".to_string(),
            reasoning_mode: "unconstrained".to_string(),
            structured_output: true,
        };

        // Hash the profile directly without file system
        let profile_hash = profile.content_hash().unwrap();

        // Build a receipt with model_profile_hash
        let runtime_hash = hex::encode(Sha256::digest(GIT_SHA.as_bytes()));
        let guardian_hash = hex::encode(Sha256::digest(b"guardian-core-v0.1.0"));
        let model_weights_hash = hex::encode(Sha256::digest(b"api-mediated-no-local-weights"));
        let inference_config_hash = hex::encode(Sha256::digest(b"api-mediated-no-local-inference"));

        let now = Utc::now();
        let unsigned = Receipt::builder()
            .session_id("a".repeat(64))
            .purpose_code(vault_family_types::Purpose::Mediation)
            .participant_ids(vec!["alice".to_string(), "bob".to_string()])
            .runtime_hash(&runtime_hash)
            .guardian_policy_hash(&guardian_hash)
            .model_weights_hash(&model_weights_hash)
            .llama_cpp_version("n/a")
            .inference_config_hash(&inference_config_hash)
            .output_schema_version("1.0.0")
            .session_start(now)
            .session_end(now)
            .fixed_window_duration_seconds(0)
            .status(ReceiptStatus::Completed)
            .execution_lane(ExecutionLane::ApiMediated)
            .output_entropy_bits(6)
            .budget_usage(BudgetUsageRecord {
                pair_id: "b".repeat(64),
                window_start: now,
                bits_used_before: 0,
                bits_used_after: 6,
                budget_limit: 128,
                budget_tier: BudgetTier::Default,
                budget_enforcement: Some("disabled".to_string()),
                compartment_id: None,
            })
            .model_profile_hash(Some(profile_hash.clone()))
            .build_unsigned()
            .expect("receipt builder should succeed");

        assert_eq!(unsigned.model_profile_hash, Some(profile_hash));
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

    #[test]
    fn test_validate_output_schema_rejects_max_length() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "compatibility_signal": { "type": "string", "enum": ["STRONG_MATCH", "PARTIAL_MATCH", "WEAK_MATCH", "NO_MATCH"] },
                "overlap_summary": { "type": "string", "maxLength": 100 }
            },
            "required": ["compatibility_signal", "overlap_summary"],
            "additionalProperties": false
        });

        let long_summary = "x".repeat(110);
        let output = serde_json::json!({
            "compatibility_signal": "STRONG_MATCH",
            "overlap_summary": long_summary
        });
        let err = validate_output_schema(&output, &schema).unwrap_err();
        assert!(err.to_string().contains("longer than 100 characters"));
    }

    #[test]
    fn test_validate_output_schema_accepts_within_max_length() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "compatibility_signal": { "type": "string", "enum": ["STRONG_MATCH", "PARTIAL_MATCH", "WEAK_MATCH", "NO_MATCH"] },
                "overlap_summary": { "type": "string", "maxLength": 100 }
            },
            "required": ["compatibility_signal", "overlap_summary"],
            "additionalProperties": false
        });

        let short_summary = "x".repeat(99);
        let output = serde_json::json!({
            "compatibility_signal": "PARTIAL_MATCH",
            "overlap_summary": short_summary
        });
        assert!(validate_output_schema(&output, &schema).is_ok());
    }

    #[test]
    fn test_contract_with_model_profile_id_optional() {
        // Contract without model_profile_id should deserialize fine (backward compat)
        let json = serde_json::json!({
            "purpose_code": "MEDIATION",
            "output_schema_id": "vault_result_mediation",
            "output_schema": {"type": "object"},
            "participants": ["alice", "bob"],
            "prompt_template_hash": "a".repeat(64)
        });
        let contract: Contract = serde_json::from_value(json).unwrap();
        assert!(contract.model_profile_id.is_none());

        // Contract with model_profile_id should deserialize with value
        let json_with_profile = serde_json::json!({
            "purpose_code": "MEDIATION",
            "output_schema_id": "vault_result_mediation",
            "output_schema": {"type": "object"},
            "participants": ["alice", "bob"],
            "prompt_template_hash": "a".repeat(64),
            "model_profile_id": "api-claude-sonnet-v1"
        });
        let contract_with_profile: Contract = serde_json::from_value(json_with_profile).unwrap();
        assert_eq!(
            contract_with_profile.model_profile_id,
            Some("api-claude-sonnet-v1".to_string())
        );
    }

    // ========================================================================
    // Policy gate tests (digit/currency guard)
    // ========================================================================

    const COMPAT_V2_SCHEMA_ID: &str = "vcav_e_compatibility_signal_v2";

    #[test]
    fn test_policy_gate_rejects_digits() {
        let output = serde_json::json!({
            "compatibility_signal": "STRONG_MATCH_42"
        });
        let err = validate_output_policy_gate(&output, COMPAT_V2_SCHEMA_ID).unwrap_err();
        assert!(matches!(err, RelayError::PolicyGate(_)));
    }

    #[test]
    fn test_policy_gate_rejects_unicode_digits() {
        // Fullwidth digit zero: U+FF10
        let output = serde_json::json!({
            "compatibility_signal": "MATCH\u{FF10}"
        });
        let err = validate_output_policy_gate(&output, COMPAT_V2_SCHEMA_ID).unwrap_err();
        assert!(matches!(err, RelayError::PolicyGate(_)));
    }

    #[test]
    fn test_policy_gate_rejects_currency() {
        for symbol in ["£", "$", "€"] {
            let output = serde_json::json!({
                "compatibility_signal": format!("MATCH{symbol}")
            });
            let err = validate_output_policy_gate(&output, COMPAT_V2_SCHEMA_ID).unwrap_err();
            assert!(
                matches!(err, RelayError::PolicyGate(_)),
                "should reject currency symbol: {symbol}"
            );
        }
    }

    #[test]
    fn test_policy_gate_rejects_digit_in_array() {
        let output = serde_json::json!({
            "compatibility_signal": "STRONG_MATCH",
            "primary_reasons": ["SECTOR_MATCH", "SIZE_7K"]
        });
        let err = validate_output_policy_gate(&output, COMPAT_V2_SCHEMA_ID).unwrap_err();
        assert!(matches!(err, RelayError::PolicyGate(_)));
    }

    #[test]
    fn test_policy_gate_accepts_clean_enum() {
        let output = serde_json::json!({
            "schema_version": "2",
            "compatibility_signal": "STRONG_MATCH",
            "thesis_fit": "ALIGNED",
            "size_fit": "WITHIN_BAND",
            "stage_fit": "ALIGNED",
            "confidence": "HIGH",
            "primary_reasons": ["SECTOR_MATCH", "SIZE_COMPATIBLE"],
            "blocking_reasons": [],
            "next_step": "PROCEED"
        });
        assert!(validate_output_policy_gate(&output, COMPAT_V2_SCHEMA_ID).is_ok());
    }

    #[test]
    fn test_policy_gate_ignores_non_compat() {
        let output = serde_json::json!({
            "decision": "PROCEED_42",
            "amount": "$100"
        });
        // Non-COMPAT v2 schema: gate does not fire
        assert!(validate_output_policy_gate(&output, "vault_result_mediation").is_ok());
    }

    #[test]
    fn test_schema_rejects_numeric_literal_before_gate() {
        // Proves the invariant: schema validation catches numeric types before
        // the policy gate runs. If this test ever fails, the schema has been
        // weakened and the policy gate has a gap for numeric-typed values.
        let compat_v2_schema = serde_json::json!({
            "type": "object",
            "properties": {
                "schema_version": { "type": "string", "enum": ["2"] },
                "compatibility_signal": {
                    "type": "string",
                    "enum": ["STRONG_MATCH", "PARTIAL_MATCH", "WEAK_MATCH", "NO_MATCH"]
                },
                "thesis_fit": {
                    "type": "string",
                    "enum": ["ALIGNED", "PARTIAL", "MISALIGNED", "UNKNOWN"]
                },
                "size_fit": {
                    "type": "string",
                    "enum": ["WITHIN_BAND", "TOO_LOW", "TOO_HIGH", "UNKNOWN"]
                },
                "stage_fit": {
                    "type": "string",
                    "enum": ["ALIGNED", "PARTIAL", "MISALIGNED", "UNKNOWN"]
                },
                "confidence": {
                    "type": "string",
                    "enum": ["HIGH", "MEDIUM", "LOW"]
                },
                "primary_reasons": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["SECTOR_MATCH", "SIZE_COMPATIBLE", "STAGE_COMPATIBLE",
                                 "GEOGRAPHIC_PROXIMITY", "EXPERIENCE_RELEVANCE", "TIMELINE_COMPATIBLE"]
                    },
                    "minItems": 0, "maxItems": 3, "uniqueItems": true
                },
                "blocking_reasons": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["SIZE_INCOMPATIBLE", "SECTOR_MISMATCH", "STAGE_MISMATCH",
                                 "GEOGRAPHY_MISMATCH", "TIMELINE_CONFLICT", "STRUCTURE_INCOMPATIBLE"]
                    },
                    "minItems": 0, "maxItems": 2, "uniqueItems": true
                },
                "next_step": {
                    "type": "string",
                    "enum": ["PROCEED", "PROCEED_WITH_CAVEATS", "ASK_FOR_PUBLIC_INFO", "DO_NOT_PROCEED"]
                }
            },
            "required": ["schema_version", "compatibility_signal", "thesis_fit", "size_fit",
                         "stage_fit", "confidence", "primary_reasons", "blocking_reasons", "next_step"],
            "additionalProperties": false
        });

        // Output with a JSON number literal where a string enum is expected
        let output_with_number = serde_json::json!({
            "schema_version": "2",
            "compatibility_signal": "STRONG_MATCH",
            "thesis_fit": "ALIGNED",
            "size_fit": "WITHIN_BAND",
            "stage_fit": "ALIGNED",
            "confidence": 3,
            "primary_reasons": ["SECTOR_MATCH"],
            "blocking_reasons": [],
            "next_step": "PROCEED"
        });

        let err = validate_output_schema(&output_with_number, &compat_v2_schema);
        assert!(
            err.is_err(),
            "schema validation must reject numeric literal in enum field"
        );
    }
}
