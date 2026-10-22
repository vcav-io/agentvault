//! JSON request bodies parsed with the receipt v3 strict parser.
//!
//! Contracts and input contexts are hashed (contract hash v2, input
//! commitments), so their JSON must have a single meaning: a body that
//! repeats a member name or contains a lone surrogate is rejected instead of
//! being resolved by "last value wins". The +/-(2^53-1) number limit is
//! enforced where values are canonicalised (contract hash v2, input
//! commitments), not here.

use axum::async_trait;
use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;

/// Like `axum::Json`, but parses the body with
/// `receipt_core::parse_json_strict` before deserialising it.
pub struct StrictJson<T>(pub T);

fn is_json_content_type(req: &Request) -> bool {
    req.headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(|mime| {
            let mime = mime.trim();
            mime == "application/json"
                || (mime.starts_with("application/") && mime.ends_with("+json"))
        })
        .unwrap_or(false)
}

#[async_trait]
impl<T, S> FromRequest<S> for StrictJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        if !is_json_content_type(&req) {
            return Err((
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "Expected request with `Content-Type: application/json`",
            )
                .into_response());
        }
        let bytes = Bytes::from_request(req, state)
            .await
            .map_err(IntoResponse::into_response)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| {
            (StatusCode::BAD_REQUEST, "request body is not valid UTF-8").into_response()
        })?;
        let value = receipt_core::parse_json_strict(text).map_err(|e| {
            (StatusCode::BAD_REQUEST, format!("invalid JSON body: {e}")).into_response()
        })?;
        let parsed = serde_json::from_value(value).map_err(|e| {
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("Failed to deserialize the JSON body into the target type: {e}"),
            )
                .into_response()
        })?;
        Ok(StrictJson(parsed))
    }
}
