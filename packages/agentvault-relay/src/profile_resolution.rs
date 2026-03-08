//! Profile resolution — the policy boundary for contract-bound model selection.
//!
//! When a contract specifies `model_profile_id`, the relay resolves it to a
//! concrete runtime configuration (provider, model_id, profile hash). This
//! module enforces fail-closed semantics: if a named profile cannot be
//! resolved, the session is rejected.
//!
//! Resolution precedence:
//! - `admitted_profiles` (registry admission): checked first, already
//!   hash-verified at load time.
//! - Filesystem (`prompt_program_dir`): only used when no registry is
//!   configured (`admitted_profiles` is `None`). "Present on disk" and
//!   "admitted for execution" are separate concepts.
//!
//! Legacy mode: contracts with no `model_profile_id` return `Ok(None)`,
//! signalling the caller to use env-var defaults. This is logged visibly.

use std::collections::HashMap;

use crate::error::RelayError;
use crate::prompt_program::load_model_profile;
use crate::types::{Contract, ModelProfile};

/// Resolved runtime model configuration derived from a contract's profile binding.
#[derive(Debug, Clone)]
pub struct ResolvedRuntime {
    /// Provider name (e.g. "anthropic", "openai", "gemini").
    pub provider: String,
    /// Concrete model identifier to dispatch to the provider API.
    pub model_id: String,
    /// Content hash of the resolved profile artefact.
    pub profile_hash: String,
    /// The full resolved profile.
    pub profile: ModelProfile,
}

