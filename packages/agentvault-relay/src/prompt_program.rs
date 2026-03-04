use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::RelayError;
use crate::types::{Contract, ModelProfile, RelayInput};

/// A content-addressed description of how to assemble a provider prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptProgram {
    pub version: String,
    pub system_instruction: String,
    pub input_format: InputFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputFormat {
    Structured,
    Narrative,
}

/// Assembled provider prompt ready to send.
pub struct AssembledPrompt {
    pub system: String,
    pub user_message: String,
}

impl PromptProgram {
    /// Compute the content-addressed hash of this prompt program.
    pub fn content_hash(&self) -> Result<String, RelayError> {
        let canonical = receipt_core::canonicalize_serializable(self)
            .map_err(|e| RelayError::PromptProgram(format!("canonicalization failed: {e}")))?;
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        Ok(hex::encode(hasher.finalize()))
    }

    /// Assemble a provider prompt from the contract and both inputs.
    pub fn assemble(
        &self,
        contract: &Contract,
        input_a: &RelayInput,
        input_b: &RelayInput,
    ) -> Result<AssembledPrompt, RelayError> {
        let user_message = match self.input_format {
            InputFormat::Structured => {
                format!(
                    "Contract purpose: {purpose}\n\
                     Output schema: {schema_id}\n\n\
                     --- Input from {role_a} ---\n\
                     {context_a}\n\n\
                     --- Input from {role_b} ---\n\
                     {context_b}\n\n\
                     Respond with ONLY the JSON object matching the output schema. \
                     No explanation, no markdown, no code fences.",
                    purpose = contract.purpose_code,
                    schema_id = contract.output_schema_id,
                    role_a = input_a.role,
                    context_a = serde_json::to_string_pretty(&input_a.context).map_err(|e| {
                        RelayError::PromptProgram(format!("failed to serialize input_a: {e}"))
                    })?,
                    role_b = input_b.role,
                    context_b = serde_json::to_string_pretty(&input_b.context).map_err(|e| {
                        RelayError::PromptProgram(format!("failed to serialize input_b: {e}"))
                    })?,
                )
            }
            InputFormat::Narrative => {
                format!(
                    "You are mediating between two parties for a {purpose} session.\n\n\
                     {role_a} says:\n{context_a}\n\n\
                     {role_b} says:\n{context_b}\n\n\
                     Respond with ONLY the JSON object matching the output schema. \
                     No explanation, no markdown, no code fences.",
                    purpose = contract.purpose_code,
                    role_a = input_a.role,
                    context_a = serde_json::to_string_pretty(&input_a.context).map_err(|e| {
                        RelayError::PromptProgram(format!("failed to serialize input_a: {e}"))
                    })?,
                    role_b = input_b.role,
                    context_b = serde_json::to_string_pretty(&input_b.context).map_err(|e| {
                        RelayError::PromptProgram(format!("failed to serialize input_b: {e}"))
                    })?,
                )
            }
        };

        Ok(AssembledPrompt {
            system: self.system_instruction.clone(),
            user_message,
        })
    }
}

impl ModelProfile {
    /// Compute the content-addressed hash of this model profile (SHA-256 of canonical JSON).
    pub fn content_hash(&self) -> Result<String, RelayError> {
        let canonical = receipt_core::canonicalize_serializable(self).map_err(|e| {
            RelayError::PromptProgram(format!("model profile canonicalization failed: {e}"))
        })?;
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        Ok(hex::encode(hasher.finalize()))
    }
}

/// Load a model profile from the file system by its profile_id.
/// The file is named `{profile_id}.json` in the given directory.
pub fn load_model_profile(dir: &str, profile_id: &str) -> Result<ModelProfile, RelayError> {
    // Sanitize profile_id to prevent path traversal: no '..', no '/', only safe chars
    if profile_id.contains("..") || profile_id.contains('/') || profile_id.contains('\\') {
        return Err(RelayError::PromptProgram(
            "model profile_id contains invalid characters".to_string(),
        ));
    }

    let path = std::path::Path::new(dir).join(format!("{profile_id}.json"));
    let data = std::fs::read_to_string(&path).map_err(|e| {
        tracing::debug!(path = %path.display(), error = %e, "model profile load failed");
        RelayError::PromptProgram(format!("model profile not found for id: {profile_id}"))
    })?;

    let profile: ModelProfile = serde_json::from_str(&data)
        .map_err(|e| RelayError::PromptProgram(format!("invalid model profile JSON: {e}")))?;

    Ok(profile)
}

const LOCKFILE_NAME: &str = "model_profiles.lock";

