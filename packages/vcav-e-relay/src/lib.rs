pub mod error;
pub mod prompt_program;
pub mod provider;
pub mod relay;
pub mod session;
pub mod types;

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use ed25519_dalek::SigningKey;

use crate::error::RelayError;
use crate::relay::compute_contract_hash;
use crate::session::{SessionState, SessionStore, TokenRole};
use crate::types::{
    CapabilitiesResponse, CreateSessionRequest, CreateSessionResponse, HealthResponse,
    RelayInput, RelayRequest, RelayResponse, SessionOutputResponse, SessionStatusResponse,
    SubmitInputRequest,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct AppState {
    pub signing_key: SigningKey,
    pub anthropic_api_key: String,
    pub anthropic_model_id: String,
    pub anthropic_base_url: Option<String>,
    pub prompt_program_dir: String,
    pub session_store: SessionStore,
}

// ============================================================================
// Token extraction helper
// ============================================================================

/// Extract bearer token from Authorization header.
fn extract_bearer_token(headers: &HeaderMap) -> Result<&str, RelayError> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(RelayError::Unauthorized)
}

// ============================================================================
// Health and capabilities (unchanged)
// ============================================================================

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

// ============================================================================
// Single-shot relay (POST /relay — existing)
// ============================================================================

async fn relay_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<RelayRequest>,
) -> Result<Json<RelayResponse>, RelayError> {
    let response = relay::relay(request, &state).await?;
    Ok(Json(response))
}

// ============================================================================
// Bilateral session endpoints
// ============================================================================

/// POST /sessions — create a new bilateral session.
async fn create_session_handler(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateSessionRequest>,
) -> Result<Json<CreateSessionResponse>, RelayError> {
    // Validate provider
    if request.provider != "anthropic" {
        return Err(RelayError::ContractValidation(format!(
            "unsupported provider: {}",
            request.provider
        )));
    }

    // Validate contract has exactly 2 participants
    if request.contract.participants.len() != 2 {
        return Err(RelayError::ContractValidation(
            "contract must have exactly 2 participants".to_string(),
        ));
    }

    // Compute contract hash deterministically
    let contract_hash = compute_contract_hash(&request.contract)?;

    // Create session with tokens
    let (session_id, tokens) = state
        .session_store
        .create(request.contract, contract_hash.clone(), request.provider)
        .await;

    Ok(Json(CreateSessionResponse {
        session_id,
        contract_hash,
        initiator_submit_token: tokens.initiator_submit,
        initiator_read_token: tokens.initiator_read,
        responder_submit_token: tokens.responder_submit,
        responder_read_token: tokens.responder_read,
    }))
}

/// POST /sessions/:id/input — submit one participant's input.
async fn submit_input_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<SubmitInputRequest>,
) -> Result<Json<SessionStatusResponse>, RelayError> {
    let token = extract_bearer_token(&headers)?;

    // Validate token — returns None for unknown sessions (constant-shape).
    let role = state
        .session_store
        .validate_token(&session_id, token)
        .await
        .ok_or(RelayError::Unauthorized)?;

    // Only submit tokens can submit input
    let is_initiator = match role {
        TokenRole::InitiatorSubmit => true,
        TokenRole::ResponderSubmit => false,
        _ => return Err(RelayError::Unauthorized),
    };

    // Verify contract hash if the caller provided one
    if let Some(ref expected_hash) = request.expected_contract_hash {
        let hash_matches = state
            .session_store
            .with_session(&session_id, |session| {
                session.contract_hash == *expected_hash
            })
            .await
            .unwrap_or(false);

        if !hash_matches {
            return Err(RelayError::ContractValidation(
                "expected_contract_hash does not match session contract".to_string(),
            ));
        }
    }

    // Submit input and check if both inputs are now present
    let both_ready = state
        .session_store
        .with_session(&session_id, |session| {
            // Check one-time submit: reject if already submitted
            if is_initiator && session.initiator_submitted {
                return Err(RelayError::Unauthorized);
            }
            if !is_initiator && session.responder_submitted {
                return Err(RelayError::Unauthorized);
            }

            // Only accept input in Created or Partial state
            if session.state != SessionState::Created && session.state != SessionState::Partial {
                return Err(RelayError::ContractValidation(
                    "session not accepting inputs".to_string(),
                ));
            }

            let input = RelayInput {
                role: request.role.clone(),
                context: request.context.clone(),
            };

            if is_initiator {
                session.initiator_input = Some(input);
                session.initiator_submitted = true;
            } else {
                session.responder_input = Some(input);
                session.responder_submitted = true;
            }

            // Update state
            if session.initiator_submitted && session.responder_submitted {
                session.state = SessionState::Processing;
                Ok(true)
            } else {
                session.state = SessionState::Partial;
                Ok(false)
            }
        })
        .await
        .ok_or(RelayError::Unauthorized)??;

    // If both inputs received, spawn background inference task
    if both_ready {
        spawn_inference(state.clone(), session_id.clone()).await;
    }

    // Return current status
    let (current_state, abort_reason) = state
        .session_store
        .get_state(&session_id)
        .await
        .unwrap_or((SessionState::Created, None));

    Ok(Json(SessionStatusResponse {
        state: current_state,
        abort_reason,
    }))
}

