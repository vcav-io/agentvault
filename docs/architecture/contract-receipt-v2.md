# Contract & Receipt v2 — Unified Architecture Spec

> **Status:** Draft
> **Canonical schema:** `agentvault-receipt-schema-v2.1.0.revised.json`
> **Issues:** #155 (receipt hardening), #151 (contract completeness), #147 (enforcement policy)

## Design Principles

1. **Commitments are verifiable; claims are not.** Every receipt field falls into exactly one category.
2. **The contract is the single root of trust.** Everything that governs a session is in the contract or referenced by content hash from the contract.
3. **Receipt v2 is additive.** v1 receipts remain verifiable. Verifiers dispatch on `receipt_schema_version`.
4. **Assurance level is mandatory context.** "Receipt verified" must never appear without it.

---

## 1. Contract v2 Struct

The contract gains fields that were previously hardcoded in relay config or absent entirely.

### Current Contract (v1)

```rust
pub struct Contract {
    pub purpose_code: Purpose,
    pub output_schema_id: String,
    pub output_schema: serde_json::Value,
    pub participants: Vec<String>,
    pub prompt_template_hash: String,
    pub entropy_budget_bits: Option<u32>,
    pub timing_class: Option<String>,
    pub metadata: serde_json::Value,
    pub model_profile_id: Option<String>,
}
```

### Contract v2

New and changed fields marked with `// NEW`.

```rust
pub struct Contract {
    // --- Existing fields (unchanged) ---
    pub purpose_code: Purpose,
    pub output_schema_id: String,
    pub output_schema: serde_json::Value,
    pub participants: Vec<String>,
    pub prompt_template_hash: String,
    pub entropy_budget_bits: Option<u32>,
    pub timing_class: Option<String>,
    pub metadata: serde_json::Value,
    pub model_profile_id: Option<String>,

    // --- NEW: enforcement policy binding (#147) ---
    /// Content hash of the enforcement policy governing this session.
    /// If present, the receipt's guardian_policy_hash MUST match.
    pub enforcement_policy_hash: Option<String>,

    // --- NEW: output schema as content-addressed artefact ---
    /// SHA-256 of JCS(output_schema). Allows schema lookup by hash
    /// without embedding the full schema inline.
    pub output_schema_hash: Option<String>,

    // --- NEW: provider/model constraints (#151 gap 3) ---
    /// Model constraints rather than exact model IDs. The relay selects
    /// a model satisfying all constraints.
    pub model_constraints: Option<ModelConstraints>,

    // --- NEW: completion token limit (#149 → contract-level) ---
    /// Per-session max completion tokens. Relay enforces a ceiling but
    /// the contract can request a lower value.
    pub max_completion_tokens: Option<u32>,

    // --- NEW: session/invite TTLs (#151 gap 5) ---
    pub session_ttl_secs: Option<u32>,
    pub invite_ttl_secs: Option<u32>,

    // --- NEW: entropy enforcement mode (#151 gap 6) ---
    pub entropy_enforcement: Option<EntropyEnforcementMode>,
}

pub struct ModelConstraints {
    /// Allowed provider IDs (e.g. ["openai", "anthropic"]).
    /// Empty = any provider.
    pub allowed_providers: Vec<String>,
    /// Allowed model ID patterns (e.g. ["gpt-4o*", "claude-sonnet-*"]).
    /// Empty = any model.
    pub allowed_models: Vec<String>,
    /// Minimum model capability tier (e.g. "mid", "frontier").
    pub min_tier: Option<String>,
}

pub enum EntropyEnforcementMode {
    /// Budget tracked but not enforced. Current default.
    Advisory,
    /// Session blocked if budget would be exceeded.
    Gate,
    /// Session aborted mid-execution if budget breached.
    Strict,
}
```

### Contract Hash

`compute_contract_hash()` already uses JCS canonicalization of the full struct. Adding fields automatically includes them in the hash. No special plumbing needed.

---

## 2. Receipt v2 Struct

Maps directly from `agentvault-receipt-schema-v2.1.0.revised.json`.

### Top-Level Structure

