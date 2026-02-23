//! Forked entropy calculation for the relay.
//!
//! This is a self-contained copy of the schema entropy upper-bound calculator
//! from guardian-core. The relay needs only this one function and its helpers;
//! forking eliminates the relay's dependency on guardian-core.
//!
//! Changes from the original are intentionally zero — the logic must produce
//! identical results. Golden tests pin known outputs to detect drift.

use serde_json::Value;
use thiserror::Error;

/// Errors that can occur during entropy calculation
#[derive(Error, Debug, PartialEq, Eq)]
pub enum EntropyError {
    #[error("Field '{field}' has empty enum")]
    EmptyEnum { field: String },

    #[error("Schema node uses unsupported construct at '{path}'")]
    UnsupportedSchemaConstruct { path: String },

    #[error("Unresolvable local $ref '{reference}' at '{path}'")]
    UnresolvableLocalRef { path: String, reference: String },

    #[error("Schema node at '{path}' requires x-vcav-entropy-bits-upper-bound metadata")]
    MissingUpperBoundMetadata { path: String },

    #[error("Entropy calculation overflow at '{path}'")]
    EntropyOverflow { path: String },
}

/// Calculate entropy in bits for an enum with given cardinality.
/// Formula: ceil(log2(cardinality))
pub fn enum_entropy_bits(cardinality: usize) -> u16 {
    if cardinality <= 1 {
        return 0;
    }
    (cardinality as f64).log2().ceil() as u16
}

/// Custom schema metadata key for conservative upper bounds when exact enumeration is unsupported.
pub const ENTROPY_UPPER_BOUND_KEY: &str = "x-vcav-entropy-bits-upper-bound";

/// Calculate a conservative entropy upper bound for a JSON Schema.
///
/// Supports exact enumeration for object + enum schemas including local `#/$defs/*` refs.
/// For unsupported constructs, requires `x-vcav-entropy-bits-upper-bound` at the node.
pub fn calculate_schema_entropy_upper_bound(schema: &Value) -> Result<u16, EntropyError> {
    calculate_upper_bound_at(schema, schema, "$")
}

fn calculate_upper_bound_at(root: &Value, node: &Value, path: &str) -> Result<u16, EntropyError> {
    if let Some(bits) = explicit_upper_bound(node, path)? {
        return Ok(bits);
    }

    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        let target = resolve_local_ref(root, reference).ok_or_else(|| {
            EntropyError::UnresolvableLocalRef {
                path: format!("{path}/$ref"),
                reference: reference.to_string(),
            }
        })?;
        return calculate_upper_bound_at(root, target, reference);
    }

    if node.get("const").is_some() {
        return Ok(0);
    }

    if has_unsupported_composition(node) {
        return Err(EntropyError::MissingUpperBoundMetadata {
            path: path.to_string(),
        });
    }

    if let Some(enum_values) = node.get("enum").and_then(Value::as_array) {
        if enum_values.is_empty() {
            return Err(EntropyError::EmptyEnum {
                field: path.to_string(),
            });
        }
        if !enum_values.iter().all(Value::is_string) {
            return Err(EntropyError::UnsupportedSchemaConstruct {
                path: path.to_string(),
            });
        }
        return Ok(enum_entropy_bits(enum_values.len()));
    }

    if node.get("type").and_then(Value::as_str) == Some("object") {
        let properties = match node.get("properties") {
            Some(Value::Object(props)) => props,
            _ => return Ok(0),
        };
        let mut total_bits: u16 = 0;
        for (field, field_schema) in properties {
            let child_path = format!("{path}/properties/{field}");
            let bits = calculate_upper_bound_at(root, field_schema, &child_path)?;
            total_bits =
                total_bits
                    .checked_add(bits)
                    .ok_or_else(|| EntropyError::EntropyOverflow {
                        path: child_path.clone(),
                    })?;
        }
        return Ok(total_bits);
    }

    Err(EntropyError::MissingUpperBoundMetadata {
        path: path.to_string(),
    })
}

fn explicit_upper_bound(node: &Value, path: &str) -> Result<Option<u16>, EntropyError> {
    let Some(raw) = node.get(ENTROPY_UPPER_BOUND_KEY) else {
        return Ok(None);
    };
    let value = raw
        .as_u64()
        .ok_or_else(|| EntropyError::UnsupportedSchemaConstruct {
            path: format!("{path}/{ENTROPY_UPPER_BOUND_KEY}"),
        })?;
    Ok(Some(value.min(u16::MAX as u64) as u16))
}

fn has_unsupported_composition(node: &Value) -> bool {
    ["oneOf", "anyOf", "allOf", "not"]
        .iter()
        .any(|key| node.get(*key).is_some())
}

