pub mod error;
pub mod prompt_program;
pub mod provider;
pub mod relay;
pub mod types;

use std::sync::Arc;

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use ed25519_dalek::SigningKey;

use crate::types::{CapabilitiesResponse, HealthResponse, RelayRequest, RelayResponse};

const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct AppState {
    pub signing_key: SigningKey,
    pub anthropic_api_key: String,
    pub anthropic_model_id: String,
    pub anthropic_base_url: Option<String>,
    pub prompt_program_dir: String,
}

async fn health_handler() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: VERSION,
        execution_lane: "API_MEDIATED",
    })
}

async fn capabilities_handler() -> Json<CapabilitiesResponse> {
    Json(CapabilitiesResponse {
        execution_lane: "API_MEDIATED",
        providers: vec!["anthropic"],
        purposes: guardian_core::Purpose::all()
            .iter()
            .map(|p| p.to_string())
            .collect(),
        entropy_enforcement: "ADVISORY",
        receipt_schema_version: receipt_core::SCHEMA_VERSION,
    })
}

async fn relay_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RelayRequest>,
) -> Result<Json<RelayResponse>, error::RelayError> {
    let response = relay::relay(request, &state).await?;
    Ok(Json(response))
}

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/capabilities", get(capabilities_handler))
        .route("/relay", post(relay_handler))
        .with_state(state)
}
