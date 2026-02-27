use std::collections::HashMap;

use serde::Deserialize;

use crate::error::RelayError;

/// A registered agent with an inbox bearer token.
#[derive(Debug, Clone, Deserialize)]
pub struct RegisteredAgent {
    pub agent_id: String,
    /// Bearer token for inbox operations.
    pub inbox_token: String,
    /// Ed25519 public key (hex). Optional — used as default for from_agent_pubkey
    /// when creating invites.
    #[serde(default)]
    pub public_key_hex: Option<String>,
}

/// Agent registry config file format.
#[derive(Debug, Deserialize)]
struct RegistryConfig {
    agents: Vec<RegisteredAgent>,
}

/// Registry of agents authorized for inbox operations.
///
/// Loaded from a JSON config file at startup. Fail-closed: missing file = startup
/// failure unless `VCAV_INBOX_AUTH=off` is explicitly set.
#[derive(Clone)]
pub struct AgentRegistry {
    /// token -> RegisteredAgent (for constant-time-ish lookup by token)
    by_token: HashMap<String, RegisteredAgent>,
    /// agent_id -> RegisteredAgent (for lookup by agent_id)
    by_agent_id: HashMap<String, RegisteredAgent>,
}

impl AgentRegistry {
    /// Load from a JSON config file.
    ///
    /// File format:
    /// ```json
    /// {
    ///   "agents": [
    ///     { "agent_id": "alice", "inbox_token": "hex...", "public_key_hex": "aa..." },
    ///     { "agent_id": "bob", "inbox_token": "hex..." }
    ///   ]
    /// }
    /// ```
    pub fn load_from_file(path: &str) -> Result<Self, RelayError> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| RelayError::Internal(format!("failed to read agent registry: {e}")))?;
        let config: RegistryConfig = serde_json::from_str(&content)
            .map_err(|e| RelayError::Internal(format!("failed to parse agent registry: {e}")))?;
        Self::from_agents(config.agents)
    }

    /// Build from a list of agents.
    pub fn from_agents(agents: Vec<RegisteredAgent>) -> Result<Self, RelayError> {
        let mut by_token = HashMap::new();
        let mut by_agent_id = HashMap::new();
        for agent in agents {
            if agent.inbox_token.is_empty() {
                return Err(RelayError::Internal(format!(
                    "agent '{}' has an empty inbox_token",
                    agent.agent_id
                )));
            }
            if by_token.contains_key(&agent.inbox_token) {
                return Err(RelayError::Internal(format!(
                    "duplicate inbox_token for agent '{}'",
                    agent.agent_id
                )));
            }
            if by_agent_id.contains_key(&agent.agent_id) {
                return Err(RelayError::Internal(format!(
                    "duplicate agent_id '{}'",
                    agent.agent_id
                )));
            }
            by_token.insert(agent.inbox_token.clone(), agent.clone());
            by_agent_id.insert(agent.agent_id.clone(), agent);
        }
        Ok(Self {
            by_token,
            by_agent_id,
        })
    }

    /// Create an empty registry (for dev mode with VCAV_INBOX_AUTH=off).
    pub fn empty() -> Self {
        Self {
            by_token: HashMap::new(),
            by_agent_id: HashMap::new(),
        }
    }

    /// Validate an inbox bearer token. Returns the registered agent if valid.
    pub fn validate_token(&self, token: &str) -> Option<&RegisteredAgent> {
        self.by_token.get(token)
    }

    /// Look up an agent by agent_id.
    pub fn get_agent(&self, agent_id: &str) -> Option<&RegisteredAgent> {
        self.by_agent_id.get(agent_id)
    }

    /// Check if the registry has any agents registered.
    pub fn is_empty(&self) -> bool {
        self.by_agent_id.is_empty()
    }

    /// Number of registered agents.
    pub fn len(&self) -> usize {
        self.by_agent_id.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_agents() -> Vec<RegisteredAgent> {
        vec![
            RegisteredAgent {
                agent_id: "alice".to_string(),
                inbox_token: "alice_token_123".to_string(),
                public_key_hex: Some("aa".repeat(32)),
            },
            RegisteredAgent {
                agent_id: "bob".to_string(),
                inbox_token: "bob_token_456".to_string(),
                public_key_hex: None,
            },
        ]
    }

    #[test]
    fn test_load_from_agents() {
        let registry = AgentRegistry::from_agents(test_agents()).unwrap();
        assert_eq!(registry.len(), 2);
        assert!(!registry.is_empty());
    }

    #[test]
    fn test_validate_token() {
        let registry = AgentRegistry::from_agents(test_agents()).unwrap();

        let agent = registry.validate_token("alice_token_123").unwrap();
        assert_eq!(agent.agent_id, "alice");
        let expected_key = "aa".repeat(32);
        assert_eq!(agent.public_key_hex.as_deref(), Some(expected_key.as_str()));

        let agent = registry.validate_token("bob_token_456").unwrap();
        assert_eq!(agent.agent_id, "bob");
        assert!(agent.public_key_hex.is_none());

        assert!(registry.validate_token("invalid_token").is_none());
        assert!(registry.validate_token("").is_none());
    }

    #[test]
    fn test_get_agent() {
        let registry = AgentRegistry::from_agents(test_agents()).unwrap();
        assert!(registry.get_agent("alice").is_some());
        assert!(registry.get_agent("bob").is_some());
        assert!(registry.get_agent("charlie").is_none());
    }

    #[test]
    fn test_empty_registry() {
        let registry = AgentRegistry::empty();
        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);
        assert!(registry.validate_token("anything").is_none());
    }

    #[test]
    fn test_duplicate_token_rejected() {
        let agents = vec![
            RegisteredAgent {
                agent_id: "alice".to_string(),
                inbox_token: "same_token".to_string(),
                public_key_hex: None,
            },
            RegisteredAgent {
                agent_id: "bob".to_string(),
                inbox_token: "same_token".to_string(),
                public_key_hex: None,
            },
        ];
        let result = AgentRegistry::from_agents(agents);
        assert!(result.is_err());
    }

    #[test]
    fn test_duplicate_agent_id_rejected() {
        let agents = vec![
            RegisteredAgent {
                agent_id: "alice".to_string(),
                inbox_token: "token_1".to_string(),
                public_key_hex: None,
            },
            RegisteredAgent {
                agent_id: "alice".to_string(),
                inbox_token: "token_2".to_string(),
                public_key_hex: None,
            },
        ];
        let result = AgentRegistry::from_agents(agents);
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_token_rejected() {
        let agents = vec![RegisteredAgent {
            agent_id: "alice".to_string(),
            inbox_token: "".to_string(),
            public_key_hex: None,
        }];
        let result = AgentRegistry::from_agents(agents);
        assert!(result.is_err());
    }

    #[test]
    fn test_load_from_json() {
        let json = r#"{
            "agents": [
                { "agent_id": "alice", "inbox_token": "tok_a", "public_key_hex": "aabbcc" },
                { "agent_id": "bob", "inbox_token": "tok_b" }
            ]
        }"#;
        let tmpdir = std::env::temp_dir().join("av_test_registry");
        std::fs::create_dir_all(&tmpdir).ok();
        let path = tmpdir.join("agents.json");
        std::fs::write(&path, json).unwrap();

        let registry = AgentRegistry::load_from_file(path.to_str().unwrap()).unwrap();
        assert_eq!(registry.len(), 2);
        assert!(registry.validate_token("tok_a").is_some());
        assert!(registry.validate_token("tok_b").is_some());

        std::fs::remove_dir_all(&tmpdir).ok();
    }
}
