//! Bearer-token handling shared by every authenticated endpoint.
//!
//! - Tokens are compared in constant time ([`tokens_equal`]).
//! - Operator-configured tokens (`SELKEY_OPERATOR_TOKEN`, agent registry
//!   `inbox_token`s) must meet a minimum strength ([`check_token_strength`]).
//! - Authentication runs in request extractors that read only the request
//!   head, and each handler lists them before its body extractor, so an
//!   unauthenticated request is rejected before its body is read or parsed.

use std::sync::Arc;

use axum::async_trait;
use axum::extract::{FromRequestParts, Path};
use axum::http::request::Parts;
use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::error::RelayError;
use crate::session::TokenRole;
use crate::AppState;

/// Minimum length, in characters, of an operator-configured token.
pub const MIN_TOKEN_LEN: usize = 32;

/// Minimum estimated strength, in bits, of an operator-configured token.
pub const MIN_TOKEN_BITS: f64 = 128.0;

/// Compare two secrets in constant time.
///
/// Both values are hashed first, so the comparison time depends on neither
/// the position of the first differing byte nor the length of the expected
/// value.
pub fn tokens_equal(presented: &str, expected: &str) -> bool {
    let a = Sha256::digest(presented.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    bool::from(a.ct_eq(&b))
}

/// Minimum number of distinct characters in an operator-configured token.
pub const MIN_TOKEN_DISTINCT_CHARS: usize = 8;

/// Check that an operator-configured token is long and varied enough.
///
/// Requires at least [`MIN_TOKEN_LEN`] printable ASCII characters (no
/// spaces), at least [`MIN_TOKEN_DISTINCT_CHARS`] distinct characters, and
/// an estimated strength of at least [`MIN_TOKEN_BITS`]. The estimate is
/// `length * log2(alphabet)`, where the alphabet is 16 for a hex token and
/// otherwise the combined size of the character classes used (lower case,
/// upper case, digits, symbols). A random 32-byte hex token
/// (`openssl rand -hex 32`) passes; short tokens, tokens with few distinct
/// characters and tokens that repeat a shorter sequence do not. These checks
/// catch obvious mistakes only: use a random generator. The
/// returned error never contains the token.
pub fn check_token_strength(token: &str) -> Result<(), String> {
    const ADVICE: &str = "generate one with `openssl rand -hex 32`";
    if token.len() < MIN_TOKEN_LEN {
        return Err(format!(
            "token is shorter than {MIN_TOKEN_LEN} characters; {ADVICE}"
        ));
    }
    if !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("token must contain only printable ASCII characters (no spaces)".to_string());
    }
    let distinct = token
        .bytes()
        .collect::<std::collections::BTreeSet<u8>>()
        .len();
    if distinct < MIN_TOKEN_DISTINCT_CHARS {
        return Err(format!(
            "token is too repetitive (fewer than {MIN_TOKEN_DISTINCT_CHARS} distinct characters); {ADVICE}"
        ));
    }
    // A short block repeated (e.g. 16 characters written four times) adds
    // length without adding randomness.
    let bytes = token.as_bytes();
    if (1..=bytes.len() / 2).any(|period| bytes[period..] == bytes[..bytes.len() - period]) {
        return Err(format!("token repeats a shorter sequence; {ADVICE}"));
    }
    let is_hex = !token.bytes().all(|b| b.is_ascii_digit())
        && (token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b)));
    let alphabet: u32 = if is_hex {
        16
    } else {
        let bytes = token.as_bytes();
        let mut size = 0;
        if bytes.iter().any(u8::is_ascii_lowercase) {
            size += 26;
        }
        if bytes.iter().any(u8::is_ascii_uppercase) {
            size += 26;
        }
        if bytes.iter().any(u8::is_ascii_digit) {
            size += 10;
        }
        if bytes.iter().any(u8::is_ascii_punctuation) {
            size += 32;
        }
        size
    };
    let estimated_bits = token.len() as f64 * f64::from(alphabet).log2();
    if estimated_bits < MIN_TOKEN_BITS {
        return Err(format!(
            "token is too weak (estimated {estimated_bits:.0} bits, minimum {MIN_TOKEN_BITS:.0}); {ADVICE}"
        ));
    }
    Ok(())
}

/// Extract the bearer token from the Authorization header.
pub fn extract_bearer_token(headers: &HeaderMap) -> Result<&str, RelayError> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(RelayError::Unauthorized)
}

/// Require the operator token if one is configured.
pub fn check_operator_token(state: &AppState, headers: &HeaderMap) -> Result<(), RelayError> {
    match state.operator_token.as_deref() {
        None => Ok(()),
        Some(expected) => {
            let presented = extract_bearer_token(headers)?;
            if tokens_equal(presented, expected) {
                Ok(())
            } else {
                Err(RelayError::Unauthorized)
            }
        }
    }
}

