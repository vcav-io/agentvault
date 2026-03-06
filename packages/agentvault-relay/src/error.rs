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

    #[error("Output policy gate violation: {0}")]
    PolicyGate(String),

    #[error("Receipt signing failed: {0}")]
    ReceiptSigning(String),

    #[error("Enforcement policy error: {0}")]
    EnforcementPolicy(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Unauthorized")]
    Unauthorized,

    #[error("Session not found")]
    SessionNotFound,

    #[error("Invite not found")]
    InviteNotFound,

    #[error("Invite state conflict: {0}")]
    InviteStateConflict(String),

    #[error("Service unavailable: {0}")]
    ServiceUnavailable(String),

    #[error("Policy not available: requested hash '{requested_hash}'")]
    PolicyNotAvailable { requested_hash: String },

    #[error("No policy resolvable: {0}")]
    NoPolicyResolvable(String),
}

impl RelayError {
    fn status_code(&self) -> StatusCode {
        match self {
            RelayError::ContractValidation(_) => StatusCode::BAD_REQUEST,
            RelayError::PromptProgram(_) => StatusCode::BAD_REQUEST,
            RelayError::Provider(_) => StatusCode::BAD_GATEWAY,
            RelayError::OutputValidation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            RelayError::PolicyGate(_) => StatusCode::UNPROCESSABLE_ENTITY,
            RelayError::ReceiptSigning(_) => StatusCode::INTERNAL_SERVER_ERROR,
            RelayError::EnforcementPolicy(_) => StatusCode::INTERNAL_SERVER_ERROR,
            RelayError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            // Constant-shape: all return 401 with same body.
            // Caller cannot distinguish "bad token" from "unknown session/invite".
            RelayError::Unauthorized | RelayError::SessionNotFound | RelayError::InviteNotFound => {
                StatusCode::UNAUTHORIZED
            }
            RelayError::InviteStateConflict(_) => StatusCode::CONFLICT,
            RelayError::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            RelayError::PolicyNotAvailable { .. } => StatusCode::BAD_REQUEST,
            RelayError::NoPolicyResolvable(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for RelayError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        // Constant-shape error: no variable detail for auth or policy gate errors.
        let error_msg = match &self {
            RelayError::Unauthorized | RelayError::SessionNotFound | RelayError::InviteNotFound => {
                "UNAUTHORIZED".to_string()
            }
            RelayError::PolicyGate(_) => "OUTPUT_POLICY_VIOLATION".to_string(),
            RelayError::ServiceUnavailable(_) => "SERVICE_UNAVAILABLE".to_string(),
            other => other.to_string(),
        };
        let body = serde_json::json!({
            "error": error_msg,
        });
        (status, axum::Json(body)).into_response()
    }
}
