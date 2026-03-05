use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::RelayError;

// ============================================================================
// Artefact types
// ============================================================================

/// Content-addressed relay enforcement policy.
///
/// Rules are read at runtime by `validate_output_enforcement_rules` in relay.rs.
/// The policy hash is bound into every receipt via `guardian_policy_hash`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayEnforcementPolicy {
    pub policy_version: String,
    pub policy_id: String,
    pub policy_scope: String,
    #[serde(default)]
    pub model_profile_allowlist: Vec<String>,
    #[serde(default)]
    pub provider_allowlist: Vec<String>,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    pub rules: Vec<EnforcementRule>,
    #[serde(default)]
    pub entropy_constraints: Option<EntropyConstraints>,
}

/// A single enforcement rule in the policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnforcementRule {
    pub rule_id: String,
    #[serde(rename = "type")]
    pub rule_type: RuleType,
    pub value: String,
    pub scope: RuleScope,
    pub classification: EnforcementClass,
}

/// Rule types supported by the relay.
///
/// v1 supports only unicode category rejection. Regex is reserved — the relay
/// rejects configs that declare it until cross-language determinism is specified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleType {
    UnicodeCategoryReject,
    // Regex is intentionally omitted — cross-language determinism not yet specified.
}

/// Scope descriptor for a rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleScope {
    pub kind: RuleScopeKind,
    #[serde(default)]
    pub skip_keys: Vec<String>,
}

/// Scope kinds supported by the relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleScopeKind {
    AllStringValues,
}

/// Entropy constraints in the policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntropyConstraints {
    pub budget_bits: u32,
    pub classification: EnforcementClass,
    #[serde(default)]
    pub review_trigger_pct: Option<u8>,
}

/// Enforcement classification for a rule or constraint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EnforcementClass {
    Gate,
    Advisory,
}

// ============================================================================
// Policy scope
// ============================================================================

const POLICY_SCOPE_RELAY_GLOBAL: &str = "RELAY_GLOBAL";

/// Validate that the policy declares a known scope.
///
/// The only supported scope is `RELAY_GLOBAL` — rules apply to all output schemas.
pub fn validate_policy_scope(policy: &RelayEnforcementPolicy) -> Result<(), RelayError> {
    if policy.policy_scope != POLICY_SCOPE_RELAY_GLOBAL {
        return Err(RelayError::EnforcementPolicy(format!(
            "unsupported policy_scope '{}' — only '{}' is supported",
            policy.policy_scope, POLICY_SCOPE_RELAY_GLOBAL,
        )));
    }
    Ok(())
}

// ============================================================================
// Rule category validation (startup check)
// ============================================================================

/// Unicode categories supported by the relay's enforcement guard.
const SUPPORTED_CATEGORIES: &[&str] = &["Nd", "Sc"];

/// Validate that all rules reference supported unicode categories.
///
/// Called at startup. Unknown categories cause a startup failure (fail-closed).
pub fn validate_rule_categories(policy: &RelayEnforcementPolicy) -> Result<(), RelayError> {
    for rule in &policy.rules {
        match rule.rule_type {
            RuleType::UnicodeCategoryReject => {
                if !SUPPORTED_CATEGORIES.contains(&rule.value.as_str()) {
                    return Err(RelayError::EnforcementPolicy(format!(
                        "rule '{}' references unsupported unicode category '{}' — supported: {:?}",
                        rule.rule_id, rule.value, SUPPORTED_CATEGORIES,
                    )));
                }
            }
        }
    }
    Ok(())
}

// ============================================================================
// Capabilities
// ============================================================================

/// Stable versioned capability strings exposed via `/capabilities`.
pub const CAP_UNICODE_CATEGORY_REJECT: &str = "enforcement.unicode_category_reject.v1";

/// Capabilities that the relay can support.
///
/// Required capabilities are derived from the policy rules, not declared in JSON.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RelayCapability {
    UnicodeCategoryReject,
    ProviderAllowlistEnforcement,
    ModelProfileAllowlistEnforcement,
    MaxOutputTokensEnforcement,
    EntropyBudgetEnforcement,
}

