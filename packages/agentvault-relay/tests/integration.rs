//! Integration tests for AgentVault relay.
//!
//! These tests exercise the receipt construction and verification pipeline
//! without calling the actual Anthropic API. They validate that:
//! - Receipts are correctly built with API_MEDIATED execution lane
//! - Receipt signatures verify with receipt-core
//! - Contract/prompt hashes are correctly bound
//! - Entropy is computed and recorded
//! - Schema validation rejects non-conforming output
//! - End-to-end /relay endpoint (with mock Anthropic) returns valid receipt

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use ed25519_dalek::SigningKey;
use tower::ServiceExt;

use agentvault_relay::{
    agent_registry::{AgentRegistry, RegisteredAgent},
    build_router,
    enforcement_policy::{
        EnforcementClass, EnforcementRule, RelayEnforcementPolicy, RuleScope, RuleScopeKind,
        RuleType,
    },
    inbox::InboxStore,
    session::SessionStore,
    AppState,
};

/// Build a minimal enforcement policy for tests.
fn test_enforcement_policy() -> RelayEnforcementPolicy {
    RelayEnforcementPolicy {
        policy_version: "1".to_string(),
        policy_id: "test_policy".to_string(),
        policy_scope: "RELAY_GLOBAL".to_string(),
        model_profile_allowlist: vec![],
        provider_allowlist: vec![],
        max_output_tokens: None,
        rules: vec![
            EnforcementRule {
                rule_id: "no_digits".to_string(),
                rule_type: RuleType::UnicodeCategoryReject,
                value: "Nd".to_string(),
                scope: RuleScope {
                    kind: RuleScopeKind::AllStringValues,
                    skip_keys: vec!["schema_version".to_string()],
                },
                classification: EnforcementClass::Gate,
            },
            EnforcementRule {
                rule_id: "no_currency_symbols".to_string(),
                rule_type: RuleType::UnicodeCategoryReject,
                value: "Sc".to_string(),
                scope: RuleScope {
                    kind: RuleScopeKind::AllStringValues,
                    skip_keys: vec!["schema_version".to_string()],
                },
                classification: EnforcementClass::Gate,
            },
        ],
        entropy_constraints: None,
    }
}

/// Build a test signing key (deterministic).
fn test_signing_key() -> SigningKey {
    SigningKey::from_bytes(&[0x42u8; 32])
}

/// Build a test AppState pointing at a mock Anthropic server.
fn test_app_state(mock_base_url: &str, prompt_dir: &str) -> AppState {
    AppState {
        signing_key: test_signing_key(),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some(mock_base_url.to_string()),
        openai_api_key: None,
        openai_model_id: "gpt-4o".to_string(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: "gemini-2.5-flash".to_string(),
        gemini_base_url: None,
        prompt_program_dir: prompt_dir.to_string(),
        session_store: SessionStore::new(Duration::from_secs(600)),
        enforcement_policy: test_enforcement_policy(),
        enforcement_policy_hash: "0".repeat(64),
        agent_registry: AgentRegistry::empty(),
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        is_dev: false,
    }
}

/// Sample mediation output schema.
fn mediation_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "decision": {
                "type": "string",
                "enum": ["PROCEED", "DECLINE", "DEFER"]
            },
            "confidence_bucket": {
                "type": "string",
                "enum": ["HIGH", "MEDIUM", "LOW"]
            },
            "reason_code": {
                "type": "string",
                "enum": ["ALIGNED", "MISALIGNED", "UNCLEAR"]
            }
        },
        "required": ["decision", "confidence_bucket", "reason_code"],
        "additionalProperties": false
    })
}

/// Create a prompt program file in a temp dir and return (dir_path, content_hash).
fn setup_prompt_program(test_name: &str) -> (String, String) {
    use agentvault_relay::prompt_program::PromptProgram;

    let program = PromptProgram {
        version: "1.0.0".to_string(),
        system_instruction: "You are a structured data classifier.".to_string(),
        input_format: agentvault_relay::prompt_program::InputFormat::Structured,
    };

    let hash = program.content_hash().unwrap();
    let dir = std::env::temp_dir().join(format!("vcav-e-relay-{test_name}"));
    std::fs::create_dir_all(&dir).unwrap();

    let path = dir.join(format!("{hash}.json"));
    std::fs::write(&path, serde_json::to_string(&program).unwrap()).unwrap();

    (dir.to_str().unwrap().to_string(), hash)
}

// ============================================================================
// Receipt construction and verification (no API call)
// ============================================================================

#[test]
fn test_receipt_construction_and_signature_verification() {
    use chrono::Utc;
    use entropy_core::calculate_schema_entropy_upper_bound;
    use receipt_core::{
        BudgetUsageRecord, ExecutionLane, ModelIdentity, Receipt, ReceiptStatus, SignalClass,
    };
    use sha2::{Digest, Sha256};
    use vault_family_types::{generate_pair_id, BudgetTier, Purpose};

    let signing_key = test_signing_key();
    let verifying_key = signing_key.verifying_key();

    let schema = mediation_schema();
    let entropy_bits = calculate_schema_entropy_upper_bound(&schema).unwrap() as u32;

    let session_start = Utc::now();
    let session_end = Utc::now();
    let session_id = hex::encode(Sha256::digest(b"test-session"));

    let participants = vec!["alice".to_string(), "bob".to_string()];
    let pair_id = generate_pair_id(&participants[0], &participants[1]);
    let relay_hash = hex::encode(Sha256::digest(b"vcav-e-relay-v0.1.0"));

    let output = serde_json::json!({
        "decision": "PROCEED",
        "confidence_bucket": "HIGH",
        "reason_code": "ALIGNED"
    });

    let budget_usage = BudgetUsageRecord {
        pair_id,
        window_start: session_start,
        bits_used_before: 0,
        bits_used_after: entropy_bits,
        budget_limit: 128,
        budget_tier: BudgetTier::Default,
        budget_enforcement: Some("disabled".to_string()),
        compartment_id: None,
    };

    let unsigned = Receipt::builder()
        .session_id(session_id)
        .purpose_code(Purpose::Mediation)
        .participant_ids(participants)
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
        .contract_hash(Some("a".repeat(64)))
        .output_schema_id(Some("vault_result_mediation".to_string()))
        .signal_class(Some(SignalClass::SessionCompleted))
        .prompt_template_hash(Some("b".repeat(64)))
        .model_identity(Some(ModelIdentity {
            provider: "anthropic".to_string(),
            model_id: "claude-sonnet-4-5-20250929".to_string(),
            model_version: None,
        }))
        .build_unsigned()
        .expect("receipt builder should succeed");

    // Verify execution lane
    assert_eq!(unsigned.execution_lane, ExecutionLane::ApiMediated);
    assert_eq!(unsigned.purpose_code, Purpose::Mediation);
    assert_eq!(unsigned.contract_hash, Some("a".repeat(64)));
    assert_eq!(unsigned.prompt_template_hash, Some("b".repeat(64)));

    // Sign
    let signature = receipt_core::sign_receipt(&unsigned, &signing_key).expect("signing");

    // Verify signature
    receipt_core::verify_receipt(&unsigned, &signature, &verifying_key)
        .expect("signature must verify");

    // Build final receipt
    let receipt = unsigned.sign(signature);
    assert!(receipt.is_completed());
    assert_eq!(receipt.execution_lane, ExecutionLane::ApiMediated);
    assert_eq!(receipt.output, Some(output));
    assert!(receipt.output_entropy_bits > 0);
}

