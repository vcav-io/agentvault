use std::collections::HashMap;

use serde::Deserialize;

use crate::error::RelayError;

/// A registered agent with an inbox bearer token.
#[derive(Debug, Clone, Deserialize)]
pub struct RegisteredAgent {
    pub agent_id: String,
    /// Bearer token for inbox operations.
    pub inbox_token: String,
    /// Ed25519 public key (hex). Optional. When set, it is the
    /// `from_agent_pubkey` attached to this agent's invites.
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
/// failure unless `SELKEY_INBOX_AUTH=off` is explicitly set. Every
/// `inbox_token` must pass [`crate::auth::check_token_strength`].
#[derive(Clone)]
pub struct AgentRegistry {
    /// Registered agents, in load order. Token lookup compares the presented
    /// token with every entry in constant time.
    agents: Vec<RegisteredAgent>,
    /// agent_id -> index into `agents`
    by_agent_id: HashMap<String, usize>,
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
        let mut tokens = std::collections::HashSet::new();
        let mut by_agent_id = HashMap::new();
        for (index, agent) in agents.iter().enumerate() {
            if agent.inbox_token.is_empty() {
                return Err(RelayError::Internal(format!(
                    "agent '{}' has an empty inbox_token",
                    agent.agent_id
                )));
            }
            crate::auth::check_token_strength(&agent.inbox_token).map_err(|reason| {
                RelayError::Internal(format!(
                    "agent '{}' has a weak inbox_token: {reason}",
                    agent.agent_id
                ))
            })?;
            if !tokens.insert(agent.inbox_token.as_str()) {
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
            by_agent_id.insert(agent.agent_id.clone(), index);
        }
        Ok(Self {
            agents,
            by_agent_id,
        })
    }

    /// Create an empty registry (for dev mode with SELKEY_INBOX_AUTH=off).
    pub fn empty() -> Self {
        Self {
            agents: Vec::new(),
            by_agent_id: HashMap::new(),
        }
    }

    /// Validate an inbox bearer token. Returns the registered agent if valid.
    ///
    /// The token is compared with every registered token in constant time.
    pub fn validate_token(&self, token: &str) -> Option<&RegisteredAgent> {
        let mut matched = None;
        for agent in &self.agents {
            if crate::auth::tokens_equal(token, &agent.inbox_token) {
                matched = Some(agent);
            }
        }
        matched
    }

    /// Look up an agent by agent_id.
    pub fn get_agent(&self, agent_id: &str) -> Option<&RegisteredAgent> {
        self.by_agent_id.get(agent_id).map(|&i| &self.agents[i])
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

    const ALICE_TOKEN: &str = "6a1f0c3e9b7d24a58e0f1b6c3d9a7e2f";
    const BOB_TOKEN: &str = "c4e8b2a6f0d93715e2b8a4c6d0f19e37";

    fn test_agents() -> Vec<RegisteredAgent> {
        vec![
            RegisteredAgent {
                agent_id: "alice".to_string(),
                inbox_token: ALICE_TOKEN.to_string(),
                public_key_hex: Some("aa".repeat(32)),
            },
            RegisteredAgent {
                agent_id: "bob".to_string(),
                inbox_token: BOB_TOKEN.to_string(),
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

        let agent = registry.validate_token(ALICE_TOKEN).unwrap();
        assert_eq!(agent.agent_id, "alice");
        let expected_key = "aa".repeat(32);
        assert_eq!(agent.public_key_hex.as_deref(), Some(expected_key.as_str()));

        let agent = registry.validate_token(BOB_TOKEN).unwrap();
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
                inbox_token: ALICE_TOKEN.to_string(),
                public_key_hex: None,
            },
            RegisteredAgent {
                agent_id: "bob".to_string(),
                inbox_token: ALICE_TOKEN.to_string(),
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
                inbox_token: ALICE_TOKEN.to_string(),
                public_key_hex: None,
            },
            RegisteredAgent {
                agent_id: "alice".to_string(),
                inbox_token: BOB_TOKEN.to_string(),
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
                { "agent_id": "alice", "inbox_token": "6a1f0c3e9b7d24a58e0f1b6c3d9a7e2f", "public_key_hex": "aabbcc" },
                { "agent_id": "bob", "inbox_token": "c4e8b2a6f0d93715e2b8a4c6d0f19e37" }
            ]
        }"#;
        let tmpdir = std::env::temp_dir().join("selkey_test_registry");
        std::fs::create_dir_all(&tmpdir).ok();
        let path = tmpdir.join("agents.json");
        std::fs::write(&path, json).unwrap();

        let registry = AgentRegistry::load_from_file(path.to_str().unwrap()).unwrap();
        assert_eq!(registry.len(), 2);
        assert!(registry.validate_token(ALICE_TOKEN).is_some());
        assert!(registry.validate_token(BOB_TOKEN).is_some());

        std::fs::remove_dir_all(&tmpdir).ok();
    }

    #[test]
    fn test_weak_inbox_tokens_rejected_at_load() {
        for weak in [
            "alice_token_123".to_string(),
            "test_alice_inbox_token_7f3a9b2e".to_string(),
            "a".repeat(64),
            "ab".repeat(32),
        ] {
            let agents = vec![RegisteredAgent {
                agent_id: "alice".to_string(),
                inbox_token: weak.clone(),
                public_key_hex: None,
            }];
            let err = match AgentRegistry::from_agents(agents) {
                Ok(_) => panic!("weak token accepted: {weak:?}"),
                Err(e) => e.to_string(),
            };
            assert!(err.contains("weak inbox_token"), "{err}");
            assert!(
                !err.contains(&weak),
                "error must not contain the token: {err}"
            );
        }
    }

    #[test]
    fn test_validate_token_rejects_prefix_and_extension() {
        let registry = AgentRegistry::from_agents(test_agents()).unwrap();
        assert!(registry.validate_token(&ALICE_TOKEN[..31]).is_none());
        assert!(registry
            .validate_token(&format!("{ALICE_TOKEN}0"))
            .is_none());
        assert_eq!(
            registry
                .validate_token(ALICE_TOKEN)
                .map(|a| a.agent_id.as_str()),
            Some("alice")
        );
    }
}
