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
}