#[test]
fn test_receipt_execution_lane_is_api_mediated() {
    use chrono::Utc;
    use receipt_core::{BudgetUsageRecord, ExecutionLane, Receipt, ReceiptStatus};
    use sha2::{Digest, Sha256};
    use vault_family_types::{BudgetTier, Purpose};

    let relay_hash = hex::encode(Sha256::digest(b"vcav-e-relay-v0.1.0"));
    let now = Utc::now();

    let unsigned = Receipt::builder()
        .session_id("a".repeat(64))
        .purpose_code(Purpose::Mediation)
        .participant_ids(vec!["alice".to_string(), "bob".to_string()])
        .runtime_hash(&relay_hash)
        .guardian_policy_hash(&relay_hash)
        .model_weights_hash(&relay_hash)
        .llama_cpp_version("n/a")
        .inference_config_hash(&relay_hash)
        .output_schema_version("1.0.0")
        .session_start(now)
        .session_end(now)
        .fixed_window_duration_seconds(0)
        .status(ReceiptStatus::Completed)
        .execution_lane(ExecutionLane::ApiMediated)
        .output_entropy_bits(8)
        .budget_usage(BudgetUsageRecord {
            pair_id: "c".repeat(64),
            window_start: now,
            bits_used_before: 0,
            bits_used_after: 8,
            budget_limit: 128,
            budget_tier: BudgetTier::Default,
            budget_enforcement: Some("disabled".to_string()),
            compartment_id: None,
        })
        .build_unsigned()
        .unwrap();

    // Verify execution lane serializes correctly
    let json = serde_json::to_value(&unsigned).unwrap();
    assert_eq!(json["execution_lane"], "API_MEDIATED");
}

#[test]
fn test_entropy_computation_for_mediation_schema() {
    use entropy_core::calculate_schema_entropy_upper_bound;

    let schema = mediation_schema();
    let entropy = calculate_schema_entropy_upper_bound(&schema).unwrap();

    // 3 options × 3 options × 3 options = ceil(log2(3)) + ceil(log2(3)) + ceil(log2(3)) = 2+2+2 = 6
    assert_eq!(entropy, 6);
}

#[test]
fn test_schema_validation_rejects_invalid_output() {
    let schema = mediation_schema();
    let compiled = jsonschema::JSONSchema::compile(&schema).unwrap();

    // Valid output
    let valid = serde_json::json!({
        "decision": "PROCEED",
        "confidence_bucket": "HIGH",
        "reason_code": "ALIGNED"
    });
    assert!(compiled.validate(&valid).is_ok());

    // Invalid: wrong enum value
    let invalid_enum = serde_json::json!({
        "decision": "INVALID_VALUE",
        "confidence_bucket": "HIGH",
        "reason_code": "ALIGNED"
    });
    assert!(compiled.validate(&invalid_enum).is_err());

    // Invalid: missing required field
    let missing_field = serde_json::json!({
        "decision": "PROCEED"
    });
    assert!(compiled.validate(&missing_field).is_err());

    // Invalid: additional property
    let extra_field = serde_json::json!({
        "decision": "PROCEED",
        "confidence_bucket": "HIGH",
        "reason_code": "ALIGNED",
        "extra": "not_allowed"
    });
    assert!(compiled.validate(&extra_field).is_err());
}

#[test]
fn test_prompt_program_hash_binding() {
    use sha2::{Digest, Sha256};

    // Two different prompt programs should produce different hashes
    let p1 = serde_json::json!({
        "version": "1.0.0",
        "system_instruction": "You are a mediator.",
        "input_format": "structured"
    });
    let p2 = serde_json::json!({
        "version": "1.0.0",
        "system_instruction": "You are a different mediator.",
        "input_format": "structured"
    });

    let c1 = receipt_core::canonicalize_serializable(&p1).unwrap();
    let c2 = receipt_core::canonicalize_serializable(&p2).unwrap();

    let h1 = hex::encode(Sha256::digest(c1.as_bytes()));
    let h2 = hex::encode(Sha256::digest(c2.as_bytes()));

    assert_ne!(h1, h2);
    assert_eq!(h1.len(), 64);
    assert_eq!(h2.len(), 64);
}

#[test]
fn test_contract_hash_binding() {
    use sha2::{Digest, Sha256};

    let c1 = serde_json::json!({
        "purpose_code": "MEDIATION",
        "output_schema_id": "vault_result_mediation",
        "participants": ["alice", "bob"]
    });
    let c2 = serde_json::json!({
        "purpose_code": "MEDIATION",
        "output_schema_id": "vault_result_mediation",
        "participants": ["alice", "charlie"]
    });

    let canon1 = receipt_core::canonicalize_serializable(&c1).unwrap();
    let canon2 = receipt_core::canonicalize_serializable(&c2).unwrap();

    let h1 = hex::encode(Sha256::digest(canon1.as_bytes()));
    let h2 = hex::encode(Sha256::digest(canon2.as_bytes()));

    assert_ne!(h1, h2);
}

