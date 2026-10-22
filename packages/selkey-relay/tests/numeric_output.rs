//! Numeric values in released output, exercised over HTTP with a mock provider.
//!
//! The model can write the same number in many ways (`0`, `0.0`, `-0.0`,
//! `0e5`, `1.0`, `1e0`). The relay must release one representation per
//! value: the delivered output and the receipt's output hash must not depend
//! on how the provider spelled a number, and integers beyond 2^53 - 1 (which
//! have no unique spelling) must not be released.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use ed25519_dalek::SigningKey;
use tower::ServiceExt;

use selkey_relay::{
    agent_registry::AgentRegistry, build_router, inbox::InboxStore, session::SessionStore, AppState,
};

const OPERATOR_TOKEN: &str = "numeric-output-operator-token";
const NONCE_A: &str = "0101010101010101010101010101010101010101010101010101010101010101";
const NONCE_B: &str = "0202020202020202020202020202020202020202020202020202020202020202";

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[0x24u8; 32])
}

fn integer_array_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "v": {
                "type": "array",
                "maxItems": 4,
                "items": {"type": "integer", "minimum": 0, "maximum": 0}
            }
        },
        "required": ["v"],
        "additionalProperties": false
    })
}

fn integer_enum_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "n": {"type": "integer", "enum": [1]},
            "z": {"const": 0},
            "i": {"type": "integer", "minimum": 0, "maximum": 7},
            "x": {"type": "number", "enum": [0.5, 1]}
        },
        "required": ["n", "z", "i", "x"],
        "additionalProperties": false
    })
}

/// Contracts cannot carry numbers beyond 2^53 - 1, so a strict inline schema
/// bounds integers to that range.
fn safe_integer_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "i": {
                "type": "integer",
                "minimum": -9_007_199_254_740_991i64,
                "maximum": 9_007_199_254_740_991i64
            }
        },
        "required": ["i"],
        "additionalProperties": false
    })
}

/// A registry schema may leave an integer unbounded (with an operator-supplied
/// entropy bound), so the schema itself admits integers beyond 2^53 - 1.
fn unbounded_integer_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "i": {"type": "integer", "x-vcav-entropy-bits-upper-bound": 64}
        },
        "required": ["i"],
        "additionalProperties": false
    })
}

