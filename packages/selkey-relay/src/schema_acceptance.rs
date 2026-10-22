//! Output schema acceptance for contracts.
//!
//! The output schema bounds what a session can release, so the relay only
//! accepts schemas it can bound itself:
//!
//! - **Registry schemas** (matched by content hash against the relay's schema
//!   registry) are accepted everywhere. Their entropy upper bound is computed
//!   by `entropy-core`, which honours `x-vcav-entropy-bits-upper-bound`
//!   annotations because registry content is operator-controlled.
//! - **Inline schemas** not in the registry are accepted only when the relay
//!   runs with `SELKEY_ENV=dev`, and only if they are *strict* (see
//!   [`strict_schema_upper_bound`]). Their entropy upper bound is computed by
//!   the relay from the schema structure; schema-supplied bound annotations
//!   are ignored.
//!
//! Any failure to compute an upper bound rejects the contract.

use entropy_core::{calculate_schema_entropy_upper_bound, enum_entropy_bits};
use serde_json::Value;

use crate::error::RelayError;
use crate::relay::{compile_output_schema, compute_output_schema_hash};
use crate::schema_registry::{check_declared_draft, SchemaRegistry};
use crate::types::Contract;

/// An output schema the relay has accepted for a contract.
#[derive(Debug, Clone)]
pub struct ResolvedOutputSchema {
    /// The schema used for provider structured output and output validation.
    pub schema: Value,
    /// SHA-256(JCS(schema)).
    pub hash: String,
    /// Entropy upper bound in bits.
    pub entropy_bits: u32,
    /// Whether the schema came from the relay's schema registry.
    pub from_registry: bool,
}

/// Resolve and accept a contract's output schema.
///
/// `allow_inline` permits strict inline schemas that are not in the registry
/// (set from `SELKEY_ENV=dev`).
pub fn resolve_output_schema(
    contract: &Contract,
    registry: &SchemaRegistry,
    allow_inline: bool,
) -> Result<ResolvedOutputSchema, RelayError> {
    // A schema without a `properties` key is treated as a stub that refers to
    // the registry via `output_schema_hash`.
    let is_stub = contract
        .output_schema
        .as_object()
        .map(|obj| !obj.contains_key("properties"))
        .unwrap_or(true);

    let candidate_hash = match contract.output_schema_hash {
        Some(ref requested_hash) if is_stub => {
            let schema = registry.get(requested_hash).ok_or_else(|| {
                RelayError::ContractValidation(format!(
                    "output_schema_hash '{requested_hash}' not found in schema registry"
                ))
            })?;
            return accept_registry_schema(schema.clone(), requested_hash.clone());
        }
        Some(ref requested_hash) => {
            let computed_hash = compute_output_schema_hash(&contract.output_schema)?;
            if *requested_hash != computed_hash {
                return Err(RelayError::ContractValidation(format!(
                    "output_schema_hash mismatch: contract says '{requested_hash}' but inline schema hashes to '{computed_hash}'"
                )));
            }
            computed_hash
        }
        None => compute_output_schema_hash(&contract.output_schema)?,
    };

    if let Some(schema) = registry.get(&candidate_hash) {
        return accept_registry_schema(schema.clone(), candidate_hash);
    }

    if !allow_inline {
        return Err(RelayError::ContractValidation(format!(
            "output schema '{candidate_hash}' is not in this relay's schema registry; \
             reference a registry schema by output_schema_hash"
        )));
    }

    let bits = strict_schema_upper_bound(&contract.output_schema).map_err(|reason| {
        RelayError::ContractValidation(format!("inline output schema rejected: {reason}"))
    })?;
    ensure_compiles(&contract.output_schema)?;
    Ok(ResolvedOutputSchema {
        schema: contract.output_schema.clone(),
        hash: candidate_hash,
        entropy_bits: bits,
        from_registry: false,
    })
}

