use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures_util::stream::Stream;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::agent_registry::AgentRegistry;
use crate::error::RelayError;
use crate::inbox_types::*;
use crate::AppState;

// ============================================================================
// Auth helper
// ============================================================================

/// Extract agent_id from inbox bearer token.
fn extract_inbox_agent<'a>(
    headers: &HeaderMap,
    registry: &'a AgentRegistry,
) -> Result<&'a str, RelayError> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(RelayError::Unauthorized)?;

    registry
        .validate_token(token)
        .map(|agent| agent.agent_id.as_str())
        .ok_or(RelayError::Unauthorized)
}

// ============================================================================
// POST /invites — create a new invite
// ============================================================================

pub async fn create_invite_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateInviteRequest>,
) -> Result<Json<CreateInviteResponse>, RelayError> {
    let agent_id = extract_inbox_agent(&headers, &state.agent_registry)?;

    // Resolve from_agent_pubkey: request override > registry default
    let pubkey = request.from_agent_pubkey.clone().or_else(|| {
        state
            .agent_registry
            .get_agent(agent_id)
            .and_then(|a| a.public_key_hex.clone())
    });

    let response = state
        .inbox_store
        .create_invite(agent_id, &request, pubkey)
        .await?;

    Ok(Json(response))
}

// ============================================================================
// GET /inbox — list inbox
// ============================================================================

pub async fn list_inbox_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<InboxQuery>,
) -> Result<Json<InboxResponse>, RelayError> {
    let agent_id = extract_inbox_agent(&headers, &state.agent_registry)?;
    let response = state.inbox_store.list_inbox(agent_id, &query).await;
    Ok(Json(response))
}

// ============================================================================
// GET /invites/:id — get invite detail
// ============================================================================

pub async fn get_invite_handler(
    State(state): State<Arc<AppState>>,
    Path(invite_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<InviteDetailResponse>, RelayError> {
    let agent_id = extract_inbox_agent(&headers, &state.agent_registry)?;
    let response = state.inbox_store.get_invite(&invite_id, agent_id).await?;
    Ok(Json(response))
}

// ============================================================================
// POST /invites/:id/accept — accept invite
// ============================================================================

pub async fn accept_invite_handler(
    State(state): State<Arc<AppState>>,
    Path(invite_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<AcceptInviteRequest>,
) -> Result<Json<AcceptInviteResponse>, RelayError> {
    let agent_id = extract_inbox_agent(&headers, &state.agent_registry)?;
    let response = state
        .inbox_store
        .accept_invite(
            &invite_id,
            agent_id,
            request.expected_contract_hash.as_deref(),
            &state.session_store,
        )
        .await?;
    Ok(Json(response))
}

// ============================================================================
// POST /invites/:id/decline — decline invite
// ============================================================================

pub async fn decline_invite_handler(
    State(state): State<Arc<AppState>>,
    Path(invite_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<DeclineInviteRequest>,
) -> Result<Json<InviteDetailResponse>, RelayError> {
    let agent_id = extract_inbox_agent(&headers, &state.agent_registry)?;
    let response = state
        .inbox_store
        .decline_invite(&invite_id, agent_id, request.reason_code)
        .await?;
    Ok(Json(response))
}

// ============================================================================
// POST /invites/:id/cancel — cancel invite (sender only)
// ============================================================================

pub async fn cancel_invite_handler(
    State(state): State<Arc<AppState>>,
    Path(invite_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<InviteDetailResponse>, RelayError> {
    let agent_id = extract_inbox_agent(&headers, &state.agent_registry)?;
    let response = state
        .inbox_store
        .cancel_invite(&invite_id, agent_id)
        .await?;
    Ok(Json(response))
}

// ============================================================================
// GET /inbox/events — SSE stream (recipient only, lossy wakeup)
// ============================================================================

pub async fn inbox_events_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, RelayError> {
    let agent_id = extract_inbox_agent(&headers, &state.agent_registry)?;
    let rx = state.inbox_store.subscribe(agent_id).await;

    let stream = BroadcastStream::new(rx).filter_map(|result| match result {
        Ok(event) => {
            let event_name = match event.event_type {
                InboxEventType::InviteCreated => "invite_created",
                InboxEventType::InviteAccepted => "invite_accepted",
                InboxEventType::InviteDeclined => "invite_declined",
                InboxEventType::InviteExpired => "invite_expired",
                InboxEventType::InviteCanceled => "invite_canceled",
            };
            match serde_json::to_string(&event) {
                Ok(data) => Some(Ok(Event::default().event(event_name).data(data))),
                Err(e) => {
                    eprintln!("SSE: failed to serialize InboxEvent: {e} — event dropped");
                    None
                }
            }
        }
        Err(_) => None, // Skip lagged events (SSE is lossy)
    });

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    ))
}