fn resolve_local_ref<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    if !reference.starts_with("#/") {
        return None;
    }
    let mut current = root;
    for token in reference.trim_start_matches("#/").split('/') {
        let key = token.replace("~1", "/").replace("~0", "~");
        current = current.get(&key)?;
    }
    Some(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ==================== Golden tests ====================
    // These pin the output of calculate_schema_entropy_upper_bound for known
    // schema JSON bytes. The inputs are inline literals (not file paths) to
    // ensure byte-exact stability regardless of directory layout.

    /// Compatibility schema: decision(3) + confidence(3) + reason(13) = 2+2+4 = 8 bits
    const GOLDEN_COMPAT_SCHEMA: &str = r#"{
        "type": "object",
        "properties": {
            "decision": { "type": "string", "enum": ["PROCEED", "DO_NOT_PROCEED", "INCONCLUSIVE"] },
            "confidence_bucket": { "type": "string", "enum": ["LOW", "MEDIUM", "HIGH"] },
            "reason_code": { "type": "string", "enum": [
                "GOALS_MISMATCH", "COMMUNICATION_STYLE", "LOGISTICS",
                "MUTUAL_INTEREST_UNCLEAR", "RESERVED_01", "RESERVED_02",
                "RESERVED_03", "RESERVED_04", "RESERVED_05", "RESERVED_06",
                "RESERVED_07", "RESERVED_08", "UNKNOWN"
            ]}
        },
        "additionalProperties": false
    }"#;

    /// D2 schema with $defs: 2 × (decision(3) + confidence(3) + reason(3) + hint(3)) = 2×8 = 16
    const GOLDEN_D2_SCHEMA: &str = r##"{
        "type": "object",
        "properties": {
            "output_a": { "$ref": "#/$defs/agent_output" },
            "output_b": { "$ref": "#/$defs/agent_output" }
        },
        "$defs": {
            "agent_output": {
                "type": "object",
                "properties": {
                    "decision": { "type": "string", "enum": ["PROCEED", "DO_NOT_PROCEED", "INCONCLUSIVE"] },
                    "confidence_bucket": { "type": "string", "enum": ["LOW", "MEDIUM", "HIGH"] },
                    "reason_code": { "type": "string", "enum": ["VALUES", "COMMUNICATION", "UNKNOWN"] },
                    "self_adjustment_hint": { "type": "string", "enum": ["BE_MORE_DIRECT", "SLOW_DOWN", "NONE"] }
                }
            }
        },
        "additionalProperties": false
    }"##;

    /// Multi-key object: tests that key ordering doesn't affect total.
    /// Fields: a(4)=2, b(8)=3, c(2)=1, d(16)=4 → total 10 bits
    const GOLDEN_MULTIKEY_SCHEMA: &str = r#"{
        "type": "object",
        "properties": {
            "alpha": { "type": "string", "enum": ["A1", "A2", "A3", "A4"] },
            "bravo": { "type": "string", "enum": ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"] },
            "charlie": { "type": "string", "enum": ["C1", "C2"] },
            "delta": { "type": "string", "enum": ["D1","D2","D3","D4","D5","D6","D7","D8","D9","D10","D11","D12","D13","D14","D15","D16"] }
        },
        "additionalProperties": false
    }"#;

    #[test]
    fn golden_compatibility_schema() {
        let schema: Value = serde_json::from_str(GOLDEN_COMPAT_SCHEMA).unwrap();
        assert_eq!(calculate_schema_entropy_upper_bound(&schema).unwrap(), 8);
    }

    #[test]
    fn golden_d2_schema_with_refs() {
        let schema: Value = serde_json::from_str(GOLDEN_D2_SCHEMA).unwrap();
        assert_eq!(calculate_schema_entropy_upper_bound(&schema).unwrap(), 16);
    }

    #[test]
    fn golden_multikey_object() {
        let schema: Value = serde_json::from_str(GOLDEN_MULTIKEY_SCHEMA).unwrap();
        assert_eq!(calculate_schema_entropy_upper_bound(&schema).unwrap(), 10);
    }

    #[test]
    fn const_is_zero_bits() {
        let schema: Value = serde_json::from_str(r#"{
            "type": "object",
            "properties": { "version": { "const": "V1" } }
        }"#)
        .unwrap();
        assert_eq!(calculate_schema_entropy_upper_bound(&schema).unwrap(), 0);
    }

    #[test]
    fn empty_enum_errors() {
        let schema: Value = serde_json::from_str(r#"{
            "type": "object",
            "properties": { "status": { "type": "string", "enum": [] } }
        }"#)
        .unwrap();
        assert!(matches!(
            calculate_schema_entropy_upper_bound(&schema),
            Err(EntropyError::EmptyEnum { .. })
        ));
    }

    #[test]
    fn unsupported_composition_requires_metadata() {
        let schema: Value = serde_json::from_str(r#"{
            "type": "object",
            "properties": {
                "decision": { "oneOf": [{ "const": "A" }, { "const": "B" }] }
            }
        }"#)
        .unwrap();
        assert!(matches!(
            calculate_schema_entropy_upper_bound(&schema),
            Err(EntropyError::MissingUpperBoundMetadata { .. })
        ));
    }

    #[test]
    fn explicit_metadata_overrides() {
        let schema: Value = serde_json::from_str(r#"{
            "type": "object",
            "properties": {
                "decision": {
                    "oneOf": [{ "const": "A" }, { "const": "B" }],
                    "x-vcav-entropy-bits-upper-bound": 1
                }
            }
        }"#)
        .unwrap();
        assert_eq!(calculate_schema_entropy_upper_bound(&schema).unwrap(), 1);
    }

    #[test]
    fn unresolvable_ref_errors() {
        let schema: Value = serde_json::from_str(r##"{
            "type": "object",
            "properties": { "x": { "$ref": "#/$defs/missing" } }
        }"##)
        .unwrap();
        assert!(matches!(
            calculate_schema_entropy_upper_bound(&schema),
            Err(EntropyError::UnresolvableLocalRef { .. })
        ));
    }

    // ==================== enum_entropy_bits ====================

    #[test]
    fn enum_entropy_edge_cases() {
        assert_eq!(enum_entropy_bits(0), 0);
        assert_eq!(enum_entropy_bits(1), 0);
        assert_eq!(enum_entropy_bits(2), 1);
    }

    #[test]
    fn enum_entropy_powers_of_two() {
        assert_eq!(enum_entropy_bits(4), 2);
        assert_eq!(enum_entropy_bits(8), 3);
        assert_eq!(enum_entropy_bits(16), 4);
        assert_eq!(enum_entropy_bits(256), 8);
    }
}