fn accept_registry_schema(schema: Value, hash: String) -> Result<ResolvedOutputSchema, RelayError> {
    check_declared_draft(&schema).map_err(|e| {
        RelayError::ContractValidation(format!("registry output schema rejected: {e}"))
    })?;
    ensure_compiles(&schema)?;
    let bits = calculate_schema_entropy_upper_bound(&schema).map_err(|e| {
        RelayError::ContractValidation(format!(
            "entropy upper bound could not be computed for output schema: {e}"
        ))
    })?;
    Ok(ResolvedOutputSchema {
        schema,
        hash,
        entropy_bits: u32::from(bits),
        from_registry: true,
    })
}

/// Reject a schema the output validator cannot compile (for example, an
/// invalid `pattern`), so the contract fails before any provider call.
fn ensure_compiles(schema: &Value) -> Result<(), RelayError> {
    compile_output_schema(schema)
        .map(|_| ())
        .map_err(|e| RelayError::ContractValidation(format!("output schema does not compile: {e}")))
}

/// Bits used to bound one Unicode scalar value in a length-bounded string.
const BITS_PER_CHAR: u64 = 21;

/// Maximum schema nesting depth accepted for inline schemas.
const MAX_DEPTH: usize = 32;

/// Keywords accepted in strict inline schemas. Keys starting with `x-` are
/// annotations and are ignored (including `x-vcav-entropy-bits-upper-bound`).
///
/// Output is validated as JSON Schema draft 7 (see
/// [`crate::relay::OUTPUT_SCHEMA_DRAFT`]), and each keyword here has the
/// meaning the bound below assumes under that draft. `$schema` is not
/// accepted: a schema must not select a draft in which these keywords mean
/// something else (for example, `const` is not a draft-04 keyword).
const ALLOWED_KEYWORDS: &[&str] = &[
    "$comment",
    "title",
    "description",
    "default",
    "examples",
    "type",
    "enum",
    "const",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
];

/// Check that an inline schema is strict and compute its entropy upper bound.
///
/// A strict schema:
/// - is a JSON object at every node (no `true`/`false` schemas) and every node
///   declares a single `type`, an `enum`, or a `const`;
/// - uses only [`ALLOWED_KEYWORDS`] (no `$schema`, composition, references,
///   `patternProperties` or other dynamic properties);
/// - sets `additionalProperties: false` on every object and lists every
///   property in `required`;
/// - bounds every string with `enum` or `maxLength`, every array with
///   `maxItems`, and every integer with `minimum` and `maximum`
///   (`number` must use `enum`).
///
/// The bound is computed from structure alone: enums contribute
/// `ceil(log2(n))` bits, strings `maxLength * 21` bits plus length, arrays
/// `maxItems * item_bits` plus length, integers `ceil(log2(range))`,
/// booleans 1 bit.
pub fn strict_schema_upper_bound(schema: &Value) -> Result<u32, String> {
    let bits = node_bound(schema, "$", 0)?;
    if bits > u64::from(u16::MAX) {
        return Err(format!(
            "entropy upper bound ({bits} bits) exceeds the supported maximum"
        ));
    }
    Ok(bits as u32)
}

fn length_bits(max_len: u64) -> u64 {
    u64::from(enum_entropy_bits(
        usize::try_from(max_len.saturating_add(1)).unwrap_or(usize::MAX),
    ))
}

fn overflow(path: &str) -> String {
    format!("{path}: entropy upper bound overflows")
}

