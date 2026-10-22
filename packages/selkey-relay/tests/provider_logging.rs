//! Provider error logging: logs carry the HTTP status, never response bodies.
//!
//! Lives in its own test binary so it can install a process-wide tracing
//! subscriber and capture every log line.

use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use axum::routing::post;

use selkey_relay::provider::gemini::GeminiProvider;
use selkey_relay::provider::openai::OpenAIProvider;
use selkey_relay::provider::ProviderRequest;

const MARKER: &str = "ECHOED_REQUEST_CONTENT_7f31";

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

/// A server answering every POST with `status` and a body containing MARKER.
async fn start_echo_server(status: StatusCode, body: serde_json::Value) -> String {
    let app = axum::Router::new().fallback(post(move || {
        let body = body.clone();
        async move { (status, axum::Json(body)) }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base_url
}

fn request() -> ProviderRequest {
    ProviderRequest {
        system: "system".to_string(),
        user_message: MARKER.to_string(),
        output_schema: None,
        max_tokens: 16,
    }
}

#[tokio::test]
async fn test_provider_errors_log_status_without_response_body() {
    let logs = CapturedLogs::default();
    tracing_subscriber::fmt()
        .with_writer(logs.clone())
        // Relay logs only: HTTP client internals are not under test.
        .with_env_filter("selkey_relay=trace")
        .with_ansi(false)
        .init();

    let error_body =
        serde_json::json!({ "error": { "message": format!("bad request: {MARKER}") } });

    // OpenAI error status.
    let url = start_echo_server(StatusCode::BAD_REQUEST, error_body.clone()).await;
    let provider = OpenAIProvider::new("k".to_string(), "m".to_string(), Some(url)).unwrap();
    assert!(provider.call(request()).await.is_err());

    // Gemini error status.
    let url = start_echo_server(StatusCode::BAD_REQUEST, error_body).await;
    let provider = GeminiProvider::new("k".to_string(), "m".to_string(), Some(url)).unwrap();
    assert!(provider.call(request()).await.is_err());

    // Gemini success status with no candidates / no content parts.
    for body in [
        serde_json::json!({ "promptFeedback": { "note": MARKER } }),
        serde_json::json!({ "candidates": [{ "note": MARKER, "finishReason": "STOP" }] }),
    ] {
        let url = start_echo_server(StatusCode::OK, body).await;
        let provider = GeminiProvider::new("k".to_string(), "m".to_string(), Some(url)).unwrap();
        assert!(provider.call(request()).await.is_err());
    }

    let captured = String::from_utf8_lossy(&logs.0.lock().unwrap()).into_owned();
    assert!(captured.contains("OpenAI API error"), "{captured}");
    assert!(captured.contains("Gemini API error"), "{captured}");
    assert!(
        captured.contains("400"),
        "status should be logged: {captured}"
    );
    assert!(
        !captured.contains(MARKER),
        "provider response body logged: {captured}"
    );
}
