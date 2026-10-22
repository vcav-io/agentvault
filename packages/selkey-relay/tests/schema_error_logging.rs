//! Session failure logging for output schema validation errors.
//!
//! Lives in its own test binary so it can install a process-wide tracing
//! subscriber and capture every log line without interference from other tests.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use ed25519_dalek::SigningKey;
use tower::ServiceExt;

use selkey_relay::{
    agent_registry::AgentRegistry,
    build_router,
    enforcement_policy::{content_hash, PolicyRegistry, RelayEnforcementPolicy},
    inbox::InboxStore,
    session::{AbortReason, SessionState, SessionStore},
    AppState,
};

/// Well-formed client commitment nonce (64 lowercase hex characters).
const TEST_NONCE: &str = "1111111111111111111111111111111111111111111111111111111111111111";

#[derive(Clone, Default)]
struct CapturedLogs(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLogs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CapturedLogs {
    type Writer = CapturedLogs;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

async fn start_mock_anthropic(output: serde_json::Value) -> String {
    use axum::routing::post;
    let app = axum::Router::new().route(
        "/v1/messages",
        post(move || {
            let output = output.clone();
            async move {
                axum::Json(serde_json::json!({
                    "id": "msg_mock",
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "text", "text": serde_json::to_string(&output).unwrap() }],
                    "model": "test-model",
                    "stop_reason": "end_turn",
                    "usage": { "input_tokens": 1, "output_tokens": 1 }
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base_url
}

#[tokio::test]
async fn test_session_schema_error_log_omits_output_values() {
    let logs = CapturedLogs::default();
    tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .init();

    // Prompt program on disk
    let program = selkey_relay::prompt_program::PromptProgram {
        version: "1.0.0".to_string(),
        system_instruction: "You are a structured data classifier.".to_string(),
        input_format: selkey_relay::prompt_program::InputFormat::Structured,
    };
    let prompt_hash = program.content_hash().unwrap();
    let prompt_dir = std::env::temp_dir().join("selkey-relay-schema-error-logging");
    std::fs::create_dir_all(&prompt_dir).unwrap();
    std::fs::write(
        prompt_dir.join(format!("{prompt_hash}.json")),
        serde_json::to_string(&program).unwrap(),
    )
    .unwrap();

    let mock_base_url = start_mock_anthropic(serde_json::json!({
        "decision": "PRIVATE_VALUE_ALPHA",
        "private_key_bravo": "PRIVATE_VALUE_CHARLIE"
    }))
    .await;

    let policy = RelayEnforcementPolicy {
        policy_version: "1".to_string(),
        policy_id: "test_policy".to_string(),
        policy_scope: "RELAY_GLOBAL".to_string(),
        model_profile_allowlist: vec![],
        provider_allowlist: vec![],
        max_output_tokens: None,
        rules: vec![],
        entropy_constraints: None,
    };
    let policy_hash = content_hash(&policy).unwrap();
    let output_schema = serde_json::json!({
        "type": "object",
        "properties": {
            "decision": { "type": "string", "enum": ["PROCEED", "DECLINE"] }
        },
        "required": ["decision"],
        "additionalProperties": false
    });
    let output_schema_hash =
        selkey_relay::relay::compute_output_schema_hash(&output_schema).unwrap();
    let schema_registry =
        selkey_relay::schema_registry::SchemaRegistry::from_map(std::collections::HashMap::from([
            (output_schema_hash, output_schema.clone()),
        ]));
    let state = Arc::new(AppState {
        signing_key: SigningKey::from_bytes(&[0x42u8; 32]),
        anthropic_api_key: Some("test-key".to_string()),
        anthropic_model_id: "test-model".to_string(),
        anthropic_base_url: Some(mock_base_url),
        openai_api_key: None,
        openai_model_id: String::new(),
        openai_base_url: None,
        gemini_api_key: None,
        gemini_model_id: String::new(),
        gemini_base_url: None,
        prompt_program_dir: prompt_dir.to_string_lossy().into_owned(),
        session_store: SessionStore::new(Duration::from_secs(600)),
        policy_registry: PolicyRegistry::single(policy, policy_hash),
        agent_registry: AgentRegistry::empty(),
        inbox_store: InboxStore::new(Duration::from_secs(600)),
        max_completion_tokens: 4096,
        session_ttl_secs: 600,
        invite_ttl_secs: 604800,
        schema_registry,
        is_dev: false,
        health_expose_model: false,
        admitted_programs: None,
        admitted_profiles: None,
        operator_token: None,
    });

    let (session_id, tokens) = state
        .session_store
        .create(
            serde_json::from_value(serde_json::json!({
                "purpose_code": "MEDIATION",
                "output_schema_id": "vault_result_mediation",
                "output_schema": output_schema,
                "participants": ["alice", "bob"],
                "prompt_template_hash": prompt_hash
            }))
            .unwrap(),
            "hash".to_string(),
            "anthropic".to_string(),
        )
        .await;

    for (token, role) in [
        (&tokens.initiator_submit, "alice"),
        (&tokens.responder_submit, "bob"),
    ] {
        let response = build_router(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/sessions/{session_id}/input"))
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from(
                        serde_json::to_vec(&serde_json::json!({ "role": role, "context": {}, "commitment_nonce": TEST_NONCE }))
                            .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    let mut aborted = false;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (s, reason) = state.session_store.get_state(&session_id).await.unwrap();
        if s == SessionState::Aborted {
            assert_eq!(reason, Some(AbortReason::SchemaValidation));
            aborted = true;
            break;
        }
    }
    assert!(aborted, "session should abort on schema validation failure");

    let captured = String::from_utf8_lossy(&logs.0.lock().unwrap()).into_owned();
    assert!(
        captured.contains("session inference failed"),
        "expected failure log line, got: {captured}"
    );
    assert!(captured.contains("/decision"), "missing path: {captured}");
    assert!(captured.contains("enum"), "missing keyword: {captured}");
    assert!(
        captured.contains("additionalProperties"),
        "missing keyword: {captured}"
    );
    assert!(
        !captured.contains("PRIVATE_VALUE"),
        "output value logged: {captured}"
    );
    assert!(
        !captured.contains("private_key_bravo"),
        "output key logged: {captured}"
    );

    std::fs::remove_dir_all(&prompt_dir).ok();
}
