//! Integration tests for VCAV-E relay.
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

use axum::body::Body;
use axum::http::{Request, StatusCode};
use ed25519_dalek::SigningKey;
use tower::ServiceExt;

use vcav_e_relay::{build_router, AppState};

/// Build a test signing key (deterministic).
fn test_signing_key() -> SigningKey {
    SigningKey::from_bytes(&[0x42u8; 32])
}

/// Build a test AppState pointing at a mock Anthropic server.
fn test_app_state(mock_base_url: &str, prompt_dir: &str) -> AppState {
    AppState {
        signing_key: test_signing_key(),
        anthropic_api_key: "test-key".to_string(),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some(mock_base_url.to_string()),
        prompt_program_dir: prompt_dir.to_string(),
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
    use vcav_e_relay::prompt_program::PromptProgram;

    let program = PromptProgram {
        version: "1.0.0".to_string(),
        system_instruction: "You are a structured data classifier.".to_string(),
        input_format: vcav_e_relay::prompt_program::InputFormat::Structured,
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
    use guardian_core::{calculate_schema_entropy_upper_bound, generate_pair_id, BudgetTier, Purpose};
    use receipt_core::{
        BudgetUsageRecord, ExecutionLane, ModelIdentity, Receipt, ReceiptStatus, SignalClass,
    };
    use sha2::{Digest, Sha256};

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
    use guardian_core::{BudgetTier, Purpose};
    use receipt_core::{BudgetUsageRecord, ExecutionLane, Receipt, ReceiptStatus};
    use sha2::{Digest, Sha256};

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
    use guardian_core::calculate_schema_entropy_upper_bound;

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
    use guardian_core::{BudgetTier, Purpose};
    use receipt_core::{
        BudgetUsageRecord, ExecutionLane, Receipt, ReceiptStatus, SignalClass,
    };
    use sha2::{Digest, Sha256};

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
    let unsigned: receipt_core::UnsignedReceipt =
        serde_json::from_value(receipt.clone()).unwrap();
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