/// Validate model profile lockfile: for each entry, load profile, compute hash, compare.
/// Missing lockfile → Ok (graceful degradation for dev environments).
/// Hash mismatch → Err (hard failure).
pub fn validate_model_profile_lockfile(dir: &str) -> Result<(), RelayError> {
    let lockfile_path = std::path::Path::new(dir).join(LOCKFILE_NAME);

    let data = match std::fs::read_to_string(&lockfile_path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::warn!(
                path = %lockfile_path.display(),
                "model_profiles.lock not found — skipping profile hash validation (dev mode)"
            );
            return Ok(());
        }
        Err(e) => {
            return Err(RelayError::PromptProgram(format!(
                "failed to read model_profiles.lock: {e}"
            )));
        }
    };

    let lockfile: HashMap<String, String> = serde_json::from_str(&data).map_err(|e| {
        RelayError::PromptProgram(format!("invalid model_profiles.lock format: {e}"))
    })?;

    for (profile_id, expected_hash) in &lockfile {
        let profile = load_model_profile(dir, profile_id)?;
        let actual_hash = profile.content_hash()?;
        if &actual_hash != expected_hash {
            return Err(RelayError::PromptProgram(format!(
                "model profile hash mismatch for '{profile_id}': \
                 expected {expected_hash}, got {actual_hash}"
            )));
        }
        tracing::debug!(profile_id, "model profile hash verified");
    }

    tracing::info!(count = lockfile.len(), "model profile lockfile validated");
    Ok(())
}

/// Generate (or regenerate) the lockfile for all valid ModelProfile JSON files in `dir`.
/// Scans `*.json` files, deserializes those that match ModelProfile, and writes
/// `model_profiles.lock` with `{ profile_id -> content_hash }` entries.
pub fn generate_model_profile_lockfile(dir: &str) -> Result<(), RelayError> {
    let dir_path = std::path::Path::new(dir);

    let entries = std::fs::read_dir(dir_path).map_err(|e| {
        RelayError::PromptProgram(format!("failed to read prompt_programs dir: {e}"))
    })?;

    let mut lockfile: HashMap<String, String> = HashMap::new();

    for entry in entries {
        let entry = entry.map_err(|e| {
            RelayError::PromptProgram(format!("failed to read directory entry: {e}"))
        })?;
        let path = entry.path();

        // Only process *.json, skip the lockfile itself
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let data = match std::fs::read_to_string(&path) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let profile: ModelProfile = match serde_json::from_str(&data) {
            Ok(p) => p,
            Err(_) => continue, // Not a ModelProfile — skip
        };

        let hash = profile.content_hash()?;
        lockfile.insert(profile.profile_id.clone(), hash);
    }

    let lockfile_path = dir_path.join(LOCKFILE_NAME);
    let lockfile_json = serde_json::to_string_pretty(&lockfile)
        .map_err(|e| RelayError::PromptProgram(format!("failed to serialize lockfile: {e}")))?;
    std::fs::write(&lockfile_path, lockfile_json + "\n")
        .map_err(|e| RelayError::PromptProgram(format!("failed to write lockfile: {e}")))?;

    tracing::info!(
        path = %lockfile_path.display(),
        count = lockfile.len(),
        "model_profiles.lock written"
    );
    Ok(())
}