#[test]
fn test_receipt_roundtrip_serialization() {
    use chrono::Utc;
    use receipt_core::{BudgetUsageRecord, ExecutionLane, Receipt, ReceiptStatus, SignalClass};
    use sha2::{Digest, Sha256};
    use vault_family_types::{BudgetTier, Purpose};

    let signing_key = test_signing_key();
    let relay_hash = hex::encode(Sha256::digest(b"vcav-e-relay-v0.1.0"));
    let now = Utc::now();

    let output = serde_json::json!({
        "decision": "DEFER",
        "confidence_bucket": "LOW",
        "reason_code": "UNCLEAR"
    });

    let unsigned = Receipt::builder()
        .session_id("f".repeat(64))
        .purpose_code(Purpose::Mediation)
        .participant_ids(vec!["alice".to_string(), "bob".to_string()])
        .runtime_hash(&relay_hash)
        .guardian_policy_hash(&relay_hash)
        .model_weights_hash(&relay_hash)
        .llama_cpp_version("n/a")
        .inference_config_hash(&relay_hash)
        .output_schema_version("1.0.0")
        .session_start(now)
        .session_end(now)
        .fixed_window_duration_seconds(0)
        .status(ReceiptStatus::Completed)
        .execution_lane(ExecutionLane::ApiMediated)
        .output(Some(output))
        .output_entropy_bits(6)
        .budget_usage(BudgetUsageRecord {
            pair_id: "c".repeat(64),
            window_start: now,
            bits_used_before: 0,
            bits_used_after: 6,
            budget_limit: 128,
            budget_tier: BudgetTier::Default,
            budget_enforcement: Some("disabled".to_string()),
            compartment_id: None,
        })
        .contract_hash(Some("d".repeat(64)))
        .output_schema_id(Some("vault_result_mediation".to_string()))
        .signal_class(Some(SignalClass::SessionCompleted))
        .prompt_template_hash(Some("e".repeat(64)))
        .build_unsigned()
        .unwrap();

    let signature = receipt_core::sign_receipt(&unsigned, &signing_key).unwrap();
    let receipt = unsigned.sign(signature);

    // Serialize to JSON
    let json_str = serde_json::to_string(&receipt).unwrap();

    // Deserialize back
    let parsed: receipt_core::Receipt = serde_json::from_str(&json_str).unwrap();

    assert_eq!(parsed.execution_lane, ExecutionLane::ApiMediated);
    assert_eq!(parsed.contract_hash, Some("d".repeat(64)));
    assert_eq!(parsed.prompt_template_hash, Some("e".repeat(64)));
    assert_eq!(
        parsed.output_schema_id,
        Some("vault_result_mediation".to_string())
    );
    assert_eq!(parsed.signal_class, Some(SignalClass::SessionCompleted));
    assert_eq!(parsed.signature, receipt.signature);
}

// ============================================================================
// HTTP endpoint tests (using real router from lib.rs)
// ============================================================================

#[tokio::test]
async fn test_health_endpoint() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["status"], "ok");
    assert_eq!(json["execution_lane"], "API_MEDIATED");
    assert_eq!(json["provider"], "anthropic");
    assert_eq!(json["model_id"], "test-model");
}

#[tokio::test]
async fn test_capabilities_endpoint() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["execution_lane"], "API_MEDIATED");
    assert_eq!(json["entropy_enforcement"], "ADVISORY");
    assert!(json["providers"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("anthropic")));
}

// ============================================================================
// End-to-end /relay test with mock Anthropic API
// ============================================================================

/// Start a mock Anthropic API server that returns a canned mediation response.
async fn start_mock_anthropic(output: serde_json::Value) -> String {
    use axum::routing::post;

    let app = axum::Router::new().route(
        "/v1/messages",
        post(move || {
            let output = output.clone();
            async move {
                let response = serde_json::json!({
                    "id": "msg_mock_123",
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "text",
                        "text": serde_json::to_string(&output).unwrap()
                    }],
                    "model": "test-model",
                    "stop_reason": "end_turn",
                    "usage": { "input_tokens": 10, "output_tokens": 5 }
                });
                axum::Json(response)
            }
        }),
    );

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://127.0.0.1:{}", addr.port());

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    base_url
}