/// The set of capabilities this relay implementation supports.
fn supported_capabilities() -> HashSet<RelayCapability> {
    let mut caps = HashSet::new();
    caps.insert(RelayCapability::UnicodeCategoryReject);
    caps.insert(RelayCapability::ProviderAllowlistEnforcement);
    caps.insert(RelayCapability::ModelProfileAllowlistEnforcement);
    caps.insert(RelayCapability::MaxOutputTokensEnforcement);
    caps.insert(RelayCapability::EntropyBudgetEnforcement);
    caps
}

/// Return the list of enforcement capability strings for the `/capabilities` endpoint.
///
/// Only capabilities with runtime enforcement (output guard) are exposed here.
/// Capabilities used only for startup validation (e.g. provider allowlist checks)
/// are intentionally omitted — they are internal invariants, not external contracts.
pub fn supported_capability_strings() -> Vec<String> {
    vec![CAP_UNICODE_CATEGORY_REJECT.to_string()]
}

/// Derive required capabilities from a policy.
///
/// Capabilities are derived from the rules and fields present in the policy,
/// not declared in the JSON. This prevents inconsistency between declared and
/// actual requirements.
pub fn derive_required_capabilities(policy: &RelayEnforcementPolicy) -> HashSet<RelayCapability> {
    let mut caps = HashSet::new();

    for rule in &policy.rules {
        match rule.rule_type {
            RuleType::UnicodeCategoryReject => {
                caps.insert(RelayCapability::UnicodeCategoryReject);
            }
        }
    }

    if !policy.provider_allowlist.is_empty() {
        caps.insert(RelayCapability::ProviderAllowlistEnforcement);
    }
    if !policy.model_profile_allowlist.is_empty() {
        caps.insert(RelayCapability::ModelProfileAllowlistEnforcement);
    }
    if policy.max_output_tokens.is_some() {
        caps.insert(RelayCapability::MaxOutputTokensEnforcement);
    }
    if let Some(ref ec) = policy.entropy_constraints {
        if ec.classification == EnforcementClass::Gate {
            caps.insert(RelayCapability::EntropyBudgetEnforcement);
        }
    }

    caps
}

/// Validate that all required capabilities are in the supported set.
///
/// Testable inner function — takes explicit required/supported sets.
pub fn validate_capabilities_with(
    required: &HashSet<RelayCapability>,
    supported: &HashSet<RelayCapability>,
) -> Result<(), RelayError> {
    for cap in required {
        if !supported.contains(cap) {
            return Err(RelayError::EnforcementPolicy(format!(
                "policy requires unsupported capability: {cap:?}"
            )));
        }
    }
    Ok(())
}

/// Validate that all required capabilities are supported by this relay.
///
/// Fails closed: if any required capability is unsupported, returns an error.
pub fn validate_capabilities(policy: &RelayEnforcementPolicy) -> Result<(), RelayError> {
    let required = derive_required_capabilities(policy);
    let supported = supported_capabilities();
    validate_capabilities_with(&required, &supported)
}

// ============================================================================
// Content addressing
// ============================================================================

