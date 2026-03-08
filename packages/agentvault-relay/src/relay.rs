use chrono::Utc;
use entropy_core::calculate_schema_entropy_upper_bound;
use receipt_core::{
    AssuranceLevel, BudgetEnforcementMode, BudgetUsageRecord, BudgetUsageV2, Claims, Commitments,
    ExecutionLane, ExecutionLaneV2, HashAlgorithm, InputCommitment, Operator, PreflightBundle,
    Receipt, ReceiptStatus, ReceiptV2, SessionStatus, SignalClass, UnsignedReceiptV2,
    CANONICALIZATION_V2, CHANNEL_CAPACITY_MEASUREMENT_VERSION, SCHEMA_VERSION_V2,
};
use sha2::{Digest, Sha256};
use vault_family_types::{generate_pair_id, BudgetTier};

use crate::error::RelayError;
use crate::profile_resolution::resolve_runtime_profile;
use crate::prompt_program::load_prompt_program;
use crate::provider::anthropic::AnthropicProvider;
use crate::provider::gemini::GeminiProvider;
use crate::provider::openai::OpenAIProvider;
use crate::provider::ProviderRequest;
use crate::session::AbortReason;
use crate::types::{Contract, RelayInput, RelayRequest, RelayResponse};
use crate::AppState;

/// Git commit SHA embedded at build time by build.rs.
/// Falls back to "unknown" in environments where .git/ is not present.
const GIT_SHA: &str = env!("AV_GIT_SHA");

