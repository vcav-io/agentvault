//! Receipt v3 behaviour of the relay, exercised over HTTP with a mock provider.
//!
//! Covers: the required client commitment nonce, salted input commitments,
//! the participant's own-input check, contract hash v2, and v3 success and
//! failure receipts.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use tower::ServiceExt;

use selkey_relay::{
    agent_registry::AgentRegistry, build_router, inbox::InboxStore, session::SessionStore, AppState,
};

const OPERATOR_TOKEN: &str = "receipt-v3-operator-token";

const NONCE_A: &str = "0101010101010101010101010101010101010101010101010101010101010101";
const NONCE_B: &str = "0202020202020202020202020202020202020202020202020202020202020202";
const NONCE_C: &str = "0303030303030303030303030303030303030303030303030303030303030303";

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[0x42u8; 32])
}

fn mediation_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "decision": {"type": "string", "enum": ["PROCEED", "DECLINE", "DEFER"]},
            "confidence_bucket": {"type": "string", "enum": ["HIGH", "MEDIUM", "LOW"]},
            "reason_code": {"type": "string", "enum": ["ALIGNED", "MISALIGNED", "UNCLEAR"]}
        },
        "required": ["decision", "confidence_bucket", "reason_code"],
        "additionalProperties": false
    })
}

fn mock_output() -> serde_json::Value {
    serde_json::json!({
        "decision": "PROCEED",
        "confidence_bucket": "HIGH",
        "reason_code": "ALIGNED"
    })
}

fn app_state(mock_base_url: &str, prompt_dir: &str) -> Arc<AppState> {
    let schema = mediation_schema();
    let schema_hash = selkey_relay::relay::compute_output_schema_hash(&schema).unwrap();
    let policy = selkey_relay::enforcement_policy::RelayEnforcementPolicy {
        policy_version: "1".to_string(),
        policy_id: "receipt_v3_test_policy".to_string(),
        policy_scope: "RELAY_GLOBAL".to_string(),
        model_profile_allowlist: vec![],
        provider_allowlist: vec![],
        max_output_tokens: None,
        rules: vec![],
        entropy_constraints: None,
    };
    let policy_hash = selkey_relay::enforcement_policy::content_hash(&policy).unwrap();
    Arc::new(AppState {
        signing_key: signing_key(),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some(mock_base_url.to_string()),
        openai_api_key: None,
        openai_model_id: String::new(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: String::new(),
        gemini_base_url: None,
        prompt_program_dir: prompt_dir.to_string(),
        session_store: SessionStore::new(Duration::from_secs(600)),
        policy_registry: selkey_relay::enforcement_policy::PolicyRegistry::single(
            policy,
            policy_hash,
        ),
        agent_registry: AgentRegistry::empty(),
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        session_ttl_secs: 600,
        invite_ttl_secs: 600,
        schema_registry: selkey_relay::schema_registry::SchemaRegistry::from_map(
            std::collections::HashMap::from([(schema_hash, schema)]),
        ),
        is_dev: false,
        health_expose_model: false,
        admitted_programs: None,
        admitted_profiles: None,
        operator_token: Some(OPERATOR_TOKEN.to_string()),
    })
}

fn setup_prompt_program(test_name: &str) -> (String, String) {
    use selkey_relay::prompt_program::PromptProgram;
    let program = PromptProgram {
        version: "1.0.0".to_string(),
        system_instruction: "You are a structured data classifier.".to_string(),
        input_format: selkey_relay::prompt_program::InputFormat::Structured,
    };
    let hash = program.content_hash().unwrap();
    let dir = std::env::temp_dir().join(format!("selkey-receipt-v3-{test_name}"));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(format!("{hash}.json")),
        serde_json::to_string(&program).unwrap(),
    )
    .unwrap();
    (dir.to_str().unwrap().to_string(), hash)
}

async fn serve(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://127.0.0.1:{port}", port = addr.port())
}

async fn start_mock_provider() -> String {
    use axum::routing::post;
    let app = axum::Router::new().route(
        "/v1/messages",
        post(|| async {
            axum::Json(serde_json::json!({
                "id": "msg_mock",
                "type": "message",
                "role": "assistant",
                "content": [{"type": "text", "text": mock_output().to_string()}],
                "model": "test-model",
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 10, "output_tokens": 5}
            }))
        }),
    );
    serve(app).await
}

async fn start_failing_mock_provider() -> String {
    use axum::routing::post;
    let app = axum::Router::new().route(
        "/v1/messages",
        post(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "mock provider error") }),
    );
    serve(app).await
}