```rust
pub struct ReceiptV2 {
    pub receipt_schema_version: String,       // "2.0.0"
    pub receipt_canonicalization: String,      // "JCS_V1"
    pub receipt_id: String,                   // UUID
    pub session_id: String,                   // UUID
    pub issued_at: DateTime<Utc>,
    pub assurance_level: AssuranceLevel,
    pub operator: Operator,
    pub commitments: Commitments,
    pub claims: Claims,
    pub provider_attestation: Option<ProviderAttestation>,
    pub tee_attestation: Option<TeeAttestation>,
    pub signature: Signature,
}
```

### Commitments (Verifiable)

```rust
pub struct Commitments {
    // --- Required ---
    pub contract_hash: String,                // SHA-256(JCS(contract))
    pub schema_hash: String,                  // SHA-256(JCS(output_schema))
    pub output_hash: String,                  // SHA-256(JCS(output))
    pub input_commitments: Vec<InputCommitment>,
    pub assembled_prompt_hash: String,        // SHA-256(assembled prompt bytes)
    pub prompt_assembly_version: String,      // e.g. "1.0.0"

    // --- Optional ---
    pub output: Option<serde_json::Value>,    // inline output (convenience)
    pub prompt_template_hash: Option<String>,
    pub effective_config_hash: Option<String>,
    pub preflight_bundle: Option<PreflightBundle>,

    // --- Retrieval hooks (when output/bundle omitted) ---
    pub output_retrieval_uri: Option<String>,
    pub output_media_type: Option<String>,
    pub preflight_bundle_uri: Option<String>,
}

pub struct InputCommitment {
    pub participant_id: String,
    pub input_hash: String,           // SHA-256 hex
    pub hash_alg: HashAlgorithm,
    pub canonicalization: String,     // "CANONICAL_JSON_V1"
}

pub enum HashAlgorithm {
    #[serde(rename = "SHA-256")]
    Sha256,
    #[serde(rename = "SHA-384")]
    Sha384,
    #[serde(rename = "SHA-512")]
    Sha512,
}

pub struct PreflightBundle {
    pub policy_hash: String,
    pub prompt_template_hash: String,
    pub model_profile_hash: String,
    pub schema_hash: String,
    pub enforcement_parameters: serde_json::Value,
}
```

### Claims (Not Independently Verifiable)

```rust
pub struct Claims {
    pub model_identity_asserted: Option<String>,
    pub model_identity_attested: Option<String>,
    pub model_profile_hash_asserted: Option<String>,
    pub runtime_hash_asserted: Option<String>,
    pub runtime_hash_attested: Option<String>,
    pub budget_enforcement_mode: Option<BudgetEnforcementMode>,
    pub provider_latency_ms: Option<u64>,
    pub token_usage: Option<TokenUsage>,
    pub relay_software_version: Option<String>,
}

pub enum BudgetEnforcementMode {
    #[serde(rename = "enforced")]
    Enforced,
    #[serde(rename = "advisory")]
    Advisory,
    #[serde(rename = "disabled")]
    Disabled,
}

pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}
```

### Assurance Level

```rust
pub enum AssuranceLevel {
    /// Relay signs its own receipt. No external attestation.
    #[serde(rename = "SELF_ASSERTED")]
    SelfAsserted,
    /// Operator publishes verifiable audit trail.
    #[serde(rename = "OPERATOR_AUDITED")]
    OperatorAudited,
    /// Model provider supplied signed inference metadata.
    #[serde(rename = "PROVIDER_ATTESTED")]
    ProviderAttested,
    /// Hardware TEE attestation binds receipt to enclave measurement.
    #[serde(rename = "TEE_ATTESTED")]
    TeeAttested,
}
```

### Operator Identity

```rust
pub struct Operator {
    pub operator_id: String,
    pub operator_key_fingerprint: String,  // SHA-256 hex of signing pubkey
    pub operator_key_discovery: Option<String>,  // URI for key pinning
}
```

### Signature

```rust
pub struct Signature {
    pub alg: SignatureAlgorithm,
    pub value: String,              // base64url-encoded
    pub signed_fields: Option<String>,  // "ALL_EXCEPT_SIGNATURE"
}

pub enum SignatureAlgorithm {
    Ed25519,
    ES256,
    ES384,
}
```

