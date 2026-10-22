//! Operator limits: per-session entropy cap, request size, store capacity
//! and creation rates.
//!
//! These are denial-of-service and probing controls. They bound what one
//! session can release and how fast sessions and invites can be created; they
//! do not track disclosure across sessions (see the threat model).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::RelayError;

/// Default per-session entropy cap, in bits (`SELKEY_MAX_ENTROPY_BITS_PER_SESSION`).
pub const DEFAULT_MAX_ENTROPY_BITS_PER_SESSION: u32 = 64;
/// Default maximum request body size (`SELKEY_MAX_BODY_BYTES`).
pub const DEFAULT_MAX_BODY_BYTES: usize = 256 * 1024;
/// Default maximum number of sessions held in memory (`SELKEY_MAX_SESSIONS`).
pub const DEFAULT_MAX_SESSIONS: usize = 10_000;
/// Default maximum number of invites held in memory (`SELKEY_MAX_INVITES`).
pub const DEFAULT_MAX_INVITES: usize = 10_000;
/// Default maximum pending invites per sending agent
/// (`SELKEY_MAX_PENDING_INVITES_PER_AGENT`).
pub const DEFAULT_MAX_PENDING_INVITES_PER_AGENT: usize = 100;
/// Default maximum invites in any state held per sending agent
/// (`SELKEY_MAX_INVITES_PER_AGENT`).
pub const DEFAULT_MAX_INVITES_PER_AGENT: usize = 1_000;
/// Default session creations per minute per client address
/// (`SELKEY_SESSION_CREATE_RATE_PER_MIN`, also applies to POST /relay).
pub const DEFAULT_SESSION_CREATE_RATE_PER_MIN: u32 = 60;
/// Default invite creations per minute per agent
/// (`SELKEY_INVITE_CREATE_RATE_PER_MIN`).
pub const DEFAULT_INVITE_CREATE_RATE_PER_MIN: u32 = 30;
/// Maximum number of distinct keys a rate limiter tracks at once.
pub const MAX_RATE_LIMIT_KEYS: usize = 10_000;

/// Operator-configured limits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitConfig {
    pub max_entropy_bits_per_session: u32,
    pub max_body_bytes: usize,
    pub max_sessions: usize,
    pub max_invites: usize,
    pub max_pending_invites_per_agent: usize,
    pub max_invites_per_agent: usize,
    pub session_create_rate_per_min: u32,
    pub invite_create_rate_per_min: u32,
}

impl Default for LimitConfig {
    fn default() -> Self {
        Self {
            max_entropy_bits_per_session: DEFAULT_MAX_ENTROPY_BITS_PER_SESSION,
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            max_sessions: DEFAULT_MAX_SESSIONS,
            max_invites: DEFAULT_MAX_INVITES,
            max_pending_invites_per_agent: DEFAULT_MAX_PENDING_INVITES_PER_AGENT,
            max_invites_per_agent: DEFAULT_MAX_INVITES_PER_AGENT,
            session_create_rate_per_min: DEFAULT_SESSION_CREATE_RATE_PER_MIN,
            invite_create_rate_per_min: DEFAULT_INVITE_CREATE_RATE_PER_MIN,
        }
    }
}