/// Compute the content-addressed hash of a relay enforcement policy.
///
/// Uses RFC 8785 JCS canonicalization — same as `PromptProgram` and `ModelProfile`.
pub fn content_hash(policy: &RelayEnforcementPolicy) -> Result<String, RelayError> {
    let canonical = receipt_core::canonicalize_serializable(policy)
        .map_err(|e| RelayError::EnforcementPolicy(format!("canonicalization failed: {e}")))?;
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

// ============================================================================
// Load
// ============================================================================

/// Load and parse a relay enforcement policy from a JSON file.
pub fn load_enforcement_policy(path: &str) -> Result<RelayEnforcementPolicy, RelayError> {
    let data = std::fs::read_to_string(path).map_err(|e| {
        RelayError::EnforcementPolicy(format!("failed to read enforcement policy at {path}: {e}"))
    })?;
    let policy: RelayEnforcementPolicy = serde_json::from_str(&data).map_err(|e| {
        RelayError::EnforcementPolicy(format!("invalid enforcement policy JSON at {path}: {e}"))
    })?;
    Ok(policy)
}

// ============================================================================
// Lockfile
// ============================================================================

const LOCKFILE_NAME: &str = "relay_policies.lock";

/// Validate the enforcement policy lockfile.
///
/// The lockfile lives at `<dir>/relay_policies.lock` and maps `policy_id` to
/// expected content hash.
///
/// **Fail-closed by default**: missing lockfile = startup failure unless
/// BOTH `AV_ENFORCEMENT_LOCKFILE_SKIP=1` AND `AV_ENV=dev` are set.
pub fn validate_enforcement_lockfile(dir: &str) -> Result<(), RelayError> {
    let lockfile_path = std::path::Path::new(dir).join(LOCKFILE_NAME);

    let data = match std::fs::read_to_string(&lockfile_path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Check dev override: requires BOTH flags
            let skip = std::env::var("AV_ENFORCEMENT_LOCKFILE_SKIP")
                .map(|v| v == "1")
                .unwrap_or(false);
            let is_dev = std::env::var("AV_ENV").map(|v| v == "dev").unwrap_or(false);

            if skip && is_dev {
                tracing::warn!(
                    path = %lockfile_path.display(),
                    "relay_policies.lock not found — skipping enforcement policy lockfile validation (AV_ENV=dev override)"
                );
                return Ok(());
            }

            return Err(RelayError::EnforcementPolicy(format!(
                "relay_policies.lock not found at {} — relay refuses to start without enforcement policy lockfile. \
                 Set AV_ENFORCEMENT_LOCKFILE_SKIP=1 and AV_ENV=dev to skip in development.",
                lockfile_path.display()
            )));
        }
        Err(e) => {
            return Err(RelayError::EnforcementPolicy(format!(
                "failed to read relay_policies.lock: {e}"
            )));
        }
    };

    let lockfile: std::collections::HashMap<String, String> =
        serde_json::from_str(&data).map_err(|e| {
            RelayError::EnforcementPolicy(format!("invalid relay_policies.lock format: {e}"))
        })?;

    if lockfile.is_empty() {
        return Err(RelayError::EnforcementPolicy(
            "relay_policies.lock is empty — at least one policy must be pinned".to_string(),
        ));
    }

    // Reverse check: every .json file on disk must have a lockfile entry
    let on_disk_ids = scan_policy_ids(dir)?;
    for disk_id in &on_disk_ids {
        if !lockfile.contains_key(disk_id) {
            return Err(RelayError::EnforcementPolicy(format!(
                "policy file '{disk_id}.json' is not in the lockfile — \
                 regenerate relay_policies.lock to include it"
            )));
        }
    }

    for (policy_id, expected_hash) in &lockfile {
        // Sanitize policy_id to prevent path traversal
        if policy_id.contains("..") || policy_id.contains('/') || policy_id.contains('\\') {
            return Err(RelayError::EnforcementPolicy(
                "policy_id in lockfile contains invalid characters".to_string(),
            ));
        }

        let policy_path = std::path::Path::new(dir).join(format!("{policy_id}.json"));
        let policy_path_str = policy_path.to_str().ok_or_else(|| {
            RelayError::EnforcementPolicy(format!(
                "policy path for '{policy_id}' is not valid UTF-8: {}",
                policy_path.display()
            ))
        })?;
        let policy = load_enforcement_policy(policy_path_str)?;
        let actual_hash = content_hash(&policy)?;
        if &actual_hash != expected_hash {
            return Err(RelayError::EnforcementPolicy(format!(
                "enforcement policy hash mismatch for '{policy_id}': \
                 expected {expected_hash}, got {actual_hash}"
            )));
        }
        tracing::debug!(policy_id, "enforcement policy hash verified");
    }

    tracing::info!(
        count = lockfile.len(),
        "enforcement policy lockfile validated"
    );
    Ok(())
}

/// Load and parse the lockfile, returning the map of `policy_id -> hash`.
///
/// Returns an error if the lockfile is missing or malformed.
pub fn load_lockfile_entries(
    dir: &str,
) -> Result<std::collections::HashMap<String, String>, RelayError> {
    let lockfile_path = std::path::Path::new(dir).join(LOCKFILE_NAME);
    let data = std::fs::read_to_string(&lockfile_path).map_err(|e| {
        RelayError::EnforcementPolicy(format!(
            "failed to read relay_policies.lock at {}: {e}",
            lockfile_path.display()
        ))
    })?;
    let lockfile: std::collections::HashMap<String, String> =
        serde_json::from_str(&data).map_err(|e| {
            RelayError::EnforcementPolicy(format!("invalid relay_policies.lock format: {e}"))
        })?;
    Ok(lockfile)
}

