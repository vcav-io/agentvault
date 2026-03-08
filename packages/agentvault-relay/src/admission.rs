//! Registry admission module.
//!
//! Selectively loads content-addressed artefacts from a local registry clone,
//! verifying SHA-256(JCS(artefact)) digests at startup. Fail-closed: any
//! mismatch, missing file, or config error prevents the relay from starting.
//!
//! When `AV_REGISTRY_PATH` is unset the relay falls back to its existing
//! lockfile-based loading — this module is not invoked at all.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::enforcement_policy::RelayEnforcementPolicy;
use crate::error::RelayError;
use crate::prompt_program::PromptProgram;

// ============================================================================
// Config types (parsed from relay-admission.toml)
// ============================================================================

/// Top-level admission config.
#[derive(Debug, Clone, Deserialize)]
pub struct AdmissionConfig {
    pub registry: RegistryConfig,
    #[serde(default)]
    pub schemas: KindAdmission,
    #[serde(default)]
    pub policies: KindAdmission,
    #[serde(default)]
    pub profiles: KindAdmission,
    #[serde(default)]
    pub programs: KindAdmission,
}

/// Registry location.
#[derive(Debug, Clone, Deserialize)]
pub struct RegistryConfig {
    pub path: String,
}

/// Admission list for a single artefact kind.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct KindAdmission {
    #[serde(default)]
    pub allow: Vec<String>,
    pub default: Option<String>,
}

// ============================================================================
// Loaded artefact sets returned to the caller
// ============================================================================

/// All artefacts loaded and verified from the registry.
#[derive(Debug)]
pub struct AdmittedArtefacts {
    /// Schemas keyed by bare hex hash (no `sha256:` prefix).
    pub schemas: HashMap<String, serde_json::Value>,
    /// Enforcement policies keyed by bare hex hash.
    pub policies: HashMap<String, RelayEnforcementPolicy>,
    /// Default policy bare hex hash (guaranteed to be in `policies`).
    pub default_policy_hash: Option<String>,
    /// Model profiles keyed by bare hex hash.
    pub profiles: HashMap<String, crate::types::ModelProfile>,
    /// Default profile bare hex hash (guaranteed to be in `profiles`).
    pub default_profile_hash: Option<String>,
    /// Prompt programs keyed by bare hex hash.
    pub programs: HashMap<String, PromptProgram>,
}

// ============================================================================
// Public entry point
// ============================================================================

/// Parse `relay-admission.toml` from the given path, load all admitted
/// artefacts, verify every digest. Returns an error on any failure (fail-closed).
///
/// `registry_path_override`: if `Some`, overrides `[registry].path` from the
/// TOML config. This implements the `AV_REGISTRY_PATH` env var override
/// described in the design doc.
pub fn load_admission(
    config_path: &Path,
    registry_path_override: Option<&str>,
) -> Result<AdmittedArtefacts, RelayError> {
    let config = parse_config(config_path)?;
    validate_defaults(&config)?;

    let registry_path_str = registry_path_override.unwrap_or(&config.registry.path);
    let registry_root = resolve_registry_root(config_path, registry_path_str)?;

    let schemas = load_kind::<serde_json::Value>(&registry_root, "schemas", &config.schemas)?;
    let policies =
        load_kind::<RelayEnforcementPolicy>(&registry_root, "policies", &config.policies)?;
    let profiles =
        load_kind::<crate::types::ModelProfile>(&registry_root, "profiles", &config.profiles)?;
    let programs = load_kind::<PromptProgram>(&registry_root, "programs", &config.programs)?;

    let default_policy_hash = config.policies.default.as_ref().map(|d| strip_prefix(d));
    let default_profile_hash = config.profiles.default.as_ref().map(|d| strip_prefix(d));

    Ok(AdmittedArtefacts {
        schemas,
        policies,
        default_policy_hash,
        profiles,
        default_profile_hash,
        programs,
    })
}

// ============================================================================
// Config parsing
// ============================================================================

fn parse_config(path: &Path) -> Result<AdmissionConfig, RelayError> {
    let data = std::fs::read_to_string(path).map_err(|e| {
        RelayError::Internal(format!(
            "failed to read admission config {}: {e}",
            path.display()
        ))
    })?;
    let config: AdmissionConfig = toml::from_str(&data).map_err(|e| {
        RelayError::Internal(format!(
            "failed to parse admission config {}: {e}",
            path.display()
        ))
    })?;
    Ok(config)
}