/// Load a prompt program from the file system by its content-addressed hash.
pub fn load_prompt_program(dir: &str, expected_hash: &str) -> Result<PromptProgram, RelayError> {
    // Validate hash format to prevent path traversal (expected_hash is user-controlled)
    if expected_hash.len() != 64 || !expected_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(RelayError::ContractValidation(
            "prompt_template_hash must be exactly 64 hex characters".to_string(),
        ));
    }

    let path = std::path::Path::new(dir).join(format!("{expected_hash}.json"));
    let data = std::fs::read_to_string(&path).map_err(|e| {
        tracing::debug!(path = %path.display(), error = %e, "prompt program load failed");
        RelayError::PromptProgram(format!(
            "prompt program not found for hash: {expected_hash}"
        ))
    })?;

    let program: PromptProgram = serde_json::from_str(&data)
        .map_err(|e| RelayError::PromptProgram(format!("invalid prompt program JSON: {e}")))?;

    let actual_hash = program.content_hash()?;
    if actual_hash != expected_hash {
        return Err(RelayError::ContractValidation(format!(
            "prompt program hash mismatch: expected {expected_hash}, got {actual_hash}"
        )));
    }

    Ok(program)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_program() -> PromptProgram {
        PromptProgram {
            version: "1.0.0".to_string(),
            system_instruction: "You are a structured data classifier.".to_string(),
            input_format: InputFormat::Structured,
        }
    }

    #[test]
    fn test_content_hash_deterministic() {
        let program = sample_program();
        let hash1 = program.content_hash().unwrap();
        let hash2 = program.content_hash().unwrap();
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 64);
    }

    #[test]
    fn test_content_hash_changes_with_content() {
        let p1 = sample_program();
        let mut p2 = sample_program();
        p2.system_instruction = "Different instruction.".to_string();
        assert_ne!(p1.content_hash().unwrap(), p2.content_hash().unwrap());
    }

    #[test]
    fn test_assemble_structured() {
        let program = sample_program();
        let contract = Contract {
            purpose_code: vault_family_types::Purpose::Mediation,
            output_schema_id: "vault_result_mediation".to_string(),
            output_schema: serde_json::json!({}),
            participants: vec!["alice".to_string(), "bob".to_string()],
            prompt_template_hash: "x".repeat(64),
            entropy_budget_bits: None,
            timing_class: None,
            metadata: serde_json::Value::Null,
            model_profile_id: None,
            enforcement_policy_hash: None,
            output_schema_hash: None,
            model_constraints: None,
            max_completion_tokens: None,
            session_ttl_secs: None,
            invite_ttl_secs: None,
            entropy_enforcement: None,
        };
        let input_a = RelayInput {
            role: "alice".to_string(),
            context: serde_json::json!({"preference": "morning"}),
        };
        let input_b = RelayInput {
            role: "bob".to_string(),
            context: serde_json::json!({"preference": "evening"}),
        };

        let result = program.assemble(&contract, &input_a, &input_b).unwrap();
        assert!(result.user_message.contains("alice"));
        assert!(result.user_message.contains("bob"));
        assert!(result.user_message.contains("MEDIATION"));
        assert_eq!(result.system, program.system_instruction);
    }

    #[test]
    fn test_load_prompt_program_hash_mismatch() {
        let dir = std::env::temp_dir().join("vcav-e-relay-test-mismatch");
        std::fs::create_dir_all(&dir).unwrap();

        let program = sample_program();
        let hash = program.content_hash().unwrap();

        let path = dir.join(format!("{hash}.json"));
        let mut modified = program;
        modified.system_instruction = "tampered".to_string();
        std::fs::write(&path, serde_json::to_string(&modified).unwrap()).unwrap();

        let result = load_prompt_program(dir.to_str().unwrap(), &hash);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("hash mismatch"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_prompt_program_success() {
        let dir = std::env::temp_dir().join("vcav-e-relay-test-success");
        std::fs::create_dir_all(&dir).unwrap();

        let program = sample_program();
        let hash = program.content_hash().unwrap();

        let path = dir.join(format!("{hash}.json"));
        std::fs::write(&path, serde_json::to_string(&program).unwrap()).unwrap();

        let loaded = load_prompt_program(dir.to_str().unwrap(), &hash).unwrap();
        assert_eq!(loaded.version, program.version);
        assert_eq!(loaded.system_instruction, program.system_instruction);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_prompt_program_rejects_path_traversal() {
        let result = load_prompt_program("/tmp", "../../etc/passwd");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("64 hex characters"));
    }

    #[test]
    fn test_load_prompt_program_rejects_non_hex() {
        let result = load_prompt_program("/tmp", &"g".repeat(64));
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("64 hex characters"));
    }

    #[test]
    fn test_load_model_profile_success() {
        use crate::types::ModelProfile;

        let dir = std::env::temp_dir().join("vcav-e-relay-test-model-profile");
        std::fs::create_dir_all(&dir).unwrap();

        let profile = ModelProfile {
            profile_version: "1".to_string(),
            profile_id: "test-model-v1".to_string(),
            provider: "anthropic".to_string(),
            model_family: "claude-sonnet".to_string(),
            reasoning_mode: "unconstrained".to_string(),
            structured_output: true,
        };

        let path = dir.join("test-model-v1.json");
        std::fs::write(&path, serde_json::to_string(&profile).unwrap()).unwrap();

        let loaded = load_model_profile(dir.to_str().unwrap(), "test-model-v1").unwrap();
        assert_eq!(loaded.profile_id, "test-model-v1");
        assert_eq!(loaded.provider, "anthropic");
        assert_eq!(loaded.model_family, "claude-sonnet");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_model_profile_rejects_path_traversal() {
        let result = load_model_profile("/tmp", "../etc/passwd");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("invalid characters"));
    }

    #[test]
    fn test_load_model_profile_rejects_backslash() {
        let result = load_model_profile("/tmp", "foo\\bar");
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("invalid characters"));
    }

    #[test]
    fn test_model_profile_content_hash_deterministic() {
        use crate::types::ModelProfile;

        let profile = ModelProfile {
            profile_version: "1".to_string(),
            profile_id: "api-claude-sonnet-v1".to_string(),
            provider: "anthropic".to_string(),
            model_family: "claude-sonnet".to_string(),
            reasoning_mode: "unconstrained".to_string(),
            structured_output: true,
        };

        let h1 = profile.content_hash().unwrap();
        let h2 = profile.content_hash().unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn test_model_profile_content_hash_changes_with_content() {
        use crate::types::ModelProfile;

        let p1 = ModelProfile {
            profile_version: "1".to_string(),
            profile_id: "api-claude-sonnet-v1".to_string(),
            provider: "anthropic".to_string(),
            model_family: "claude-sonnet".to_string(),
            reasoning_mode: "unconstrained".to_string(),
            structured_output: true,
        };
        let mut p2 = p1.clone();
        p2.model_family = "claude-haiku".to_string();

        assert_ne!(p1.content_hash().unwrap(), p2.content_hash().unwrap());
    }

    fn make_test_profile(profile_id: &str) -> crate::types::ModelProfile {
        crate::types::ModelProfile {
            profile_version: "1".to_string(),
            profile_id: profile_id.to_string(),
            provider: "anthropic".to_string(),
            model_family: "claude-sonnet".to_string(),
            reasoning_mode: "unconstrained".to_string(),
            structured_output: true,
        }
    }

    fn write_profile(dir: &std::path::Path, profile: &crate::types::ModelProfile) {
        let path = dir.join(format!("{}.json", profile.profile_id));
        std::fs::write(path, serde_json::to_string(profile).unwrap()).unwrap();
    }

    fn write_lockfile(dir: &std::path::Path, entries: &[(&str, &str)]) {
        use std::collections::HashMap;
        let map: HashMap<&str, &str> = entries.iter().cloned().collect();
        let path = dir.join(LOCKFILE_NAME);
        std::fs::write(path, serde_json::to_string_pretty(&map).unwrap()).unwrap();
    }

    #[test]
    fn test_lockfile_valid() {
        let dir = std::env::temp_dir().join("vcav-lockfile-valid");
        std::fs::create_dir_all(&dir).unwrap();

        let profile = make_test_profile("test-model-v1");
        write_profile(&dir, &profile);
        let hash = profile.content_hash().unwrap();
        write_lockfile(&dir, &[("test-model-v1", &hash)]);

        let result = validate_model_profile_lockfile(dir.to_str().unwrap());
        assert!(result.is_ok(), "expected Ok, got: {result:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_lockfile_hash_mismatch() {
        let dir = std::env::temp_dir().join("vcav-lockfile-mismatch");
        std::fs::create_dir_all(&dir).unwrap();

        let profile = make_test_profile("test-model-v1");
        write_profile(&dir, &profile);
        // Write a deliberately wrong hash
        write_lockfile(&dir, &[("test-model-v1", &"a".repeat(64))]);

        let result = validate_model_profile_lockfile(dir.to_str().unwrap());
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("hash mismatch"),
            "error should mention hash mismatch"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_lockfile_missing_is_ok() {
        let dir = std::env::temp_dir().join("vcav-lockfile-missing");
        std::fs::create_dir_all(&dir).unwrap();
        // No lockfile written

        let result = validate_model_profile_lockfile(dir.to_str().unwrap());
        assert!(result.is_ok(), "missing lockfile should return Ok");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_lockfile_extra_profile_not_in_lockfile_is_ok() {
        let dir = std::env::temp_dir().join("vcav-lockfile-extra");
        std::fs::create_dir_all(&dir).unwrap();

        let p1 = make_test_profile("pinned-model-v1");
        let p2 = make_test_profile("extra-model-v1");
        write_profile(&dir, &p1);
        write_profile(&dir, &p2);

        // Only lockfile entry for p1 — p2 is extra (unlisted)
        let hash1 = p1.content_hash().unwrap();
        write_lockfile(&dir, &[("pinned-model-v1", &hash1)]);

        let result = validate_model_profile_lockfile(dir.to_str().unwrap());
        assert!(
            result.is_ok(),
            "extra unlisted profile should not cause failure"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_generate_lockfile() {
        let dir = std::env::temp_dir().join("vcav-lockfile-generate");
        std::fs::create_dir_all(&dir).unwrap();

        let profile = make_test_profile("gen-model-v1");
        write_profile(&dir, &profile);

        generate_model_profile_lockfile(dir.to_str().unwrap()).unwrap();

        // Lockfile should now exist and validate successfully
        let result = validate_model_profile_lockfile(dir.to_str().unwrap());
        assert!(
            result.is_ok(),
            "generated lockfile should validate: {result:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
