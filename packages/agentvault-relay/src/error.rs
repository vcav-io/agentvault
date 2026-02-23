use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum RelayError {
    #[error("Contract validation failed: {0}")]
    ContractValidation(String),

    #[error("Prompt program error: {0}")]
    PromptProgram(String),

    #[error("Provider error: {0}")]
    Provider(String),

    #[error("Output schema validation failed: {0}")]
    OutputValidation(String),

    #[error("Receipt signing failed: {0}")]
    ReceiptSigning(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Unauthorized")]
    Unauthorized,

    #[error("Session not found")]
    SessionNotFound,
}

impl RelayError {
    fn status_code(&self) -> StatusCode {
        match self {
            RelayError::ContractValidation(_) => StatusCode::BAD_REQUEST,
            RelayError::PromptProgram(_) => StatusCode::BAD_REQUEST,
            RelayError::Provider(_) => StatusCode::BAD_GATEWAY,
            RelayError::OutputValidation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            RelayError::ReceiptSigning(_) => StatusCode::INTERNAL_SERVER_ERROR,
            RelayError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            // Constant-shape: both return 401 with same body.
            // Caller cannot distinguish "bad token" from "unknown session".
            RelayError::Unauthorized | RelayError::SessionNotFound => StatusCode::UNAUTHORIZED,
        }
    }
}

impl IntoResponse for RelayError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        // Constant-shape error: no variable detail for auth errors.
        let error_msg = match &self {
            RelayError::Unauthorized | RelayError::SessionNotFound => "UNAUTHORIZED".to_string(),
            other => other.to_string(),
        };
        let body = serde_json::json!({
            "error": error_msg,
        });
        (status, axum::Json(body)).into_response()
    }
}