/// Validate that every `default` digest appears in the corresponding `allow` list.
fn validate_defaults(config: &AdmissionConfig) -> Result<(), RelayError> {
    validate_default_in_allow("policies", &config.policies)?;
    validate_default_in_allow("profiles", &config.profiles)?;
    validate_default_in_allow("schemas", &config.schemas)?;
    validate_default_in_allow("programs", &config.programs)?;
    Ok(())
}

fn validate_default_in_allow(kind: &str, admission: &KindAdmission) -> Result<(), RelayError> {
    if let Some(ref default) = admission.default {
        if !admission.allow.contains(default) {
            return Err(RelayError::Internal(format!(
                "admission config: {kind}.default '{default}' is not in {kind}.allow list"
            )));
        }
    }
    Ok(())
}

/// Resolve the registry root relative to the config file's parent directory.
fn resolve_registry_root(config_path: &Path, registry_path: &str) -> Result<PathBuf, RelayError> {
    let base = config_path.parent().unwrap_or(Path::new("."));
    let resolved = base.join(registry_path);
    if !resolved.is_dir() {
        return Err(RelayError::Internal(format!(
            "registry path does not exist or is not a directory: {}",
            resolved.display()
        )));
    }
    Ok(resolved)
}

// ============================================================================
// Digest helpers
// ============================================================================

/// Strip the `sha256:` prefix, returning the bare hex hash.
fn strip_prefix(qualified: &str) -> String {
    qualified
        .strip_prefix("sha256:")
        .unwrap_or(qualified)
        .to_string()
}

/// Parse a qualified digest into (algorithm, hex).
fn parse_qualified_digest(digest: &str) -> Result<(&str, &str), RelayError> {
    let (alg, hex) = digest.split_once(':').ok_or_else(|| {
        RelayError::Internal(format!(
            "invalid digest format (expected 'sha256:<hex>'): {digest}"
        ))
    })?;
    if alg != "sha256" {
        return Err(RelayError::Internal(format!(
            "unsupported digest algorithm '{alg}' — only sha256 is supported"
        )));
    }
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(RelayError::Internal(format!(
            "digest hex must be exactly 64 hex characters: {hex}"
        )));
    }
    Ok((alg, hex))
}

/// Convert a qualified digest to the on-disk filename: `sha256-<hex>.json`.
fn digest_to_filename(qualified: &str) -> Result<String, RelayError> {
    let (alg, hex) = parse_qualified_digest(qualified)?;
    Ok(format!("{alg}-{hex}.json"))
}

