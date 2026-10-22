//! Content-addressed output schema registry.
//!
//! Schemas are JSON files loaded from a directory at startup. Each schema is
//! indexed by its SHA-256(JCS(schema)) content hash. Contracts can reference
//! schemas by hash instead of embedding them inline.

use std::collections::HashMap;
use std::path::Path;

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

    /// Create a registry from a pre-verified map of hash -> schema.
    pub fn from_map(schemas: HashMap<String, serde_json::Value>) -> Self {
        Self { schemas }
    }

    /// Check every schema with [`check_declared_draft`].
    ///
    /// Used for registries built from a pre-verified map (registry admission),
    /// which do not go through [`SchemaRegistry::load_from_dir`].
    pub fn check_declared_drafts(&self) -> Result<(), RelayError> {
        let mut hashes: Vec<&String> = self.schemas.keys().collect();
        hashes.sort();
        for hash in hashes {
            check_declared_draft(&self.schemas[hash])
                .map_err(|e| RelayError::Internal(format!("output schema {hash}: {e}")))?;
        }
        Ok(())
    }

    /// Load all `.json` files from `dir` and index by content hash.
    ///
    /// Skips files that fail to parse as JSON. Fails if a schema declares a
    /// JSON Schema draft other than the one output is validated with (see
    /// [`check_declared_draft`]), so such a schema is never silently served.
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
                        check_declared_draft(&schema).map_err(|e| {
                            RelayError::Internal(format!(
                                "output schema {} rejected: {e}",
                                path.display()
                            ))
                        })?;
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

/// `$schema` values accepted at the root of an output schema: draft 7, the
/// draft output is validated with ([`crate::relay::OUTPUT_SCHEMA_DRAFT`]).
const DRAFT_7_URIS: &[&str] = &[
    "http://json-schema.org/draft-07/schema",
    "http://json-schema.org/draft-07/schema#",
];

/// Check that an output schema cannot change the JSON Schema draft it is
/// validated with.
///
/// The validator is pinned to draft 7, but it re-reads `$schema` from the
/// target of a `$ref`. So `$schema` is accepted only at the root, and only
/// naming draft 7. Any other `$schema` key, at any depth (including inside
/// `const`/`enum` values or as a property name), is rejected.
pub fn check_declared_draft(schema: &serde_json::Value) -> Result<(), String> {
    if let Some(root) = schema.as_object() {
        if let Some(uri) = root.get("$schema") {
            if !uri.as_str().is_some_and(|u| DRAFT_7_URIS.contains(&u)) {
                return Err(format!(
                    "root $schema must be omitted or name JSON Schema draft 7, found {uri}"
                ));
            }
        }
        for (key, child) in root {
            if key != "$schema" {
                reject_nested_schema_keyword(child, &format!("/{key}"))?;
            }
        }
    }
    Ok(())
}

fn reject_nested_schema_keyword(value: &serde_json::Value, path: &str) -> Result<(), String> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let child_path = format!("{path}/{key}");
                if key == "$schema" {
                    return Err(format!(
                        "$schema is only allowed at the root (found at {child_path})"
                    ));
                }
                reject_nested_schema_keyword(child, &child_path)?;
            }
            Ok(())
        }
        serde_json::Value::Array(items) => {
            for (i, child) in items.iter().enumerate() {
                reject_nested_schema_keyword(child, &format!("{path}/{i}"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Load a JSON file and compute its content hash.
fn load_and_hash_schema(path: &Path) -> Result<(String, serde_json::Value), RelayError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| RelayError::Internal(format!("failed to read {}: {e}", path.display())))?;
    let schema: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| RelayError::Internal(format!("failed to parse {}: {e}", path.display())))?;
    let hash = crate::relay::hash_json_v3(&schema)
        .map_err(|e| RelayError::Internal(format!("schema canonicalization: {e}")))?;
    Ok((hash, schema))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
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
        let canonical = receipt_core::canonicalize_v3(&schema).unwrap();
        let expected_hash = hex::encode(Sha256::digest(canonical.as_bytes()));

        assert!(reg.get(&expected_hash).is_some());
        assert_eq!(reg.get(&expected_hash).unwrap(), &schema);

        fs::remove_dir_all(&dir).ok();
    }

    fn ref_to_subschema_declaring(draft_uri: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "$defs": {
                "signal": { "$schema": draft_uri, "const": "OK" }
            },
            "properties": { "signal": { "$ref": "#/$defs/signal" } },
            "required": ["signal"],
            "additionalProperties": false
        })
    }

    #[test]
    fn test_load_from_dir_rejects_ref_target_declaring_a_draft() {
        let dir = std::env::temp_dir().join(format!(
            "selkey-schema-reg-nested-draft-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let schema = ref_to_subschema_declaring("http://json-schema.org/draft-04/schema#");
        fs::write(dir.join("nested_draft.json"), schema.to_string()).unwrap();

        let err = SchemaRegistry::load_from_dir(&dir).unwrap_err();
        assert!(
            err.to_string()
                .contains("$schema is only allowed at the root"),
            "{err}"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_check_declared_draft() {
        let base = serde_json::json!({
            "type": "object",
            "properties": { "signal": { "const": "OK" } },
            "required": ["signal"],
            "additionalProperties": false
        });
        assert!(check_declared_draft(&base).is_ok());
        for uri in DRAFT_7_URIS {
            let mut schema = base.clone();
            schema["$schema"] = serde_json::json!(uri);
            assert!(check_declared_draft(&schema).is_ok(), "{uri}");
        }
        for uri in [
            "http://json-schema.org/draft-04/schema#",
            "http://json-schema.org/draft-06/schema#",
            "https://json-schema.org/draft/2020-12/schema",
        ] {
            let mut schema = base.clone();
            schema["$schema"] = serde_json::json!(uri);
            assert!(check_declared_draft(&schema).is_err(), "{uri}");
        }
        for uri in [
            "http://json-schema.org/draft-04/schema#",
            "http://json-schema.org/draft-07/schema#",
        ] {
            assert!(check_declared_draft(&ref_to_subschema_declaring(uri)).is_err());
        }
        let in_definitions = serde_json::json!({
            "type": "object",
            "definitions": { "x": { "$schema": "http://json-schema.org/draft-04/schema#" } },
            "properties": { "signal": { "$ref": "#/definitions/x" } }
        });
        assert!(check_declared_draft(&in_definitions).is_err());
    }

    #[test]
    fn test_check_declared_drafts_on_admitted_map() {
        let bad = ref_to_subschema_declaring("http://json-schema.org/draft-04/schema#");
        let reg = SchemaRegistry::from_map(HashMap::from([("ab".repeat(32), bad)]));
        assert!(reg.check_declared_drafts().is_err());
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
