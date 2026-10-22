use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures_util::stream::Stream;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::auth::InboxAgent;
use crate::error::RelayError;
use crate::inbox_types::*;
use crate::resolve_provider;
use crate::AppState;

// ============================================================================
// POST /invites — create a new invite
// ============================================================================

pub async fn create_invite_handler(
    State(state): State<Arc<AppState>>,
    // Authentication runs before the body is read.
    InboxAgent(agent_id): InboxAgent,
    crate::strict_json::StrictJson(mut request): crate::strict_json::StrictJson<
        CreateInviteRequest,
    >,
) -> Result<Json<CreateInviteResponse>, RelayError> {
    // Resolve provider (empty string → auto-select first configured)
    request.provider = resolve_provider(&request.provider, &state)?;

    let pubkey = resolve_sender_pubkey(
        request.from_agent_pubkey.as_deref(),
        state
            .agent_registry
            .get_agent(&agent_id)
            .and_then(|a| a.public_key_hex.as_deref()),
    )?;

    let response = state
        .inbox_store
        .create_invite(&agent_id, &request, pubkey)
        .await?;

    Ok(Json(response))
}

/// The sender key attached to an invite.
///
/// The key always comes from the agent registry entry of the authenticated
/// sender. A `from_agent_pubkey` in the request is accepted only if it equals
/// that registered key (hex, any case); otherwise the request is rejected.
pub(crate) fn resolve_sender_pubkey(
    requested: Option<&str>,
    registered: Option<&str>,
) -> Result<Option<String>, RelayError> {
    match (requested, registered) {
        (None, registered) => Ok(registered.map(str::to_string)),
        (Some(req), Some(reg)) if req.eq_ignore_ascii_case(reg) => Ok(Some(reg.to_string())),
        (Some(_), _) => Err(RelayError::ContractValidation(
            "from_agent_pubkey must match the sender's key in the agent registry".to_string(),
        )),
    }
}

// ============================================================================
// GET /inbox — list inbox
// ============================================================================

pub async fn list_inbox_handler(
    State(state): State<Arc<AppState>>,
    InboxAgent(agent_id): InboxAgent,
    Query(query): Query<InboxQuery>,
) -> Result<Json<InboxResponse>, RelayError> {
    let response = state.inbox_store.list_inbox(&agent_id, &query).await;
    Ok(Json(response))
}

// ============================================================================
// GET /invites/:id — get invite detail
// ============================================================================

pub async fn get_invite_handler(
    State(state): State<Arc<AppState>>,
    Path(invite_id): Path<String>,
    InboxAgent(agent_id): InboxAgent,
) -> Result<Json<InviteDetailResponse>, RelayError> {
    let response = state.inbox_store.get_invite(&invite_id, &agent_id).await?;
    Ok(Json(response))
}

// ============================================================================
// POST /invites/:id/accept — accept invite
// ============================================================================

pub async fn accept_invite_handler(
    State(state): State<Arc<AppState>>,
    Path(invite_id): Path<String>,
    InboxAgent(agent_id): InboxAgent,
    Json(request): Json<AcceptInviteRequest>,
) -> Result<Json<AcceptInviteResponse>, RelayError> {
    let response = state
        .inbox_store
        .accept_invite(
            &invite_id,
            &agent_id,
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
    InboxAgent(agent_id): InboxAgent,
    Json(request): Json<DeclineInviteRequest>,
) -> Result<Json<InviteDetailResponse>, RelayError> {
    let response = state
        .inbox_store
        .decline_invite(&invite_id, &agent_id, request.reason_code)
        .await?;
    Ok(Json(response))
}

// ============================================================================
// POST /invites/:id/cancel — cancel invite (sender only)
// ============================================================================

pub async fn cancel_invite_handler(
    State(state): State<Arc<AppState>>,
    Path(invite_id): Path<String>,
    InboxAgent(agent_id): InboxAgent,
) -> Result<Json<InviteDetailResponse>, RelayError> {
    let response = state
        .inbox_store
        .cancel_invite(&invite_id, &agent_id)
        .await?;
    Ok(Json(response))
}

// ============================================================================
// GET /inbox/events — SSE stream (recipient only, lossy wakeup)
// ============================================================================

pub async fn inbox_events_handler(
    State(state): State<Arc<AppState>>,
    InboxAgent(agent_id): InboxAgent,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, RelayError> {
    let rx = state.inbox_store.subscribe(&agent_id).await;

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
                    tracing::error!(error = %e, "SSE: failed to serialize InboxEvent — event dropped");
                    None
                }
            }
        }
        Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(n)) => {
            tracing::warn!(skipped = n, "SSE: receiver lagged, events dropped");
            None
        }
    });

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sender_pubkey_comes_from_registry() {
        let registered = "aa".repeat(32);
        // No request value: the registered key (or none) is used.
        assert_eq!(
            resolve_sender_pubkey(None, Some(&registered)).unwrap(),
            Some(registered.clone())
        );
        assert_eq!(resolve_sender_pubkey(None, None).unwrap(), None);
        // A request value equal to the registered key is accepted.
        assert_eq!(
            resolve_sender_pubkey(Some(&registered.to_uppercase()), Some(&registered)).unwrap(),
            Some(registered.clone())
        );
        // Any other request value is rejected, including when no key is registered.
        let other = "bb".repeat(32);
        assert!(resolve_sender_pubkey(Some(&other), Some(&registered)).is_err());
        assert!(resolve_sender_pubkey(Some(&other), None).is_err());
    }
}