/// Scan a directory for `.json` files that deserialize as `RelayEnforcementPolicy`
/// and return their `policy_id` values.
fn scan_policy_ids(dir: &str) -> Result<HashSet<String>, RelayError> {
    let dir_path = std::path::Path::new(dir);
    let entries = std::fs::read_dir(dir_path).map_err(|e| {
        RelayError::EnforcementPolicy(format!("failed to read relay_policies dir: {e}"))
    })?;

    let mut ids = HashSet::new();
    for entry in entries {
        let entry = entry.map_err(|e| {
            RelayError::EnforcementPolicy(format!("failed to read directory entry: {e}"))
        })?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let data = match std::fs::read_to_string(&path) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "skipping policy file: failed to read"
                );
                continue;
            }
        };
        let policy: RelayEnforcementPolicy = match serde_json::from_str(&data) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "skipping file: not a valid RelayEnforcementPolicy"
                );
                continue;
            }
        };
        ids.insert(policy.policy_id.clone());
    }
    Ok(ids)
}

/// Generate (or regenerate) the lockfile for all valid enforcement policy JSON files in `dir`.
///
/// Scans `*.json` files, deserializes those that match `RelayEnforcementPolicy`, and writes
/// `relay_policies.lock` with `{ policy_id -> content_hash }` entries.
pub fn generate_enforcement_lockfile(dir: &str) -> Result<(), RelayError> {
    let dir_path = std::path::Path::new(dir);

    let entries = std::fs::read_dir(dir_path).map_err(|e| {
        RelayError::EnforcementPolicy(format!("failed to read relay_policies dir: {e}"))
    })?;

    let mut lockfile: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for entry in entries {
        let entry = entry.map_err(|e| {
            RelayError::EnforcementPolicy(format!("failed to read directory entry: {e}"))
        })?;
        let path = entry.path();

        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let data = match std::fs::read_to_string(&path) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "skipping policy file: failed to read"
                );
                continue;
            }
        };

        let policy: RelayEnforcementPolicy = match serde_json::from_str(&data) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "skipping file: not a valid RelayEnforcementPolicy"
                );
                continue;
            }
        };

        let hash = content_hash(&policy)?;
        lockfile.insert(policy.policy_id.clone(), hash);
    }

    let lockfile_path = dir_path.join(LOCKFILE_NAME);
    let lockfile_json = serde_json::to_string_pretty(&lockfile)
        .map_err(|e| RelayError::EnforcementPolicy(format!("failed to serialize lockfile: {e}")))?;
    std::fs::write(&lockfile_path, lockfile_json + "\n")
        .map_err(|e| RelayError::EnforcementPolicy(format!("failed to write lockfile: {e}")))?;

    tracing::info!(
        path = %lockfile_path.display(),
        count = lockfile.len(),
        "relay_policies.lock written"
    );
    Ok(())
}

