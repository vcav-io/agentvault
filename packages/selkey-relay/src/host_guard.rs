//! Host header check for locally bound relays.
//!
//! A web page can make a browser send requests to a loopback relay under a
//! hostname that resolves to 127.0.0.1 (DNS rebinding). When the relay listens
//! on loopback, or when `SELKEY_ALLOWED_HOSTS` is set, every request must name
//! an allowed host in its `Host` header: `localhost`, `127.0.0.1`, `[::1]`, or
//! a name from `SELKEY_ALLOWED_HOSTS` (comma-separated, e.g. a compose service
//! name). Other requests get `403` before any handler runs.

use std::collections::BTreeSet;
use std::net::IpAddr;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;

/// Hostnames always accepted by an active host check.
const LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "[::1]"];

/// Which `Host` values the relay accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPolicy {
    allowed: BTreeSet<String>,
}

impl HostPolicy {
    /// The policy for a bind address and `SELKEY_ALLOWED_HOSTS` value, or
    /// `None` when no check applies (non-loopback bind and no list).
    pub fn for_bind(bind_addr: IpAddr, allowed_hosts: Option<&str>) -> Option<Self> {
        let extra: Vec<String> = allowed_hosts
            .unwrap_or("")
            .split(',')
            .map(|h| h.trim().to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .collect();
        if !bind_addr.is_loopback() && extra.is_empty() {
            return None;
        }
        let allowed = LOOPBACK_HOSTS
            .iter()
            .map(|h| h.to_string())
            .chain(extra)
            .collect();
        Some(Self { allowed })
    }

    /// Whether a `Host` header value names an allowed host (port ignored).
    pub fn allows(&self, host_header: &str) -> bool {
        let host = host_header.trim().to_ascii_lowercase();
        let name = if host.starts_with('[') {
            // IPv6 literal: "[::1]" or "[::1]:3100"
            match host.find(']') {
                Some(end) if host[end + 1..].is_empty() || host[end + 1..].starts_with(':') => {
                    &host[..=end]
                }
                _ => return false,
            }
        } else {
            match host.rsplit_once(':') {
                Some((name, port)) if port.bytes().all(|b| b.is_ascii_digit()) => name,
                Some(_) => return false,
                None => host.as_str(),
            }
        };
        self.allowed.contains(name)
    }
}

async fn check_host(
    State(policy): State<Arc<HostPolicy>>,
    request: Request,
    next: Next,
) -> Response {
    let allowed = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|host| policy.allows(host));
    if allowed {
        next.run(request).await
    } else {
        (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({ "error": "HOST_NOT_ALLOWED" })),
        )
            .into_response()
    }
}

/// Apply the host check to a router, if `policy` is set.
pub fn apply(router: Router, policy: Option<HostPolicy>) -> Router {
    match policy {
        Some(policy) => router.layer(axum::middleware::from_fn_with_state(
            Arc::new(policy),
            check_host,
        )),
        None => router,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loopback() -> IpAddr {
        "127.0.0.1".parse().unwrap()
    }

    #[test]
    fn test_policy_applies_on_loopback_or_with_list() {
        assert!(HostPolicy::for_bind(loopback(), None).is_some());
        assert!(HostPolicy::for_bind("::1".parse().unwrap(), None).is_some());
        assert!(HostPolicy::for_bind("0.0.0.0".parse().unwrap(), None).is_none());
        assert!(HostPolicy::for_bind("0.0.0.0".parse().unwrap(), Some(" , ")).is_none());
        let policy = HostPolicy::for_bind("0.0.0.0".parse().unwrap(), Some("relay")).unwrap();
        assert!(policy.allows("relay:3100"));
        assert!(policy.allows("localhost:3100"));
    }

    #[test]
    fn test_allowed_host_values() {
        let policy = HostPolicy::for_bind(loopback(), Some("Relay, relay.internal")).unwrap();
        for ok in [
            "localhost",
            "localhost:3100",
            "LOCALHOST:3100",
            "127.0.0.1:3100",
            "[::1]",
            "[::1]:3100",
            "relay",
            "relay.internal:8080",
        ] {
            assert!(policy.allows(ok), "{ok}");
        }
        for bad in [
            "",
            "attacker.example",
            "attacker.example:3100",
            "localhost.attacker.example",
            "127.0.0.1.nip.io:3100",
            "127.0.0.2:3100",
            "[::2]:3100",
            "[::1]x",
            "localhost:abc",
            "relay:3100:1",
        ] {
            assert!(!policy.allows(bad), "{bad}");
        }
    }
}
