# AgentVault Protocol Specification

> **Protocol version: 0.1.0**
>
> This document is the normative specification for the AgentVault bounded-disclosure
> coordination protocol. A conforming implementation can be built from this document
> and the JSON schemas in the `schemas/` directory.

---

## 1. Overview

AgentVault is a protocol for producing bounded, verifiable signals from a shared LLM
call between two agents without revealing their raw inputs to each other.

Three roles participate in every session:

- **Initiator** — the agent that proposes the session and provides the contract.
- **Responder** — the agent that accepts (or declines) the session.
- **Relay** — a stateless intermediary that receives both inputs, assembles a prompt
  from a content-addressed template, calls a model, validates the output against a
  JSON Schema and guardian policy, signs a receipt, and returns the bounded output to
  both parties.

The protocol supports two execution modes:

- **Single-shot** — both inputs and the contract are submitted in a single request.
  The relay returns the output synchronously.
- **Bilateral session** — each participant submits independently. The relay holds state
  until both inputs arrive, then runs inference asynchronously.

**Guarantees.** The protocol guarantees that: (a) the output conforms to the contract's
JSON Schema, (b) the guardian enforcement policy was applied, (c) the receipt
cryptographically binds all content-addressed artefacts that governed the session.

**Non-guarantees.** The protocol does not guarantee model quality, relay honesty, input
confidentiality from the relay, or fair simultaneous delivery to both parties.

**Related documents.** See [API Reference](api-reference.md) for HTTP endpoint details,
[Getting Started](getting-started.md) for an implementation tutorial, and
[Schema Versioning Policy](schema-versioning-policy.md) for schema evolution rules.

---

## 2. Data Model

This section defines every named object in the protocol. Field names are JSON keys
(snake_case). Types are JSON types unless otherwise noted.

### 2.1 Contract

The bilateral agreement submitted to the relay. All fields MUST be present in the
serialized JSON (including null-valued optional fields) when computing the contract hash.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `purpose_code` | string enum | yes | Session purpose. Values: `COMPATIBILITY`, `MEDIATION`, `SCHEDULING`. A relay advertises its supported set via `GET /capabilities`. |
| `output_schema_id` | string | yes | Human-readable schema identifier (e.g., `vcav_e_compatibility_signal_v2`). |
| `output_schema` | object (JSON Schema) | yes | Inline JSON Schema. The relay validates the model output against this at runtime. |
| `participants` | array of string | yes | Exactly 2 participant identifiers. |
| `prompt_template_hash` | string (64 hex) | yes | SHA-256 of the canonical prompt program JSON. |
| `entropy_budget_bits` | integer or null | no | Advisory upper bound on output information content (bits). |
| `timing_class` | string or null | no | Reserved for future use. |
| `metadata` | object or null | no | Opaque key-value map. Included in the contract hash. |
| `model_profile_id` | string or null | no | References a content-addressed model profile on the relay. |

### 2.2 Input Envelope

A single participant's submission to the relay.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `role` | string | yes | Must match one of `contract.participants`. |
| `context` | object | yes | Arbitrary JSON. Opaque to the relay. |
| `expected_contract_hash` | string (64 hex) or null | no | If provided, the relay rejects the input if the session's actual contract hash does not match. Prevents contract substitution attacks. |

### 2.3 Prompt Program

A content-addressed assembly template stored on the relay. Referenced by
`contract.prompt_template_hash`. The relay loads the program file by hash, re-hashes
the loaded content, and rejects the request if the hashes differ (fail-closed).

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Program format version (e.g., `"1.0.0"`). |
| `system_instruction` | string | System prompt sent to the model. |
| `input_format` | string enum | `"structured"` or `"narrative"`. Determines how inputs are assembled into the user message. |

Prompt programs MUST be valid JSON (no comments or non-JSON elements). The hash is
computed over the RFC 8785 canonical form, not the raw file bytes. Two files with
identical JSON content but different whitespace produce the same hash.