fn node_bound(node: &Value, path: &str, depth: usize) -> Result<u64, String> {
    if depth > MAX_DEPTH {
        return Err(format!("{path}: schema nesting exceeds {MAX_DEPTH} levels"));
    }
    let obj = node
        .as_object()
        .ok_or_else(|| format!("{path}: schema must be a JSON object"))?;

    for key in obj.keys() {
        if !key.starts_with("x-") && !ALLOWED_KEYWORDS.contains(&key.as_str()) {
            return Err(format!("{path}: keyword '{key}' is not allowed"));
        }
    }

    if let Some(values) = obj.get("enum") {
        let values = values
            .as_array()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| format!("{path}: enum must be a non-empty array"))?;
        return Ok(u64::from(enum_entropy_bits(values.len())));
    }
    if obj.contains_key("const") {
        return Ok(0);
    }

    let ty = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{path}: must declare a single type, an enum or a const"))?;

    match ty {
        "object" => {
            if obj.get("additionalProperties") != Some(&Value::Bool(false)) {
                return Err(format!(
                    "{path}: object must set additionalProperties: false"
                ));
            }
            let empty = serde_json::Map::new();
            let properties = match obj.get("properties") {
                None => &empty,
                Some(Value::Object(props)) => props,
                Some(_) => return Err(format!("{path}: properties must be an object")),
            };
            let required: Vec<&str> = match obj.get("required") {
                None => Vec::new(),
                Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
                Some(_) => return Err(format!("{path}: required must be an array")),
            };
            let mut total: u64 = 0;
            for (name, child) in properties {
                if !required.contains(&name.as_str()) {
                    return Err(format!(
                        "{path}: property '{name}' must be listed in required"
                    ));
                }
                let child_path = format!("{path}/properties/{name}");
                let bits = node_bound(child, &child_path, depth + 1)?;
                total = total
                    .checked_add(bits)
                    .ok_or_else(|| overflow(&child_path))?;
            }
            Ok(total)
        }
        "array" => {
            let max_items = obj
                .get("maxItems")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("{path}: array must set maxItems"))?;
            let items = obj
                .get("items")
                .ok_or_else(|| format!("{path}: array must define items"))?;
            let item_bits = node_bound(items, &format!("{path}/items"), depth + 1)?;
            max_items
                .checked_mul(item_bits)
                .and_then(|b| b.checked_add(length_bits(max_items)))
                .ok_or_else(|| overflow(path))
        }
        "string" => {
            let max_len = obj
                .get("maxLength")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("{path}: string must be bounded by enum or maxLength"))?;
            max_len
                .checked_mul(BITS_PER_CHAR)
                .and_then(|b| b.checked_add(length_bits(max_len)))
                .ok_or_else(|| overflow(path))
        }
        "integer" => {
            let min = obj.get("minimum").and_then(Value::as_i64);
            let max = obj.get("maximum").and_then(Value::as_i64);
            match (min, max) {
                (Some(min), Some(max)) if max >= min => {
                    let span = (i128::from(max) - i128::from(min)) as u64;
                    Ok(length_bits(span))
                }
                _ => Err(format!(
                    "{path}: integer must set integer minimum and maximum (minimum <= maximum)"
                )),
            }
        }
        "boolean" => Ok(1),
        "null" => Ok(0),
        other => Err(format!(
            "{path}: type '{other}' must be constrained by enum"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn contract_with(schema: Value, hash: Option<String>) -> Contract {
        serde_json::from_value(json!({
            "purpose_code": "MEDIATION",
            "output_schema_id": "test",
            "output_schema": schema,
            "output_schema_hash": hash,
            "participants": ["alice", "bob"],
            "prompt_template_hash": "a".repeat(64)
        }))
        .unwrap()
    }

    fn enum_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "signal": { "type": "string", "enum": ["A", "B", "C", "D"] }
            },
            "required": ["signal"],
            "additionalProperties": false
        })
    }

    fn registry_with(schema: &Value) -> (SchemaRegistry, String) {
        let hash = compute_output_schema_hash(schema).unwrap();
        let mut map = std::collections::HashMap::new();
        map.insert(hash.clone(), schema.clone());
        (SchemaRegistry::from_map(map), hash)
    }

    fn permissive_schemas() -> Vec<Value> {
        vec![
            json!({}),
            json!(true),
            json!({"type": "object"}),
            json!({"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"], "additionalProperties": false}),
            json!({"type": "object", "properties": {"a": {"type": "array", "items": {"type": "string", "enum": ["X"]}}}, "required": ["a"], "additionalProperties": false}),
            json!({"type": "object", "properties": {"a": {"type": "string", "enum": ["X"]}}, "required": ["a"]}),
            json!({"type": "object", "properties": {"a": {"type": "string", "enum": ["X"]}}, "required": ["a"], "additionalProperties": true}),
            json!({"type": "object", "properties": {"a": {}}, "required": ["a"], "additionalProperties": false}),
            json!({"type": "object", "properties": {"a": true}, "required": ["a"], "additionalProperties": false}),
            json!({"type": "object", "properties": {"a": {"type": "string", "pattern": "^.*$"}}, "required": ["a"], "additionalProperties": false}),
            json!({"type": "object", "properties": {"a": {"type": "number"}}, "required": ["a"], "additionalProperties": false}),
            json!({"type": "object", "properties": {"a": {"anyOf": [{"type": "string"}]}}, "required": ["a"], "additionalProperties": false}),
            json!({"type": "object", "patternProperties": {".*": {"type": "string"}}, "additionalProperties": false}),
        ]
    }

    #[test]
    fn test_permissive_inline_schemas_rejected_outside_dev() {
        for schema in permissive_schemas() {
            let contract = contract_with(schema.clone(), None);
            let err = resolve_output_schema(&contract, &SchemaRegistry::empty(), false)
                .expect_err(&format!("schema {schema} should be rejected"));
            assert!(matches!(err, RelayError::ContractValidation(_)));
        }
    }

    #[test]
    fn test_permissive_inline_schemas_rejected_in_dev() {
        for schema in permissive_schemas() {
            let contract = contract_with(schema.clone(), None);
            let err = resolve_output_schema(&contract, &SchemaRegistry::empty(), true)
                .expect_err(&format!("schema {schema} should be rejected"));
            assert!(matches!(err, RelayError::ContractValidation(_)));
        }
    }

    #[test]
    fn test_strict_inline_schema_rejected_outside_dev() {
        let contract = contract_with(enum_schema(), None);
        let err = resolve_output_schema(&contract, &SchemaRegistry::empty(), false).unwrap_err();
        assert!(err
            .to_string()
            .contains("not in this relay's schema registry"));
    }

    #[test]
    fn test_strict_inline_schema_accepted_in_dev() {
        let contract = contract_with(enum_schema(), None);
        let resolved = resolve_output_schema(&contract, &SchemaRegistry::empty(), true).unwrap();
        assert!(!resolved.from_registry);
        assert_eq!(resolved.entropy_bits, 2);
    }

    #[test]
    fn test_registry_schema_accepted_by_hash_reference() {
        let (registry, hash) = registry_with(&enum_schema());
        let contract = contract_with(json!({}), Some(hash.clone()));
        let resolved = resolve_output_schema(&contract, &registry, false).unwrap();
        assert!(resolved.from_registry);
        assert_eq!(resolved.hash, hash);
        assert_eq!(resolved.schema, enum_schema());
        assert_eq!(resolved.entropy_bits, 2);
    }

    #[test]
    fn test_registry_schema_accepted_when_inlined() {
        let (registry, hash) = registry_with(&enum_schema());
        for declared in [None, Some(hash.clone())] {
            let contract = contract_with(enum_schema(), declared);
            let resolved = resolve_output_schema(&contract, &registry, false).unwrap();
            assert!(resolved.from_registry);
            assert_eq!(resolved.hash, hash);
        }
    }

    #[test]
    fn test_shipped_registry_schemas_accepted() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schemas/output");
        let registry = SchemaRegistry::load_from_dir(&dir).unwrap();
        assert!(registry.len() >= 2);
        for hash in registry.hashes() {
            let contract = contract_with(json!({}), Some(hash.to_string()));
            let resolved = resolve_output_schema(&contract, &registry, false)
                .unwrap_or_else(|e| panic!("registry schema {hash} rejected: {e}"));
            assert!(resolved.entropy_bits > 0);
        }
    }

    #[test]
    fn test_self_declared_bound_ignored_for_inline_schema() {
        let schema = json!({
            "type": "object",
            "properties": {
                "reasons": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["A", "B", "C", "D"] },
                    "maxItems": 3,
                    "x-vcav-entropy-bits-upper-bound": 0
                },
                "note": { "type": "string", "maxLength": 10, "x-vcav-entropy-bits-upper-bound": 0 }
            },
            "required": ["reasons", "note"],
            "additionalProperties": false,
            "x-vcav-entropy-bits-upper-bound": 0
        });
        let contract = contract_with(schema, None);
        let resolved = resolve_output_schema(&contract, &SchemaRegistry::empty(), true).unwrap();
        // reasons: 3 items * 2 bits + 2 length bits = 8; note: 10 * 21 + 4 length bits = 214
        assert_eq!(resolved.entropy_bits, 8 + 214);
    }

    #[test]
    fn test_self_declared_bound_honoured_for_registry_schema() {
        let schema = json!({
            "type": "object",
            "properties": {
                "reasons": {
                    "type": "array",
                    "items": { "type": "string", "enum": ["A", "B", "C", "D"] },
                    "maxItems": 3,
                    "x-vcav-entropy-bits-upper-bound": 5
                }
            },
            "required": ["reasons"],
            "additionalProperties": false
        });
        let (registry, hash) = registry_with(&schema);
        let contract = contract_with(json!({}), Some(hash));
        let resolved = resolve_output_schema(&contract, &registry, false).unwrap();
        assert_eq!(resolved.entropy_bits, 5);
    }

    #[test]
    fn test_entropy_error_rejects_registry_schema() {
        // A registry schema whose upper bound cannot be computed is rejected
        // rather than recorded as 0 bits.
        let schema = json!({
            "type": "object",
            "properties": { "free": { "type": "string" } },
            "additionalProperties": false
        });
        let (registry, hash) = registry_with(&schema);
        let contract = contract_with(json!({}), Some(hash));
        let err = resolve_output_schema(&contract, &registry, false).unwrap_err();
        assert!(err
            .to_string()
            .contains("entropy upper bound could not be computed"));
    }

    #[test]
    fn test_stub_schema_without_hash_rejected() {
        let contract = contract_with(json!({}), None);
        assert!(resolve_output_schema(&contract, &SchemaRegistry::empty(), false).is_err());
        assert!(resolve_output_schema(&contract, &SchemaRegistry::empty(), true).is_err());
    }

    #[test]
    fn test_inline_hash_mismatch_rejected() {
        let contract = contract_with(enum_schema(), Some("ab".repeat(32)));
        let err = resolve_output_schema(&contract, &SchemaRegistry::empty(), true).unwrap_err();
        assert!(err.to_string().contains("output_schema_hash mismatch"));
    }

    #[test]
    fn test_strict_bounds_for_scalar_types() {
        let schema = json!({
            "type": "object",
            "properties": {
                "flag": { "type": "boolean" },
                "count": { "type": "integer", "minimum": 0, "maximum": 7 },
                "nothing": { "type": "null" },
                "fixed": { "const": "X" }
            },
            "required": ["flag", "count", "nothing", "fixed"],
            "additionalProperties": false
        });
        assert_eq!(strict_schema_upper_bound(&schema).unwrap(), 1 + 3);
    }

    #[test]
    fn test_inline_schema_declaring_a_draft_rejected_in_dev() {
        let with_schema_keyword = |schema_uri: &str| {
            let mut schema = json!({
                "type": "object",
                "properties": { "signal": { "const": "OK" } },
                "required": ["signal"],
                "additionalProperties": false
            });
            schema["$schema"] = json!(schema_uri);
            schema
        };
        let nested = json!({
            "type": "object",
            "properties": {
                "signal": { "$schema": "http://json-schema.org/draft-04/schema#", "const": "OK" }
            },
            "required": ["signal"],
            "additionalProperties": false
        });
        for schema in [
            with_schema_keyword("http://json-schema.org/draft-04/schema#"),
            with_schema_keyword("http://json-schema.org/draft-06/schema#"),
            with_schema_keyword("http://json-schema.org/draft-07/schema#"),
            with_schema_keyword("https://json-schema.org/draft/2020-12/schema"),
            with_schema_keyword("https://example.com/custom-meta-schema"),
            nested,
        ] {
            let contract = contract_with(schema.clone(), None);
            let err = resolve_output_schema(&contract, &SchemaRegistry::empty(), true)
                .expect_err(&format!("schema {schema} should be rejected"));
            assert!(
                err.to_string().contains("keyword '$schema' is not allowed"),
                "{err}"
            );
        }
    }

    #[test]
    fn test_strict_inline_schema_rejects_draft_dependent_keywords() {
        // Keywords whose meaning differs between drafts are outside the strict
        // subset, so the bound never depends on which draft a reader assumes.
        let wrap = |prop: Value| {
            json!({
                "type": "object",
                "properties": { "a": prop },
                "required": ["a"],
                "additionalProperties": false
            })
        };
        for schema in [
            wrap(json!({"type": "array", "maxItems": 2, "items": [{"type": "boolean"}]})),
            wrap(
                json!({"type": "array", "maxItems": 2, "prefixItems": [{"type": "boolean"}], "items": {"type": "boolean"}}),
            ),
            wrap(json!({"type": "integer", "minimum": 0, "maximum": 3, "exclusiveMinimum": true})),
            wrap(json!({"type": "integer", "minimum": 0, "maximum": 3, "exclusiveMaximum": 3})),
            json!({"type": "object", "properties": {}, "additionalProperties": false, "dependencies": {"a": ["b"]}}),
            wrap(json!({"id": "x", "type": "boolean"})),
            wrap(json!({"$id": "x", "type": "boolean"})),
            json!({"type": "object", "properties": {}, "additionalProperties": false, "definitions": {}}),
            json!({"type": "object", "properties": {}, "additionalProperties": false, "$defs": {}}),
        ] {
            assert!(
                strict_schema_upper_bound(&schema).is_err(),
                "schema {schema} should be rejected"
            );
        }
    }

    #[test]
    fn test_uncompilable_schema_rejected_at_admission() {
        let schema = json!({
            "type": "object",
            "properties": { "a": { "type": "string", "maxLength": 3, "pattern": "(" } },
            "required": ["a"],
            "additionalProperties": false
        });
        let contract = contract_with(schema.clone(), None);
        let err = resolve_output_schema(&contract, &SchemaRegistry::empty(), true).unwrap_err();
        assert!(err.to_string().contains("does not compile"), "{err}");

        let (registry, hash) = registry_with(&schema);
        let contract = contract_with(json!({}), Some(hash));
        let err = resolve_output_schema(&contract, &registry, false).unwrap_err();
        assert!(err.to_string().contains("does not compile"), "{err}");
    }

    #[test]
    fn test_registry_schema_with_ref_target_declaring_a_draft_rejected() {
        let schema = json!({
            "type": "object",
            "$defs": {
                "signal": { "$schema": "http://json-schema.org/draft-04/schema#", "const": "OK" }
            },
            "properties": { "signal": { "$ref": "#/$defs/signal" } },
            "required": ["signal"],
            "additionalProperties": false
        });
        let (registry, hash) = registry_with(&schema);
        let contract = contract_with(json!({}), Some(hash));
        let err = resolve_output_schema(&contract, &registry, false).unwrap_err();
        assert!(
            err.to_string()
                .contains("$schema is only allowed at the root"),
            "{err}"
        );
    }

    #[test]
    fn test_strict_bound_overflow_rejected() {
        let schema = json!({
            "type": "array",
            "maxItems": u64::MAX,
            "items": { "type": "string", "maxLength": u64::MAX }
        });
        assert!(strict_schema_upper_bound(&schema).is_err());
    }
}
