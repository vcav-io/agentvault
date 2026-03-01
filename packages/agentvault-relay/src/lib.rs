#![cfg_attr(not(test), forbid(unsafe_code))]

pub mod agent_registry;
pub mod enforcement_policy;
pub mod error;
pub mod inbox;
pub mod inbox_handlers;
#[cfg(feature = "persistence")]
pub mod inbox_sqlite;
pub mod inbox_types;
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

use crate::agent_registry::AgentRegistry;
use crate::enforcement_policy::RelayEnforcementPolicy;
use crate::error::RelayError;
use crate::inbox::InboxStore;
use crate::relay::compute_contract_hash;
use crate::session::{SessionState, SessionStore, TokenRole};
use crate::types::{
    CapabilitiesResponse, CreateSessionRequest, CreateSessionResponse, HealthResponse, RelayInput,
    RelayRequest, RelayResponse, SessionMetadata, SessionOutputResponse, SessionStatusResponse,
    SubmitInputRequest,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const GIT_SHA: &str = env!("VCAV_GIT_SHA");

pub struct AppState {
    pub signing_key: SigningKey,
    pub anthropic_api_key: String,
    pub anthropic_model_id: String,
    pub anthropic_base_url: Option<String>,
    pub openai_api_key: Option<String>,
    pub openai_model_id: String,
    pub openai_base_url: Option<String>,
    pub prompt_program_dir: String,
    pub session_store: SessionStore,
    /// Loaded enforcement policy — rules read at runtime by the output guard.
    pub enforcement_policy: RelayEnforcementPolicy,
    /// Content hash of the loaded enforcement policy (bound into receipts).
    pub enforcement_policy_hash: String,
    /// Agent registry for inbox authentication.
    pub agent_registry: AgentRegistry,
    /// In-memory inbox store for async invites.
    pub inbox_store: InboxStore,
    /// Whether VCAV_ENV=dev — enables diagnostic endpoints.
    pub is_dev: bool,
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
        git_sha: GIT_SHA,
        execution_lane: "API_MEDIATED",
    })
}

async fn capabilities_handler(State(state): State<Arc<AppState>>) -> Json<CapabilitiesResponse> {
    let mut providers = vec!["anthropic"];
    if state.openai_api_key.is_some() {
        providers.push("openai");
    }
    Json(CapabilitiesResponse {
        execution_lane: "API_MEDIATED",
        providers,
        purposes: vault_family_types::Purpose::all()
            .iter()
            .map(|p| p.to_string())
            .collect(),
        entropy_enforcement: "ADVISORY",
        receipt_schema_version: receipt_core::SCHEMA_VERSION,
        enforcement_capabilities: enforcement_policy::supported_capability_strings(),
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
    match request.provider.as_str() {
        "anthropic" => {}
        "openai" if state.openai_api_key.is_some() => {}
        other => {
            return Err(RelayError::ContractValidation(format!(
                "unsupported provider: {other}"
            )));
        }
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

    // Compute input size for metadata (before moving into session)
    let input_bytes = if state.is_dev {
        serde_json::to_string(&request.context)
            .map(|s| s.len())
            .map_err(|e| tracing::warn!("failed to serialize input context for metadata: {e}"))
            .ok()
    } else {
        None
    };

    // Submit input and check if both inputs are now present
    let is_dev = state.is_dev;
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

            // Capture input timing and sizes in metadata
            if is_dev {
                let meta = session.metadata.get_or_insert_with(|| {
                    SessionMetadata::new(session.id.clone(), session.created_at)
                });
                let now = chrono::Utc::now();
                if is_initiator {
                    meta.timing.initiator_input_at = Some(now);
                    meta.sizes.initiator_input_bytes = input_bytes;
                } else {
                    meta.timing.responder_input_at = Some(now);
                    meta.sizes.responder_input_bytes = input_bytes;
                }
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
        tracing::error!(session_id = %session_id, "session vanished before inference could start");
        return;
    };

    let is_dev = state.is_dev;
    let store = state.session_store.clone();
    tokio::spawn(async move {
        match relay::relay_core(&contract, &input_a, &input_b, &provider, &state).await {
            Ok((result, timing)) => {
                let output_bytes = serde_json::to_string(&result.output)
                    .map(|s| s.len())
                    .map_err(|e| tracing::warn!("failed to serialize output for metadata: {e}"))
                    .ok();
                let receipt_bytes = serde_json::to_string(&result.receipt)
                    .map(|s| s.len())
                    .map_err(|e| tracing::warn!("failed to serialize receipt for metadata: {e}"))
                    .ok();
                store
                    .with_session(&session_id, |session| {
                        session.output = Some(result.output);
                        session.receipt = Some(result.receipt);
                        session.receipt_signature = Some(result.receipt_signature);
                        session.state = SessionState::Completed;

                        if is_dev {
                            let mut meta = session.metadata.take().unwrap_or_else(|| {
                                SessionMetadata::new(session.id.clone(), session.created_at)
                            });
                            meta.timing.inference_start_at = Some(timing.inference_start_at);
                            meta.timing.inference_end_at = Some(timing.inference_end_at);
                            meta.timing.output_ready_at = Some(chrono::Utc::now());
                            meta.sizes.output_bytes = output_bytes;
                            meta.sizes.receipt_bytes = receipt_bytes;
                            session.metadata = Some(meta);
                        }
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

/// GET /sessions/:id/metadata — dev-only diagnostic endpoint.
async fn session_metadata_handler(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, RelayError> {
    if !state.is_dev {
        return Err(RelayError::Unauthorized);
    }

    let token = extract_bearer_token(&headers)?;

    let role = state
        .session_store
        .validate_token(&session_id, token)
        .await
        .ok_or(RelayError::Unauthorized)?;

    match role {
        TokenRole::InitiatorRead | TokenRole::ResponderRead => {}
        _ => return Err(RelayError::Unauthorized),
    }

    let metadata = state
        .session_store
        .with_session(&session_id, |session| session.metadata.clone())
        .await
        .ok_or(RelayError::Unauthorized)?;

    match metadata {
        Some(meta) => {
            let value = serde_json::to_value(meta)
                .map_err(|e| RelayError::Internal(format!("metadata serialization: {e}")))?;
            Ok(Json(value))
        }
        None => Ok(Json(serde_json::json!({
            "timing": {},
            "sizes": {}
        }))),
    }
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
        .route("/sessions/:id/metadata", get(session_metadata_handler))
        // Inbox endpoints
        .route("/invites", post(inbox_handlers::create_invite_handler))
        .route("/inbox", get(inbox_handlers::list_inbox_handler))
        .route("/invites/:id", get(inbox_handlers::get_invite_handler))
        .route(
            "/invites/:id/accept",
            post(inbox_handlers::accept_invite_handler),
        )
        .route(
            "/invites/:id/decline",
            post(inbox_handlers::decline_invite_handler),
        )
        .route(
            "/invites/:id/cancel",
            post(inbox_handlers::cancel_invite_handler),
        )
        .route("/inbox/events", get(inbox_handlers::inbox_events_handler))
        .with_state(state)
}