impl LimitConfig {
    /// Read limits from the environment. Unset variables keep their default;
    /// a set but invalid value (not a positive integer) is an error.
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// As [`LimitConfig::from_env`], with an explicit variable lookup.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        fn read<T: std::str::FromStr + PartialOrd + From<u8>>(
            lookup: &impl Fn(&str) -> Option<String>,
            name: &str,
            default: T,
        ) -> Result<T, String> {
            match lookup(name).map(|v| v.trim().to_string()) {
                None => Ok(default),
                Some(v) if v.is_empty() => Ok(default),
                Some(v) => match v.parse::<T>() {
                    Ok(n) if n >= T::from(1u8) => Ok(n),
                    _ => Err(format!("{name} must be a positive integer")),
                },
            }
        }
        let d = Self::default();
        Ok(Self {
            max_entropy_bits_per_session: read(
                &lookup,
                "SELKEY_MAX_ENTROPY_BITS_PER_SESSION",
                d.max_entropy_bits_per_session,
            )?,
            max_body_bytes: read(&lookup, "SELKEY_MAX_BODY_BYTES", d.max_body_bytes)?,
            max_sessions: read(&lookup, "SELKEY_MAX_SESSIONS", d.max_sessions)?,
            max_invites: read(&lookup, "SELKEY_MAX_INVITES", d.max_invites)?,
            max_pending_invites_per_agent: read(
                &lookup,
                "SELKEY_MAX_PENDING_INVITES_PER_AGENT",
                d.max_pending_invites_per_agent,
            )?,
            max_invites_per_agent: read(
                &lookup,
                "SELKEY_MAX_INVITES_PER_AGENT",
                d.max_invites_per_agent,
            )?,
            session_create_rate_per_min: read(
                &lookup,
                "SELKEY_SESSION_CREATE_RATE_PER_MIN",
                d.session_create_rate_per_min,
            )?,
            invite_create_rate_per_min: read(
                &lookup,
                "SELKEY_INVITE_CREATE_RATE_PER_MIN",
                d.invite_create_rate_per_min,
            )?,
        })
    }
}

/// A fixed-window rate limiter keyed by caller (client address or agent).
///
/// The number of tracked keys is bounded by [`MAX_RATE_LIMIT_KEYS`]: when it
/// is full, entries from past windows are dropped, and if every tracked key
/// is still in its current window the one whose window started earliest is
/// evicted.
#[derive(Clone)]
pub struct RateLimiter {
    per_window: u32,
    window: Duration,
    max_keys: usize,
    inner: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
}

impl RateLimiter {
    pub fn new(per_window: u32, window: Duration) -> Self {
        Self::with_max_keys(per_window, window, MAX_RATE_LIMIT_KEYS)
    }

