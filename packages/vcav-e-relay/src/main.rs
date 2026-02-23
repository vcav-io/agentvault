use std::sync::Arc;
use std::time::Duration;

use ed25519_dalek::SigningKey;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use agentvault_relay::{build_router, session::SessionStore, AppState};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let api_key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY must be set");
    let model_id = std::env::var("VCAV_MODEL_ID")
        .unwrap_or_else(|_| "claude-sonnet-4-5-20250929".to_string());
    let prompt_dir =
        std::env::var("VCAV_PROMPT_PROGRAM_DIR").unwrap_or_else(|_| "prompt_programs".to_string());
    let port: u16 = std::env::var("VCAV_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3100);

    let signing_key = match std::env::var("VCAV_SIGNING_KEY_HEX") {
        Ok(hex_str) => {
            let bytes = hex::decode(&hex_str).expect("VCAV_SIGNING_KEY_HEX must be valid hex");
            let bytes: [u8; 32] = bytes
                .try_into()
                .expect("VCAV_SIGNING_KEY_HEX must be exactly 64 hex characters (32 bytes)");
            let key = SigningKey::from_bytes(&bytes);
            tracing::info!(
                verifying_key_hex = %receipt_core::public_key_to_hex(&key.verifying_key()),
                "Loaded relay signing key from VCAV_SIGNING_KEY_HEX"
            );
            key
        }
        Err(_) => {
            let key = SigningKey::generate(&mut rand::thread_rng());
            tracing::warn!(
                verifying_key_hex = %receipt_core::public_key_to_hex(&key.verifying_key()),
                "No VCAV_SIGNING_KEY_HEX set — generated ephemeral signing key (receipts will not verify across restarts)"
            );
            key
        }
    };

    let anthropic_base_url = std::env::var("ANTHROPIC_BASE_URL").ok();

    let session_ttl_secs: u64 = std::env::var("VCAV_SESSION_TTL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    let session_store = SessionStore::new(Duration::from_secs(session_ttl_secs));

    // Start background session reaper
    session_store.clone().start_reaper();

    let state = Arc::new(AppState {
        signing_key,
        anthropic_api_key: api_key,
        anthropic_model_id: model_id,
        anthropic_base_url,
        prompt_program_dir: prompt_dir,
        session_store,
    });

    let app = build_router(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!(%addr, session_ttl_secs, "AgentVault relay starting");
    let listener = TcpListener::bind(&addr).await.expect("bind failed");
    axum::serve(listener, app).await.expect("server error");
}