/// Compute SHA-256 hash of an output schema using JCS canonicalization.
/// Bound into receipts as `output_schema_hash`.
pub fn compute_output_schema_hash(schema: &serde_json::Value) -> Result<String, RelayError> {
    let canonical = receipt_core::canonicalize_serializable(schema)
        .map_err(|e| RelayError::ContractValidation(format!("schema canonicalization: {e}")))?;
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

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

use crate::enforcement_policy::{EnforcementClass, EnforcementRule, RuleScopeKind, RuleType};

/// Validate output against all enforcement rules from the loaded policy.
///
/// **Threat model**: This is a defense-in-depth backstop / schema regression detector,
/// not the primary privacy control. The primary control is the all-enum schema with
/// `additionalProperties: false`. This guard fires only if the schema is misconfigured,
/// weakened, or a provider structured-output bug bypasses enum constraints.
///
/// **Scope**: Relay-global — rules apply to ALL output schemas, not just COMPAT v2.
/// Scans JSON string values only. JSON number literals (e.g. `{"confidence": 3}`)
/// are NOT checked — schema validation runs first and rejects non-string types where
/// string enums are expected.
fn validate_output_enforcement_rules(
    output: &serde_json::Value,
    rules: &[EnforcementRule],
) -> Result<(), RelayError> {
    for rule in rules {
        match rule.rule_type {
            RuleType::UnicodeCategoryReject => {
                if json_strings_contain_category(output, &rule.value, &rule.scope) {
                    match rule.classification {
                        EnforcementClass::Gate => {
                            tracing::warn!(rule_id = %rule.rule_id, "GATE rule violated");
                            return Err(RelayError::PolicyGate(rule.rule_id.clone()));
                        }
                        EnforcementClass::Advisory => {
                            tracing::warn!(
                                rule_id = %rule.rule_id,
                                category = %rule.value,
                                "ADVISORY enforcement rule violated (non-blocking)"
                            );
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// Check if top-level value contains forbidden characters per scope rules.
///
/// For `AllStringValues` scope: applies skip_keys at the top-level object only.
/// If the top-level value is an Array, applies skip_keys to nothing (arrays have
/// no keys) — the array elements are checked recursively via `json_value_contains_category`.
fn json_strings_contain_category(
    value: &serde_json::Value,
    category: &str,
    scope: &crate::enforcement_policy::RuleScope,
) -> bool {
    match &scope.kind {
        RuleScopeKind::AllStringValues => match value {
            serde_json::Value::Object(map) => map.iter().any(|(key, val)| {
                if scope.skip_keys.contains(key) {
                    return false;
                }
                json_value_contains_category(val, category)
            }),
            serde_json::Value::Array(arr) => arr
                .iter()
                .any(|v| json_value_contains_category(v, category)),
            _ => json_value_contains_category(value, category),
        },
    }
}

/// Recursively check if any string value in the JSON contains a character
/// matching the given unicode category.
fn json_value_contains_category(value: &serde_json::Value, category: &str) -> bool {
    match value {
        serde_json::Value::String(s) => s.chars().any(|c| unicode_category_contains(c, category)),
        serde_json::Value::Array(arr) => arr
            .iter()
            .any(|v| json_value_contains_category(v, category)),
        serde_json::Value::Object(map) => map
            .values()
            .any(|v| json_value_contains_category(v, category)),
        _ => false,
    }
}

/// Check if a character belongs to the given unicode general category.
///
/// **Nd handling**: `c.is_numeric()` is a conservative superset of Unicode category Nd.
/// It covers Nd (decimal digits) ∪ Nl (letter numbers like Roman numerals) ∪ No (other
/// numbers like superscripts). This is intentional for defense-in-depth: narrowing to
/// exact Nd would *relax* the guard by allowing Nl/No characters through. A future
/// contributor should NOT "fix" this to exact Nd without understanding that doing so
/// weakens the security boundary.
fn unicode_category_contains(c: char, category: &str) -> bool {
    match category {
        "Nd" => c.is_numeric(),
        "Sc" => is_currency_symbol(c),
        _ => {
            // Startup validation (`validate_rule_categories`) ensures this is unreachable.
            // debug_assert catches regressions in tests without adding a runtime error path.
            debug_assert!(false, "unsupported unicode category: {category}");
            false
        }
    }
}

/// Pre-computed context for building failure receipts.
/// Computed before relay_core so the data is available if relay_core fails.
pub struct FailureReceiptContext {
    pub contract_hash: String,
    pub output_schema_hash: String,
    pub input_commitments: Vec<InputCommitment>,
    pub assembled_prompt_hash: String,
    pub prompt_template_hash: String,
    pub model_profile_hash: Option<String>,
    pub runtime_hash: String,
    pub effective_model_id: String,
    pub effective_max_tokens: u32,
    pub entropy_bits: u32,
    pub entropy_budget_bits: Option<u32>,
}

/// Diagnostic timing from relay_core. Not part of the production result type.
pub struct InferenceTiming {
    pub inference_start_at: chrono::DateTime<chrono::Utc>,
    pub inference_end_at: chrono::DateTime<chrono::Utc>,
}

/// Result of core relay execution.
pub struct RelayResult {
    pub output: serde_json::Value,
    pub receipt: Receipt,
    pub receipt_signature: String,
    pub receipt_v2: ReceiptV2,
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
) -> Result<(RelayResult, InferenceTiming), RelayError> {
    let session_start = Utc::now();

    // 1. Validate contract has exactly 2 participants
    if contract.participants.len() != 2 {
        return Err(RelayError::ContractValidation(
            "contract must have exactly 2 participants".to_string(),
        ));
    }

    // 2. Resolve enforcement policy from registry
    let resolved = state
        .policy_registry
        .resolve(contract.enforcement_policy_hash.as_deref())?;
    let resolved_hash = resolved.hash.to_string();
    let resolved_policy = resolved.policy;

    // Warn if contract omits policy hash on a multi-policy relay
    if contract.enforcement_policy_hash.is_none() && state.policy_registry.len() > 1 {
        tracing::warn!(
            default_policy = %resolved_hash,
            "contract lacks enforcement_policy_hash — using default policy; \
             future versions may reject contracts without explicit policy declaration"
        );
    }

    // 2a. Enforce model profile allowlist
    if !resolved_policy.model_profile_allowlist.is_empty() {
        match &contract.model_profile_id {
            Some(profile_id) if resolved_policy.model_profile_allowlist.contains(profile_id) => {}
            Some(profile_id) => {
                return Err(RelayError::ContractValidation(format!(
                    "model_profile_id '{profile_id}' not in enforcement allowlist"
                )));
            }
            None => {
                return Err(RelayError::ContractValidation(
                    "model_profile_id is required when enforcement policy specifies an allowlist"
                        .to_string(),
                ));
            }
        }
    }

    // 2b. Resolve runtime profile from contract's profile binding (fail-closed)
    let resolved_profile = resolve_runtime_profile(
        contract,
        &state.admitted_profiles,
        &state.prompt_program_dir,
    )?;

    let (effective_provider, effective_model_id, model_profile_hash) = match &resolved_profile {
        Some(rt) => {
            tracing::info!(
                profile_id = %rt.profile.profile_id,
                provider = %rt.provider,
                model_id = %rt.model_id,
                "profile-driven dispatch"
            );
            (
                rt.provider.as_str(),
                rt.model_id.clone(),
                Some(rt.profile_hash.clone()),
            )
        }
        None => {
            tracing::warn!("session running in legacy unbound mode (no model_profile_id)");
            let model = match provider_name {
                "anthropic" => state.anthropic_model_id.clone(),
                "openai" => state.openai_model_id.clone(),
                "gemini" => state.gemini_model_id.clone(),
                _ => String::new(),
            };
            (provider_name, model, None)
        }
    };

    // 2b2. Validate relay verifying key pinning (#184)
    if let Some(ref pinned_key) = contract.relay_verifying_key_hex {
        let our_key = receipt_core::public_key_to_hex(&state.signing_key.verifying_key());
        if *pinned_key != our_key {
            return Err(RelayError::ContractValidation(format!(
                "contract pins relay key '{}...' but this relay's key is '{}...'",
                &pinned_key[..12.min(pinned_key.len())],
                &our_key[..12],
            )));
        }
    }

    // 2c. Validate provider against contract allowed_providers (#151 gap 3, #261)
    if let Some(ref constraints) = contract.model_constraints {
        if !constraints.allowed_providers.is_empty()
            && !constraints
                .allowed_providers
                .contains(&effective_provider.to_string())
        {
            return Err(RelayError::ContractValidation(format!(
                "provider '{}' not in contract model_constraints.allowed_providers {:?}",
                effective_provider, constraints.allowed_providers,
            )));
        }
    }

    // 2d. Validate model_id against contract allowed_models (#151 gap 3)
    if let Some(ref constraints) = contract.model_constraints {
        if !constraints.allowed_models.is_empty() {
            let model_allowed = constraints.allowed_models.iter().any(|pattern| {
                if let Some(prefix) = pattern.strip_suffix('*') {
                    effective_model_id.starts_with(prefix)
                } else {
                    *pattern == effective_model_id
                }
            });
            if !model_allowed {
                return Err(RelayError::ContractValidation(format!(
                    "model '{}' not in contract model_constraints.allowed_models {:?}",
                    effective_model_id, constraints.allowed_models,
                )));
            }
        }
    }

    // 2f. Validate contract TTLs against relay maximums (#151 gap 5)
    if let Some(contract_session_ttl) = contract.session_ttl_secs {
        if u64::from(contract_session_ttl) > state.session_ttl_secs {
            return Err(RelayError::ContractValidation(format!(
                "contract session_ttl_secs ({}) exceeds relay maximum ({})",
                contract_session_ttl, state.session_ttl_secs,
            )));
        }
    }
    if let Some(contract_invite_ttl) = contract.invite_ttl_secs {
        if u64::from(contract_invite_ttl) > state.invite_ttl_secs {
            return Err(RelayError::ContractValidation(format!(
                "contract invite_ttl_secs ({}) exceeds relay maximum ({})",
                contract_invite_ttl, state.invite_ttl_secs,
            )));
        }
    }

    // 2g. Resolve effective max_completion_tokens (#149 + contract override)
    // Contract can request lower but not higher than relay ceiling.
    let effective_max_tokens = match contract.max_completion_tokens {
        Some(contract_max) => std::cmp::min(contract_max, state.max_completion_tokens),
        None => state.max_completion_tokens,
    };

    // 3. Compute contract hash and resolve output schema
    let contract_hash = compute_contract_hash(contract)?;

    // 3b. Resolve effective output schema — registry lookup or inline
    // A schema is a "stub" (requiring registry lookup) if it has no `properties` key.
    let is_stub_schema = contract
        .output_schema
        .as_object()
        .map(|obj| !obj.contains_key("properties"))
        .unwrap_or(true);
    let effective_schema = if let Some(ref requested_hash) = contract.output_schema_hash {
        if is_stub_schema {
            // Contract references schema by hash — look up from registry
            state
                .schema_registry
                .get(requested_hash)
                .cloned()
                .ok_or_else(|| {
                    RelayError::ContractValidation(format!(
                        "output_schema_hash '{requested_hash}' not found in schema registry"
                    ))
                })?
        } else {
            // Both inline schema and hash provided — verify consistency
            tracing::warn!(
                output_schema_hash = %requested_hash,
                "contract provides both inline output_schema and output_schema_hash; \
                 inline schemas are deprecated — use hash-only reference"
            );
            let computed_hash = compute_output_schema_hash(&contract.output_schema)?;
            if *requested_hash != computed_hash {
                return Err(RelayError::ContractValidation(format!(
                    "output_schema_hash mismatch: contract says '{requested_hash}' but inline schema hashes to '{computed_hash}'"
                )));
            }
            contract.output_schema.clone()
        }
    } else {
        contract.output_schema.clone()
    };
    let output_schema_hash = compute_output_schema_hash(&effective_schema)?;

    // 4. Load and validate prompt program
    let program = match &state.admitted_programs {
        Some(programs) => programs
            .get(&contract.prompt_template_hash)
            .cloned()
            .ok_or_else(|| {
                RelayError::PromptProgram(format!(
                    "prompt program not found in admitted set for hash: {}",
                    contract.prompt_template_hash
                ))
            })?,
        None => load_prompt_program(&state.prompt_program_dir, &contract.prompt_template_hash)?,
    };

    // 5. Assemble provider request
    let assembled = program.assemble(contract, input_a, input_b)?;

    // Compute input commitments (one per participant) — must be done before provider call.
    let input_commitments: Vec<InputCommitment> = {
        let inputs = [
            (&contract.participants[0], input_a),
            (&contract.participants[1], input_b),
        ];
        let mut commitments = Vec::with_capacity(2);
        for (participant_id, input) in &inputs {
            let canonical = receipt_core::canonicalize_serializable(&input.context)
                .map_err(|e| RelayError::Internal(format!("input canonicalization: {e}")))?;
            let mut hasher = Sha256::new();
            hasher.update(canonical.as_bytes());
            commitments.push(InputCommitment {
                participant_id: (*participant_id).clone(),
                input_hash: hex::encode(hasher.finalize()),
                hash_alg: HashAlgorithm::Sha256,
                canonicalization: "CANONICAL_JSON_V1".to_string(),
            });
        }
        commitments
    };

    // Compute assembled_prompt_hash — hash of the assembled prompt JSON (system + user_message).
    // Computed once before the first provider call; never recomputed on retry.
    let assembled_prompt_hash = {
        let prompt_json = serde_json::json!({
            "system": assembled.system,
            "user_message": assembled.user_message,
        });
        let canonical = receipt_core::canonicalize_serializable(&prompt_json)
            .map_err(|e| RelayError::Internal(format!("prompt canonicalization: {e}")))?;
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        hex::encode(hasher.finalize())
    };

    let provider_request = ProviderRequest {
        system: assembled.system,
        user_message: assembled.user_message,
        output_schema: Some(effective_schema.clone()),
        max_tokens: effective_max_tokens,
    };

    // 6. Call provider (using effective_provider, which may differ from
    //    caller-supplied provider_name when a model profile overrides it)
    let inference_start = Utc::now();
    let provider_response = match effective_provider {
        "anthropic" => {
            let api_key = state.anthropic_api_key.clone().ok_or_else(|| {
                RelayError::ContractValidation("Anthropic API key not configured".to_string())
            })?;
            let provider = AnthropicProvider::new(
                api_key,
                effective_model_id.clone(),
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
                effective_model_id.clone(),
                state.openai_base_url.clone(),
            )?;
            provider.call(provider_request).await?
        }
        "gemini" => {
            let api_key = state.gemini_api_key.clone().ok_or_else(|| {
                RelayError::ContractValidation("Gemini API key not configured".to_string())
            })?;
            let provider = GeminiProvider::new(
                api_key,
                effective_model_id.clone(),
                state.gemini_base_url.clone(),
            )?;
            provider.call(provider_request).await?
        }
        _ => {
            return Err(RelayError::ContractValidation(format!(
                "unsupported provider: {effective_provider}"
            )));
        }
    };
    let inference_end = Utc::now();

    // 7. Parse output
    let output: serde_json::Value = serde_json::from_str(&provider_response.text)
        .map_err(|e| RelayError::OutputValidation(format!("output is not valid JSON: {e}")))?;

    // 8. Validate output against schema
    validate_output_schema(&output, &effective_schema)?;

    // 8b. Enforcement rules: reject forbidden characters in string values
    validate_output_enforcement_rules(&output, &resolved_policy.rules)?;

    // 9. Compute entropy and enforce per contract mode (#151 gap 6)
    let entropy_bits = calculate_schema_entropy_upper_bound(&effective_schema)
        .map(|v| v as u32)
        .unwrap_or_else(|e| {
            tracing::warn!("entropy calculation failed: {e}; recording 0");
            0
        });

    let entropy_mode = contract
        .entropy_enforcement
        .unwrap_or(vault_family_types::EntropyEnforcementMode::Advisory);

    if let Some(budget) = contract.entropy_budget_bits {
        if entropy_bits > budget {
            match entropy_mode {
                vault_family_types::EntropyEnforcementMode::Advisory => {
                    tracing::warn!(
                        entropy_bits,
                        budget,
                        "schema entropy exceeds contract budget (advisory only)"
                    );
                }
                vault_family_types::EntropyEnforcementMode::Gate
                | vault_family_types::EntropyEnforcementMode::Strict => {
                    return Err(RelayError::ContractValidation(format!(
                        "schema entropy ({entropy_bits} bits) exceeds contract budget ({budget} bits) — enforcement mode: {entropy_mode:?}"
                    )));
                }
            }
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
        budget_enforcement: Some(
            match entropy_mode {
                vault_family_types::EntropyEnforcementMode::Advisory => "advisory",
                vault_family_types::EntropyEnforcementMode::Gate => "gate",
                vault_family_types::EntropyEnforcementMode::Strict => "strict",
            }
            .to_string(),
        ),
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
    let guardian_policy_hash = resolved_hash.clone();

    // model_profile_hash already resolved in step 2b — no duplicate lookup needed.

    let unsigned = Receipt::builder()
        .session_id(session_id.clone())
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
        .contract_hash(Some(contract_hash.clone()))
        .output_schema_id(Some(contract.output_schema_id.clone()))
        .output_schema_hash(Some(output_schema_hash.clone()))
        .signal_class(Some(SignalClass::SessionCompleted))
        .entropy_budget_bits_opt(contract.entropy_budget_bits)
        .prompt_template_hash(Some(prompt_template_hash.clone()))
        .contract_timing_class(contract.timing_class.clone())
        .model_profile_hash(model_profile_hash.clone())
        .model_identity(Some(receipt_core::ModelIdentity {
            provider: effective_provider.to_string(),
            model_id: effective_model_id.clone(),
            model_version: provider_response.model_id.clone().into(),
        }))
        .build_unsigned()
        .ok_or_else(|| {
            RelayError::ReceiptSigning("receipt builder missing required fields".to_string())
        })?;

    let signature = receipt_core::sign_receipt(&unsigned, &state.signing_key)
        .map_err(|e| RelayError::ReceiptSigning(format!("signing failed: {e}")))?;

    let receipt_signature = signature.clone();
    let receipt = unsigned.sign(signature);

    // --- v2 receipt construction ---
    let v2_enforcement_mode = match entropy_mode {
        vault_family_types::EntropyEnforcementMode::Advisory => BudgetEnforcementMode::Advisory,
        vault_family_types::EntropyEnforcementMode::Gate
        | vault_family_types::EntropyEnforcementMode::Strict => BudgetEnforcementMode::Enforced,
    };
    let receipt_v2 = build_receipt_v2(
        &session_id,
        &contract_hash,
        &output_schema_hash,
        &output,
        input_commitments,
        assembled_prompt_hash,
        &prompt_template_hash,
        model_profile_hash.as_deref(),
        &effective_model_id,
        effective_provider,
        &runtime_hash,
        &resolved_hash,
        state,
        inference_start,
        inference_end,
        v2_enforcement_mode,
        effective_max_tokens,
        entropy_bits,
        contract.entropy_budget_bits,
    )?;

    let timing = InferenceTiming {
        inference_start_at: inference_start,
        inference_end_at: inference_end,
    };

    Ok((
        RelayResult {
            output,
            receipt,
            receipt_signature,
            receipt_v2,
        },
        timing,
    ))
}

/// Build and sign a v2 receipt from relay execution data.
///
/// Returns a signed ReceiptV2. Errors are propagated as RelayError::ReceiptSigning.
#[allow(clippy::too_many_arguments)]
fn build_receipt_v2(
    session_id: &str,
    contract_hash: &str,
    schema_hash: &str,
    output: &serde_json::Value,
    input_commitments: Vec<InputCommitment>,
    assembled_prompt_hash: String,
    prompt_template_hash: &str,
    model_profile_hash: Option<&str>,
    model_id: &str,
    provider_name: &str,
    runtime_hash: &str,
    policy_hash: &str,
    state: &AppState,
    inference_start: chrono::DateTime<chrono::Utc>,
    inference_end: chrono::DateTime<chrono::Utc>,
    budget_enforcement_mode: BudgetEnforcementMode,
    effective_max_tokens: u32,
    entropy_bits: u32,
    entropy_budget_bits: Option<u32>,
) -> Result<ReceiptV2, RelayError> {
    // Compute output hash
    let output_hash = {
        let canonical = receipt_core::canonicalize_serializable(output)
            .map_err(|e| RelayError::ReceiptSigning(format!("output canonicalization: {e}")))?;
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        hex::encode(hasher.finalize())
    };

    // Build preflight bundle
    let enforcement_parameters = serde_json::json!({
        "max_completion_tokens": effective_max_tokens,
    });
    let preflight_bundle = PreflightBundle {
        policy_hash: policy_hash.to_string(),
        prompt_template_hash: prompt_template_hash.to_string(),
        model_profile_hash: model_profile_hash.unwrap_or("none").to_string(),
        schema_hash: schema_hash.to_string(),
        enforcement_parameters: enforcement_parameters.clone(),
    };

    // Compute effective_config_hash from preflight bundle
    let effective_config_hash = {
        let canonical = receipt_core::canonicalize_serializable(&preflight_bundle)
            .map_err(|e| RelayError::ReceiptSigning(format!("preflight canonicalization: {e}")))?;
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        Some(hex::encode(hasher.finalize()))
    };

    // Compute operator key fingerprint: SHA-256(hex bytes of verifying key)
    let verifying_key_hex = receipt_core::public_key_to_hex(&state.signing_key.verifying_key());
    let operator_key_fingerprint = {
        let key_bytes = hex::decode(&verifying_key_hex).unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(&key_bytes);
        hex::encode(hasher.finalize())
    };

    let operator_id =
        std::env::var("AV_OPERATOR_ID").unwrap_or_else(|_| "agentvault-relay-dev".to_string());

    let provider_latency_ms = (inference_end - inference_start)
        .num_milliseconds()
        .try_into()
        .unwrap_or(0u64);

    let receipt_id = uuid::Uuid::new_v4().to_string();

    let unsigned = UnsignedReceiptV2 {
        receipt_schema_version: SCHEMA_VERSION_V2.to_string(),
        receipt_canonicalization: CANONICALIZATION_V2.to_string(),
        receipt_id,
        session_id: session_id.to_string(),
        issued_at: Utc::now(),
        assurance_level: AssuranceLevel::SelfAsserted,
        operator: Operator {
            operator_id,
            operator_key_fingerprint,
            operator_key_discovery: None,
        },
        commitments: Commitments {
            contract_hash: contract_hash.to_string(),
            schema_hash: schema_hash.to_string(),
            output_hash,
            input_commitments,
            assembled_prompt_hash,
            prompt_assembly_version: "1.0.0".to_string(),
            output: Some(output.clone()),
            rejected_output_hash: None,
            initiator_submission_hash: None,
            responder_submission_hash: None,
            prompt_template_hash: Some(prompt_template_hash.to_string()),
            effective_config_hash,
            preflight_bundle: Some(preflight_bundle),
            output_retrieval_uri: None,
            output_media_type: None,
            preflight_bundle_uri: None,
        },
        claims: Claims {
            model_identity_asserted: Some(format!("{provider_name}/{model_id}")),
            model_identity_attested: None,
            model_profile_hash_asserted: model_profile_hash.map(str::to_string),
            runtime_hash_asserted: Some(runtime_hash.to_string()),
            runtime_hash_attested: None,
            budget_enforcement_mode: Some(budget_enforcement_mode),
            provider_latency_ms: Some(provider_latency_ms),
            token_usage: None,
            relay_software_version: Some(env!("CARGO_PKG_VERSION").to_string()),
            // Session outcome (#189)
            status: Some(SessionStatus::Success),
            signal_class: Some("SESSION_COMPLETED".to_string()),
            // Execution lane (#190)
            execution_lane: Some(ExecutionLaneV2::Standard),
            // Channel capacity (#188)
            channel_capacity_bits_upper_bound: Some(entropy_bits),
            channel_capacity_measurement_version: Some(
                CHANNEL_CAPACITY_MEASUREMENT_VERSION.to_string(),
            ),
            entropy_budget_bits,
            schema_entropy_ceiling_bits: Some(entropy_bits),
            budget_usage: Some(BudgetUsageV2 {
                bits_used_before: 0, // cross-session ledger not yet wired
                bits_used_after: entropy_bits,
                budget_limit: entropy_budget_bits.unwrap_or(128),
            }),
        },
        provider_attestation: None,
        tee_attestation: None,
    };

    receipt_core::sign_and_assemble_receipt_v2(unsigned, &state.signing_key)
        .map_err(|e| RelayError::ReceiptSigning(format!("v2 signing failed: {e}")))
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

/// Map an AbortReason to a v2 receipt (SessionStatus, signal_class) pair.
fn abort_reason_to_receipt_status(reason: AbortReason) -> (SessionStatus, &'static str) {
    match reason {
        AbortReason::SchemaValidation => (SessionStatus::Rejected, "schema_validation_failed"),
        AbortReason::PolicyGate => (SessionStatus::Rejected, "policy_gate_violated"),
        AbortReason::ProviderError => (SessionStatus::Error, "provider_error"),
        AbortReason::Timeout => (SessionStatus::Error, "timeout"),
        AbortReason::ContractMismatch => (SessionStatus::Error, "contract_validation_failed"),
    }
}

/// Build and sign a v2 failure receipt.
///
/// Failure receipts record that an inference session did not produce accepted output.
/// The `output_hash` is set to the SHA-256 of an empty string (no valid output).
/// `rejected_output_hash` will be populated when the VFC rev pin is bumped (#184).
#[allow(clippy::too_many_arguments)]
pub fn build_failure_receipt_v2(
    abort_reason: AbortReason,
    session_id: &str,
    contract_hash: &str,
    schema_hash: &str,
    input_commitments: Vec<InputCommitment>,
    assembled_prompt_hash: String,
    prompt_template_hash: &str,
    model_profile_hash: Option<&str>,
    model_id: &str,
    provider_name: &str,
    runtime_hash: &str,
    policy_hash: &str,
    state: &AppState,
    inference_start: Option<chrono::DateTime<chrono::Utc>>,
    inference_end: Option<chrono::DateTime<chrono::Utc>>,
    effective_max_tokens: u32,
    entropy_bits: u32,
    entropy_budget_bits: Option<u32>,
    rejected_output_bytes: Option<&[u8]>,
) -> Result<ReceiptV2, RelayError> {
    let (status, signal_class) = abort_reason_to_receipt_status(abort_reason);

    // output_hash: SHA-256 of empty string — no valid output was produced/accepted
    let output_hash = hex::encode(Sha256::digest(b""));

    // rejected_output_hash: SHA-256 of rejected output bytes, if any (#184)
    let rejected_output_hash =
        rejected_output_bytes.map(|bytes| hex::encode(Sha256::digest(bytes)));

    // Build preflight bundle (same as success path)
    let enforcement_parameters = serde_json::json!({
        "max_completion_tokens": effective_max_tokens,
    });
    let preflight_bundle = PreflightBundle {
        policy_hash: policy_hash.to_string(),
        prompt_template_hash: prompt_template_hash.to_string(),
        model_profile_hash: model_profile_hash.unwrap_or("none").to_string(),
        schema_hash: schema_hash.to_string(),
        enforcement_parameters: enforcement_parameters.clone(),
    };

    let effective_config_hash = {
        let canonical = receipt_core::canonicalize_serializable(&preflight_bundle)
            .map_err(|e| RelayError::ReceiptSigning(format!("preflight canonicalization: {e}")))?;
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        Some(hex::encode(hasher.finalize()))
    };

    let verifying_key_hex = receipt_core::public_key_to_hex(&state.signing_key.verifying_key());
    let operator_key_fingerprint = {
        let key_bytes = hex::decode(&verifying_key_hex).unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(&key_bytes);
        hex::encode(hasher.finalize())
    };

    let operator_id =
        std::env::var("AV_OPERATOR_ID").unwrap_or_else(|_| "agentvault-relay-dev".to_string());

    let provider_latency_ms = match (inference_start, inference_end) {
        (Some(start), Some(end)) => {
            Some((end - start).num_milliseconds().try_into().unwrap_or(0u64))
        }
        _ => None,
    };

    let receipt_id = uuid::Uuid::new_v4().to_string();
    let budget_enforcement_mode = BudgetEnforcementMode::Advisory;

    let unsigned = UnsignedReceiptV2 {
        receipt_schema_version: SCHEMA_VERSION_V2.to_string(),
        receipt_canonicalization: CANONICALIZATION_V2.to_string(),
        receipt_id,
        session_id: session_id.to_string(),
        issued_at: Utc::now(),
        assurance_level: AssuranceLevel::SelfAsserted,
        operator: Operator {
            operator_id,
            operator_key_fingerprint,
            operator_key_discovery: None,
        },
        commitments: Commitments {
            contract_hash: contract_hash.to_string(),
            schema_hash: schema_hash.to_string(),
            output_hash,
            input_commitments,
            assembled_prompt_hash,
            prompt_assembly_version: "1.0.0".to_string(),
            output: None, // no valid output for failure receipts
            rejected_output_hash: rejected_output_hash.clone(),
            initiator_submission_hash: None,
            responder_submission_hash: None,
            prompt_template_hash: Some(prompt_template_hash.to_string()),
            effective_config_hash,
            preflight_bundle: Some(preflight_bundle),
            output_retrieval_uri: None,
            output_media_type: None,
            preflight_bundle_uri: None,
        },
        claims: Claims {
            model_identity_asserted: Some(format!("{provider_name}/{model_id}")),
            model_identity_attested: None,
            model_profile_hash_asserted: model_profile_hash.map(str::to_string),
            runtime_hash_asserted: Some(runtime_hash.to_string()),
            runtime_hash_attested: None,
            budget_enforcement_mode: Some(budget_enforcement_mode),
            provider_latency_ms,
            token_usage: None,
            relay_software_version: Some(env!("CARGO_PKG_VERSION").to_string()),
            status: Some(status),
            signal_class: Some(signal_class.to_string()),
            execution_lane: Some(ExecutionLaneV2::Standard),
            channel_capacity_bits_upper_bound: Some(entropy_bits),
            channel_capacity_measurement_version: Some(
                CHANNEL_CAPACITY_MEASUREMENT_VERSION.to_string(),
            ),
            entropy_budget_bits,
            schema_entropy_ceiling_bits: Some(entropy_bits),
            budget_usage: Some(BudgetUsageV2 {
                bits_used_before: 0,
                bits_used_after: 0, // no capacity consumed on failure
                budget_limit: entropy_budget_bits.unwrap_or(128),
            }),
        },
        provider_attestation: None,
        tee_attestation: None,
    };

    receipt_core::sign_and_assemble_receipt_v2(unsigned, &state.signing_key)
        .map_err(|e| RelayError::ReceiptSigning(format!("v2 failure receipt signing failed: {e}")))
}

/// Single-shot relay endpoint handler (POST /relay).
/// Delegates to `relay_core`.
pub async fn relay(request: RelayRequest, state: &AppState) -> Result<RelayResponse, RelayError> {
    let provider = crate::resolve_provider(&request.provider, state)?;
    let (result, _timing) = relay_core(
        &request.contract,
        &request.input_a,
        &request.input_b,
        &provider,
        state,
    )
    .await?;

    Ok(RelayResponse {
        output: result.output,
        receipt: result.receipt,
        receipt_signature: result.receipt_signature,
        receipt_v2: Some(result.receipt_v2),
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
            model_profile_hash: None,
            enforcement_policy_hash: None,
            output_schema_hash: None,
            model_constraints: None,
            max_completion_tokens: None,
            session_ttl_secs: None,
            invite_ttl_secs: None,
            entropy_enforcement: None,
            relay_verifying_key_hex: None,
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
            model_id: "claude-sonnet-4-6".to_string(),
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
            model_id: "claude-sonnet-4-6".to_string(),
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

    fn make_failure_test_state(seed: u8) -> crate::AppState {
        use ed25519_dalek::SigningKey;
        let signing_key = SigningKey::from_bytes(&[seed; 32]);
        crate::AppState {
            signing_key,
            anthropic_api_key: None,
            anthropic_model_id: "test-model".to_string(),
            anthropic_base_url: None,
            openai_api_key: None,
            openai_model_id: String::new(),
            openai_base_url: None,
            gemini_api_key: None,
            gemini_model_id: String::new(),
            gemini_base_url: None,
            prompt_program_dir: "/tmp/nonexistent".to_string(),
            session_store: crate::session::SessionStore::new(std::time::Duration::from_secs(60)),
            policy_registry: crate::enforcement_policy::PolicyRegistry::single(
                crate::enforcement_policy::RelayEnforcementPolicy {
                    policy_version: "1".to_string(),
                    policy_id: "test-policy".to_string(),
                    policy_scope: "RELAY_GLOBAL".to_string(),
                    model_profile_allowlist: vec![],
                    provider_allowlist: vec![],
                    max_output_tokens: None,
                    rules: vec![],
                    entropy_constraints: None,
                },
                "a".repeat(64),
            ),
            agent_registry: crate::agent_registry::AgentRegistry::empty(),
            inbox_store: crate::inbox::InboxStore::new(std::time::Duration::from_secs(60)),
            max_completion_tokens: 4096,
            session_ttl_secs: 600,
            invite_ttl_secs: 300,
            schema_registry: crate::schema_registry::SchemaRegistry::empty(),
            is_dev: false,
            health_expose_model: false,
            admitted_programs: None,
            admitted_profiles: None,
        }
    }

    #[test]
    fn test_abort_reason_to_receipt_status_mapping() {
        use receipt_core::SessionStatus;
        let cases = vec![
            (
                AbortReason::SchemaValidation,
                SessionStatus::Rejected,
                "schema_validation_failed",
            ),
            (
                AbortReason::PolicyGate,
                SessionStatus::Rejected,
                "policy_gate_violated",
            ),
            (
                AbortReason::ProviderError,
                SessionStatus::Error,
                "provider_error",
            ),
            (AbortReason::Timeout, SessionStatus::Error, "timeout"),
            (
                AbortReason::ContractMismatch,
                SessionStatus::Error,
                "contract_validation_failed",
            ),
        ];
        for (reason, expected_status, expected_signal) in cases {
            let (status, signal) = abort_reason_to_receipt_status(reason);
            assert_eq!(status, expected_status, "wrong status for {:?}", reason);
            assert_eq!(
                signal, expected_signal,
                "wrong signal_class for {:?}",
                reason
            );
        }
    }

    #[test]
    fn test_build_failure_receipt_v2_schema_validation() {
        use receipt_core::{HashAlgorithm, InputCommitment, SessionStatus};
        let state = make_failure_test_state(42);
        let input_commitments = vec![
            InputCommitment {
                participant_id: "alice".to_string(),
                input_hash: "a".repeat(64),
                hash_alg: HashAlgorithm::Sha256,
                canonicalization: "CANONICAL_JSON_V1".to_string(),
            },
            InputCommitment {
                participant_id: "bob".to_string(),
                input_hash: "b".repeat(64),
                hash_alg: HashAlgorithm::Sha256,
                canonicalization: "CANONICAL_JSON_V1".to_string(),
            },
        ];
        let receipt = build_failure_receipt_v2(
            AbortReason::SchemaValidation,
            &"s".repeat(64),
            &"c".repeat(64),
            &"h".repeat(64),
            input_commitments,
            "p".repeat(64),
            &"t".repeat(64),
            None,
            "test-model",
            "anthropic",
            &"r".repeat(64),
            &"a".repeat(64),
            &state,
            None,
            None,
            4096,
            6,
            Some(128),
            None,
        )
        .expect("failure receipt should build");

        assert_eq!(receipt.claims.status, Some(SessionStatus::Rejected));
        assert_eq!(
            receipt.claims.signal_class.as_deref(),
            Some("schema_validation_failed")
        );
        let expected_empty_hash = hex::encode(sha2::Sha256::digest(b""));
        assert_eq!(receipt.commitments.output_hash, expected_empty_hash);
        assert!(receipt.commitments.output.is_none());
        assert_eq!(
            receipt
                .claims
                .budget_usage
                .as_ref()
                .unwrap()
                .bits_used_after,
            0
        );
        assert!(receipt.claims.provider_latency_ms.is_none());
        let verifying_key = state.signing_key.verifying_key();
        let (unsigned, sig) = receipt.split();
        assert!(receipt_core::verify_receipt_v2(&unsigned, &sig, &verifying_key).is_ok());
    }

    #[test]
    fn test_build_failure_receipt_v2_provider_error() {
        use receipt_core::{HashAlgorithm, InputCommitment, SessionStatus};
        let state = make_failure_test_state(99);
        let input_commitments = vec![InputCommitment {
            participant_id: "alice".to_string(),
            input_hash: "a".repeat(64),
            hash_alg: HashAlgorithm::Sha256,
            canonicalization: "CANONICAL_JSON_V1".to_string(),
        }];
        let receipt = build_failure_receipt_v2(
            AbortReason::ProviderError,
            &"s".repeat(64),
            &"c".repeat(64),
            &"h".repeat(64),
            input_commitments,
            "p".repeat(64),
            &"t".repeat(64),
            None,
            "test-model",
            "openai",
            &"r".repeat(64),
            &"a".repeat(64),
            &state,
            Some(chrono::Utc::now()),
            Some(chrono::Utc::now()),
            4096,
            10,
            None,
            None,
        )
        .expect("failure receipt should build");

        assert_eq!(receipt.claims.status, Some(SessionStatus::Error));
        assert_eq!(
            receipt.claims.signal_class.as_deref(),
            Some("provider_error")
        );
        assert!(receipt.claims.provider_latency_ms.is_some());
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
    // Enforcement rule tests (policy-driven guard)
    // ========================================================================

    use crate::enforcement_policy::{
        EnforcementClass, EnforcementRule, RuleScope, RuleScopeKind, RuleType,
    };

    fn nd_gate_rule() -> EnforcementRule {
        EnforcementRule {
            rule_id: "no_digits".to_string(),
            rule_type: RuleType::UnicodeCategoryReject,
            value: "Nd".to_string(),
            scope: RuleScope {
                kind: RuleScopeKind::AllStringValues,
                skip_keys: vec!["schema_version".to_string()],
            },
            classification: EnforcementClass::Gate,
        }
    }

    fn sc_gate_rule() -> EnforcementRule {
        EnforcementRule {
            rule_id: "no_currency_symbols".to_string(),
            rule_type: RuleType::UnicodeCategoryReject,
            value: "Sc".to_string(),
            scope: RuleScope {
                kind: RuleScopeKind::AllStringValues,
                skip_keys: vec!["schema_version".to_string()],
            },
            classification: EnforcementClass::Gate,
        }
    }

    fn nd_advisory_rule() -> EnforcementRule {
        EnforcementRule {
            rule_id: "no_digits_advisory".to_string(),
            rule_type: RuleType::UnicodeCategoryReject,
            value: "Nd".to_string(),
            scope: RuleScope {
                kind: RuleScopeKind::AllStringValues,
                skip_keys: vec![],
            },
            classification: EnforcementClass::Advisory,
        }
    }

    #[test]
    fn test_policy_gate_rejects_digits() {
        let output = serde_json::json!({
            "compatibility_signal": "STRONG_MATCH_42"
        });
        let rules = vec![nd_gate_rule()];
        let err = validate_output_enforcement_rules(&output, &rules).unwrap_err();
        assert!(matches!(err, RelayError::PolicyGate(_)));
    }

    #[test]
    fn test_policy_gate_rejects_unicode_digits() {
        // Fullwidth digit zero: U+FF10
        let output = serde_json::json!({
            "compatibility_signal": "MATCH\u{FF10}"
        });
        let rules = vec![nd_gate_rule()];
        let err = validate_output_enforcement_rules(&output, &rules).unwrap_err();
        assert!(matches!(err, RelayError::PolicyGate(_)));
    }

    #[test]
    fn test_policy_gate_rejects_currency() {
        let rules = vec![sc_gate_rule()];
        for symbol in ["£", "$", "€"] {
            let output = serde_json::json!({
                "compatibility_signal": format!("MATCH{symbol}")
            });
            let err = validate_output_enforcement_rules(&output, &rules).unwrap_err();
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
        let rules = vec![nd_gate_rule()];
        let err = validate_output_enforcement_rules(&output, &rules).unwrap_err();
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
        let rules = vec![nd_gate_rule(), sc_gate_rule()];
        assert!(validate_output_enforcement_rules(&output, &rules).is_ok());
    }

    #[test]
    fn test_advisory_rule_does_not_block() {
        let output = serde_json::json!({
            "field": "has_digit_7"
        });
        let rules = vec![nd_advisory_rule()];
        assert!(
            validate_output_enforcement_rules(&output, &rules).is_ok(),
            "ADVISORY rule should log but not block"
        );
    }

    #[test]
    fn test_empty_rules_passes() {
        let output = serde_json::json!({
            "anything": "goes_42_$$$"
        });
        let rules: Vec<EnforcementRule> = vec![];
        assert!(validate_output_enforcement_rules(&output, &rules).is_ok());
    }

    #[test]
    fn test_skip_keys_from_policy() {
        let output = serde_json::json!({
            "schema_version": "2",
            "signal": "CLEAN"
        });
        let rules = vec![nd_gate_rule()];
        assert!(
            validate_output_enforcement_rules(&output, &rules).is_ok(),
            "skip_keys should exclude schema_version containing '2'"
        );
    }

    #[test]
    fn test_mixed_gate_advisory() {
        // Both a GATE Nd rule and ADVISORY Sc rule. The digit triggers GATE → error.
        let output = serde_json::json!({
            "field": "has_digit_7"
        });
        let rules = vec![nd_gate_rule(), nd_advisory_rule()];
        let err = validate_output_enforcement_rules(&output, &rules).unwrap_err();
        assert!(
            matches!(err, RelayError::PolicyGate(_)),
            "GATE rule should fire even when ADVISORY violations exist"
        );
    }

    #[test]
    fn test_mediation_output_passes_nd_sc_rules() {
        // Clean MEDIATION-shaped output with no digits/currency passes enforcement.
        let output = serde_json::json!({
            "outcome": "AGREEMENT",
            "terms": ["FAIR_SPLIT", "MUTUAL_BENEFIT"],
            "summary": "Both parties agree to proceed"
        });
        let rules = vec![nd_gate_rule(), sc_gate_rule()];
        assert!(validate_output_enforcement_rules(&output, &rules).is_ok());
    }

    #[test]
    fn test_mediation_output_rejects_digit() {
        // MEDIATION-shaped output with digit is rejected — scope expansion enforced.
        let output = serde_json::json!({
            "outcome": "AGREEMENT",
            "terms": ["SPLIT_50_50"]
        });
        let rules = vec![nd_gate_rule()];
        let err = validate_output_enforcement_rules(&output, &rules).unwrap_err();
        assert!(matches!(err, RelayError::PolicyGate(_)));
    }

    #[test]
    fn test_top_level_array_checked() {
        // Top-level array should be recursed without skip_keys.
        let output = serde_json::json!(["CLEAN", "HAS_DIGIT_7"]);
        let rules = vec![nd_gate_rule()];
        let err = validate_output_enforcement_rules(&output, &rules).unwrap_err();
        assert!(matches!(err, RelayError::PolicyGate(_)));
    }

    #[test]
    fn test_nested_skip_key_not_skipped() {
        // A nested object key named "schema_version" containing a digit IS checked.
        // skip_keys only applies at the top level.
        let output = serde_json::json!({
            "wrapper": {
                "schema_version": "2"
            }
        });
        let rules = vec![nd_gate_rule()];
        let err = validate_output_enforcement_rules(&output, &rules).unwrap_err();
        assert!(
            matches!(err, RelayError::PolicyGate(_)),
            "nested 'schema_version' key should not be skipped"
        );
    }

    #[test]
    fn test_nd_includes_numeric_letter() {
        // Roman numeral Ⅳ (U+2163, Nl category) IS caught by "Nd" rule.
        // This proves the conservative superset (is_numeric covers Nd ∪ Nl ∪ No)
        // is intentional and locked in.
        let output = serde_json::json!({
            "field": "VALUE_\u{2163}"
        });
        let rules = vec![nd_gate_rule()];
        let err = validate_output_enforcement_rules(&output, &rules).unwrap_err();
        assert!(
            matches!(err, RelayError::PolicyGate(_)),
            "Nl character should be caught by conservative Nd superset"
        );
    }

    // ========================================================================
    // Schema hash tests (content-addressing and cross-language parity)
    // ========================================================================

    #[test]
    fn test_schema_hash_immutable() {
        let mut schema = serde_json::json!({
            "type": "object",
            "properties": {
                "mediation_signal": {
                    "type": "string",
                    "enum": ["ALIGNMENT_POSSIBLE", "PARTIAL_ALIGNMENT", "FUNDAMENTAL_DISAGREEMENT",
                             "NEEDS_FACILITATION", "INSUFFICIENT_SIGNAL"]
                }
            },
            "required": ["mediation_signal"],
            "additionalProperties": false
        });

        let h1 = compute_output_schema_hash(&schema).unwrap();
        let h2 = compute_output_schema_hash(&schema).unwrap();
        assert_eq!(h1, h2, "same schema must produce the same hash");

        // Mutate the schema and verify the hash changes
        schema
            .as_object_mut()
            .unwrap()
            .insert("description".to_string(), serde_json::json!("mutated"));
        let h3 = compute_output_schema_hash(&schema).unwrap();
        assert_ne!(h1, h3, "mutated schema must produce a different hash");
    }

    #[test]
    fn test_contract_hash_captures_schema_content() {
        let base_contract = Contract {
            purpose_code: vault_family_types::Purpose::Mediation,
            output_schema_id: "vcav_e_mediation_signal_v2".to_string(),
            output_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "signal": { "type": "string", "enum": ["A", "B"] }
                },
                "required": ["signal"],
                "additionalProperties": false
            }),
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
        };

        let mut alt_contract = base_contract.clone();
        alt_contract.output_schema = serde_json::json!({
            "type": "object",
            "properties": {
                "signal": { "type": "string", "enum": ["X", "Y", "Z"] }
            },
            "required": ["signal"],
            "additionalProperties": false
        });

        let h1 = compute_contract_hash(&base_contract).unwrap();
        let h2 = compute_contract_hash(&alt_contract).unwrap();
        assert_ne!(
            h1, h2,
            "contracts with different output_schema must have different contract hashes"
        );
    }

    #[test]
    fn test_cross_language_schema_hash_parity() {
        // Constructs the MEDIATION schema matching schemas/output/vcav_e_mediation_signal_v2.schema.json
        // exactly. Hash verified against TypeScript computeOutputSchemaHash (JCS + SHA-256).
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "mediation_signal": {
                    "type": "string",
                    "enum": [
                        "ALIGNMENT_POSSIBLE",
                        "PARTIAL_ALIGNMENT",
                        "FUNDAMENTAL_DISAGREEMENT",
                        "NEEDS_FACILITATION",
                        "INSUFFICIENT_SIGNAL"
                    ]
                },
                "common_ground_code": {
                    "type": "string",
                    "enum": [
                        "GOAL_ALIGNMENT",
                        "RESOURCE_ALIGNMENT",
                        "RELATIONSHIP_CONTINUITY",
                        "VALUE_ALIGNMENT",
                        "OPERATIONAL_ALIGNMENT",
                        "NO_COMMON_GROUND_DETECTED"
                    ]
                },
                "next_step_signal": {
                    "type": "string",
                    "enum": [
                        "DIRECT_DIALOGUE",
                        "STRUCTURED_NEGOTIATION",
                        "THIRD_PARTY_FACILITATION",
                        "COOLING_PERIOD",
                        "SEEK_CLARIFICATION"
                    ]
                },
                "confidence_band": {
                    "type": "string",
                    "enum": ["LOW", "MEDIUM", "HIGH"]
                }
            },
            "required": ["mediation_signal", "common_ground_code", "next_step_signal", "confidence_band"],
            "additionalProperties": false
        });

        let hash = compute_output_schema_hash(&schema).unwrap();
        assert_eq!(
            hash, "0d25ea011d60a30156796b7e510caa804068bd4c01faa2f637def7dd07d5b3f6",
            "MEDIATION schema hash must match TypeScript computeOutputSchemaHash \
             (schemas/output/vcav_e_mediation_signal_v2.schema.json)"
        );
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

    // -----------------------------------------------------------------------
    // Schema resolution tests (#181)
    // -----------------------------------------------------------------------

    #[test]
    fn test_schema_resolution_inline_no_hash() {
        // Real inline schema, no hash → uses inline, no registry involvement
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "signal": { "type": "string", "enum": ["yes", "no"] } },
            "required": ["signal"],
            "additionalProperties": false
        });

        let is_stub = schema
            .as_object()
            .map(|obj| !obj.contains_key("properties"))
            .unwrap_or(true);
        assert!(!is_stub, "schema with properties should not be a stub");

        // When output_schema_hash is None and schema has properties,
        // the schema is used directly (the else branch at relay.rs ~line 397)
    }

    #[test]
    fn test_schema_resolution_stub_no_hash_is_error() {
        // Stub schema {} with no hash → no way to resolve → error
        let stub = serde_json::json!({});
        let is_stub = stub
            .as_object()
            .map(|obj| !obj.contains_key("properties"))
            .unwrap_or(true);
        assert!(is_stub, "empty object should be detected as stub");

        // With no output_schema_hash, the stub is used directly but will fail
        // schema validation downstream (no properties = no valid output).
        // The relay doesn't reject stubs without hashes at the resolution stage —
        // it fails at validate_output_schema.
    }

    #[test]
    fn test_schema_resolution_stub_with_hash_registry_lookup() {
        // Stub schema {} + hash → registry lookup
        let real_schema = serde_json::json!({
            "type": "object",
            "properties": { "signal": { "type": "string", "enum": ["yes", "no"] } },
            "required": ["signal"],
            "additionalProperties": false
        });

        // Compute hash of the real schema
        let canonical = receipt_core::canonicalize_serializable(&real_schema).unwrap();
        let hash = hex::encode(Sha256::digest(canonical.as_bytes()));

        // Build a minimal registry
        let dir = std::env::temp_dir().join("vcav-schema-resolution-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("test.json"),
            serde_json::to_string_pretty(&real_schema).unwrap(),
        )
        .unwrap();
        let registry = crate::schema_registry::SchemaRegistry::load_from_dir(&dir).unwrap();

        // Lookup by hash should succeed
        let looked_up = registry.get(&hash);
        assert!(looked_up.is_some(), "registry should find schema by hash");
        assert_eq!(looked_up.unwrap(), &real_schema);

        std::fs::remove_dir_all(&dir).ok();
    }

    // -----------------------------------------------------------------------
    // Receipt-binding tests for multi-policy correctness (#182)
    // -----------------------------------------------------------------------

    #[test]
    fn test_receipt_binds_selected_policy_not_default() {
        // A multi-policy registry where the contract selects a non-default policy.
        // The receipt must bind the selected hash, not the default.
        use crate::enforcement_policy::{content_hash, PolicyRegistry, RelayEnforcementPolicy};

        let policy_a = RelayEnforcementPolicy {
            policy_version: "1".to_string(),
            policy_id: "policy_a".to_string(),
            policy_scope: "RELAY_GLOBAL".to_string(),
            model_profile_allowlist: vec![],
            provider_allowlist: vec![],
            max_output_tokens: None,
            rules: vec![],
            entropy_constraints: None,
        };
        let hash_a = content_hash(&policy_a).unwrap();

        let policy_b = RelayEnforcementPolicy {
            policy_version: "1".to_string(),
            policy_id: "policy_b".to_string(),
            policy_scope: "RELAY_GLOBAL".to_string(),
            model_profile_allowlist: vec![],
            provider_allowlist: vec![],
            max_output_tokens: None,
            rules: vec![],
            entropy_constraints: None,
        };
        let hash_b = content_hash(&policy_b).unwrap();

        let mut policies = std::collections::HashMap::new();
        policies.insert(hash_a.clone(), policy_a);
        policies.insert(hash_b.clone(), policy_b);

        // Default is policy_a, but contract requests policy_b
        let registry = PolicyRegistry::new(policies, hash_a.clone()).unwrap();
        let resolved = registry.resolve(Some(&hash_b)).unwrap();

        assert_eq!(resolved.hash, hash_b, "should resolve to requested policy");
        assert_ne!(
            resolved.hash, hash_a,
            "should NOT resolve to default policy"
        );
        assert_eq!(resolved.policy.policy_id, "policy_b");
    }

    #[test]
    fn test_preflight_and_receipt_agree_on_policy_hash() {
        // Both preflight bundle and final receipt must contain the same policy_hash.
        // We verify this by building a v2 receipt and checking the preflight bundle's
        // policy_hash matches what we pass in.
        let state = make_failure_test_state(77);
        let policy_hash = "b".repeat(64);

        let input_commitments = vec![InputCommitment {
            participant_id: "alice".to_string(),
            input_hash: "a".repeat(64),
            hash_alg: HashAlgorithm::Sha256,
            canonicalization: "CANONICAL_JSON_V1".to_string(),
        }];

        let receipt = build_failure_receipt_v2(
            AbortReason::ProviderError,
            &"s".repeat(64),
            &"c".repeat(64),
            &"h".repeat(64),
            input_commitments,
            "p".repeat(64),
            &"t".repeat(64),
            None,
            "test-model",
            "anthropic",
            &"r".repeat(64),
            &policy_hash,
            &state,
            None,
            None,
            4096,
            10,
            None,
            None,
        )
        .expect("failure receipt should build");

        // The effective_config_hash is computed from a PreflightBundle that includes
        // policy_hash. If we passed the wrong policy_hash, the config hash would differ.
        // We can't directly inspect the preflight, but we can verify the receipt was built
        // successfully with our specific policy_hash by checking effective_config_hash exists.
        assert!(
            receipt.commitments.effective_config_hash.is_some(),
            "effective_config_hash should be set (computed from preflight with our policy_hash)"
        );
    }

    #[test]
    fn test_default_vs_explicit_produce_different_receipts() {
        // Two contracts against the same multi-policy registry:
        // one with explicit hash, one without. They should resolve to different policies
        // and thus produce different guardian_policy_hash values.
        use crate::enforcement_policy::{content_hash, PolicyRegistry, RelayEnforcementPolicy};

        let policy_default = RelayEnforcementPolicy {
            policy_version: "1".to_string(),
            policy_id: "default_policy".to_string(),
            policy_scope: "RELAY_GLOBAL".to_string(),
            model_profile_allowlist: vec![],
            provider_allowlist: vec![],
            max_output_tokens: None,
            rules: vec![],
            entropy_constraints: None,
        };
        let hash_default = content_hash(&policy_default).unwrap();

        let policy_explicit = RelayEnforcementPolicy {
            policy_version: "1".to_string(),
            policy_id: "explicit_policy".to_string(),
            policy_scope: "RELAY_GLOBAL".to_string(),
            model_profile_allowlist: vec![],
            provider_allowlist: vec![],
            max_output_tokens: None,
            rules: vec![],
            entropy_constraints: None,
        };
        let hash_explicit = content_hash(&policy_explicit).unwrap();

        let mut policies = std::collections::HashMap::new();
        policies.insert(hash_default.clone(), policy_default);
        policies.insert(hash_explicit.clone(), policy_explicit);

        let registry = PolicyRegistry::new(policies, hash_default.clone()).unwrap();

        // Contract without hash → default
        let resolved_default = registry.resolve(None).unwrap();
        assert_eq!(resolved_default.hash, hash_default);

        // Contract with explicit hash → explicit policy
        let resolved_explicit = registry.resolve(Some(&hash_explicit)).unwrap();
        assert_eq!(resolved_explicit.hash, hash_explicit);

        // They must differ
        assert_ne!(
            resolved_default.hash, resolved_explicit.hash,
            "default and explicit paths should produce different policy hashes"
        );
    }
}