#[tokio::test]
async fn test_relay_endpoint_end_to_end() {
    // 1. Set up prompt program on disk
    let (prompt_dir, prompt_hash) = setup_prompt_program("e2e-relay");

    // 2. Start mock Anthropic server
    let mock_output = serde_json::json!({
        "decision": "PROCEED",
        "confidence_bucket": "HIGH",
        "reason_code": "ALIGNED"
    });
    let mock_base_url = start_mock_anthropic(mock_output.clone()).await;

    // 3. Build relay app with mock
    let state = Arc::new(test_app_state(&mock_base_url, &prompt_dir));
    let verifying_key = state.signing_key.verifying_key();
    let app = build_router(state);

    // 4. Build relay request
    let relay_request = serde_json::json!({
        "contract": {
            "purpose_code": "MEDIATION",
            "output_schema_id": "vault_result_mediation",
            "output_schema": mediation_schema(),
            "participants": ["alice", "bob"],
            "prompt_template_hash": prompt_hash,
            "entropy_budget_bits": 64
        },
        "input_a": {
            "role": "alice",
            "context": { "preference": "morning meetings" }
        },
        "input_b": {
            "role": "bob",
            "context": { "preference": "afternoon meetings" }
        },
        "provider": "anthropic"
    });

    // 5. Send POST /relay
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/relay")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&relay_request).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    // 6. Verify output matches expected
    assert_eq!(json["output"], mock_output);

    // 7. Verify receipt fields
    let receipt = &json["receipt"];
    assert_eq!(receipt["execution_lane"], "API_MEDIATED");
    assert_eq!(receipt["purpose_code"], "MEDIATION");
    assert_eq!(receipt["status"], "COMPLETED");
    assert!(receipt["contract_hash"].as_str().unwrap().len() == 64);
    assert_eq!(receipt["prompt_template_hash"], prompt_hash);
    assert!(receipt["output_entropy_bits"].as_u64().unwrap() > 0);
    assert_eq!(receipt["signal_class"], "SESSION_COMPLETED");

    // 8. Verify receipt_signature is present and non-empty
    let receipt_sig = json["receipt_signature"].as_str().unwrap();
    assert_eq!(receipt_sig.len(), 128); // 64-byte Ed25519 sig = 128 hex chars

    // 9. Verify budget_limit uses contract value (not hardcoded 128)
    assert_eq!(receipt["budget_usage"]["budget_limit"], 64);

    // 10. Verify receipt signature using verifier
    //     Deserialize as UnsignedReceipt (ignores the signature field)
    let unsigned: receipt_core::UnsignedReceipt = serde_json::from_value(receipt.clone()).unwrap();
    receipt_core::verify_receipt(&unsigned, receipt_sig, &verifying_key)
        .expect("receipt signature must verify");

    // Clean up
    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_relay_endpoint_rejects_invalid_provider() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("e2e-bad-provider");

    let state = Arc::new(test_app_state("http://unused", &prompt_dir));
    let app = build_router(state);

    let relay_request = serde_json::json!({
        "contract": {
            "purpose_code": "MEDIATION",
            "output_schema_id": "vault_result_mediation",
            "output_schema": mediation_schema(),
            "participants": ["alice", "bob"],
            "prompt_template_hash": prompt_hash
        },
        "input_a": { "role": "alice", "context": {} },
        "input_b": { "role": "bob", "context": {} },
        "provider": "openai"
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/relay")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&relay_request).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    std::fs::remove_dir_all(&prompt_dir).ok();
}

// ============================================================================
// Model profile allowlist enforcement tests
// ============================================================================

#[tokio::test]
async fn test_relay_rejects_missing_model_profile_when_allowlist_set() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("e2e-allowlist-none");

    let mut state = test_app_state("http://unused", &prompt_dir);
    state.enforcement_policy.model_profile_allowlist = vec!["api-claude-sonnet-v1".to_string()];
    let app = build_router(Arc::new(state));

    // Contract without model_profile_id should be rejected
    let relay_request = serde_json::json!({
        "contract": {
            "purpose_code": "MEDIATION",
            "output_schema_id": "vault_result_mediation",
            "output_schema": mediation_schema(),
            "participants": ["alice", "bob"],
            "prompt_template_hash": prompt_hash
        },
        "input_a": { "role": "alice", "context": {} },
        "input_b": { "role": "bob", "context": {} },
        "provider": "anthropic"
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/relay")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&relay_request).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let error_msg = json["error"].as_str().unwrap_or("");
    assert!(
        error_msg.contains("model_profile_id is required"),
        "Expected allowlist error, got: {error_msg}"
    );

    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_relay_rejects_wrong_model_profile() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("e2e-allowlist-wrong");

    let mut state = test_app_state("http://unused", &prompt_dir);
    state.enforcement_policy.model_profile_allowlist = vec!["api-claude-sonnet-v1".to_string()];
    let app = build_router(Arc::new(state));

    // Contract with wrong model_profile_id should be rejected
    let relay_request = serde_json::json!({
        "contract": {
            "purpose_code": "MEDIATION",
            "output_schema_id": "vault_result_mediation",
            "output_schema": mediation_schema(),
            "participants": ["alice", "bob"],
            "prompt_template_hash": prompt_hash,
            "model_profile_id": "api-gpt4o-v1"
        },
        "input_a": { "role": "alice", "context": {} },
        "input_b": { "role": "bob", "context": {} },
        "provider": "anthropic"
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/relay")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&relay_request).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let error_msg = json["error"].as_str().unwrap_or("");
    assert!(
        error_msg.contains("not in enforcement allowlist"),
        "Expected allowlist error, got: {error_msg}"
    );

    std::fs::remove_dir_all(&prompt_dir).ok();
}

// ============================================================================
// Bilateral session tests
// ============================================================================

#[tokio::test]
async fn test_create_session_returns_tokens_and_contract_hash() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));
    let app = build_router(state);

    let create_request = serde_json::json!({
        "contract": {
            "purpose_code": "COMPATIBILITY",
            "output_schema_id": "test_schema",
            "output_schema": mediation_schema(),
            "participants": ["alice", "bob"],
            "prompt_template_hash": "a".repeat(64)
        }
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/sessions")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&create_request).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    // Session ID is SHA-256 hex (64 chars)
    assert_eq!(json["session_id"].as_str().unwrap().len(), 64);

    // Contract hash is SHA-256 hex (64 chars)
    assert_eq!(json["contract_hash"].as_str().unwrap().len(), 64);

    // All four tokens are 64 hex chars (32 bytes)
    for key in &[
        "initiator_submit_token",
        "initiator_read_token",
        "responder_submit_token",
        "responder_read_token",
    ] {
        let token = json[key].as_str().unwrap();
        assert_eq!(token.len(), 64, "{key} should be 64 hex chars");
    }

    // All tokens are unique
    let tokens: Vec<&str> = [
        "initiator_submit_token",
        "initiator_read_token",
        "responder_submit_token",
        "responder_read_token",
    ]
    .iter()
    .map(|k| json[k].as_str().unwrap())
    .collect();
    for (i, a) in tokens.iter().enumerate() {
        for (j, b) in tokens.iter().enumerate() {
            if i != j {
                assert_ne!(a, b);
            }
        }
    }
}

#[tokio::test]
async fn test_session_status_requires_valid_token() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));

    // Create a session first
    let (session_id, _tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "COMPATIBILITY",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    let app = build_router(state);

    // Request without token → 401
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sessions/{session_id}/status"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_session_status_with_valid_token() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "COMPATIBILITY",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sessions/{session_id}/status"))
                .header(
                    "authorization",
                    format!("Bearer {}", tokens.initiator_submit),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["state"], "CREATED");
    assert!(json["abort_reason"].is_null());
}