The prompt program is not returned in the receipt — only its hash. Third parties who
want to verify which prompt governed an execution must obtain the program file
independently.

### 2.4 Model Profile

Describes the provider and model configuration agreed to by both parties.

| Field | Type | Description |
|-------|------|-------------|
| `profile_version` | string | Profile format version (e.g., `"1"`). |
| `profile_id` | string | Human-readable identifier (e.g., `"api-claude-sonnet-v1"`). |
| `provider` | string | `"anthropic"` or `"openai"`. |
| `model_family` | string | Model family name (e.g., `"claude-sonnet"`). |
| `reasoning_mode` | string | Reasoning mode (e.g., `"unconstrained"`). |
| `structured_output` | boolean | Whether the provider supports structured output. |

Content-addressed by JCS + SHA-256. Bound into the receipt as `model_profile_hash`.
Optional: if `contract.model_profile_id` is null, no profile hash appears in the receipt.

### 2.5 Guardian Enforcement Policy

The relay-global rule set applied to every output. Loaded at startup, content-addressed,
and bound into every receipt.

| Field | Type | Description |
|-------|------|-------------|
| `policy_version` | string | Policy format version. |
| `policy_id` | string | Human-readable identifier. |
| `policy_scope` | string | Must be `"RELAY_GLOBAL"`. |
| `model_profile_allowlist` | array of string | Allowed model profile IDs. |
| `provider_allowlist` | array of string | Allowed providers. |
| `max_output_tokens` | integer or null | Token limit for model output. |
| `rules` | array of Rule | Enforcement rules (see [Section 9](#9-guardian-policy-rules)). |
| `entropy_constraints` | object or null | `{budget_bits, classification, review_trigger_pct}`. |

### 2.6 Receipt

The signed audit record returned with every completed session. This is the core
verifiable artefact of the protocol. All hash fields are 64-character lowercase hex
strings (SHA-256).

Receipt v2 (schema version `"2.0.0"`) organises fields into two top-level groups:
**commitments** (independently verifiable hashes) and **claims** (relay assertions).
See [docs/architecture/contract-receipt-v2.md](architecture/contract-receipt-v2.md)
for the full field reference and migration notes.

**Top-level fields:**

| Field | Type | Description |
|-------|------|-------------|
| `receipt_schema_version` | string | Receipt format version. `"2.0.0"`. |
| `receipt_canonicalization` | string | `"JCS_V1"`. |
| `receipt_id` | string (UUID) | Unique receipt identifier. |
| `session_id` | string (UUID) | Session identifier. |
| `issued_at` | string (ISO 8601) | When the receipt was signed. |
| `assurance_level` | string enum | `SELF_ASSERTED`, `OPERATOR_AUDITED`, `PROVIDER_ATTESTED`, or `TEE_ATTESTED`. |
| `operator` | object | `{operator_id, operator_key_fingerprint, operator_key_discovery?}`. |
| `commitments` | object | Independently verifiable hashes. See below. |
| `claims` | object | Relay assertions; not independently verifiable. See below. |
| `signature` | object | `{alg, value, signed_fields}`. Ed25519 by default. |

**Commitments** (verifiable — a third party who holds the inputs and artefacts can
independently recompute all these hashes):

| Field | Type | Description |
|-------|------|-------------|
| `contract_hash` | string (64 hex) | SHA-256(JCS(contract)). |
| `schema_hash` | string (64 hex) | SHA-256(JCS(output_schema)). |
| `output_hash` | string (64 hex) | SHA-256(JCS(output)). |
| `output` | object or null | Inline bounded output (convenience). |
| `input_commitments` | array | Per-participant `{participant_id, input_hash, hash_alg, canonicalization}`. |
| `assembled_prompt_hash` | string (64 hex) | SHA-256 of the assembled prompt bytes. |
| `prompt_assembly_version` | string | Prompt assembler version (e.g., `"1.0.0"`). |
| `prompt_template_hash` | string (64 hex) or null | SHA-256 of canonical prompt program. |
| `preflight_bundle` | object or null | `{policy_hash, prompt_template_hash, model_profile_hash, schema_hash, enforcement_parameters}`. |

**Claims** (relay assertions — believed but not cryptographically verifiable):

| Field | Type | Description |
|-------|------|-------------|
| `model_identity_asserted` | string or null | Model ID as reported by the provider API. |
| `model_identity_attested` | string or null | Model ID from provider attestation (if available). |
| `model_profile_hash_asserted` | string (64 hex) or null | SHA-256 of the model profile used. |
| `runtime_hash_asserted` | string (64 hex) or null | SHA-256 of the relay's git commit SHA string. |
| `budget_enforcement_mode` | string or null | `"enforced"`, `"advisory"`, or `"disabled"`. |
| `provider_latency_ms` | integer or null | Wall-clock latency of the provider call. |
| `token_usage` | object or null | `{prompt_tokens, completion_tokens, total_tokens}`. |
| `relay_software_version` | string or null | Relay software version string. |

**Assurance levels:**

| Level | Description |
|-------|-------------|
| `SELF_ASSERTED` | Relay signs its own receipt. No external attestation. Current default. |
| `OPERATOR_AUDITED` | Operator publishes a verifiable audit trail alongside the receipt. |
| `PROVIDER_ATTESTED` | Model provider supplied signed inference metadata bound into the receipt. |
| `TEE_ATTESTED` | Hardware TEE attestation binds the receipt to an enclave measurement. |

"Receipt verified" must always be reported with its assurance level. A `SELF_ASSERTED`
receipt proves the relay's stated rules were declared — it does not prove relay honesty.

---

## 3. Execution Modes

A conforming relay MUST implement both execution modes.

### 3.1 Single-Shot

One request carries the contract and both inputs. The relay executes the full pipeline
synchronously: validate contract → load prompt program → assemble prompt → call model
→ validate output → apply guardian policy → compute entropy → build and sign receipt →
return result. No session state is created. The session ID in the receipt is a fresh
random value. See `POST /relay` in the [API Reference](api-reference.md).

### 3.2 Bilateral Session

A multi-step protocol where each participant submits independently:

1. **Create session.** The initiator submits the contract via `POST /sessions`. The
   relay generates a session ID and four role-scoped tokens, computes the contract hash,
   and returns all to the initiator. Session state: `CREATED`.
2. **Submit inputs.** Each participant submits their input via `POST /sessions/:id/input`
   using their submit token. The first submission transitions state to `PARTIAL`. The
   second transitions to `PROCESSING` and triggers background inference.
3. **Poll.** Participants poll `GET /sessions/:id/status` until the state is `COMPLETED`
   or `ABORTED`.
4. **Retrieve.** Participants retrieve the output and receipt via
   `GET /sessions/:id/output` using their read token.

**Token scoping.** Four tokens are generated per session, split by capability and role:

| Token | Can submit input | Can read output | One-time |
|-------|-----------------|-----------------|----------|
| `initiator_submit_token` | yes | no | yes |
| `initiator_read_token` | no | yes | no |
| `responder_submit_token` | yes | no | yes |
| `responder_read_token` | no | yes | no |

Submit tokens are consumed on use. Resubmission returns 401 (constant-shape). All
tokens for a session share the same session TTL. Sessions expire after
`AV_SESSION_TTL_SECS` (default: 600 seconds); expired sessions return 401 for all
subsequent requests. Read tokens remain valid until the session TTL elapses or the
session store reaper removes a terminal session, whichever comes first.

---

## 4. Session State Machine

### States

| State | Description |
|-------|-------------|
| `CREATED` | Session created, no inputs received. |
| `PARTIAL` | One input received, waiting for the other. |
| `PROCESSING` | Both inputs received, inference running. |
| `COMPLETED` | Output validated, receipt signed. Terminal. |
| `ABORTED` | Session failed. Terminal. |

### Transitions

```
CREATED ──[first input]──► PARTIAL ──[second input]──► PROCESSING
    │                          │                           │
    │                          │                           ├──[success]──► COMPLETED
    │                          │                           │
    └──[timeout]───────────────┴──[timeout]──► ABORTED ◄───┘
                                                  ▲
                                                  └──[any error]
```

Valid transitions:

| From | To | Trigger |
|------|----|---------|
| `CREATED` | `PARTIAL` | First input received. |
| `PARTIAL` | `PROCESSING` | Second input received (inference spawned). |
| `PROCESSING` | `COMPLETED` | Inference succeeded, output validated, receipt signed. |
| `PROCESSING` | `ABORTED` | Error during inference, validation, or policy enforcement. |
| `CREATED` | `ABORTED` | Session TTL expired before both inputs arrived. |
| `PARTIAL` | `ABORTED` | Session TTL expired, or input submission error (e.g., contract mismatch). |

Terminal states (`COMPLETED`, `ABORTED`) are immutable. A session in a terminal state
remains readable (status and output endpoints) until the session store reaper removes it.

### Abort Reasons

| Reason | Trigger |
|--------|---------|
| `TIMEOUT` | Session TTL expired. |
| `SCHEMA_VALIDATION` | Model output failed JSON Schema validation. |
| `PROVIDER_ERROR` | Upstream model provider returned an error. |
| `CONTRACT_MISMATCH` | `expected_contract_hash` did not match the session's stored hash. |
| `POLICY_GATE` | Guardian enforcement rule with `GATE` classification fired. |

The relay does not expose internal error details for aborted sessions beyond the abort
reason code.

---

## 5. Invite Coordination

The invite system allows agents to coordinate session creation asynchronously. A relay
that supports the inbox endpoints MUST implement this section.

### 5.1 Invite Lifecycle

An invite is created by the initiator and delivered to the recipient. The invite carries
`contract_hash` and `purpose_code` but not the full contract body.

**Invite states:** `PENDING`, `ACCEPTED`, `DECLINED`, `CANCELED`, `EXPIRED`.

Valid transitions:

| From | To | Actor |
|------|----|-------|
| `PENDING` | `ACCEPTED` | Recipient. |
| `PENDING` | `DECLINED` | Recipient. |
| `PENDING` | `CANCELED` | Sender. |
| `PENDING` | `EXPIRED` | Automatic (TTL, default 7 days). |

Same-state transitions are idempotent (re-accepting an accepted invite returns the same
tokens). All other transitions from terminal states are invalid and return 409 Conflict.

### 5.2 Token Redaction

When an invite is accepted, the relay creates a bilateral session and generates four
tokens. Each party sees only their own tokens:

- **Sender** (`GET /invites/:id`): receives `initiator_submit_token` and
  `initiator_read_token`.
- **Recipient** (`POST /invites/:id/accept` response, and `GET /invites/:id`): receives
  `responder_submit_token` and `responder_read_token`.
- **Third party**: receives no tokens and no session ID.

Pre-accept: all token and session ID fields are null for all callers.

### 5.3 Invite Fields

| Field | Type | Description |
|-------|------|-------------|
| `invite_id` | string | Format: `inv_` + 16 hex characters. |
| `from_agent_id` | string | Sender's agent identifier. |
| `to_agent_id` | string | Recipient's agent identifier. |
| `from_agent_pubkey` | string (64 hex) or null | Sender's Ed25519 public key for out-of-band verification. Not used by the relay. |
| `status` | string enum | One of: `PENDING`, `ACCEPTED`, `DECLINED`, `CANCELED`, `EXPIRED`. |
| `purpose_code` | string | From the contract. |
| `contract_hash` | string (64 hex) | SHA-256 of the canonical contract. |
| `provider` | string | Provider name (e.g., `"anthropic"`). |
| `created_at` | string (ISO 8601) | Creation timestamp. |
| `updated_at` | string (ISO 8601) | Last status change timestamp. |
| `expires_at` | string (ISO 8601) | Expiration timestamp. |
| `decline_reason_code` | string enum or null | `NOT_INTERESTED`, `BUSY`, `CONFLICT`, `SECURITY_CONCERN`. Opaque to the relay. |

### 5.4 SSE Event Stream

The relay pushes inbox events on `GET /inbox/events` as Server-Sent Events.

**Event types:** `INVITE_CREATED`, `INVITE_ACCEPTED`, `INVITE_DECLINED`,
`INVITE_CANCELED`, `INVITE_EXPIRED`.

**Event fields:** `event_id` (monotonic integer per agent), `event_type`, `invite_id`,
`from_agent_id`, `timestamp`.

The stream is lossy — if the receiver lags, events may be dropped. Clients SHOULD track
the highest `event_id` seen and reconcile via `GET /inbox` on reconnect.

### 5.5 Contract Substitution Prevention

The `expected_contract_hash` field on `POST /invites/:id/accept` and
`POST /sessions/:id/input` serves the same purpose: the relay verifies the stored
contract hash matches before proceeding. A conforming relay MUST accept this field and
enforce the check when provided.

---

## 6. Content Addressing

All content-addressed hashes in the protocol use the same algorithm: RFC 8785 (JSON
Canonicalization Scheme, JCS) applied to the JSON object, followed by SHA-256 of the
UTF-8 bytes. The result is a lowercase hex string of exactly 64 characters.

Content-addressed artefacts (contracts, prompt programs, model profiles, guardian
policies) MUST NOT contain unknown fields. Only fields defined in this specification
are permitted. Unknown fields would cause two parties to hash different supersets of the
same logical object and produce different hashes.

### 6.1 Hash Algorithm

```
canonical_string = JCS(json_object)       // RFC 8785: sorted keys, no whitespace
hash_bytes       = SHA-256(canonical_string.as_utf8_bytes())
hash_hex         = lowercase_hex(hash_bytes)   // 64 characters
```

### 6.2 Hash Bindings

| Object | Receipt field | When computed |
|--------|---------------|---------------|
| Contract (full object) | `contract_hash` | Session creation. |
| `contract.output_schema` (extracted) | `output_schema_hash` | Session creation. |
| Prompt program | `prompt_template_hash` | Before inference. Verified against `contract.prompt_template_hash`. |
| Guardian policy | `guardian_policy_hash` | Relay startup. |
| Model profile | `model_profile_hash` | Before inference. Null if `contract.model_profile_id` is null. |
| Relay git SHA (string) | `runtime_hash` | Build time. `SHA-256(git_sha_string.as_utf8_bytes())`. |

### 6.3 Null-Field Inclusion

When computing a hash, all fields MUST be present in the serialized JSON, including
fields with null values. The JCS canonical form of an object with null fields differs
from one with those fields omitted.

**Worked example.** Consider a contract with `timing_class: null` and
`model_profile_id: null`:

Correct canonical form (null fields present):
```json
{"entropy_budget_bits":null,"metadata":null,"model_profile_id":null,"output_schema":{"type":"object"},"output_schema_id":"test","participants":["alice","bob"],"prompt_template_hash":"aaaa...","purpose_code":"MEDIATION","timing_class":null}
```

Incorrect form (null fields omitted):
```json
{"output_schema":{"type":"object"},"output_schema_id":"test","participants":["alice","bob"],"prompt_template_hash":"aaaa...","purpose_code":"MEDIATION"}
```

These produce different SHA-256 hashes. An implementation that omits null fields will
fail cross-party verification.

### 6.4 Sentinel Hashes

For API-mediated execution, the relay cannot meaningfully reference local model weights
or inference configuration. The protocol defines sentinel values:

| Field | Input bytes | Purpose |
|-------|-------------|---------|
| `model_weights_hash` | `b"api-mediated-no-local-weights"` | Declares API-mediated execution (no local weights). |
| `inference_config_hash` | `b"api-mediated-no-local-inference"` | Declares API-mediated execution (no local inference config). |

These are stable — a verifier can check them to confirm the relay declared API-mediated
execution. See [Appendix B](#appendix-b--known-hash-vectors) for precomputed values.

---

## 7. Receipt Signing and Verification

### 7.1 Signing Key

The relay holds an Ed25519 signing key (RFC 8032). The key seed is 32 bytes
(64 hex characters). The corresponding verifying key (public key) MUST be distributed
out-of-band to parties who want to verify receipts.

If no key is configured, the relay generates an ephemeral key per startup. Receipts
signed by ephemeral keys cannot be verified after a restart.

### 7.2 Signing Procedure

The relay signs the receipt by:

1. Constructing the unsigned receipt (all fields except `signature`).
2. Serializing it to canonical JSON (RFC 8785 JCS).
3. Signing the UTF-8 bytes of the canonical string with Ed25519 (RFC 8032).
4. Encoding the 64-byte signature as lowercase hex (128 characters).

### 7.3 Wire Format

The receipt is returned as a JSON object in the `receipt` field. The signature is a
separate field (`receipt_signature`, 128-char hex). The receipt object MUST NOT contain
a `signature` field internally — the signature is always external. This prevents
ambiguity during verification (the canonical form of the unsigned receipt is the
verification input).

### 7.4 Verification Algorithm

A verifier with a receipt and the relay's public key can verify the receipt as follows:

```
function verify_receipt(receipt_json, signature_hex, public_key_hex):
    // 1. Decode inputs
    signature_bytes  = hex_decode(signature_hex)      // → 64 bytes
    public_key_bytes = hex_decode(public_key_hex)     // → 32 bytes

    // 2. Canonicalize the receipt
    canonical_string = JCS(receipt_json)               // RFC 8785
    message_bytes    = utf8_encode(canonical_string)

    // 3. Verify Ed25519 signature (RFC 8032)
    valid = ed25519_verify(public_key_bytes, message_bytes, signature_bytes)
    if not valid:
        return INVALID

    // 4. Verify hash chain (optional, requires artefact access)
    if has_contract:
        expected = SHA-256(JCS(contract))
        assert receipt_json.contract_hash == hex_encode(expected)
    if has_output_schema:
        expected = SHA-256(JCS(output_schema))
        assert receipt_json.output_schema_hash == hex_encode(expected)

    return VALID
```

Step 3 verifies that the receipt was produced by the relay that holds the private key.
Step 4 verifies the hash chain — that the contract and schema bound into the receipt
match the ones the verifier holds.

### 7.5 Trust Model

Receipt fields fall into two categories: **commitments** and **claims**.

**Commitments** — independently verifiable by any party who holds the inputs and
artefacts. A verifier recomputes the hash from the source artefact and confirms it
matches the receipt.

**Claims** — relay assertions. The relay reports what it believes to be true (e.g.,
which model it called), but these fields cannot be independently verified from the
receipt alone.

**What receipts prove (at `SELF_ASSERTED` level):**

- The output was produced by a relay that holds the corresponding signing key.
- The output conforms to the schema identified by `commitments.schema_hash`.
- The guardian policy identified by `commitments.preflight_bundle.policy_hash` was loaded at startup.
- The prompt program identified by `commitments.prompt_template_hash` was used.
- Each participant's input is bound by hash in `commitments.input_commitments`.

**What receipts do not prove:**

- The relay is honest (it could have modified inputs or fabricated output).
- The model identified by `claims.model_identity_asserted` was actually called.
- Either party's inputs were private from the relay.
- The output was delivered simultaneously to both parties.

**Assurance levels** extend what receipts prove beyond `SELF_ASSERTED`. See
[Section 2.6](#26-receipt) for the level definitions. Higher assurance levels
(`OPERATOR_AUDITED`, `PROVIDER_ATTESTED`, `TEE_ATTESTED`) are defined in the schema
and receipt v2 spec but are not yet active in the production relay.

---

## 8. Error Semantics

### 8.1 Constant-Shape Auth Errors

All authentication failures MUST return HTTP 401 with a fixed body:

```json
{"error": "UNAUTHORIZED"}
```

This applies uniformly to: invalid token, expired session, unknown session ID, unknown
invite ID, and wrong token role. The relay MUST NOT distinguish these cases in the
response. This prevents session enumeration. Relays SHOULD normalize authentication
error response timing to prevent timing side channels between known and unknown sessions.

### 8.2 Policy Gate Errors

When a guardian rule with `classification: GATE` fires, the relay MUST return HTTP 422
with a fixed body:

```json
{"error": "OUTPUT_POLICY_VIOLATION"}
```

No detail about which rule fired or what content triggered it is exposed. This prevents
callers from reverse-engineering the guardian policy.

### 8.3 Schema Validation Errors

When the model output fails JSON Schema validation, the relay returns HTTP 422. Unlike
policy gate errors, diagnostic content (the schema validation error message) MAY be
included. Implementations may omit details at their discretion.

### 8.4 Decline Reason Codes

Decline reasons are caller-provided from a fixed enum: `NOT_INTERESTED`, `BUSY`,
`CONFLICT`, `SECURITY_CONCERN`. The relay stores and returns whatever the decliner
sends. No semantic meaning is enforced.

### 8.5 Session Abort Reasons

When a session aborts, the abort reason is stored and exposed via the status endpoint.
Abort reasons are a closed enum. The mapping from relay errors to abort reasons:

| Relay error | Abort reason |
|-------------|-------------|
| Output schema validation failed | `SCHEMA_VALIDATION` |
| Guardian policy gate fired | `POLICY_GATE` |
| Upstream provider error | `PROVIDER_ERROR` |
| Contract hash mismatch | `CONTRACT_MISMATCH` |
| Session TTL expired | `TIMEOUT` |
| All other errors | `PROVIDER_ERROR` (conservative fallback) |

---

## 9. Guardian Policy Rules

The guardian enforcement policy is a relay-global rule set applied to every model output
after schema validation passes.

### 9.1 Rule Types

The current protocol version supports one rule type: `unicode_category_reject`.

A rule of this type scans every string value in the output JSON and rejects the output
if any string contains a character in the specified Unicode general category.

Supported category values:

| Value | Unicode category | Coverage |
|-------|-----------------|----------|
| `Nd` | Decimal digit numbers | Conservative superset: includes Nd (decimal digits), Nl (letter numbers), and No (other numbers) as a defense-in-depth measure. A rule value of `"Nd"` activates scanning for all three categories. |
| `Sc` | Currency symbols | As defined by Unicode 15.1. |

A conforming relay MUST reject configurations that declare unsupported categories
(fail-closed at startup).

### 9.2 Rule Scope

Each rule has a scope descriptor:

| Field | Type | Description |
|-------|------|-------------|
| `kind` | string enum | Currently only `"all_string_values"`: scan every string value in the output recursively. |
| `skip_keys` | array of string | Top-level object keys to exclude from scanning. Applies only at the top level of the output object, not in nested objects. |

### 9.3 Classification

Each rule carries a `classification`:

- **`GATE`** — the relay MUST abort the session with `POLICY_GATE` and return the
  constant-shape 422 error. The output is not delivered.
- **`ADVISORY`** — the relay logs a warning but does not block the output. Advisory
  violations are not reported to callers.

### 9.4 Layered Enforcement

Enforcement is layered:

1. **Schema validation** runs first. If the output fails the JSON Schema, the relay
   returns `SCHEMA_VALIDATION` without running the guardian.
2. **Guardian rules** run second, only on schema-valid output.

This layering means the schema provides primary enforcement (strict enum fields prevent
most forbidden content), while the guardian provides defense-in-depth.

### 9.5 Policy Activation

Guardian enforcement MUST be deterministic: given an identical policy and identical
output, any conforming relay MUST produce the same accept/reject decision.

The relay loads exactly one enforcement policy at startup. The policy hash is computed
and bound into every receipt via `guardian_policy_hash`. A verifier who obtains the
policy file can independently compute the hash and confirm which rules were active.

---

## 10. Entropy Budget

### 10.1 Purpose

The entropy budget is an advisory upper bound on the number of bits of information the
output can reveal. The bound is computed from the output schema structure, not from the
actual output — it is a structural property of the schema.

### 10.2 Computation

The relay computes the entropy upper bound from the output schema:

- **Enum fields:** `ceil(log2(cardinality))` bits. A field with 4 values = 2 bits.
- **Array fields:** If the schema includes the `x-vcav-entropy-bits-upper-bound`
  extension property (see [Appendix A](#appendix-a--schema-extension-properties)), that
  value is used. Otherwise, the bound is derived from the item enum and array constraints.
- **Objects:** Sum of all property entropy bounds.

The result is a conservative upper-bound estimate recorded in the receipt as
`output_entropy_bits`.

### 10.3 Contract Budget

If `contract.entropy_budget_bits` is set, the relay compares the computed bound against
it. In the current protocol version, this comparison is **advisory only** — a budget
overrun is logged but does not abort the session.

The `GET /capabilities` endpoint declares the enforcement level in
`entropy_enforcement`: either `"ADVISORY"` or `"GATE"`.

### 10.4 Budget Usage Record

The receipt contains a `budget_usage` object (see [Section 2.6](#26-receipt)) that
records: the deterministic pair ID (SHA-256 of sorted participant IDs), the entropy used
before and after this session, the budget limit, and the enforcement tier.

In the current implementation, `bits_used_before` is always 0 (no cross-session budget
accumulation).

### 10.5 Schema Extension Property

The `x-vcav-entropy-bits-upper-bound` JSON Schema extension property on array fields is
a hint to the entropy calculator. Standard JSON Schema validators ignore unknown
extensions — its presence does not affect schema validation behavior.

---

## Appendix A — Schema Extension Properties

### `x-vcav-entropy-bits-upper-bound`

- **Applies to:** array-typed schema properties.
- **Type:** integer.
- **Semantics:** declares the maximum number of bits of information the array field can
  carry, accounting for item cardinality, array length bounds, and uniqueness constraints.
- **Used by:** the relay's entropy calculator. Not used by JSON Schema validation.

Example:
```json
{
  "primary_reasons": {
    "type": "array",
    "items": {"type": "string", "enum": ["A", "B", "C", "D", "E", "F"]},
    "minItems": 0,
    "maxItems": 3,
    "uniqueItems": true,
    "x-vcav-entropy-bits-upper-bound": 8
  }
}
```

---

## Appendix B — Known Hash Vectors

### Sentinel Hashes (API-Mediated Execution)

| Field | Input | SHA-256 (hex) |
|-------|-------|---------------|
| `model_weights_hash` | `b"api-mediated-no-local-weights"` | `a2047844c820b7f520eea38292fdeb8976aeb2a796bf6fff6d79b22521c9464f` |
| `inference_config_hash` | `b"api-mediated-no-local-inference"` | `74bd034292a56c4541211604196b79fcea3edb6e192203ebe2d2572e578f43a3` |

### Cross-Language Parity Vector

Reference schema: `schemas/output/vcav_e_mediation_signal_v2.schema.json`

```
SHA-256(JCS(mediation_signal_v2_schema)) = 0d25ea011d60a30156796b7e510caa804068bd4c01faa2f637def7dd07d5b3f6
```

This hash is produced by both the Rust relay (`compute_output_schema_hash`) and the
TypeScript client (`computeOutputSchemaHash`) from the same schema content. It serves as
a cross-language parity test vector.