/// Return a no-op enforcement policy used when the lockfile is skipped in dev mode.
///
/// All fields are empty/None — no rules, no allowlists — so every request passes through.
/// This is only reachable when both `AV_ENFORCEMENT_LOCKFILE_SKIP=1` and `AV_ENV=dev`
/// are set.
pub fn dev_skip_policy() -> RelayEnforcementPolicy {
    RelayEnforcementPolicy {
        policy_version: "dev-skip".to_string(),
        policy_id: "dev-skip".to_string(),
        policy_scope: "RELAY_GLOBAL".to_string(),
        model_profile_allowlist: vec![],
        provider_allowlist: vec![],
        max_output_tokens: None,
        rules: vec![],
        entropy_constraints: None,
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Mutex to serialize tests that mutate process-global env vars.
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn sample_policy() -> RelayEnforcementPolicy {
        RelayEnforcementPolicy {
            policy_version: "1".to_string(),
            policy_id: "compatibility_safe_v1".to_string(),
            policy_scope: "RELAY_GLOBAL".to_string(),
            model_profile_allowlist: vec!["api-claude-sonnet-v1".to_string()],
            provider_allowlist: vec!["anthropic".to_string(), "openai".to_string()],
            max_output_tokens: None,
            rules: vec![
                EnforcementRule {
                    rule_id: "no_digits".to_string(),
                    rule_type: RuleType::UnicodeCategoryReject,
                    value: "Nd".to_string(),
                    scope: RuleScope {
                        kind: RuleScopeKind::AllStringValues,
                        skip_keys: vec!["schema_version".to_string()],
                    },
                    classification: EnforcementClass::Gate,
                },
                EnforcementRule {
                    rule_id: "no_currency_symbols".to_string(),
                    rule_type: RuleType::UnicodeCategoryReject,
                    value: "Sc".to_string(),
                    scope: RuleScope {
                        kind: RuleScopeKind::AllStringValues,
                        skip_keys: vec!["schema_version".to_string()],
                    },
                    classification: EnforcementClass::Gate,
                },
            ],
            entropy_constraints: Some(EntropyConstraints {
                budget_bits: 32,
                classification: EnforcementClass::Advisory,
                review_trigger_pct: Some(80),
            }),
        }
    }

    // -----------------------------------------------------------------------
    // Serde round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn test_serde_round_trip() {
        let policy = sample_policy();
        let json = serde_json::to_string(&policy).unwrap();
        let deserialized: RelayEnforcementPolicy = serde_json::from_str(&json).unwrap();
        let json2 = serde_json::to_string(&deserialized).unwrap();
        assert_eq!(
            json, json2,
            "serde round-trip should produce identical JSON"
        );
    }

    #[test]
    fn test_unknown_rule_type_rejected() {
        let json = r#"{
            "policy_version": "1",
            "policy_id": "test",
            "rules": [{
                "rule_id": "test",
                "type": "regex_match",
                "value": ".*",
                "scope": { "kind": "all_string_values" },
                "classification": "GATE"
            }]
        }"#;
        let result: Result<RelayEnforcementPolicy, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "unknown rule_type 'regex_match' should be rejected by serde"
        );
    }

    #[test]
    fn test_example_policy_deserializes() {
        let json = include_str!("../prompt_programs/relay_policies/compatibility_safe_v1.json");
        let policy: RelayEnforcementPolicy = serde_json::from_str(json).unwrap();
        assert_eq!(policy.policy_id, "compatibility_safe_v1");
        assert_eq!(policy.rules.len(), 2);
        assert_eq!(policy.rules[0].rule_type, RuleType::UnicodeCategoryReject);
        assert_eq!(policy.rules[0].classification, EnforcementClass::Gate);
    }

    // -----------------------------------------------------------------------
    // Content hash
    // -----------------------------------------------------------------------

    #[test]
    fn test_content_hash_deterministic() {
        let policy = sample_policy();
        let h1 = content_hash(&policy).unwrap();
        let h2 = content_hash(&policy).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64, "hash should be 64 hex characters");
    }

    #[test]
    fn test_content_hash_changes_with_content() {
        let p1 = sample_policy();
        let mut p2 = sample_policy();
        p2.policy_id = "different_policy_v1".to_string();
        assert_ne!(
            content_hash(&p1).unwrap(),
            content_hash(&p2).unwrap(),
            "different policy_id should produce different hash"
        );
    }

    // -----------------------------------------------------------------------
    // Capability derivation
    // -----------------------------------------------------------------------

    #[test]
    fn test_derive_capabilities_unicode_reject() {
        let policy = sample_policy();
        let caps = derive_required_capabilities(&policy);
        assert!(
            caps.contains(&RelayCapability::UnicodeCategoryReject),
            "unicode_category_reject rule should require UnicodeCategoryReject capability"
        );
    }

    #[test]
    fn test_derive_capabilities_provider_allowlist() {
        let policy = sample_policy();
        let caps = derive_required_capabilities(&policy);
        assert!(
            caps.contains(&RelayCapability::ProviderAllowlistEnforcement),
            "non-empty provider_allowlist should require ProviderAllowlistEnforcement"
        );
    }

    #[test]
    fn test_derive_capabilities_model_profile_allowlist() {
        let policy = sample_policy();
        let caps = derive_required_capabilities(&policy);
        assert!(
            caps.contains(&RelayCapability::ModelProfileAllowlistEnforcement),
            "non-empty model_profile_allowlist should require ModelProfileAllowlistEnforcement"
        );
    }

    #[test]
    fn test_derive_capabilities_empty_policy() {
        let policy = RelayEnforcementPolicy {
            policy_version: "1".to_string(),
            policy_id: "empty".to_string(),
            policy_scope: "RELAY_GLOBAL".to_string(),
            model_profile_allowlist: vec![],
            provider_allowlist: vec![],
            max_output_tokens: None,
            rules: vec![],
            entropy_constraints: None,
        };
        let caps = derive_required_capabilities(&policy);
        assert!(
            caps.is_empty(),
            "empty policy should require no capabilities"
        );
    }

    #[test]
    fn test_validate_capabilities_accepts_sample_policy() {
        let policy = sample_policy();
        assert!(
            validate_capabilities(&policy).is_ok(),
            "sample policy should pass capability validation"
        );
    }

    // -----------------------------------------------------------------------
    // Lockfile
    // -----------------------------------------------------------------------

    fn write_policy_file(dir: &std::path::Path, policy: &RelayEnforcementPolicy) {
        let path = dir.join(format!("{}.json", policy.policy_id));
        std::fs::write(path, serde_json::to_string(policy).unwrap()).unwrap();
    }

    fn write_lockfile_entries(dir: &std::path::Path, entries: &[(&str, &str)]) {
        let map: std::collections::HashMap<&str, &str> = entries.iter().cloned().collect();
        let path = dir.join(LOCKFILE_NAME);
        std::fs::write(path, serde_json::to_string_pretty(&map).unwrap()).unwrap();
    }

    #[test]
    fn test_lockfile_valid_passes() {
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-valid");
        std::fs::create_dir_all(&dir).unwrap();

        let policy = sample_policy();
        write_policy_file(&dir, &policy);
        let hash = content_hash(&policy).unwrap();
        write_lockfile_entries(&dir, &[("compatibility_safe_v1", &hash)]);

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());
        assert!(result.is_ok(), "valid lockfile should pass: {result:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_lockfile_hash_mismatch_fails() {
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-mismatch");
        std::fs::create_dir_all(&dir).unwrap();

        let policy = sample_policy();
        write_policy_file(&dir, &policy);
        write_lockfile_entries(&dir, &[("compatibility_safe_v1", &"a".repeat(64))]);

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("hash mismatch"),
            "error should mention hash mismatch"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_lockfile_missing_fails_by_default() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-missing");
        std::fs::create_dir_all(&dir).unwrap();
        // No lockfile written

        unsafe {
            std::env::set_var("AV_ENV", "production");
            std::env::remove_var("AV_ENFORCEMENT_LOCKFILE_SKIP");
        }

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());

        unsafe {
            std::env::remove_var("AV_ENV");
        }

        assert!(
            result.is_err(),
            "missing lockfile should fail closed by default"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_lockfile_missing_warns_with_dev_override() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-dev-skip");
        std::fs::create_dir_all(&dir).unwrap();
        // No lockfile written

        unsafe {
            std::env::set_var("AV_ENFORCEMENT_LOCKFILE_SKIP", "1");
            std::env::set_var("AV_ENV", "dev");
        }

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());

        unsafe {
            std::env::remove_var("AV_ENFORCEMENT_LOCKFILE_SKIP");
            std::env::remove_var("AV_ENV");
        }

        assert!(
            result.is_ok(),
            "missing lockfile with AV_ENV=dev + AV_ENFORCEMENT_LOCKFILE_SKIP=1 should warn but not fail"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_lockfile_skip_without_dev_env_fails() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-skip-no-dev");
        std::fs::create_dir_all(&dir).unwrap();

        unsafe {
            std::env::set_var("AV_ENFORCEMENT_LOCKFILE_SKIP", "1");
            std::env::set_var("AV_ENV", "production");
        }

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());

        unsafe {
            std::env::remove_var("AV_ENFORCEMENT_LOCKFILE_SKIP");
            std::env::remove_var("AV_ENV");
        }

        assert!(
            result.is_err(),
            "AV_ENFORCEMENT_LOCKFILE_SKIP=1 without AV_ENV=dev should still fail"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_generate_lockfile_round_trip() {
        let _guard = ENV_MUTEX.lock().unwrap();
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-generate");
        std::fs::create_dir_all(&dir).unwrap();

        let policy = sample_policy();
        write_policy_file(&dir, &policy);

        unsafe {
            std::env::remove_var("AV_ENFORCEMENT_LOCKFILE_SKIP");
            std::env::remove_var("AV_ENV");
        }

        generate_enforcement_lockfile(dir.to_str().unwrap()).unwrap();

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());
        assert!(
            result.is_ok(),
            "generated lockfile should validate: {result:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // -----------------------------------------------------------------------
    // Path traversal
    // -----------------------------------------------------------------------

    #[test]
    fn test_lockfile_rejects_path_traversal_in_policy_id() {
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-traversal");
        std::fs::create_dir_all(&dir).unwrap();

        write_lockfile_entries(&dir, &[("../etc/passwd", &"a".repeat(64))]);

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("invalid characters"),
            "error should mention invalid characters for path traversal"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // -----------------------------------------------------------------------
    // Empty and malformed lockfile
    // -----------------------------------------------------------------------

    #[test]
    fn test_empty_lockfile_fails() {
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-empty");
        std::fs::create_dir_all(&dir).unwrap();

        write_lockfile_entries(&dir, &[]);

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());
        assert!(result.is_err(), "empty lockfile should fail closed");
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("at least one policy"),
            "error should mention empty lockfile"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_malformed_lockfile_json_fails() {
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-malformed");
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join(LOCKFILE_NAME);
        std::fs::write(&path, b"{not valid json").unwrap();

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());
        assert!(
            result.is_err(),
            "malformed lockfile JSON should fail closed"
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("invalid relay_policies.lock format"),
            "error should indicate format problem"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_lockfile_entry_for_missing_policy_fails() {
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-ghost");
        std::fs::create_dir_all(&dir).unwrap();

        write_lockfile_entries(&dir, &[("ghost_policy", &"a".repeat(64))]);
        // No ghost_policy.json written

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());
        assert!(
            result.is_err(),
            "lockfile entry for nonexistent policy should fail"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // -----------------------------------------------------------------------
    // Reverse lockfile check (disk → lockfile)
    // -----------------------------------------------------------------------

    #[test]
    fn test_unlocked_policy_on_disk_is_rejected() {
        let dir = std::env::temp_dir().join("vcav-enforcement-lockfile-extra-policy");
        std::fs::create_dir_all(&dir).unwrap();

        // Write the locked policy
        let policy = sample_policy();
        write_policy_file(&dir, &policy);
        let hash = content_hash(&policy).unwrap();
        write_lockfile_entries(&dir, &[("compatibility_safe_v1", &hash)]);

        // Write a second policy that is NOT in the lockfile
        let mut extra = sample_policy();
        extra.policy_id = "rogue_policy".to_string();
        write_policy_file(&dir, &extra);

        let result = validate_enforcement_lockfile(dir.to_str().unwrap());
        assert!(
            result.is_err(),
            "unlocked policy on disk should be rejected"
        );
        assert!(
            result.unwrap_err().to_string().contains("rogue_policy"),
            "error should name the unlocked policy"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // -----------------------------------------------------------------------
    // Capability derivation coverage
    // -----------------------------------------------------------------------

    #[test]
    fn test_derive_capabilities_entropy_gate_requires_budget_enforcement() {
        let mut policy = sample_policy();
        policy.entropy_constraints = Some(EntropyConstraints {
            budget_bits: 64,
            classification: EnforcementClass::Gate,
            review_trigger_pct: None,
        });
        let caps = derive_required_capabilities(&policy);
        assert!(
            caps.contains(&RelayCapability::EntropyBudgetEnforcement),
            "entropy_constraints with Gate classification should require EntropyBudgetEnforcement"
        );
    }

    #[test]
    fn test_derive_capabilities_entropy_advisory_does_not_require_budget_enforcement() {
        let mut policy = sample_policy();
        policy.entropy_constraints = Some(EntropyConstraints {
            budget_bits: 64,
            classification: EnforcementClass::Advisory,
            review_trigger_pct: None,
        });
        let caps = derive_required_capabilities(&policy);
        assert!(
            !caps.contains(&RelayCapability::EntropyBudgetEnforcement),
            "Advisory entropy constraint should not require EntropyBudgetEnforcement"
        );
    }

    #[test]
    fn test_derive_capabilities_max_output_tokens() {
        let mut policy = sample_policy();
        policy.max_output_tokens = Some(1024);
        let caps = derive_required_capabilities(&policy);
        assert!(
            caps.contains(&RelayCapability::MaxOutputTokensEnforcement),
            "non-None max_output_tokens should require MaxOutputTokensEnforcement"
        );
    }

    // -----------------------------------------------------------------------
    // Receipt binding
    // -----------------------------------------------------------------------

    #[test]
    fn test_receipt_binds_declared_enforcement_hash() {
        use chrono::Utc;
        use receipt_core::{BudgetUsageRecord, ExecutionLane, Receipt, ReceiptStatus};
        use sha2::{Digest, Sha256};
        use vault_family_types::BudgetTier;

        let policy = sample_policy();
        let enforcement_hash = content_hash(&policy).unwrap();

        let runtime_hash = hex::encode(Sha256::digest(b"test-git-sha"));
        let model_weights_hash = hex::encode(Sha256::digest(b"api-mediated-no-local-weights"));
        let inference_config_hash = hex::encode(Sha256::digest(b"api-mediated-no-local-inference"));

        let now = Utc::now();
        let unsigned = Receipt::builder()
            .session_id("a".repeat(64))
            .purpose_code(vault_family_types::Purpose::Mediation)
            .participant_ids(vec!["alice".to_string(), "bob".to_string()])
            .runtime_hash(&runtime_hash)
            .guardian_policy_hash(&enforcement_hash)
            .model_weights_hash(&model_weights_hash)
            .llama_cpp_version("n/a")
            .inference_config_hash(&inference_config_hash)
            .output_schema_version("1.0.0")
            .session_start(now)
            .session_end(now)
            .fixed_window_duration_seconds(0)
            .status(ReceiptStatus::Completed)
            .execution_lane(ExecutionLane::ApiMediated)
            .output_entropy_bits(6)
            .budget_usage(BudgetUsageRecord {
                pair_id: "b".repeat(64),
                window_start: now,
                bits_used_before: 0,
                bits_used_after: 6,
                budget_limit: 128,
                budget_tier: BudgetTier::Default,
                budget_enforcement: Some("disabled".to_string()),
                compartment_id: None,
            })
            .build_unsigned()
            .expect("receipt builder should succeed");

        assert_eq!(
            unsigned.guardian_policy_hash, enforcement_hash,
            "receipt guardian_policy_hash must equal enforcement policy content hash"
        );
        assert_eq!(enforcement_hash.len(), 64, "hash should be 64 hex chars");

        // Changing a policy field must change the bound hash.
        let mut modified = sample_policy();
        modified.policy_id = "modified_v1".to_string();
        let modified_hash = content_hash(&modified).unwrap();
        assert_ne!(
            enforcement_hash, modified_hash,
            "modifying policy must change the content hash bound into receipts"
        );
    }

    // -----------------------------------------------------------------------
    // Policy scope validation
    // -----------------------------------------------------------------------

    #[test]
    fn test_policy_scope_relay_global_accepted() {
        let policy = sample_policy();
        assert!(validate_policy_scope(&policy).is_ok());
    }

    #[test]
    fn test_policy_scope_unknown_rejected() {
        let mut policy = sample_policy();
        policy.policy_scope = "SCHEMA_SPECIFIC".to_string();
        let err = validate_policy_scope(&policy).unwrap_err();
        assert!(
            err.to_string().contains("unsupported policy_scope"),
            "unknown scope should fail: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // Rule category validation
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_rule_categories_rejects_unknown() {
        let mut policy = sample_policy();
        policy.rules.push(EnforcementRule {
            rule_id: "bad_category".to_string(),
            rule_type: RuleType::UnicodeCategoryReject,
            value: "Zz".to_string(),
            scope: RuleScope {
                kind: RuleScopeKind::AllStringValues,
                skip_keys: vec![],
            },
            classification: EnforcementClass::Gate,
        });
        let err = validate_rule_categories(&policy).unwrap_err();
        assert!(
            err.to_string()
                .contains("unsupported unicode category 'Zz'"),
            "unknown category should fail: {err}"
        );
    }

    #[test]
    fn test_validate_rule_categories_accepts_nd_and_sc() {
        let policy = sample_policy();
        assert!(validate_rule_categories(&policy).is_ok());
    }

    // -----------------------------------------------------------------------
    // Capability rejection path (#53)
    // -----------------------------------------------------------------------

    #[test]
    fn test_validate_capabilities_rejects_unsupported() {
        // Craft a required set with a capability not in the supported set.
        let mut required = HashSet::new();
        required.insert(RelayCapability::UnicodeCategoryReject);

        // supported set is intentionally empty
        let supported = HashSet::new();

        let err = validate_capabilities_with(&required, &supported).unwrap_err();
        assert!(
            err.to_string().contains("unsupported capability"),
            "missing capability should fail: {err}"
        );
    }
}