#[tokio::test]
async fn test_submit_input_transitions_to_partial() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "COMPATIBILITY",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    let app = build_router(state);

    let input_request = serde_json::json!({
        "role": "alice",
        "context": { "preference": "morning" }
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/sessions/{session_id}/input"))
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!("Bearer {}", tokens.initiator_submit),
                )
                .body(Body::from(serde_json::to_vec(&input_request).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["state"], "PARTIAL");
}

#[tokio::test]
async fn test_submit_token_is_one_time_use() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "COMPATIBILITY",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    let state_arc = Arc::new(test_app_state("http://unused", "/tmp"));
    // Manually insert session into this app state's store
    // We need to use the same store, so let's use the original state
    drop(state_arc);

    let input_request = serde_json::json!({
        "role": "alice",
        "context": {}
    });

    // First submit succeeds
    let app = build_router(Arc::new(test_app_state("http://unused", "/tmp")));
    // We can't easily reuse the router for two requests without cloning.
    // Instead, test via the session store directly.

    // Submit input directly via store
    state
        .session_store
        .with_session(&session_id, |session| {
            session.initiator_input = Some(agentvault_relay::types::RelayInput {
                role: "alice".to_string(),
                context: serde_json::json!({}),
            });
            session.initiator_submitted = true;
            session.state = agentvault_relay::session::SessionState::Partial;
        })
        .await;

    // Now try to submit again via HTTP — should be rejected
    let app = build_router(Arc::new(AppState {
        signing_key: test_signing_key(),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some("http://unused".to_string()),
        openai_api_key: None,
        openai_model_id: "gpt-4o".to_string(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: "gemini-2.5-flash".to_string(),
        gemini_base_url: None,
        prompt_program_dir: "/tmp".to_string(),
        session_store: state.session_store.clone(),
        enforcement_policy: test_enforcement_policy(),
        enforcement_policy_hash: "0".repeat(64),
        agent_registry: AgentRegistry::empty(),
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        is_dev: false,
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/sessions/{session_id}/input"))
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!("Bearer {}", tokens.initiator_submit),
                )
                .body(Body::from(serde_json::to_vec(&input_request).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    // One-time submit: second attempt returns UNAUTHORIZED
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_output_requires_read_token() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "COMPATIBILITY",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    let app = build_router(state);

    // Submit token should NOT be able to read output
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sessions/{session_id}/output"))
                .header(
                    "authorization",
                    format!("Bearer {}", tokens.initiator_submit),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_output_with_read_token_before_completion() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "COMPATIBILITY",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sessions/{session_id}/output"))
                .header("authorization", format!("Bearer {}", tokens.initiator_read))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    // Constant-shape: state + null fields
    assert_eq!(json["state"], "CREATED");
    assert!(json["output"].is_null());
    assert!(json["receipt"].is_null());
    assert!(json["receipt_signature"].is_null());
}

#[tokio::test]
async fn test_unknown_session_returns_unauthorized() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));
    let app = build_router(state);

    // Status of unknown session
    let response = app
        .oneshot(
            Request::builder()
                .uri("/sessions/nonexistent-session-id/status")
                .header("authorization", "Bearer some-random-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // Constant-shape: same response as bad token
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_bilateral_session_e2e_with_mock() {
    // Full bilateral flow: create → submit A → submit B → poll → output
    let (prompt_dir, prompt_hash) = setup_prompt_program("bilateral-e2e");

    let mock_output = serde_json::json!({
        "decision": "PROCEED",
        "confidence_bucket": "HIGH",
        "reason_code": "ALIGNED"
    });
    let mock_base_url = start_mock_anthropic(mock_output.clone()).await;

    let state = Arc::new(test_app_state(&mock_base_url, &prompt_dir));
    let verifying_key = state.signing_key.verifying_key();

    // 1. Create session
    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "COMPATIBILITY",
                "output_schema_id": "test_schema",
                "output_schema": mediation_schema(),
                "participants": ["alice", "bob"],
                "prompt_template_hash": prompt_hash,
                "entropy_budget_bits": 32
            }))
            .unwrap(),
            "will-be-recomputed".to_string(),
            "anthropic".to_string(),
        )
        .await;

    // 2. Submit initiator input
    let app = build_router(Arc::new(AppState {
        signing_key: test_signing_key(),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some(mock_base_url.clone()),
        openai_api_key: None,
        openai_model_id: "gpt-4o".to_string(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: "gemini-2.5-flash".to_string(),
        gemini_base_url: None,
        prompt_program_dir: prompt_dir.clone(),
        session_store: state.session_store.clone(),
        enforcement_policy: test_enforcement_policy(),
        enforcement_policy_hash: "0".repeat(64),
        agent_registry: AgentRegistry::empty(),
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        is_dev: false,
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/sessions/{session_id}/input"))
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!("Bearer {}", tokens.initiator_submit),
                )
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "role": "alice",
                        "context": { "preference": "morning" }
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["state"], "PARTIAL");

    // 3. Submit responder input (triggers inference)
    let app = build_router(Arc::new(AppState {
        signing_key: test_signing_key(),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some(mock_base_url.clone()),
        openai_api_key: None,
        openai_model_id: "gpt-4o".to_string(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: "gemini-2.5-flash".to_string(),
        gemini_base_url: None,
        prompt_program_dir: prompt_dir.clone(),
        session_store: state.session_store.clone(),
        enforcement_policy: test_enforcement_policy(),
        enforcement_policy_hash: "0".repeat(64),
        agent_registry: AgentRegistry::empty(),
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        is_dev: false,
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/sessions/{session_id}/input"))
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!("Bearer {}", tokens.responder_submit),
                )
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "role": "bob",
                        "context": { "preference": "afternoon" }
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    // 4. Wait for inference to complete
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let (s, _) = state.session_store.get_state(&session_id).await.unwrap();
        if s == agentvault_relay::session::SessionState::Completed
            || s == agentvault_relay::session::SessionState::Aborted
        {
            break;
        }
    }

    let (final_state, abort_reason) = state.session_store.get_state(&session_id).await.unwrap();
    assert_eq!(
        final_state,
        agentvault_relay::session::SessionState::Completed,
        "session should be completed, abort_reason: {:?}",
        abort_reason
    );

    // 5. Retrieve output with read token
    let app = build_router(Arc::new(AppState {
        signing_key: test_signing_key(),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some(mock_base_url),
        openai_api_key: None,
        openai_model_id: "gpt-4o".to_string(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: "gemini-2.5-flash".to_string(),
        gemini_base_url: None,
        prompt_program_dir: prompt_dir.clone(),
        session_store: state.session_store.clone(),
        enforcement_policy: test_enforcement_policy(),
        enforcement_policy_hash: "0".repeat(64),
        agent_registry: AgentRegistry::empty(),
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        is_dev: false,
    }));

    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/sessions/{session_id}/output"))
                .header("authorization", format!("Bearer {}", tokens.initiator_read))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["state"], "COMPLETED");
    assert_eq!(json["output"], mock_output);
    assert!(json["receipt"].is_object());
    assert!(json["receipt_signature"].is_string());

    // 6. Verify receipt
    let receipt = &json["receipt"];
    assert_eq!(receipt["execution_lane"], "API_MEDIATED");
    assert_eq!(receipt["status"], "COMPLETED");

    let receipt_sig = json["receipt_signature"].as_str().unwrap();
    assert_eq!(receipt_sig.len(), 128);

    let unsigned: receipt_core::UnsignedReceipt = serde_json::from_value(receipt.clone()).unwrap();
    receipt_core::verify_receipt(&unsigned, receipt_sig, &verifying_key)
        .expect("bilateral session receipt must verify");

    std::fs::remove_dir_all(&prompt_dir).ok();
}

// ============================================================================
// Contract hash verification at submit time
// ============================================================================

#[tokio::test]
async fn test_submit_with_correct_contract_hash_succeeds() {
    let real_hash = "correct_hash_abc";
    let state = Arc::new(test_app_state("http://unused", "/tmp"));

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "COMPATIBILITY",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            real_hash.to_string(),
            "anthropic".to_string(),
        )
        .await;

    let app = build_router(Arc::new(AppState {
        signing_key: test_signing_key(),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some("http://unused".to_string()),
        openai_api_key: None,
        openai_model_id: "gpt-4o".to_string(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: "gemini-2.5-flash".to_string(),
        gemini_base_url: None,
        prompt_program_dir: "/tmp".to_string(),
        session_store: state.session_store.clone(),
        enforcement_policy: test_enforcement_policy(),
        enforcement_policy_hash: "0".repeat(64),
        agent_registry: AgentRegistry::empty(),
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        is_dev: false,
    }));

    let input_request = serde_json::json!({
        "role": "alice",
        "context": { "preference": "morning" },
        "expected_contract_hash": real_hash
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/sessions/{session_id}/input"))
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!("Bearer {}", tokens.initiator_submit),
                )
                .body(Body::from(serde_json::to_vec(&input_request).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_submit_with_wrong_contract_hash_rejected() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "COMPATIBILITY",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "real_hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    let app = build_router(Arc::new(AppState {
        signing_key: test_signing_key(),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some("http://unused".to_string()),
        openai_api_key: None,
        openai_model_id: "gpt-4o".to_string(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: "gemini-2.5-flash".to_string(),
        gemini_base_url: None,
        prompt_program_dir: "/tmp".to_string(),
        session_store: state.session_store.clone(),
        enforcement_policy: test_enforcement_policy(),
        enforcement_policy_hash: "0".repeat(64),
        agent_registry: AgentRegistry::empty(),
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        is_dev: false,
    }));

    let input_request = serde_json::json!({
        "role": "bob",
        "context": { "preference": "evening" },
        "expected_contract_hash": "wrong_hash_xyz"
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/sessions/{session_id}/input"))
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!("Bearer {}", tokens.responder_submit),
                )
                .body(Body::from(serde_json::to_vec(&input_request).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    // Contract mismatch returns 400 (contract validation error)
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_submit_without_contract_hash_still_works() {
    let state = Arc::new(test_app_state("http://unused", "/tmp"));

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "COMPATIBILITY",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    let app = build_router(Arc::new(AppState {
        signing_key: test_signing_key(),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some("http://unused".to_string()),
        openai_api_key: None,
        openai_model_id: "gpt-4o".to_string(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: "gemini-2.5-flash".to_string(),
        gemini_base_url: None,
        prompt_program_dir: "/tmp".to_string(),
        session_store: state.session_store.clone(),
        enforcement_policy: test_enforcement_policy(),
        enforcement_policy_hash: "0".repeat(64),
        agent_registry: AgentRegistry::empty(),
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        is_dev: false,
    }));

    // No expected_contract_hash field — backward compat
    let input_request = serde_json::json!({
        "role": "alice",
        "context": {}
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/sessions/{session_id}/input"))
                .header("content-type", "application/json")
                .header(
                    "authorization",
                    format!("Bearer {}", tokens.initiator_submit),
                )
                .body(Body::from(serde_json::to_vec(&input_request).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
}

// ============================================================================
// Inbox endpoint integration tests
// ============================================================================

/// Build an AppState with agent registry populated for inbox testing.
fn inbox_test_app_state() -> AppState {
    let (prompt_dir, _) = setup_prompt_program("inbox_test");
    let registry = AgentRegistry::from_agents(vec![
        RegisteredAgent {
            agent_id: "alice".to_string(),
            inbox_token: "alice_token_123".to_string(),
            public_key_hex: None,
        },
        RegisteredAgent {
            agent_id: "bob".to_string(),
            inbox_token: "bob_token_456".to_string(),
            public_key_hex: None,
        },
    ])
    .unwrap();
    AppState {
        signing_key: test_signing_key(),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some("http://localhost:9999".to_string()),
        openai_api_key: None,
        openai_model_id: "gpt-4o".to_string(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: "gemini-2.5-flash".to_string(),
        gemini_base_url: None,
        prompt_program_dir: prompt_dir,
        session_store: SessionStore::new(Duration::from_secs(600)),
        enforcement_policy: test_enforcement_policy(),
        enforcement_policy_hash: "0".repeat(64),
        agent_registry: registry,
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        is_dev: false,
    }
}

fn inbox_create_body() -> String {
    serde_json::json!({
        "to_agent_id": "bob",
        "contract": {
            "purpose_code": "COMPATIBILITY",
            "output_schema_id": "test",
            "output_schema": {"type": "object"},
            "participants": ["alice", "bob"],
            "prompt_template_hash": "a".repeat(64),
            "metadata": null
        },
        "provider": "anthropic",
        "purpose_code": "COMPATIBILITY"
    })
    .to_string()
}

#[tokio::test]
async fn test_inbox_create_invite_happy_path() {
    let state = Arc::new(inbox_test_app_state());
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/invites")
                .header("content-type", "application/json")
                .header("authorization", "Bearer alice_token_123")
                .body(Body::from(inbox_create_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 1024 * 64)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(body["invite_id"].as_str().unwrap().starts_with("inv_"));
    assert_eq!(body["status"], "PENDING");
}

#[tokio::test]
async fn test_inbox_create_invite_no_auth_returns_401() {
    let state = Arc::new(inbox_test_app_state());
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/invites")
                .header("content-type", "application/json")
                .body(Body::from(inbox_create_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_inbox_create_invite_wrong_token_returns_401() {
    let state = Arc::new(inbox_test_app_state());
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/invites")
                .header("content-type", "application/json")
                .header("authorization", "Bearer invalid_token")
                .body(Body::from(inbox_create_body()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// C3: InviteNotFound returns 401 (constant-shape — indistinguishable from bad token).
#[tokio::test]
async fn test_inbox_invite_not_found_returns_401_constant_shape() {
    let state = Arc::new(inbox_test_app_state());
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/invites/inv_nonexistent")
                .header("authorization", "Bearer alice_token_123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // InviteNotFound maps to 401 UNAUTHORIZED (constant-shape security).
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 1024 * 64)
            .await
            .unwrap(),
    )
    .unwrap();
    // Same error body as bad-token 401
    assert_eq!(body["error"], "UNAUTHORIZED");
}

#[tokio::test]
async fn test_inbox_list_inbox_returns_ok() {
    let state = Arc::new(inbox_test_app_state());
    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/inbox")
                .header("authorization", "Bearer bob_token_456")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 1024 * 64)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(body["invites"].as_array().unwrap().is_empty());
    assert_eq!(body["latest_event_id"], 0);
}

/// Cross-agent isolation: Alice cannot see Bob's inbox.
#[tokio::test]
async fn test_inbox_cross_agent_isolation() {
    let state = Arc::new(inbox_test_app_state());

    // Create an invite to Bob via the store directly
    let create_req = agentvault_relay::inbox_types::CreateInviteRequest {
        to_agent_id: "bob".to_string(),
        contract: agentvault_relay::types::Contract {
            purpose_code: vault_family_types::Purpose::Compatibility,
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
        },
        provider: "anthropic".to_string(),
        purpose_code: "COMPATIBILITY".to_string(),
        from_agent_pubkey: None,
    };
    state
        .inbox_store
        .create_invite("alice", &create_req, None)
        .await
        .unwrap();

    let app = build_router(state);

    // Alice's inbox should be empty (invite is TO bob, not TO alice)
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/inbox")
                .header("authorization", "Bearer alice_token_123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 1024 * 64)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(body["invites"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn test_inbox_accept_creates_session() {
    let state = Arc::new(inbox_test_app_state());

    // Create invite via store
    let create_req = agentvault_relay::inbox_types::CreateInviteRequest {
        to_agent_id: "bob".to_string(),
        contract: agentvault_relay::types::Contract {
            purpose_code: vault_family_types::Purpose::Compatibility,
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
        },
        provider: "anthropic".to_string(),
        purpose_code: "COMPATIBILITY".to_string(),
        from_agent_pubkey: None,
    };
    let inv = state
        .inbox_store
        .create_invite("alice", &create_req, None)
        .await
        .unwrap();

    let app = build_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/invites/{}/accept", inv.invite_id))
                .header("content-type", "application/json")
                .header("authorization", "Bearer bob_token_456")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 1024 * 64)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(body["session_id"].as_str().is_some());
    assert!(body["responder_submit_token"].as_str().is_some());
    assert!(body["responder_read_token"].as_str().is_some());
}

/// Helper to create an invite via the store (reduces boilerplate).
async fn create_test_invite(state: &AppState) -> String {
    let create_req = agentvault_relay::inbox_types::CreateInviteRequest {
        to_agent_id: "bob".to_string(),
        contract: agentvault_relay::types::Contract {
            purpose_code: vault_family_types::Purpose::Compatibility,
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
        },
        provider: "anthropic".to_string(),
        purpose_code: "COMPATIBILITY".to_string(),
        from_agent_pubkey: None,
    };
    state
        .inbox_store
        .create_invite("alice", &create_req, None)
        .await
        .unwrap()
        .invite_id
}

#[tokio::test]
async fn test_inbox_decline_returns_ok() {
    let state = Arc::new(inbox_test_app_state());
    let invite_id = create_test_invite(&state).await;

    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/invites/{invite_id}/decline"))
                .header("content-type", "application/json")
                .header("authorization", "Bearer bob_token_456")
                .body(Body::from(r#"{"reason_code": "BUSY"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 1024 * 64)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["status"], "DECLINED");
}

#[tokio::test]
async fn test_inbox_cancel_returns_ok() {
    let state = Arc::new(inbox_test_app_state());
    let invite_id = create_test_invite(&state).await;

    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/invites/{invite_id}/cancel"))
                .header("authorization", "Bearer alice_token_123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 1024 * 64)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["status"], "CANCELED");
}

/// Accept a canceled invite → 409 CONFLICT.
#[tokio::test]
async fn test_inbox_accept_canceled_returns_409() {
    let state = Arc::new(inbox_test_app_state());
    let invite_id = create_test_invite(&state).await;

    // Cancel it first via the store
    state
        .inbox_store
        .cancel_invite(&invite_id, "alice")
        .await
        .unwrap();

    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/invites/{invite_id}/accept"))
                .header("content-type", "application/json")
                .header("authorization", "Bearer bob_token_456")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
}

/// Cancel an accepted invite → 409 CONFLICT.
#[tokio::test]
async fn test_inbox_cancel_accepted_returns_409() {
    let state = Arc::new(inbox_test_app_state());
    let invite_id = create_test_invite(&state).await;

    // Accept it first via the store
    state
        .inbox_store
        .accept_invite(&invite_id, "bob", None, &state.session_store)
        .await
        .unwrap();

    let app = build_router(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/invites/{invite_id}/cancel"))
                .header("authorization", "Bearer alice_token_123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CONFLICT);
}

// ============================================================================
// entropy-core smoke test (AV #61)
// ============================================================================

/// Verify that the relay correctly calls through to entropy_core::calculate_schema_entropy_upper_bound
/// with a real schema. This catches AV-specific regressions if the upstream crate API changes.
#[test]
fn entropy_core_smoke_test() {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "choice": {
                "type": "string",
                "enum": ["a", "b", "c"]
            }
        },
        "required": ["choice"],
        "additionalProperties": false
    });
    let bits = entropy_core::calculate_schema_entropy_upper_bound(&schema).unwrap();
    // 3-element enum → ceil(log2(3)) = 2 bits. Pin exact value to detect regressions.
    assert_eq!(
        bits, 2,
        "3-element enum should produce exactly 2 entropy bits"
    );
}

// ============================================================================
// Metadata endpoint tests (#56)
// ============================================================================

#[tokio::test]
async fn test_metadata_endpoint_returns_401_in_prod() {
    let state = test_app_state("http://unused", "/tmp");
    // is_dev defaults to false in test_app_state
    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "MEDIATION",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    let app = build_router(Arc::new(state));
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/sessions/{session_id}/metadata"))
                .header("authorization", format!("Bearer {}", tokens.initiator_read))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // In prod mode (is_dev=false), metadata endpoint returns 401
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_metadata_endpoint_returns_data_in_dev() {
    let (prompt_dir, _) = setup_prompt_program("meta_dev");
    let mut state = test_app_state("http://unused", &prompt_dir);
    state.is_dev = true;

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "MEDIATION",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    // Manually set metadata on the session
    state
        .session_store
        .with_session(&session_id, |session| {
            let mut meta = agentvault_relay::types::SessionMetadata::new(
                session.id.clone(),
                session.created_at,
            );
            meta.sizes.initiator_input_bytes = Some(42);
            session.metadata = Some(meta);
        })
        .await;

    let app = build_router(Arc::new(state));
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/sessions/{session_id}/metadata"))
                .header("authorization", format!("Bearer {}", tokens.initiator_read))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 16384)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["session_id"], session_id);
    assert_eq!(json["sizes"]["initiator_input_bytes"], 42);
    // Verify top-level timing and sizes keys exist
    assert!(
        json.get("timing").is_some(),
        "metadata should have 'timing' key"
    );
    assert!(
        json.get("sizes").is_some(),
        "metadata should have 'sizes' key"
    );
}

#[tokio::test]
async fn test_metadata_endpoint_rejects_submit_token() {
    let (prompt_dir, _) = setup_prompt_program("meta_submit_token");
    let mut state = test_app_state("http://unused", &prompt_dir);
    state.is_dev = true;

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "MEDIATION",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    // Inject metadata so the endpoint has something to return
    state
        .session_store
        .with_session(&session_id, |session| {
            session.metadata = Some(agentvault_relay::types::SessionMetadata::new(
                session.id.clone(),
                session.created_at,
            ));
        })
        .await;

    let app = build_router(Arc::new(state));

    // Request with submit token should be rejected
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/sessions/{session_id}/metadata"))
                .header(
                    "authorization",
                    format!("Bearer {}", tokens.initiator_submit),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn test_metadata_returns_empty_when_not_populated() {
    let (prompt_dir, _) = setup_prompt_program("meta_empty");
    let mut state = test_app_state("http://unused", &prompt_dir);
    state.is_dev = true;

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "MEDIATION",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    // Do NOT set metadata — session.metadata is None

    let app = build_router(Arc::new(state));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/sessions/{session_id}/metadata"))
                .header("authorization", format!("Bearer {}", tokens.initiator_read))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    // Should return 200 with empty timing/sizes instead of 401
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 16384)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(
        json.get("timing").is_some(),
        "empty metadata should have 'timing' key"
    );
    assert!(
        json.get("sizes").is_some(),
        "empty metadata should have 'sizes' key"
    );
}

#[tokio::test]
async fn test_metadata_endpoint_accepts_responder_read_token() {
    let (prompt_dir, _) = setup_prompt_program("meta_responder_read");
    let mut state = test_app_state("http://unused", &prompt_dir);
    state.is_dev = true;

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "MEDIATION",
                "output_schema_id": "test",
                "output_schema": {"type": "object"},
                "participants": ["alice", "bob"],
                "prompt_template_hash": "a".repeat(64)
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    // Inject some metadata into the session
    state
        .session_store
        .with_session(&session_id, |session| {
            let mut meta = agentvault_relay::types::SessionMetadata::new(
                session.id.clone(),
                session.created_at,
            );
            meta.sizes.initiator_input_bytes = Some(99);
            session.metadata = Some(meta);
        })
        .await;

    let app = build_router(Arc::new(state));

    // Request metadata using the responder read token (not initiator_read)
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/sessions/{session_id}/metadata"))
                .header("authorization", format!("Bearer {}", tokens.responder_read))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 16384)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["session_id"], session_id);
    assert_eq!(json["sizes"]["initiator_input_bytes"], 99);
    assert!(
        json.get("timing").is_some(),
        "metadata should have 'timing' key"
    );
    assert!(
        json.get("sizes").is_some(),
        "metadata should have 'sizes' key"
    );
}