/// Resolve the runtime model from a contract's profile binding.
///
/// Returns:
/// - `Ok(Some(ResolvedRuntime))` — profile found and verified.
/// - `Ok(None)` — legacy contract with no `model_profile_id`.
/// - `Err` — profile named but not resolvable (fail closed).
pub fn resolve_runtime_profile(
    contract: &Contract,
    admitted_profiles: &Option<HashMap<String, ModelProfile>>,
    prompt_program_dir: &str,
) -> Result<Option<ResolvedRuntime>, RelayError> {
    let (profile_id, expected_hash) = match (
        contract.model_profile_id.as_deref(),
        contract.model_profile_hash.as_deref(),
    ) {
        (None, None) => return Ok(None),
        (Some(_), None) | (None, Some(_)) => return Err(RelayError::ContractValidation(
            "model_profile_id and model_profile_hash must either both be present or both be absent"
                .to_string(),
        )),
        (Some(id), Some(hash)) => (id, hash),
    };

    let profile = match admitted_profiles {
        Some(profiles) => {
            // Registry is configured — only admitted profiles are valid.
            // Linear search by profile_id (profiles are keyed by hash).
            profiles
                .values()
                .find(|p| p.profile_id == *profile_id)
                .cloned()
                .ok_or_else(|| {
                    // Check if the profile exists on disk but isn't admitted.
                    if load_model_profile(prompt_program_dir, profile_id).is_ok() {
                        RelayError::ProfileNotAdmitted {
                            profile_id: profile_id.to_string(),
                        }
                    } else {
                        RelayError::ProfileNotFound {
                            profile_id: profile_id.to_string(),
                        }
                    }
                })?
        }
        None => {
            // No registry configured — filesystem fallback (dev mode).
            load_model_profile(prompt_program_dir, profile_id).map_err(|_| {
                RelayError::ProfileNotFound {
                    profile_id: profile_id.to_string(),
                }
            })?
        }
    };

    let profile_hash = profile.content_hash().map_err(|e| {
        RelayError::PromptProgram(format!(
            "failed to compute profile hash for '{profile_id}': {e}"
        ))
    })?;

    if profile_hash != expected_hash {
        return Err(RelayError::ContractValidation(format!(
            "model_profile_hash '{expected_hash}' does not match resolved profile '{profile_hash}'"
        )));
    }

    Ok(Some(ResolvedRuntime {
        provider: profile.provider.clone(),
        model_id: profile.model_id.clone(),
        profile_hash,
        profile,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_profile(id: &str, provider: &str, model_id: &str) -> ModelProfile {
        ModelProfile {
            profile_version: "1".to_string(),
            profile_id: id.to_string(),
            provider: provider.to_string(),
            model_id: model_id.to_string(),
            model_family: "test".to_string(),
            reasoning_mode: "unconstrained".to_string(),
            structured_output: true,
        }
    }

    fn make_contract(profile_id: Option<&str>) -> Contract {
        Contract {
            purpose_code: vault_family_types::Purpose::Mediation,
            output_schema_id: "test".to_string(),
            output_schema: serde_json::json!({}),
            participants: vec!["alice".to_string(), "bob".to_string()],
            prompt_template_hash: "a".repeat(64),
            entropy_budget_bits: None,
            timing_class: None,
            metadata: serde_json::Value::Null,
            model_profile_id: profile_id.map(|s| s.to_string()),
            model_profile_hash: None,
            enforcement_policy_hash: None,
            output_schema_hash: None,
            model_constraints: None,
            max_completion_tokens: None,
            session_ttl_secs: None,
            invite_ttl_secs: None,
            entropy_enforcement: None,
            relay_verifying_key_hex: None,
        }
    }

    fn admitted_map(profiles: Vec<ModelProfile>) -> Option<HashMap<String, ModelProfile>> {
        let mut map = HashMap::new();
        for p in profiles {
            let hash = p.content_hash().unwrap();
            map.insert(hash, p);
        }
        Some(map)
    }

    // ── Positive tests ──────────────────────────────────────────────

    #[test]
    fn test_resolve_admitted_profile() {
        let profile = make_profile("api-claude-sonnet-v1", "anthropic", "claude-sonnet-4-6");
        let profile_hash = profile.content_hash().unwrap();
        let admitted = admitted_map(vec![profile.clone()]);
        let mut contract = make_contract(Some("api-claude-sonnet-v1"));
        contract.model_profile_hash = Some(profile_hash.clone());

        let result = resolve_runtime_profile(&contract, &admitted, "/nonexistent").unwrap();
        let rt = result.expect("should resolve to Some");
        assert_eq!(rt.provider, "anthropic");
        assert_eq!(rt.model_id, "claude-sonnet-4-6");
        assert_eq!(rt.profile.profile_id, "api-claude-sonnet-v1");
        assert_eq!(rt.profile_hash, profile_hash);
    }

    #[test]
    fn test_resolve_filesystem_fallback_when_no_admission() {
        let dir = std::env::temp_dir().join("vcav-profile-res-fs");
        std::fs::create_dir_all(&dir).unwrap();

        let profile = make_profile("fs-profile-v1", "openai", "gpt-5");
        let path = dir.join("fs-profile-v1.json");
        std::fs::write(&path, serde_json::to_string(&profile).unwrap()).unwrap();

        let mut contract = make_contract(Some("fs-profile-v1"));
        contract.model_profile_hash = Some(profile.content_hash().unwrap());
        let result = resolve_runtime_profile(&contract, &None, dir.to_str().unwrap()).unwrap();
        let rt = result.expect("should resolve from filesystem");
        assert_eq!(rt.provider, "openai");
        assert_eq!(rt.model_id, "gpt-5");

        std::fs::remove_dir_all(&dir).ok();
    }

    // ── Legacy tests ────────────────────────────────────────────────

    #[test]
    fn test_legacy_contract_returns_none() {
        let contract = make_contract(None);
        let result = resolve_runtime_profile(&contract, &None, "/nonexistent").unwrap();
        assert!(result.is_none(), "legacy contract should return None");
    }

    // ── Fail-closed tests ───────────────────────────────────────────

    #[test]
    fn test_unknown_profile_with_admission_rejects() {
        let admitted = admitted_map(vec![]);
        let mut contract = make_contract(Some("nonexistent-profile"));
        contract.model_profile_hash = Some("a".repeat(64));

        let err = resolve_runtime_profile(&contract, &admitted, "/nonexistent").unwrap_err();
        assert!(
            err.to_string().contains("not found"),
            "expected ProfileNotFound, got: {err}"
        );
    }

    #[test]
    fn test_unknown_profile_without_admission_rejects() {
        let mut contract = make_contract(Some("nonexistent-profile"));
        contract.model_profile_hash = Some("a".repeat(64));

        let err = resolve_runtime_profile(&contract, &None, "/nonexistent").unwrap_err();
        assert!(
            err.to_string().contains("not found"),
            "expected ProfileNotFound, got: {err}"
        );
    }

    #[test]
    fn test_profile_on_disk_but_not_admitted_rejects() {
        let dir = std::env::temp_dir().join("vcav-profile-res-not-admitted");
        std::fs::create_dir_all(&dir).unwrap();

        // Write profile to disk
        let profile = make_profile("unadmitted-v1", "anthropic", "claude-sonnet-4-6");
        let path = dir.join("unadmitted-v1.json");
        std::fs::write(&path, serde_json::to_string(&profile).unwrap()).unwrap();

        // Admission is configured but doesn't include this profile
        let admitted = admitted_map(vec![]);
        let mut contract = make_contract(Some("unadmitted-v1"));
        contract.model_profile_hash = Some(profile.content_hash().unwrap());

        let err = resolve_runtime_profile(&contract, &admitted, dir.to_str().unwrap()).unwrap_err();
        assert!(
            err.to_string().contains("not admitted"),
            "expected ProfileNotAdmitted, got: {err}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_partial_profile_binding_rejects() {
        let contract = make_contract(Some("api-claude-sonnet-v1"));

        let err = resolve_runtime_profile(&contract, &None, "/nonexistent").unwrap_err();
        assert!(
            err.to_string()
                .contains("must either both be present or both be absent"),
            "expected partial-binding rejection, got: {err}"
        );
    }

    #[test]
    fn test_mismatched_profile_hash_rejects() {
        let profile = make_profile("api-claude-sonnet-v1", "anthropic", "claude-sonnet-4-6");
        let admitted = admitted_map(vec![profile]);
        let mut contract = make_contract(Some("api-claude-sonnet-v1"));
        contract.model_profile_hash = Some("f".repeat(64));

        let err = resolve_runtime_profile(&contract, &admitted, "/nonexistent").unwrap_err();
        assert!(
            err.to_string().contains("does not match resolved profile"),
            "expected mismatched hash rejection, got: {err}"
        );
    }
}