/// Access rule for the single-shot POST /relay endpoint, where one caller
/// supplies both inputs: available with SELKEY_ENV=dev, or to callers holding
/// the operator token. Disabled otherwise.
pub fn check_single_shot_relay_access(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), RelayError> {
    if state.operator_token.is_some() {
        return check_operator_token(state, headers);
    }
    if state.is_dev {
        return Ok(());
    }
    Err(RelayError::Forbidden(
        "POST /relay is disabled: set SELKEY_OPERATOR_TOKEN (or SELKEY_ENV=dev)".to_string(),
    ))
}

/// Extractor: the operator token check for POST /sessions.
pub struct OperatorAuth;

#[async_trait]
impl FromRequestParts<Arc<AppState>> for OperatorAuth {
    type Rejection = RelayError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        check_operator_token(state, &parts.headers)?;
        Ok(OperatorAuth)
    }
}

/// Extractor: the access rule for the single-shot POST /relay endpoint.
pub struct SingleShotAuth;

#[async_trait]
impl FromRequestParts<Arc<AppState>> for SingleShotAuth {
    type Rejection = RelayError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        check_single_shot_relay_access(state, &parts.headers)?;
        Ok(SingleShotAuth)
    }
}

/// Extractor: the registered agent behind an inbox bearer token.
pub struct InboxAgent(pub String);

#[async_trait]
impl FromRequestParts<Arc<AppState>> for InboxAgent {
    type Rejection = RelayError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let token = extract_bearer_token(&parts.headers)?;
        state
            .agent_registry
            .validate_token(token)
            .map(|agent| InboxAgent(agent.agent_id.clone()))
            .ok_or(RelayError::Unauthorized)
    }
}

/// Extractor: a session id from the path plus the role of the presented
/// session token. Unknown sessions and invalid tokens are indistinguishable.
pub struct SessionCaller {
    pub session_id: String,
    pub role: TokenRole,
}

#[async_trait]
impl FromRequestParts<Arc<AppState>> for SessionCaller {
    type Rejection = RelayError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let Path(session_id) = Path::<String>::from_request_parts(parts, state)
            .await
            .map_err(|_| RelayError::Unauthorized)?;
        let token = extract_bearer_token(&parts.headers)?;
        let role = state
            .session_store
            .validate_token(&session_id, token)
            .await
            .ok_or(RelayError::Unauthorized)?;
        Ok(SessionCaller { session_id, role })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokens_equal() {
        assert!(tokens_equal("token-a", "token-a"));
        assert!(!tokens_equal("token-a", "token-b"));
        assert!(!tokens_equal("token-a", "token-a-longer"));
        assert!(!tokens_equal("token-a-longer", "token-a"));
        assert!(!tokens_equal("", "token-a"));
        assert!(tokens_equal("", ""));
    }

    #[test]
    fn test_token_strength_accepts_random_hex() {
        let token = hex::encode(Sha256::digest(b"example token seed"));
        assert_eq!(token.len(), 64);
        assert!(check_token_strength(&token).is_ok());
        // 32 hex characters (128 bits) is the minimum.
        assert!(check_token_strength(&token[..32]).is_ok());
        assert!(check_token_strength(&token[..32].to_uppercase()).is_ok());
        // 43 base64url characters (a 32-byte value) pass.
        assert!(check_token_strength("q3Xv8_Zt0LmN4pQ-rS7uW1yB2cD5eF6gH9iJkKlMnOo").is_ok());
    }

    #[test]
    fn test_token_strength_rejects_weak_tokens() {
        for weak in [
            "",
            "alice_token_123",
            "test_alice_inbox_token_7f3a9b2e",
            &"a".repeat(64),
            &"ab".repeat(32),
            &"abc".repeat(22),
            &"0123456".repeat(5),
            // Long enough, but only digits: 32 * log2(10) < 128 bits.
            "01234567890123456789012345678901",
        ] {
            assert!(check_token_strength(weak).is_err(), "accepted {weak:?}");
        }
        let with_space = format!("{} {}", "0123456789abcdef", "0123456789abcdef");
        assert!(check_token_strength(&with_space).is_err());
    }

    #[test]
    fn test_token_strength_rejects_repeated_blocks() {
        for weak in [
            "0123456789abcdef".repeat(4),
            "q3Xv8_Zt0LmN4pQ-".repeat(3),
            format!("{}{}", "6a1f0c3e9b7d24a5".repeat(2), "6a1f0c3e"),
        ] {
            let err = check_token_strength(&weak).unwrap_err();
            assert!(err.contains("repeats"), "{weak}: {err}");
        }
    }

    #[test]
    fn test_token_strength_error_omits_token() {
        let weak = "w".repeat(40);
        let err = check_token_strength(&weak).unwrap_err();
        assert!(!err.contains(&weak));
    }
}