/// A dev relay. With `registered`, the schema is in the relay's schema
/// registry; otherwise the contract's strict inline schema is accepted with a
/// structurally computed entropy bound.
fn app_state(
    mock_base_url: &str,
    prompt_dir: &str,
    schema: &serde_json::Value,
    registered: bool,
) -> Arc<AppState> {
    let mut schemas = std::collections::HashMap::new();
    if registered {
        let hash = selkey_relay::relay::compute_output_schema_hash(schema).unwrap();
        schemas.insert(hash, schema.clone());
    }
    let policy = selkey_relay::enforcement_policy::RelayEnforcementPolicy {
        policy_version: "1".to_string(),
        policy_id: "numeric_output_test_policy".to_string(),
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
        schema_registry: selkey_relay::schema_registry::SchemaRegistry::from_map(schemas),
        is_dev: true,
        health_expose_model: false,
        admitted_programs: None,
        admitted_profiles: None,
        operator_token: Some(OPERATOR_TOKEN.to_string()),
        limits: Default::default(),
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
    let dir = std::env::temp_dir().join(format!("selkey-numeric-output-{test_name}"));
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

/// A mock provider whose model output is exactly `text`.
async fn start_mock_provider(text: &str) -> String {
    use axum::routing::post;
    let text = text.to_string();
    let app = axum::Router::new().route(
        "/v1/messages",
        post(move || {
            let text = text.clone();
            async move {
                axum::Json(serde_json::json!({
                    "id": "msg_mock",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": text}],
                    "model": "test-model",
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 10, "output_tokens": 5}
                }))
            }
        }),
    );
    serve(app).await
}

/// Send a request and return the status and the raw response body.
async fn send(
    state: &Arc<AppState>,
    method: &str,
    uri: &str,
    bearer: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, Vec<u8>) {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {bearer}"));
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
    (status, bytes.to_vec())
}

async fn send_json(
    state: &Arc<AppState>,
    method: &str,
    uri: &str,
    bearer: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    let (status, bytes) = send(state, method, uri, bearer, body).await;
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// What the recipient sees for a completed or aborted session.
struct Released {
    state: String,
    /// The `output` member of the delivered response body, as delivered.
    output_text: Option<String>,
    output_hash: String,
    receipt_output: Option<serde_json::Value>,
}

/// Extract the raw text of the top-level `"output":` member (serialised before
/// the receipt) from a compact JSON response body, so the delivered bytes can
/// be compared directly.
fn raw_output_member(body: &str) -> Option<String> {
    let start = body.find("\"output\":")? + "\"output\":".len();
    let rest = &body[start..];
    if rest.starts_with("null") {
        return None;
    }
    let mut depth = 0usize;
    for (i, c) in rest.char_indices() {
        match c {
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(rest[..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Run a bilateral session whose provider returns `model_text` verbatim.
async fn run_session(
    test_name: &str,
    schema: &serde_json::Value,
    registered: bool,
    model_text: &str,
) -> Released {
    let (prompt_dir, prompt_hash) = setup_prompt_program(test_name);
    let mock = start_mock_provider(model_text).await;
    let state = app_state(&mock, &prompt_dir, schema, registered);
    let contract = serde_json::json!({
        "purpose_code": "MEDIATION",
        "output_schema_id": "numeric_output_test",
        "output_schema": schema,
        "participants": ["alice", "bob"],
        "prompt_template_hash": prompt_hash,
        "entropy_budget_bits": 128
    });

    let (status, created) = send_json(
        &state,
        "POST",
        "/sessions",
        OPERATOR_TOKEN,
        Some(serde_json::json!({"contract": contract, "provider": "anthropic"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create session: {created}");
    let sid = created["session_id"].as_str().unwrap().to_string();
    for (role, token, ctx, nonce) in [
        (
            "alice",
            "initiator_submit_token",
            serde_json::json!({"a": 1}),
            NONCE_A,
        ),
        (
            "bob",
            "responder_submit_token",
            serde_json::json!({"b": 2}),
            NONCE_B,
        ),
    ] {
        let (status, body) = send_json(
            &state,
            "POST",
            &format!("/sessions/{sid}/input"),
            created[token].as_str().unwrap(),
            Some(serde_json::json!({"role": role, "context": ctx, "commitment_nonce": nonce})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{role} submit: {body}");
    }

    for _ in 0..100 {
        let (s, _) = state.session_store.get_state(&sid).await.unwrap();
        if s == selkey_relay::session::SessionState::Completed
            || s == selkey_relay::session::SessionState::Aborted
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let (status, bytes) = send(
        &state,
        "GET",
        &format!("/sessions/{sid}/output"),
        created["initiator_read_token"].as_str().unwrap(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    std::fs::remove_dir_all(&prompt_dir).ok();

    let body = String::from_utf8(bytes).unwrap();
    let response: serde_json::Value = serde_json::from_str(&body).unwrap();
    let receipt = receipt_core::verify_receipt_v3_json(
        &response["receipt"].to_string(),
        &signing_key().verifying_key(),
    )
    .unwrap_or_else(|e| panic!("receipt must verify: {e}; response: {body}"));
    Released {
        state: response["state"].as_str().unwrap().to_string(),
        output_text: raw_output_member(&body),
        output_hash: receipt.commitments.output_hash,
        receipt_output: receipt.commitments.output,
    }
}

/// Every spelling must be released with exactly the bytes and output hash of
/// `canonical`, and the delivered bytes must be the bytes that are hashed.
async fn assert_spellings_release_as(
    test_name: &str,
    schema: &serde_json::Value,
    registered: bool,
    canonical: &str,
    spellings: &[&str],
) {
    let expected = run_session(test_name, schema, registered, canonical).await;
    assert_eq!(expected.state, "COMPLETED", "{canonical} must be released");
    assert_eq!(expected.output_text.as_deref(), Some(canonical));
    assert_eq!(
        expected.output_hash,
        receipt_core::jcs::sha256_hex(canonical.as_bytes()),
        "the output hash must be over the delivered bytes"
    );
    let canonical_value: serde_json::Value = serde_json::from_str(canonical).unwrap();
    assert_eq!(expected.receipt_output.as_ref(), Some(&canonical_value));

    for (i, spelling) in spellings.iter().enumerate() {
        let released = run_session(&format!("{test_name}-{i}"), schema, registered, spelling).await;
        assert_eq!(released.state, "COMPLETED", "{spelling} must be released");
        assert_eq!(
            released.output_text.as_deref(),
            Some(canonical),
            "{spelling} must be delivered as {canonical}"
        );
        assert_eq!(
            released.output_hash, expected.output_hash,
            "{spelling} must hash as {canonical}"
        );
        let embedded = serde_json::to_string(released.receipt_output.as_ref().unwrap()).unwrap();
        assert_eq!(
            embedded, canonical,
            "{spelling} must be committed as {canonical}"
        );
    }
}

#[tokio::test]
async fn test_relay_releases_integer_array_spellings_identically() {
    assert_spellings_release_as(
        "integer-array",
        &integer_array_schema(),
        false,
        r#"{"v":[0,0,0,0]}"#,
        &[r#"{"v":[0,0.0,-0.0,0e5]}"#, r#"{"v":[-0,0E0,0.0e-3,-0e0]}"#],
    )
    .await;
}

#[tokio::test]
async fn test_relay_releases_enum_const_and_integer_spellings_identically() {
    assert_spellings_release_as(
        "integer-enum",
        &integer_enum_schema(),
        false,
        r#"{"i":5,"n":1,"x":0.5,"z":0}"#,
        &[
            r#"{"n":1.0,"z":-0.0,"i":5.0E0,"x":0.50}"#,
            r#"{"n":1e0,"z":-0,"i":0.5e1,"x":5e-1}"#,
            r#"{"n":0.1e1,"z":0e5,"i":5.0,"x":0.5000000000000000001}"#,
        ],
    )
    .await;
    // Below f64 precision this literal is the double 1.0: it is released as
    // the integer 1, exactly like `1`.
    assert_spellings_release_as(
        "integer-enum-precision",
        &integer_enum_schema(),
        false,
        r#"{"i":1,"n":1,"x":1,"z":0}"#,
        &[r#"{"n":1.0000000000000000001,"z":0,"i":1.0000000000000000001,"x":1.0}"#],
    )
    .await;
}

#[tokio::test]
async fn test_relay_releases_large_integer_spellings_identically_or_aborts() {
    for (name, schema, registered) in [
        ("safe-integer", safe_integer_schema(), false),
        ("unbounded-integer", unbounded_integer_schema(), true),
    ] {
        assert_spellings_release_as(
            name,
            &schema,
            registered,
            r#"{"i":9007199254740991}"#,
            &[
                r#"{"i":9007199254740991.0}"#,
                r#"{"i":9.007199254740991e15}"#,
                r#"{"i":90071992547409910e-1}"#,
            ],
        )
        .await;
        assert_spellings_release_as(
            &format!("{name}-negative"),
            &schema,
            registered,
            r#"{"i":-9007199254740991}"#,
            &[
                r#"{"i":-9007199254740991.0}"#,
                r#"{"i":-9.007199254740991E15}"#,
            ],
        )
        .await;
        // Beyond 2^53 - 1 an integer has no unique spelling: such output is
        // never released, whether the schema or the receipt limit rejects it.
        for (i, text) in [
            r#"{"i":9007199254740992}"#,
            r#"{"i":9007199254740992.0}"#,
            r#"{"i":9.007199254740992e15}"#,
            r#"{"i":-9007199254740993}"#,
            r#"{"i":1152921504606846976}"#,
            r#"{"i":1e300}"#,
        ]
        .iter()
        .enumerate()
        {
            let released = run_session(&format!("{name}-out-{i}"), &schema, registered, text).await;
            assert_eq!(
                released.state, "ABORTED",
                "{name}: {text} must not be released"
            );
            assert_eq!(
                released.output_text, None,
                "{name}: {text} must not be delivered"
            );
            assert_eq!(released.receipt_output, None);
            assert_eq!(released.output_hash, receipt_core::jcs::sha256_hex(b""));
        }
    }
}