### Attestation Slots (Schema Only)

```rust
pub struct ProviderAttestation {
    pub provider_attestation_blob: String,    // base64
    pub provider_attestation_type: String,
    pub provider_key_id: String,
    pub provider_key_discovery_uri: Option<String>,
}

pub struct TeeAttestation {
    pub tee_type: Option<TeeType>,
    pub measurement: Option<String>,
    pub quote: Option<String>,
}

pub enum TeeType {
    SGX,
    TDX,
    #[serde(rename = "SEV-SNP")]
    SevSnp,
    TrustZone,
}
```

---

## 3. Contract → Receipt Field Mapping

How contract fields flow into receipt fields at session time.

| Contract field | Receipt location | Category | Verification |
|---|---|---|---|
| (whole contract) | `commitments.contract_hash` | commitment | Verifier recomputes SHA-256(JCS(contract)) |
| `output_schema` / `output_schema_hash` | `commitments.schema_hash` | commitment | Verifier recomputes from contract |
| `enforcement_policy_hash` | `commitments.preflight_bundle.policy_hash` | commitment | Verifier compares hashes |
| `prompt_template_hash` | `commitments.prompt_template_hash` | commitment | Verifier has the program file |
| `model_profile_id` | `commitments.preflight_bundle.model_profile_hash` | commitment | Verifier has the profile doc |
| `model_constraints` | `claims.model_identity_asserted` | claim | Relay selects model; not verifiable |
| `max_completion_tokens` | `commitments.preflight_bundle.enforcement_parameters` | commitment (hash) | Part of effective_config_hash |
| `entropy_enforcement` | `claims.budget_enforcement_mode` | claim | Self-reported enforcement posture |
| `session_ttl_secs` | `commitments.preflight_bundle.enforcement_parameters` | commitment (hash) | Part of effective_config_hash |
| `invite_ttl_secs` | (not in receipt — invite-phase only) | — | — |
| `entropy_budget_bits` | `commitments.preflight_bundle.enforcement_parameters` | commitment (hash) | Part of effective_config_hash |
| `participants` | `commitments.input_commitments[].participant_id` | commitment | Each participant verifies own hash |

### Fields NOT from the contract

| Receipt field | Source |
|---|---|
| `commitments.assembled_prompt_hash` | Computed by relay after `program.assemble()` |
| `commitments.output` / `output_hash` | LLM output |
| `commitments.input_commitments[].input_hash` | SHA-256(JCS(participant_input)) |
| `claims.model_identity_asserted` | Provider API response |
| `claims.runtime_hash_asserted` | Relay build hash |
| `claims.token_usage` | Provider API response |
| `claims.provider_latency_ms` | Relay wall clock |
| `operator.*` | Relay config |

---

## 4. VFC Crate Ownership

### `receipt-core`

Owns all receipt types:
- `ReceiptV2` (new, alongside existing `Receipt`)
- `UnsignedReceiptV2` (all fields except `signature`)
- `Commitments`, `Claims`, `InputCommitment`
- `AssuranceLevel`, `Operator`, `Signature`
- `ProviderAttestation`, `TeeAttestation`
- `PreflightBundle`
- `TokenUsage`, `HashAlgorithm`, `SignatureAlgorithm`, `TeeType`
- `BudgetEnforcementMode`

### `vault-family-types`

Owns contract and shared vocabulary:
- `Contract` (extended with new fields)
- `ModelConstraints` (new)
- `EntropyEnforcementMode` (new)
- Existing types: `Purpose`, `BudgetTier`, `LaneId`, etc.

### Boundary rule

If a type appears **only** in receipts → `receipt-core`.
If a type appears in contracts **or** is shared between contract and receipt → `vault-family-types`.

Exception: `AssuranceLevel` is receipt-only but semantically important enough that `vault-family-types` may re-export it for UI code. Defer this until needed.

---

## 5. Verification Algorithm v2

### Dispatch