/// Compute SHA-256 of the JCS-canonical form of a JSON value.
fn compute_jcs_sha256(value: &serde_json::Value) -> Result<String, RelayError> {
    let canonical = receipt_core::canonicalize_serializable(value)
        .map_err(|e| RelayError::Internal(format!("JCS canonicalization failed: {e}")))?;
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

// ============================================================================
// Generic artefact loader
// ============================================================================

/// Load all admitted artefacts for a single kind from `<registry_root>/<kind_dir>/`.
///
/// For each qualified digest in `admission.allow`:
/// 1. Read `<kind_dir>/sha256-<hex>.json`
/// 2. Parse as JSON, then deserialize into `T`
/// 3. Re-canonicalize and verify the digest matches
///
/// Returns a map from bare hex hash to deserialized artefact.
fn load_kind<T: serde::de::DeserializeOwned>(
    registry_root: &Path,
    kind_dir: &str,
    admission: &KindAdmission,
) -> Result<HashMap<String, T>, RelayError> {
    let mut result = HashMap::new();

    for qualified_digest in &admission.allow {
        let (_alg, hex) = parse_qualified_digest(qualified_digest)?;
        let filename = digest_to_filename(qualified_digest)?;
        let file_path = registry_root.join(kind_dir).join(&filename);

        // 1. Read raw file
        let raw = std::fs::read_to_string(&file_path).map_err(|e| {
            RelayError::Internal(format!(
                "admitted artefact missing from registry: {} ({})",
                file_path.display(),
                e
            ))
        })?;

        // 2. Parse as generic JSON for digest verification
        let json_value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
            RelayError::Internal(format!(
                "failed to parse JSON from {}: {e}",
                file_path.display()
            ))
        })?;

        // 3. Verify digest
        let actual_hash = compute_jcs_sha256(&json_value)?;
        if actual_hash != hex {
            return Err(RelayError::Internal(format!(
                "digest verification failed for {}: expected {hex}, got {actual_hash}",
                file_path.display()
            )));
        }

        // 4. Deserialize into the target type
        let artefact: T = serde_json::from_value(json_value).map_err(|e| {
            RelayError::Internal(format!(
                "type validation failed for {}: {e}",
                file_path.display()
            ))
        })?;

        result.insert(hex.to_string(), artefact);
    }

    Ok(result)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Create a unique temp dir for this test to avoid parallel test collisions.
    fn test_tmp(name: &str) -> PathBuf {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("vcav-admission-{name}-{id}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Helper: write a JSON artefact to `<dir>/<kind>/sha256-<hex>.json` and
    /// return its qualified digest.
    fn write_artefact(registry_root: &Path, kind: &str, value: &serde_json::Value) -> String {
        let kind_dir = registry_root.join(kind);
        fs::create_dir_all(&kind_dir).unwrap();

        let hash = compute_jcs_sha256(value).unwrap();
        let filename = format!("sha256-{hash}.json");
        let path = kind_dir.join(filename);
        fs::write(&path, serde_json::to_string_pretty(value).unwrap()).unwrap();

        format!("sha256:{hash}")
    }

    fn sample_schema() -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "signal": { "type": "string", "enum": ["yes", "no"] }
            },
            "required": ["signal"],
            "additionalProperties": false
        })
    }

    fn sample_policy() -> serde_json::Value {
        serde_json::json!({
            "policy_version": "1.0.0",
            "policy_id": "test-policy",
            "policy_scope": "RELAY_GLOBAL",
            "rules": []
        })
    }

    fn sample_profile() -> serde_json::Value {
        serde_json::json!({
            "profile_version": "1",
            "profile_id": "test-profile-v1",
            "provider": "anthropic",
            "model_id": "claude-sonnet-4-6",
            "model_family": "claude-sonnet",
            "reasoning_mode": "unconstrained",
            "structured_output": true
        })
    }

    fn sample_program() -> serde_json::Value {
        serde_json::json!({
            "version": "1.0.0",
            "system_instruction": "You are a structured data classifier.",
            "input_format": "structured"
        })
    }

    /// Write a complete admission config and return the config file path.
    fn setup_admission(tmp: &Path) -> (PathBuf, String, String, String, String) {
        let registry = tmp.join("registry");
        fs::create_dir_all(&registry).unwrap();

        let schema_digest = write_artefact(&registry, "schemas", &sample_schema());
        let policy_digest = write_artefact(&registry, "policies", &sample_policy());
        let profile_digest = write_artefact(&registry, "profiles", &sample_profile());
        let program_digest = write_artefact(&registry, "programs", &sample_program());

        let config_toml = format!(
            r#"[registry]
path = "{registry_path}"

[schemas]
allow = ["{schema_digest}"]

[policies]
allow = ["{policy_digest}"]
default = "{policy_digest}"

[profiles]
allow = ["{profile_digest}"]
default = "{profile_digest}"

[programs]
allow = ["{program_digest}"]
"#,
            registry_path = registry.display(),
        );

        let config_path = tmp.join("relay-admission.toml");
        fs::write(&config_path, &config_toml).unwrap();

        (
            config_path,
            schema_digest,
            policy_digest,
            profile_digest,
            program_digest,
        )
    }

    #[test]
    fn test_parse_config_success() {
        let tmp = test_tmp("parse");

        let (config_path, ..) = setup_admission(&tmp);
        let config = parse_config(&config_path).unwrap();

        assert_eq!(config.schemas.allow.len(), 1);
        assert_eq!(config.policies.allow.len(), 1);
        assert!(config.policies.default.is_some());
        assert_eq!(config.profiles.allow.len(), 1);
        assert_eq!(config.programs.allow.len(), 1);

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_load_admission_success() {
        let tmp = test_tmp("full");

        let (config_path, schema_digest, policy_digest, profile_digest, program_digest) =
            setup_admission(&tmp);
        let artefacts = load_admission(&config_path, None).unwrap();

        assert_eq!(artefacts.schemas.len(), 1);
        assert!(artefacts
            .schemas
            .contains_key(&strip_prefix(&schema_digest)));

        assert_eq!(artefacts.policies.len(), 1);
        assert!(artefacts
            .policies
            .contains_key(&strip_prefix(&policy_digest)));
        assert_eq!(
            artefacts.default_policy_hash.as_deref(),
            Some(strip_prefix(&policy_digest).as_str())
        );

        assert_eq!(artefacts.profiles.len(), 1);
        assert!(artefacts
            .profiles
            .contains_key(&strip_prefix(&profile_digest)));

        assert_eq!(artefacts.programs.len(), 1);
        assert!(artefacts
            .programs
            .contains_key(&strip_prefix(&program_digest)));

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_digest_verification_failure() {
        let tmp = test_tmp("bad-digest");

        let registry = tmp.join("registry");
        let schemas_dir = registry.join("schemas");
        fs::create_dir_all(&schemas_dir).unwrap();

        // Write a file with a wrong hash in the filename
        let fake_hex = "a".repeat(64);
        let filename = format!("sha256-{fake_hex}.json");
        let content = serde_json::json!({"type": "object"});
        fs::write(
            schemas_dir.join(&filename),
            serde_json::to_string_pretty(&content).unwrap(),
        )
        .unwrap();

        let config_toml = format!(
            r#"[registry]
path = "{}"

[schemas]
allow = ["sha256:{fake_hex}"]
"#,
            registry.display(),
        );
        let config_path = tmp.join("relay-admission.toml");
        fs::write(&config_path, &config_toml).unwrap();

        let result = load_admission(&config_path, None);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("digest verification failed"),
            "unexpected error: {err}"
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_missing_artefact_file() {
        let tmp = test_tmp("missing");

        let registry = tmp.join("registry");
        let schemas_dir = registry.join("schemas");
        fs::create_dir_all(&schemas_dir).unwrap();

        let fake_hex = "b".repeat(64);
        let config_toml = format!(
            r#"[registry]
path = "{}"

[schemas]
allow = ["sha256:{fake_hex}"]
"#,
            registry.display(),
        );
        let config_path = tmp.join("relay-admission.toml");
        fs::write(&config_path, &config_toml).unwrap();

        let result = load_admission(&config_path, None);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("admitted artefact missing"),
            "unexpected error: {err}"
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_default_not_in_allow() {
        let tmp = test_tmp("default-notinallow");

        let registry = tmp.join("registry");
        fs::create_dir_all(&registry).unwrap();

        let good_hex = "c".repeat(64);
        let bad_hex = "d".repeat(64);
        let config_toml = format!(
            r#"[registry]
path = "{}"

[policies]
allow = ["sha256:{good_hex}"]
default = "sha256:{bad_hex}"
"#,
            registry.display(),
        );
        let config_path = tmp.join("relay-admission.toml");
        fs::write(&config_path, &config_toml).unwrap();

        let result = load_admission(&config_path, None);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("not in"), "unexpected error: {err}");

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_invalid_digest_format() {
        let result = parse_qualified_digest("md5:abc123");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("unsupported"));
    }

    #[test]
    fn test_invalid_hex_length() {
        let result = parse_qualified_digest("sha256:tooshort");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("64 hex characters"));
    }

    #[test]
    fn test_missing_colon() {
        let result = parse_qualified_digest("sha256abc");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("invalid digest format"));
    }

    #[test]
    fn test_strip_prefix() {
        assert_eq!(strip_prefix("sha256:abcd"), "abcd");
        assert_eq!(strip_prefix("abcd"), "abcd");
    }

    #[test]
    fn test_type_validation_failure() {
        let tmp = test_tmp("type-fail");

        let registry = tmp.join("registry");
        let policies_dir = registry.join("policies");
        fs::create_dir_all(&policies_dir).unwrap();

        // Write something that is valid JSON but not a valid RelayEnforcementPolicy
        let not_a_policy = serde_json::json!({
            "totally": "wrong",
            "schema": true
        });
        let hash = compute_jcs_sha256(&not_a_policy).unwrap();
        let filename = format!("sha256-{hash}.json");
        fs::write(
            policies_dir.join(&filename),
            serde_json::to_string_pretty(&not_a_policy).unwrap(),
        )
        .unwrap();

        let config_toml = format!(
            r#"[registry]
path = "{}"

[policies]
allow = ["sha256:{hash}"]
default = "sha256:{hash}"
"#,
            registry.display(),
        );
        let config_path = tmp.join("relay-admission.toml");
        fs::write(&config_path, &config_toml).unwrap();

        let result = load_admission(&config_path, None);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("type validation failed"),
            "unexpected error: {err}"
        );

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn test_empty_allow_lists() {
        let tmp = test_tmp("empty");

        let registry = tmp.join("registry");
        fs::create_dir_all(&registry).unwrap();

        let config_toml = format!(
            r#"[registry]
path = "{}"
"#,
            registry.display(),
        );
        let config_path = tmp.join("relay-admission.toml");
        fs::write(&config_path, &config_toml).unwrap();

        let artefacts = load_admission(&config_path, None).unwrap();
        assert!(artefacts.schemas.is_empty());
        assert!(artefacts.policies.is_empty());
        assert!(artefacts.profiles.is_empty());
        assert!(artefacts.programs.is_empty());

        fs::remove_dir_all(&tmp).ok();
    }
}
