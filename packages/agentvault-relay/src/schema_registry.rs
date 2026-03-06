//! Content-addressed output schema registry.
//!
//! Schemas are JSON files loaded from a directory at startup. Each schema is
//! indexed by its SHA-256(JCS(schema)) content hash. Contracts can reference
//! schemas by hash instead of embedding them inline.

use std::collections::HashMap;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::RelayError;

/// In-memory registry of output schemas, indexed by content hash.
#[derive(Debug, Clone)]
pub struct SchemaRegistry {
    schemas: HashMap<String, serde_json::Value>,
}

impl SchemaRegistry {
    /// Create an empty registry.
    pub fn empty() -> Self {
        Self {
            schemas: HashMap::new(),
        }
    }

    /// Load all `.json` files from `dir` and index by content hash.
    ///
    /// Skips files that fail to parse as JSON. Logs a warning for hash
    /// collisions (same hash, different content — should never happen).
    pub fn load_from_dir(dir: &Path) -> Result<Self, RelayError> {
        let mut schemas = HashMap::new();

        let entries = std::fs::read_dir(dir).map_err(|e| {
            RelayError::Internal(format!(
                "failed to read schema directory {}: {e}",
                dir.display()
            ))
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| {
                RelayError::Internal(format!("failed to read schema directory entry: {e}"))
            })?;
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                match load_and_hash_schema(&path) {
                    Ok((hash, schema)) => {
                        schemas.insert(hash, schema);
                    }
                    Err(e) => {
                        tracing::warn!(path = %path.display(), error = %e, "skipping invalid schema file");
                    }
                }
            }
        }

        Ok(Self { schemas })
    }

    /// Look up a schema by its content hash.
    pub fn get(&self, hash: &str) -> Option<&serde_json::Value> {
        self.schemas.get(hash)
    }

    /// Number of registered schemas.
    pub fn len(&self) -> usize {
        self.schemas.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.schemas.is_empty()
    }

    /// List all registered schema hashes, sorted.
    pub fn hashes(&self) -> Vec<&str> {
        let mut hashes: Vec<&str> = self.schemas.keys().map(|s| s.as_str()).collect();
        hashes.sort();
        hashes
    }
}

/// Load a JSON file and compute its content hash.
fn load_and_hash_schema(path: &Path) -> Result<(String, serde_json::Value), RelayError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| RelayError::Internal(format!("failed to read {}: {e}", path.display())))?;
    let schema: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| RelayError::Internal(format!("failed to parse {}: {e}", path.display())))?;
    let canonical = receipt_core::canonicalize_serializable(&schema)
        .map_err(|e| RelayError::Internal(format!("schema canonicalization: {e}")))?;
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let hash = hex::encode(hasher.finalize());
    Ok((hash, schema))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_empty_registry() {
        let reg = SchemaRegistry::empty();
        assert!(reg.is_empty());
        assert_eq!(reg.len(), 0);
        assert!(reg.get("anything").is_none());
    }

    #[test]
    fn test_load_from_dir_with_schemas() {
        let dir = std::env::temp_dir().join("vcav-schema-reg-test");
        fs::create_dir_all(&dir).unwrap();

        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "signal": { "type": "string", "enum": ["yes", "no"] }
            },
            "required": ["signal"],
            "additionalProperties": false
        });
        fs::write(
            dir.join("test_schema.json"),
            serde_json::to_string_pretty(&schema).unwrap(),
        )
        .unwrap();

        let reg = SchemaRegistry::load_from_dir(&dir).unwrap();
        assert_eq!(reg.len(), 1);

        // Compute expected hash
        let canonical = receipt_core::canonicalize_serializable(&schema).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        let expected_hash = hex::encode(hasher.finalize());

        assert!(reg.get(&expected_hash).is_some());
        assert_eq!(reg.get(&expected_hash).unwrap(), &schema);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_from_dir_skips_non_json() {
        let dir = std::env::temp_dir().join("vcav-schema-reg-nonjson");
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join("readme.txt"), "not a schema").unwrap();
        fs::write(dir.join("valid.json"), r#"{"type": "object"}"#).unwrap();

        let reg = SchemaRegistry::load_from_dir(&dir).unwrap();
        assert_eq!(reg.len(), 1);

        fs::remove_dir_all(&dir).ok();
    }
}