```rust
fn verify(receipt_json: &[u8]) -> Result<VerificationResult> {
    let version = extract_schema_version(receipt_json)?;
    match version.as_str() {
        "1.0.0" => verify_v1(receipt_json),
        "2.0.0" => verify_v2(receipt_json),
        _ => Err(UnsupportedVersion(version)),
    }
}
```

Verifiers MUST refuse receipts with unknown versions (fail-closed).

### v1 Verification (Preserved)

```
1. Parse receipt JSON
2. Strip `signature` field
3. Canonicalize remaining fields with JCS (RFC 8785)
4. Compute: hash = SHA-256("VCAV-RECEIPT-V1:" || canonical_bytes)
5. Verify Ed25519 signature over hash using operator's public key
```

### v2 Verification

```
1. Parse receipt JSON
2. Extract and validate receipt_canonicalization == "JCS_V1"
3. Strip `signature` object from receipt
4. Canonicalize remaining fields with JCS (RFC 8785)
5. Compute: hash = SHA-256("VCAV-RECEIPT-V2:" || canonical_bytes)
6. Verify signature using algorithm specified in signature.alg
7. Verify commitments (if verifier has the inputs):
   a. Recompute contract_hash from contract → must match commitments.contract_hash
   b. Recompute schema_hash from output_schema → must match commitments.schema_hash
   c. Recompute output_hash from output → must match commitments.output_hash
   d. Recompute input_commitments from participant inputs
   e. If preflight_bundle present: hash it → must match effective_config_hash
```

### Domain Separator Change

- v1: `"VCAV-RECEIPT-V1:"`
- v2: `"VCAV-RECEIPT-V2:"`

This ensures a valid v1 signature cannot be misinterpreted as a valid v2 signature, even if the payload happens to parse under both schemas.

### Signature Algorithm Flexibility

v2 supports Ed25519, ES256 (P-256), and ES384 (P-384). The relay's `signature.alg` field determines which algorithm the verifier uses. Ed25519 remains the default for AgentVault deployments.

---

## 6. Migration Path

### v1 Receipts Remain Verifiable

- `verify_v1()` is preserved unchanged
- Existing signed receipts remain valid indefinitely
- No re-signing or migration of existing receipts

### v2 Is Additive

- v2 adds new top-level fields (`assurance_level`, `operator`, `commitments`, `claims`)
- v2 removes the flat field layout (all v1 fields are reorganized into commitments/claims)
- This is a breaking schema change, hence the major version bump to 2.0.0

### Relay Transition

1. Relay starts emitting v2 receipts once the code ships
2. No dual-emission period — v2 replaces v1 for new sessions
3. Old receipts stored in persistent systems remain v1 and verify with `verify_v1()`

### Contract Transition

- New contract fields are all `Option<T>` — existing contracts remain valid
- Contracts without the new fields simply don't bind those aspects of the session
- No breaking change to the Contract struct

---

## 7. Relay Data Retention Policy

### Principle

The relay is a **stateless mediator**. It processes inputs transiently and retains only commitment hashes and the signed receipt.

### Rules

1. **Raw participant inputs MUST be cleared from persistent state after receipt construction.** The relay computes `input_commitments` during execution and discards the plaintext inputs once the receipt is signed.

2. **Only commitment hashes persist.** The relay MAY log `input_hash` values (they are opaque hashes, not inputs) but MUST NOT persist the raw input JSON beyond the LLM call.

3. **The relay MAY retain the preflight bundle and signed receipt.** These are designed to be shareable — they contain only hashes and the bounded output.

4. **In-memory lifetime:** During execution, inputs exist in memory for the duration of the LLM provider call. After the provider responds and the receipt is constructed, inputs are dropped.

5. **No replay buffer for inputs.** If a session fails and must be retried, participants must resubmit their inputs. The relay does not cache inputs for retry.

### Implementation Note

In Rust, this means the input `String` / `serde_json::Value` fields in the session state struct are consumed (moved) during receipt construction, not cloned and retained.

---

## 8. Prompt Assembly Idempotency Invariant

### Problem