    pub fn with_max_keys(per_window: u32, window: Duration, max_keys: usize) -> Self {
        Self {
            per_window,
            window,
            max_keys,
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Count one request for `key`. Errors with [`RelayError::RateLimited`]
    /// once `key` has used its allowance for the current window.
    pub fn check(&self, key: &str) -> Result<(), RelayError> {
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !map.contains_key(key) && map.len() >= self.max_keys {
            let window = self.window;
            map.retain(|_, (start, _)| now.duration_since(*start) < window);
            // Still full: evict the key whose window started earliest, so
            // a new caller is never refused only because others are tracked.
            if map.len() >= self.max_keys {
                if let Some(oldest) = map
                    .iter()
                    .min_by_key(|(_, (start, _))| *start)
                    .map(|(k, _)| k.clone())
                {
                    map.remove(&oldest);
                }
            }
        }
        let entry = map.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        if entry.1 >= self.per_window {
            return Err(RelayError::RateLimited);
        }
        entry.1 += 1;
        Ok(())
    }

    /// Number of keys currently tracked.
    pub fn tracked_keys(&self) -> usize {
        self.inner.lock().map(|m| m.len()).unwrap_or(0)
    }
}

/// Limits plus the rate limiters that enforce them.
#[derive(Clone)]
pub struct Limits {
    pub config: LimitConfig,
    /// POST /sessions and POST /relay, keyed by client address.
    pub session_creates: RateLimiter,
    /// POST /invites, keyed by sending agent.
    pub invite_creates: RateLimiter,
}

impl Limits {
    pub fn new(config: LimitConfig) -> Self {
        let minute = Duration::from_secs(60);
        Self {
            session_creates: RateLimiter::new(config.session_create_rate_per_min, minute),
            invite_creates: RateLimiter::new(config.invite_create_rate_per_min, minute),
            config,
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self::new(LimitConfig::default())
    }
}

/// The client address used as the rate-limit key: the TCP peer address
/// when the server records it, otherwise a single shared key. Behind a
/// reverse proxy every request shares the proxy's address.
fn client_key(parts: &axum::http::request::Parts) -> String {
    parts
        .extensions
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| address_key(info.0.ip()))
        .unwrap_or_else(|| "unknown".to_string())
}

/// Rate-limit key for an address: the IPv4 address, or the /64 prefix of an
/// IPv6 address (one host typically controls a whole /64). IPv4-mapped IPv6
/// addresses use their IPv4 form.
pub fn address_key(ip: std::net::IpAddr) -> String {
    match ip {
        std::net::IpAddr::V4(v4) => v4.to_string(),
        std::net::IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
    }
}

/// Extractor: counts one session creation (POST /sessions, POST /relay)
/// against the caller's address, before the body is read.
pub struct SessionCreateAllowed;

#[axum::async_trait]
impl axum::extract::FromRequestParts<Arc<crate::AppState>> for SessionCreateAllowed {
    type Rejection = RelayError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &Arc<crate::AppState>,
    ) -> Result<Self, Self::Rejection> {
        state.limits.session_creates.check(&client_key(parts))?;
        Ok(SessionCreateAllowed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_limit_config_defaults_and_overrides() {
        let config = LimitConfig::from_lookup(|_| None).unwrap();
        assert_eq!(config, LimitConfig::default());
        assert_eq!(config.max_body_bytes, 256 * 1024);

        let config = LimitConfig::from_lookup(|name| match name {
            "SELKEY_MAX_ENTROPY_BITS_PER_SESSION" => Some("16".to_string()),
            "SELKEY_MAX_SESSIONS" => Some(" 5 ".to_string()),
            _ => None,
        })
        .unwrap();
        assert_eq!(config.max_entropy_bits_per_session, 16);
        assert_eq!(config.max_sessions, 5);

        for bad in ["0", "-1", "lots"] {
            let err = LimitConfig::from_lookup(|name| {
                (name == "SELKEY_MAX_INVITES").then(|| bad.to_string())
            })
            .unwrap_err();
            assert!(err.contains("SELKEY_MAX_INVITES"), "{err}");
        }
    }

    #[test]
    fn test_rate_limiter_allows_up_to_limit_per_key() {
        let limiter = RateLimiter::new(2, Duration::from_secs(60));
        assert!(limiter.check("a").is_ok());
        assert!(limiter.check("a").is_ok());
        assert!(matches!(limiter.check("a"), Err(RelayError::RateLimited)));
        assert!(limiter.check("b").is_ok());
    }

    #[test]
    fn test_full_rate_limiter_admits_new_key() {
        let limiter = RateLimiter::with_max_keys(10, Duration::from_secs(60), 2);
        assert!(limiter.check("a").is_ok());
        assert!(limiter.check("b").is_ok());
        assert!(limiter.check("c").is_ok());
        assert_eq!(limiter.tracked_keys(), 2);
    }

    #[test]
    fn test_address_key_groups_ipv6_by_prefix() {
        let key = |s: &str| address_key(s.parse().unwrap());
        assert_eq!(key("2001:db8:1:2::1"), key("2001:db8:1:2:ffff::9"));
        assert_ne!(key("2001:db8:1:2::1"), key("2001:db8:1:3::1"));
        assert_eq!(key("192.0.2.7"), "192.0.2.7");
        assert_eq!(key("::ffff:192.0.2.7"), "192.0.2.7");
    }

    #[test]
    fn test_rate_limiter_resets_after_window() {
        let limiter = RateLimiter::new(1, Duration::from_millis(20));
        assert!(limiter.check("a").is_ok());
        assert!(limiter.check("a").is_err());
        std::thread::sleep(Duration::from_millis(30));
        assert!(limiter.check("a").is_ok());
    }

    #[test]
    fn test_rate_limiter_tracks_bounded_number_of_keys() {
        let limiter = RateLimiter::with_max_keys(10, Duration::from_millis(20), 3);
        for key in ["a", "b", "c"] {
            assert!(limiter.check(key).is_ok());
        }
        // Full and every key is in its window: the oldest key is evicted and
        // the new key is admitted.
        assert!(limiter.check("d").is_ok());
        assert_eq!(limiter.tracked_keys(), 3);
        // After the window, stale keys are dropped to make room.
        std::thread::sleep(Duration::from_millis(30));
        assert!(limiter.check("e").is_ok());
        assert_eq!(limiter.tracked_keys(), 1);
    }
}
