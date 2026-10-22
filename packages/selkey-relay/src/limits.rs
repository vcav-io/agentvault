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
/// Maximum size of a contract, as compact JSON. Checked before a contract is
/// normalised, hashed or stored.
pub const MAX_CONTRACT_BYTES: usize = 16 * 1024;
/// Maximum size of a contract's `metadata`, as compact JSON.
pub const MAX_CONTRACT_METADATA_BYTES: usize = 2 * 1024;
/// Maximum length, in bytes, of each string in a contract outside
/// `output_schema` and `metadata` (participant ids, hashes, profile ids).
pub const MAX_CONTRACT_STRING_BYTES: usize = 256;
/// Maximum estimated heap of one accepted contract ([`contract_heap_bytes`]).
/// A contract within [`MAX_CONTRACT_BYTES`] made of many tiny JSON values
/// can take over 1.5 MB once parsed; this keeps any one contract (held once
/// per session and twice per invite) to a small share of a store budget.
pub const MAX_CONTRACT_HEAP_BYTES: usize = 256 * 1024;
/// Default memory budget of each in-memory store (`SELKEY_MAX_STORE_BYTES`):
/// the session store's contracts and inputs, and separately the invite
/// store's contracts, measured with [`approx_heap_bytes`].
pub const DEFAULT_MAX_STORE_BYTES: usize = 256 * 1024 * 1024;

/// Approximate heap footprint of a parsed JSON value, in bytes: the root
/// `serde_json::Value` plus everything it allocates. A compact JSON text can
/// take many times its own length in memory, so store budgets count this
/// rather than text length.
///
/// The estimate is meant to be at least the real allocation under glibc
/// malloc (the relay image is Debian bookworm): each heap allocation is
/// charged as a glibc chunk ([`alloc_chunk_bytes`]). Other allocators round
/// differently: macOS malloc can be about 18% higher for mid-size strings,
/// jemalloc and musl about 5%. Allocator fragmentation and transient parsing
/// buffers are not counted (see the provisioning note for
/// `SELKEY_MAX_STORE_BYTES` in `docs/environment-variables.md`):
/// - strings and object keys: their capacity;
/// - arrays: their capacity in `Value`s;
/// - objects: serde_json stores members in a `BTreeMap` (no
///   `preserve_order`), so each non-empty object costs whole B-tree nodes.
///   See [`BTREE_LEAF_BYTES`] for the node model.
///
/// `tests/heap_estimate.rs` checks this against a counting allocator for
/// the worst shapes (many small objects, arrays and strings).
pub fn approx_heap_bytes(value: &serde_json::Value) -> usize {
    std::mem::size_of::<serde_json::Value>().saturating_add(owned_heap_bytes(value))
}

/// Approximate heap footprint of a typed contract, as [`approx_heap_bytes`]
/// counts it: the struct itself plus what each field owns. Fields are
/// measured in place (nothing is cloned or re-serialised), so a `Value`
/// built by deserialisation is charged its real spare capacity.
pub fn contract_heap_bytes(contract: &crate::types::Contract) -> usize {
    // Capacity needs the owned types, hence &String and &Vec.
    #[allow(clippy::ptr_arg)]
    fn string(s: &String) -> usize {
        alloc_chunk_bytes(s.capacity())
    }
    fn opt_string(s: &Option<String>) -> usize {
        s.as_ref().map_or(0, string)
    }
    #[allow(clippy::ptr_arg)]
    fn strings(v: &Vec<String>) -> usize {
        v.iter().fold(
            alloc_chunk_bytes(v.capacity().saturating_mul(std::mem::size_of::<String>())),
            |sum, s| sum.saturating_add(string(s)),
        )
    }
    // Exhaustive, so a new contract field must be accounted for here.
    let crate::types::Contract {
        purpose_code: _,
        output_schema_id,
        output_schema,
        participants,
        prompt_template_hash,
        entropy_budget_bits: _,
        timing_class,
        metadata,
        model_profile_id,
        model_profile_hash,
        enforcement_policy_hash,
        output_schema_hash,
        model_constraints,
        max_completion_tokens: _,
        session_ttl_secs: _,
        invite_ttl_secs: _,
        entropy_enforcement: _,
        relay_verifying_key_hex,
    } = contract;
    let constraints = model_constraints.as_ref().map_or(0, |c| {
        strings(&c.allowed_providers)
            .saturating_add(strings(&c.allowed_models))
            .saturating_add(opt_string(&c.min_tier))
    });
    [
        std::mem::size_of::<crate::types::Contract>(),
        string(output_schema_id),
        owned_heap_bytes(output_schema),
        strings(participants),
        string(prompt_template_hash),
        opt_string(timing_class),
        owned_heap_bytes(metadata),
        opt_string(model_profile_id),
        opt_string(model_profile_hash),
        opt_string(enforcement_policy_hash),
        opt_string(output_schema_hash),
        constraints,
        opt_string(relay_verifying_key_hex),
    ]
    .into_iter()
    .fold(0usize, usize::saturating_add)
}