If the relay retries a provider call (rate limit, timeout), it could reassemble the prompt from the same inputs but produce subtly different bytes (e.g., different timestamp in system message, different whitespace from a template engine update). This would mean the `assembled_prompt_hash` in the receipt matches the retried prompt but not the original — a valid receipt over a different prompt than intended.

### Invariant

> `assembled_prompt_hash` MUST be computed once against the first assembled prompt. If the relay retries the provider call, it MUST reuse the same assembled prompt bytes — never reassemble.

### Implementation

```
1. assemble() → prompt_bytes
2. assembled_prompt_hash = SHA-256(prompt_bytes)
3. cache prompt_bytes in session state
4. provider_call(prompt_bytes)
5. on retry: provider_call(cached prompt_bytes)  // same bytes
6. on success: construct receipt with assembled_prompt_hash from step 2
7. drop prompt_bytes from session state
```

The relay MUST NOT call `assemble()` again on retry. The cached bytes are the canonical prompt for the session.

---

## Appendix A: Receipt v2 JSON Example (SELF_ASSERTED)

```json
{
  "receipt_schema_version": "2.0.0",
  "receipt_canonicalization": "JCS_V1",
  "receipt_id": "a1b2c3d4-...",
  "session_id": "e5f6a7b8-...",
  "issued_at": "2026-03-04T12:00:00Z",
  "assurance_level": "SELF_ASSERTED",
  "operator": {
    "operator_id": "relay.agentvault.dev",
    "operator_key_fingerprint": "abcd1234..."
  },
  "commitments": {
    "contract_hash": "...",
    "schema_hash": "...",
    "output_hash": "...",
    "output": { "decision": "approve", "reasoning": "..." },
    "input_commitments": [
      {
        "participant_id": "alice",
        "input_hash": "...",
        "hash_alg": "SHA-256",
        "canonicalization": "CANONICAL_JSON_V1"
      },
      {
        "participant_id": "bob",
        "input_hash": "...",
        "hash_alg": "SHA-256",
        "canonicalization": "CANONICAL_JSON_V1"
      }
    ],
    "assembled_prompt_hash": "...",
    "prompt_assembly_version": "1.0.0"
  },
  "claims": {
    "model_identity_asserted": "gpt-4o-2024-11-20",
    "budget_enforcement_mode": "advisory",
    "provider_latency_ms": 2340,
    "token_usage": {
      "prompt_tokens": 1200,
      "completion_tokens": 350,
      "total_tokens": 1550
    },
    "relay_software_version": "0.8.0"
  },
  "signature": {
    "alg": "Ed25519",
    "value": "base64url...",
    "signed_fields": "ALL_EXCEPT_SIGNATURE"
  }
}
```

## Appendix B: Golden Test Files

```
tests/receipts/
  v1_self_asserted.json            # v1 receipt, happy path
  v2_self_asserted.json            # v2 SELF_ASSERTED, happy path
  v2_operator_audited.json         # v2 with operator metadata
  v2_tampered_commitment.json      # commitment altered after signing → MUST reject
```

The failure path test (`v2_tampered_commitment.json`) is as important as the happy paths. Verifiers must correctly reject tampered receipts, not just accept valid ones.

## Appendix C: Breaking vs Additive Changes Summary

| Change | Breaking? | Migration |
|---|---|---|
| Receipt: flat → commitments/claims split | **Yes** (v2) | Version dispatch |
| Receipt: new `assurance_level` field | **Yes** (v2) | Required in v2 |
| Receipt: new `operator` object | **Yes** (v2) | Required in v2 |
| Receipt: signature becomes object with `alg` | **Yes** (v2) | String → struct |
| Receipt: domain separator V1→V2 | **Yes** (v2) | Prevents cross-version forgery |
| Contract: `enforcement_policy_hash` | Additive | `Option<String>` |
| Contract: `output_schema_hash` | Additive | `Option<String>` |
| Contract: `model_constraints` | Additive | `Option<ModelConstraints>` |
| Contract: `max_completion_tokens` | Additive | `Option<u32>` |
| Contract: TTLs | Additive | `Option<u32>` |
| Contract: `entropy_enforcement` | Additive | `Option<EntropyEnforcementMode>` |