fn contract(prompt_hash: &str) -> serde_json::Value {
    serde_json::json!({
        "purpose_code": "MEDIATION",
        "output_schema_id": "vault_result_mediation",
        "output_schema": mediation_schema(),
        "participants": ["alice", "bob"],
        "prompt_template_hash": prompt_hash,
        "entropy_budget_bits": 32
    })
}

async fn send(
    state: &Arc<AppState>,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = bearer {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some(b) => builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&b).unwrap()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = build_router(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let json = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&bytes).into()));
    (status, json)
}

async fn create_session(
    state: &Arc<AppState>,
    contract: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    send(
        state,
        "POST",
        "/sessions",
        Some(OPERATOR_TOKEN),
        Some(serde_json::json!({"contract": contract, "provider": "anthropic"})),
    )
    .await
}

async fn submit(
    state: &Arc<AppState>,
    session_id: &str,
    token: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    send(
        state,
        "POST",
        &format!("/sessions/{session_id}/input"),
        Some(token),
        Some(body),
    )
    .await
}

/// Run a full bilateral session and return the session output response.
async fn run_session(
    state: &Arc<AppState>,
    prompt_hash: &str,
    context_a: serde_json::Value,
    nonce_a: &str,
    context_b: serde_json::Value,
    nonce_b: &str,
) -> serde_json::Value {
    let (status, created) = create_session(state, contract(prompt_hash)).await;
    assert_eq!(status, StatusCode::OK, "create session: {created}");
    let sid = created["session_id"].as_str().unwrap().to_string();

    let (status, body) = submit(
        state,
        &sid,
        created["initiator_submit_token"].as_str().unwrap(),
        serde_json::json!({"role": "alice", "context": context_a, "commitment_nonce": nonce_a}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "initiator submit: {body}");
    let (status, body) = submit(
        state,
        &sid,
        created["responder_submit_token"].as_str().unwrap(),
        serde_json::json!({"role": "bob", "context": context_b, "commitment_nonce": nonce_b}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "responder submit: {body}");

    for _ in 0..100 {
        let (s, _) = state.session_store.get_state(&sid).await.unwrap();
        if s == selkey_relay::session::SessionState::Completed
            || s == selkey_relay::session::SessionState::Aborted
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let (status, output) = send(
        state,
        "GET",
        &format!("/sessions/{sid}/output"),
        Some(created["initiator_read_token"].as_str().unwrap()),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    output
}

fn nonce_bytes(hex_nonce: &str) -> [u8; 32] {
    receipt_core::parse_commitment_nonce(hex_nonce).unwrap()
}

/// Parse and verify a receipt from a response against the relay key.
fn verified_receipt(receipt: &serde_json::Value) -> receipt_core::ReceiptV3 {
    let text = serde_json::to_string(receipt).unwrap();
    receipt_core::verify_receipt_v3_json(&text, &signing_key().verifying_key())
        .unwrap_or_else(|e| panic!("receipt does not verify as v3: {e}; receipt: {receipt}"))
}

fn commitment_for<'a>(receipt: &'a receipt_core::ReceiptV3, participant: &str) -> &'a str {
    &receipt
        .commitments
        .input_commitments
        .iter()
        .find(|e| e.participant_id == participant)
        .unwrap_or_else(|| panic!("no input commitment for {participant}"))
        .input_commitment
}

// ============================================================================
// Commitment nonce is required
// ============================================================================

#[tokio::test]
async fn test_submit_rejects_missing_or_malformed_commitment_nonce() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("nonce-required");
    let state = app_state("http://127.0.0.1:9", &prompt_dir);
    let (status, created) = create_session(&state, contract(&prompt_hash)).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let sid = created["session_id"].as_str().unwrap();
    let token = created["initiator_submit_token"].as_str().unwrap();

    let uppercase = "0A".repeat(32);
    let bad_nonces: Vec<(&str, Option<serde_json::Value>)> = vec![
        ("missing", None),
        ("short", Some(serde_json::json!(&NONCE_A[..62]))),
        ("long", Some(serde_json::json!(format!("{NONCE_A}00")))),
        ("uppercase", Some(serde_json::json!(uppercase))),
        ("non-hex", Some(serde_json::json!("zz".repeat(32)))),
        ("number", Some(serde_json::json!(12345))),
        ("null", Some(serde_json::Value::Null)),
    ];
    for (label, nonce) in bad_nonces {
        let mut body = serde_json::json!({"role": "alice", "context": {"x": "y"}});
        if let Some(n) = nonce {
            body["commitment_nonce"] = n;
        }
        let (status, resp) = submit(&state, sid, token, body).await;
        assert!(
            status.is_client_error(),
            "{label} commitment_nonce must be rejected, got {status}: {resp}"
        );
        // The session must not have recorded the input.
        let submitted = state
            .session_store
            .with_session(sid, |s| s.initiator_submitted)
            .await
            .unwrap();
        assert!(!submitted, "{label} nonce must not record the input");
    }

    // A well-formed nonce is accepted.
    let (status, resp) = submit(
        &state,
        sid,
        token,
        serde_json::json!({"role": "alice", "context": {"x": "y"}, "commitment_nonce": NONCE_A}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp}");
    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_rejected_nonce_is_not_echoed_in_error() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("nonce-not-echoed");
    let state = app_state("http://127.0.0.1:9", &prompt_dir);
    let (_, created) = create_session(&state, contract(&prompt_hash)).await;
    let sid = created["session_id"].as_str().unwrap();
    let token = created["initiator_submit_token"].as_str().unwrap();
    let almost = "ab".repeat(31) + "AB";
    let (status, resp) = submit(
        &state,
        sid,
        token,
        serde_json::json!({"role": "alice", "context": {}, "commitment_nonce": almost}),
    )
    .await;
    assert!(status.is_client_error());
    assert!(
        !resp.to_string().contains(&almost),
        "error must not echo the nonce: {resp}"
    );
    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_single_shot_relay_requires_a_nonce_for_each_input() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("relay-nonce-required");
    let mock = start_mock_provider().await;
    let state = app_state(&mock, &prompt_dir);

    let body = |nonce_a: Option<&str>, nonce_b: Option<&str>| {
        let mut input_a = serde_json::json!({"role": "alice", "context": {"p": "morning"}});
        let mut input_b = serde_json::json!({"role": "bob", "context": {"p": "evening"}});
        if let Some(n) = nonce_a {
            input_a["commitment_nonce"] = serde_json::json!(n);
        }
        if let Some(n) = nonce_b {
            input_b["commitment_nonce"] = serde_json::json!(n);
        }
        serde_json::json!({
            "contract": contract(&prompt_hash),
            "input_a": input_a,
            "input_b": input_b,
            "provider": "anthropic"
        })
    };

    for (label, a, b) in [
        ("missing on input_a", None, Some(NONCE_B)),
        ("missing on input_b", Some(NONCE_A), None),
        ("short on input_a", Some(&NONCE_A[..10]), Some(NONCE_B)),
    ] {
        let (status, resp) = send(
            &state,
            "POST",
            "/relay",
            Some(OPERATOR_TOKEN),
            Some(body(a, b)),
        )
        .await;
        assert!(
            status.is_client_error(),
            "/relay with nonce {label} must be rejected, got {status}: {resp}"
        );
    }

    let (status, resp) = send(
        &state,
        "POST",
        "/relay",
        Some(OPERATOR_TOKEN),
        Some(body(Some(NONCE_A), Some(NONCE_B))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{resp}");
    let receipt = verified_receipt(&resp["receipt"]);
    let ctx_a = serde_json::json!({"p": "morning"});
    assert!(receipt_core::verify_input_commitment_v3(
        &nonce_bytes(NONCE_A),
        &ctx_a,
        commitment_for(&receipt, "alice")
    )
    .unwrap());
    std::fs::remove_dir_all(&prompt_dir).ok();
}

// ============================================================================
// Salted input commitments
// ============================================================================

#[tokio::test]
async fn test_input_commitment_depends_on_nonce() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("commitment-depends-on-nonce");
    let mock = start_mock_provider().await;
    let state = app_state(&mock, &prompt_dir);
    let ctx = serde_json::json!({"budget": "high"});
    let other = serde_json::json!({"budget": "low"});

    let first = run_session(
        &state,
        &prompt_hash,
        ctx.clone(),
        NONCE_A,
        other.clone(),
        NONCE_B,
    )
    .await;
    let second = run_session(&state, &prompt_hash, ctx.clone(), NONCE_C, other, NONCE_B).await;
    let r1 = verified_receipt(&first["receipt"]);
    let r2 = verified_receipt(&second["receipt"]);

    assert_ne!(
        commitment_for(&r1, "alice"),
        commitment_for(&r2, "alice"),
        "the same input under different nonces must give different commitments"
    );
    // Same input and nonce for bob gives the same commitment.
    assert_eq!(commitment_for(&r1, "bob"), commitment_for(&r2, "bob"));
    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_input_commitment_differs_from_unsalted_input_hash() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("commitment-not-unsalted");
    let mock = start_mock_provider().await;
    let state = app_state(&mock, &prompt_dir);

    // A small input space that a counterparty could enumerate.
    let candidates: Vec<serde_json::Value> = ["yes", "no", "maybe"]
        .iter()
        .flat_map(|answer| (0..10).map(move |n| serde_json::json!({"answer": answer, "score": n})))
        .collect();
    let actual = serde_json::json!({"answer": "yes", "score": 7});
    assert!(candidates.contains(&actual));

    let output = run_session(
        &state,
        &prompt_hash,
        actual.clone(),
        NONCE_A,
        serde_json::json!({"answer": "no", "score": 1}),
        NONCE_B,
    )
    .await;
    let receipt = verified_receipt(&output["receipt"]);
    let committed = commitment_for(&receipt, "alice");

    // Hashing each candidate without the nonce (with either canonicaliser)
    // does not reproduce the receipt's commitment.
    for candidate in &candidates {
        let legacy = receipt_core::canonicalize_serializable(candidate).unwrap();
        let rfc8785 = receipt_core::canonicalize_v3(candidate).unwrap();
        for canonical in [legacy, rfc8785] {
            let unsalted = hex::encode(Sha256::digest(canonical.as_bytes()));
            assert_ne!(
                unsalted, committed,
                "commitment must not equal an unsalted hash of {candidate}"
            );
        }
    }
    // The participant, who holds the nonce, can open it.
    assert!(
        receipt_core::verify_input_commitment_v3(&nonce_bytes(NONCE_A), &actual, committed)
            .unwrap()
    );
    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_own_input_check_passes_with_own_nonce_and_fails_with_another() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("own-input-check");
    let mock = start_mock_provider().await;
    let state = app_state(&mock, &prompt_dir);
    let ctx_a = serde_json::json!({"notes": "café 😀", "limit": 9007199254740991u64});
    let ctx_b = serde_json::json!({"slots": ["evening"], "weight": 4.5});

    let output = run_session(
        &state,
        &prompt_hash,
        ctx_a.clone(),
        NONCE_A,
        ctx_b.clone(),
        NONCE_B,
    )
    .await;
    let receipt = verified_receipt(&output["receipt"]);

    verifier_core::check_own_input_v3(&receipt, "alice", &nonce_bytes(NONCE_A), &ctx_a)
        .expect("alice's own input must open with her nonce");
    verifier_core::check_own_input_v3(&receipt, "bob", &nonce_bytes(NONCE_B), &ctx_b)
        .expect("bob's own input must open with his nonce");
    assert!(
        verifier_core::check_own_input_v3(&receipt, "alice", &nonce_bytes(NONCE_C), &ctx_a)
            .is_err(),
        "a wrong nonce must fail the own-input check"
    );
    assert!(
        verifier_core::check_own_input_v3(&receipt, "alice", &nonce_bytes(NONCE_A), &ctx_b)
            .is_err(),
        "a different input must fail the own-input check"
    );
    // Output and contract cross-checks hold for the participant too.
    verifier_core::check_received_output_v3(&receipt, &output["output"]).unwrap();
    verifier_core::check_contract_v3(&receipt, &contract(&prompt_hash)).unwrap();

    // The nonce never appears in the response.
    let text = output.to_string();
    assert!(!text.contains(NONCE_A) && !text.contains(NONCE_B));
    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_submit_rejects_context_with_out_of_range_number() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("context-number-range");
    let state = app_state("http://127.0.0.1:9", &prompt_dir);
    let (_, created) = create_session(&state, contract(&prompt_hash)).await;
    let sid = created["session_id"].as_str().unwrap();
    let token = created["initiator_submit_token"].as_str().unwrap();
    let (status, resp) = submit(
        &state,
        sid,
        token,
        serde_json::json!({
            "role": "alice",
            "context": {"n": 9007199254740992u64},
            "commitment_nonce": NONCE_A
        }),
    )
    .await;
    assert!(status.is_client_error(), "{status}: {resp}");
    std::fs::remove_dir_all(&prompt_dir).ok();
}

// ============================================================================
// Contract hash v2
// ============================================================================

/// The contract hash main computed before contract hash v2: the legacy
/// canonical form of the typed contract struct.
fn legacy_contract_hash(contract: &serde_json::Value) -> String {
    let typed: vault_family_types::Contract = serde_json::from_value(contract.clone()).unwrap();
    let canonical = receipt_core::canonicalize_serializable(&typed).unwrap();
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

#[tokio::test]
async fn test_session_contract_hash_is_contract_hash_v2() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("contract-hash-v2");
    let state = app_state("http://127.0.0.1:9", &prompt_dir);
    let c = contract(&prompt_hash);
    let (status, created) = create_session(&state, c.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        created["contract_hash"].as_str().unwrap(),
        receipt_core::compute_contract_hash_v2(&c).unwrap()
    );
    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_submit_rejects_legacy_contract_hash() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("legacy-contract-hash");
    let state = app_state("http://127.0.0.1:9", &prompt_dir);
    let c = contract(&prompt_hash);
    let legacy = legacy_contract_hash(&c);
    assert_ne!(legacy, receipt_core::compute_contract_hash_v2(&c).unwrap());

    let (_, created) = create_session(&state, c).await;
    let sid = created["session_id"].as_str().unwrap();
    let token = created["responder_submit_token"].as_str().unwrap();
    let (status, resp) = submit(
        &state,
        sid,
        token,
        serde_json::json!({
            "role": "bob",
            "context": {"x": 1},
            "expected_contract_hash": legacy,
            "commitment_nonce": NONCE_B
        }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a legacy contract hash must not match: {resp}"
    );
    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_create_session_rejects_contract_with_unknown_members() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("contract-unknown-members");
    let state = app_state("http://127.0.0.1:9", &prompt_dir);

    let mut with_hash = contract(&prompt_hash);
    with_hash["contract_hash"] = serde_json::json!("a".repeat(64));
    let mut with_unknown = contract(&prompt_hash);
    with_unknown["note"] = serde_json::json!("not part of the contract");
    let mut with_constraint_extra = contract(&prompt_hash);
    with_constraint_extra["model_constraints"] =
        serde_json::json!({"allowed_providers": ["anthropic"], "extra": true});

    for (label, c) in [
        ("contract_hash member", with_hash),
        ("unknown member", with_unknown),
        ("unknown model_constraints member", with_constraint_extra),
    ] {
        let (status, resp) = create_session(&state, c).await;
        assert!(
            status.is_client_error(),
            "contract with {label} must be rejected, got {status}: {resp}"
        );
    }
    std::fs::remove_dir_all(&prompt_dir).ok();
}

// ============================================================================
// v3 receipts on success and failure
// ============================================================================

#[tokio::test]
async fn test_success_receipt_is_v3() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("success-receipt-v3");
    let mock = start_mock_provider().await;
    let state = app_state(&mock, &prompt_dir);
    let output = run_session(
        &state,
        &prompt_hash,
        serde_json::json!({"a": 1}),
        NONCE_A,
        serde_json::json!({"b": 2}),
        NONCE_B,
    )
    .await;

    assert_eq!(output["state"], "COMPLETED");
    assert_eq!(output["receipt"]["receipt_schema_version"], "3.0.0");
    assert!(output.get("receipt_v2").is_none());
    assert!(output.get("receipt_signature").is_none());
    let receipt = verified_receipt(&output["receipt"]);
    assert_eq!(
        receipt.commitments.contract_hash,
        receipt_core::compute_contract_hash_v2(&contract(&prompt_hash)).unwrap()
    );
    let usage = receipt.claims.budget_usage.as_ref().expect("budget usage");
    assert_eq!(usage.scope, receipt_core::BudgetScope::Session);
    assert_eq!(usage.bits_used_before, 0);
    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_failure_receipt_is_v3() {
    let (prompt_dir, prompt_hash) = setup_prompt_program("failure-receipt-v3");
    let mock = start_failing_mock_provider().await;
    let state = app_state(&mock, &prompt_dir);
    let ctx_a = serde_json::json!({"a": 1});
    let output = run_session(
        &state,
        &prompt_hash,
        ctx_a.clone(),
        NONCE_A,
        serde_json::json!({"b": 2}),
        NONCE_B,
    )
    .await;

    assert_eq!(output["state"], "ABORTED");
    assert_eq!(output["receipt"]["receipt_schema_version"], "3.0.0");
    let receipt = verified_receipt(&output["receipt"]);
    assert_eq!(
        receipt.commitments.output_hash,
        hex::encode(Sha256::digest(b"")),
        "failure receipts commit to the empty output"
    );
    assert!(receipt.commitments.output.is_none());
    verifier_core::check_own_input_v3(&receipt, "alice", &nonce_bytes(NONCE_A), &ctx_a).unwrap();
    std::fs::remove_dir_all(&prompt_dir).ok();
}

#[tokio::test]
async fn test_capabilities_report_receipt_v3() {
    let state = app_state("http://127.0.0.1:9", "/tmp/nonexistent");
    let (status, caps) = send(&state, "GET", "/capabilities", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(caps["receipt_schema_version"], "3.0.0");
}