/// Size of a std `BTreeMap<String, Value>` leaf node: parent pointer,
/// parent index and length (`u16` each), then 11 keys and 11 values (std's
/// node capacity, `2 * B - 1` with `B = 6`), rounded to pointer alignment.
/// This mirrors std's private node layout; `tests/heap_estimate.rs` pins it
/// against real allocations.
pub const BTREE_LEAF_BYTES: usize = {
    let raw = std::mem::size_of::<usize>()
        + 2 * std::mem::size_of::<u16>()
        + BTREE_NODE_CAPACITY
            * (std::mem::size_of::<String>() + std::mem::size_of::<serde_json::Value>());
    let align = std::mem::align_of::<usize>();
    raw.div_ceil(align) * align
};
/// Size of an internal node: a leaf plus 12 child pointers.
pub const BTREE_INTERNAL_BYTES: usize =
    BTREE_LEAF_BYTES + (BTREE_NODE_CAPACITY + 1) * std::mem::size_of::<usize>();
const BTREE_NODE_CAPACITY: usize = 11;
/// Every non-root node holds at least this many members.
const BTREE_NODE_MIN_LEN: usize = 5;

/// Memory a heap allocation of `size` bytes takes, modelled on glibc
/// malloc: an 8-byte header, rounded up to 16 bytes, at least 32 bytes.
/// Zero-size requests do not allocate.
pub const fn alloc_chunk_bytes(size: usize) -> usize {
    if size == 0 {
        return 0;
    }
    let chunk = size.saturating_add(8 + 15) & !15;
    if chunk < 32 {
        32
    } else {
        chunk
    }
}

/// Upper bound on the node memory of a `BTreeMap` with `len` members.
fn btree_bytes(len: usize) -> usize {
    let leaf = alloc_chunk_bytes(BTREE_LEAF_BYTES);
    let internal = alloc_chunk_bytes(BTREE_INTERNAL_BYTES);
    match len {
        0 => 0,
        1..=BTREE_NODE_CAPACITY => leaf,
        _ => {
            let leaves = len.div_ceil(BTREE_NODE_MIN_LEN);
            let internals = leaves.div_ceil(BTREE_NODE_MIN_LEN) + 1;
            leaves
                .saturating_mul(leaf)
                .saturating_add(internals.saturating_mul(internal))
        }
    }
}

/// Heap bytes `value` owns, not counting the `Value` itself.
fn owned_heap_bytes(value: &serde_json::Value) -> usize {
    const NODE: usize = std::mem::size_of::<serde_json::Value>();
    match value {
        serde_json::Value::String(s) => alloc_chunk_bytes(s.capacity()),
        serde_json::Value::Array(items) => items.iter().fold(
            alloc_chunk_bytes(items.capacity().saturating_mul(NODE)),
            |sum, v| sum.saturating_add(owned_heap_bytes(v)),
        ),
        serde_json::Value::Object(map) => map.iter().fold(btree_bytes(map.len()), |sum, (k, v)| {
            sum.saturating_add(alloc_chunk_bytes(k.capacity()))
                .saturating_add(owned_heap_bytes(v))
        }),
        _ => 0,
    }
}

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
    pub max_store_bytes: usize,
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
            max_store_bytes: DEFAULT_MAX_STORE_BYTES,
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
            max_store_bytes: read(&lookup, "SELKEY_MAX_STORE_BYTES", d.max_store_bytes)?,
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
    fn test_approx_heap_bytes_counts_nodes_not_text() {
        let node = std::mem::size_of::<serde_json::Value>();
        let zeros: serde_json::Value =
            serde_json::from_str(&format!("[{}]", vec!["0"; 1000].join(","))).unwrap();
        // About 2 bytes of text per element, a whole Value in memory.
        assert!(approx_heap_bytes(&zeros) >= node * 1001);
        // Each non-empty object costs at least one B-tree leaf.
        let small: serde_json::Value = serde_json::from_str(r#"{"a":0}"#).unwrap();
        assert!(approx_heap_bytes(&small) >= node + BTREE_LEAF_BYTES);
        assert_eq!(BTREE_LEAF_BYTES, 632);
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