/// Spawn the background inference task for a session.
async fn spawn_inference(state: Arc<AppState>, session_id: String) {
    // Clone what we need from the session before spawning
    let session_data = state
        .session_store
        .with_session(&session_id, |session| {
            (
                session.contract.clone(),
                session.initiator_input.clone().unwrap(),
                session.responder_input.clone().unwrap(),
                session.provider.clone(),
            )
        })
        .await;

    let Some((contract, input_a, input_b, provider)) = session_data else {
        return;
    };

    let store = state.session_store.clone();
    tokio::spawn(async move {
        match relay::relay_core(&contract, &input_a, &input_b, &provider, &state).await {
            Ok(result) => {
                store
                    .with_session(&session_id, |session| {
                        session.output = Some(result.output);
                        session.receipt = Some(result.receipt);
                        session.receipt_signature = Some(result.receipt_signature);
                        session.state = SessionState::Completed;
                    })
                    .await;
            }
            Err(e) => {
                let abort_reason = relay::error_to_abort_reason(&e);
                tracing::error!(
                    session_id = %session_id,
                    error = %e,
                    "session inference failed"
                );
                store
                    .with_session(&session_id, |session| {
                        session.state = SessionState::Aborted;
                        session.abort_reason = Some(abort_reason);
                    })
                    .await;
            }
        }
    });
}

/// GET /sessions/:id/status — poll session status.
async fn session_status_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<SessionStatusResponse>, RelayError> {
    let token = extract_bearer_token(&headers)?;

    // Any valid token (submit or read) can check status
    state
        .session_store
        .validate_token(&session_id, token)
        .await
        .ok_or(RelayError::Unauthorized)?;

    let (current_state, abort_reason) = state
        .session_store
        .get_state(&session_id)
        .await
        .ok_or(RelayError::Unauthorized)?;

    Ok(Json(SessionStatusResponse {
        state: current_state,
        abort_reason,
    }))
}

/// GET /sessions/:id/output — retrieve bounded signal + receipt.
async fn session_output_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<SessionOutputResponse>, RelayError> {
    let token = extract_bearer_token(&headers)?;

    // Only read tokens can retrieve output
    let role = state
        .session_store
        .validate_token(&session_id, token)
        .await
        .ok_or(RelayError::Unauthorized)?;

    match role {
        TokenRole::InitiatorRead | TokenRole::ResponderRead => {}
        _ => return Err(RelayError::Unauthorized),
    }

    let response = state
        .session_store
        .with_session(&session_id, |session| SessionOutputResponse {
            state: session.state,
            abort_reason: session.abort_reason,
            output: session.output.clone(),
            receipt: session.receipt.clone(),
            receipt_signature: session.receipt_signature.clone(),
        })
        .await
        .ok_or(RelayError::Unauthorized)?;

    Ok(Json(response))
}

// ============================================================================
// Router
// ============================================================================

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/capabilities", get(capabilities_handler))
        .route("/relay", post(relay_handler))
        .route("/sessions", post(create_session_handler))
        .route("/sessions/:id/input", post(submit_input_handler))
        .route("/sessions/:id/status", get(session_status_handler))
        .route("/sessions/:id/output", get(session_output_handler))
        .with_state(state)
}
