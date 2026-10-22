# Selkey Protocol Specification

> **Protocol version: 0.1.0**
>
> This document is the normative specification for the Selkey bounded-disclosure
> coordination protocol. A conforming implementation can be built from this document
> and the JSON schemas in the `schemas/` directory.

---

## 1. Overview

Selkey is a protocol for producing bounded, verifiable signals from a shared LLM
call between two agents without revealing their raw inputs to each other.

Three roles participate in every session:

- **Initiator** — the agent that proposes the session and provides the contract.
- **Responder** — the agent that accepts (or declines) the session.
- **Relay** — an ephemeral intermediary (no persistent storage) that receives both
  inputs, assembles a prompt from a content-addressed template, calls a model,
  validates the output against a JSON Schema and guardian policy, signs a receipt,
  and returns the bounded output to both parties. The single-shot flow is fully
  stateless; the bilateral session flow holds state in memory until inference
  completes.

The protocol supports two execution modes:

- **Single-shot** — both inputs and the contract are submitted in a single request.
  The relay returns the output synchronously.
- **Bilateral session** — each participant submits independently. The relay holds state
  until both inputs arrive, then runs inference asynchronously.

**Guarantees.** In the software lane (`selkey-relay`), the protocol guarantees that:
(a) the output conforms to the contract's JSON Schema, (b) the guardian enforcement
policy was applied, (c) the receipt cryptographically binds all content-addressed
artefacts that governed the session. The TEE lane prototype doesn't yet provide all
three; see [Section 11.5](#115-differences-from-the-software-lane).

**Non-guarantees.** At the `SELF_ASSERTED` level, the protocol does not guarantee model
quality, relay honesty, input confidentiality from the relay, or fair simultaneous
delivery to both parties. The TEE execution lane (see [Section 11](#11-tee-execution-lane))
aims to remove the need to trust the relay operator through hardware attestation. It is a
prototype, not yet secure, and doesn't provide this today.

**Related documents.** See [API Reference](api-reference.md) for HTTP endpoint details,
[Getting Started](getting-started.md) for an implementation tutorial, and
[Schema Versioning Policy](schema-versioning-policy.md) for schema evolution rules.

---

## 2. Data Model

This section defines every named object in the protocol. Field names are JSON keys
(snake_case). Types are JSON types unless otherwise noted.

### 2.1 Contract

The bilateral agreement submitted to the relay. The relay identifies it by its
**contract hash v2** (`SHA256_JCS_V2`, see [Section 6.3](#63-contract-hash-v2)),
computed from the contract JSON as received. Members outside the table below
(including a `contract_hash` member) make the contract invalid. Optional members
that are absent or `null` are omitted from the hash.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `purpose_code` | string enum | yes | Session purpose. Values: `COMPATIBILITY`, `MEDIATION`, `SCHEDULING`. A relay advertises its supported set via `GET /capabilities`. |
| `output_schema_id` | string | yes | Human-readable schema identifier (e.g., `vcav_e_compatibility_signal_v2`). |
| `output_schema` | object (JSON Schema) | yes | Inline JSON Schema. The relay validates the model output against this at runtime. |
| `participants` | array of string | yes | Exactly 2 participant identifiers. |
| `prompt_template_hash` | string (64 hex) | yes | SHA-256 of the canonical prompt program JSON. |
| `entropy_budget_bits` | integer | no | Upper bound on output information content (bits). |
| `timing_class` | string | no | Reserved for future use. |
| `metadata` | any JSON | no | Opaque value. Included in the contract hash. |
| `model_profile_id` | string | no | References a content-addressed model profile on the relay. |
| `model_profile_hash` | string | no | Hash of the model profile. |
| `enforcement_policy_hash` | string | no | Selects the relay enforcement policy. |
| `output_schema_hash` | string | no | SHA-256(JCS(output_schema)); selects a registry schema. |
| `model_constraints` | object | no | `{allowed_providers?, allowed_models?, min_tier?}`; no other members. |
| `max_completion_tokens` | integer | no | Per-session completion token limit (at most the relay ceiling). |
| `session_ttl_secs` | integer | no | Session lifetime (at most the relay maximum). |
| `invite_ttl_secs` | integer | no | Invite lifetime (at most the relay maximum). |
| `entropy_enforcement` | string enum | no | `Advisory`, `Gate` or `Strict`. Default `Gate` (Section 10.3). |
| `relay_verifying_key_hex` | string (64 hex) | no | Pins the relay key that must execute the session. |

Integer members are plain JSON integers (`8`, never `8.0` or `8e0`). Numbers
anywhere in the contract, including `output_schema` and `metadata`, MUST be within
±(2^53−1).

### 2.2 Input Envelope

A single participant's submission to the relay.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `role` | string | yes | Must match one of `contract.participants`. |
| `context` | object | yes | Arbitrary JSON. Opaque to the relay. Numbers MUST be within ±(2^53−1). |
| `expected_contract_hash` | string (64 hex) or null | no | If provided, the relay rejects the input if the session's contract hash (v2) does not match, so the input is only used under the contract the submitter expects. |
| `commitment_nonce` | string (64 lowercase hex) | **yes** | Fresh 32-byte CSPRNG value generated by the submitting client for this submission. Salts the participant's input commitment (Section 2.6). The relay rejects a missing or malformed nonce, never generates one, never writes it to the receipt, logs or responses, and clears it with the input. In `POST /relay` the single caller supplies one nonce per input. |

The client keeps its nonce and exact `context` so it can check its own input
commitment in the receipt. It MUST NOT reuse a nonce, log it, or share it with the
counterparty.

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
| `provider` | string | `"anthropic"`, `"openai"`, or `"gemini"`. |
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

The relay emits **receipt v3** (`receipt_schema_version` `"3.0.0"`) only. v3 organises
fields into two top-level groups: **commitments** (verifiable hashes) and **claims**
(relay assertions). The normative definition, including canonicalisation, input
commitments, contract hash v2 and verifier rules, is `docs/receipt-v3.md` in
vault-family-core; [receipt-verification-guide.md](receipt-verification-guide.md)
summarises it. Every field except `signature` is signed. Optional fields that have no
value are omitted (never `null`), and unknown fields are rejected by verifiers.
Receipts v1 and v2 issued by earlier relays remain verifiable.

**Top-level fields:**

| Field | Type | Description |
|-------|------|-------------|
| `receipt_schema_version` | string | Receipt format version. `"3.0.0"`. |
| `receipt_canonicalization` | string | `"JCS_RFC8785"`. |
| `receipt_id` | string (UUID) | Unique receipt identifier. |
| `session_id` | string | Session identifier. |
| `issued_at` | string | When the receipt was signed, UTC, exactly `YYYY-MM-DDTHH:MM:SSZ`. |
| `assurance_level` | string enum | `SELF_ASSERTED`, `OPERATOR_AUDITED`, `PROVIDER_ATTESTED`, or `TEE_ATTESTED`. |
| `operator` | object | `{operator_id, operator_key_fingerprint, operator_key_discovery?}`. `operator_key_fingerprint` = SHA-256 of the 32-byte signing public key. |
| `commitments` | object | Independently verifiable hashes. See below. |
| `claims` | object | Relay assertions; not independently verifiable. See below. |
| `signature` | object | `{alg: "Ed25519", value, signed_fields: "ALL_EXCEPT_SIGNATURE"}`, `value` base64url without padding. Not signed. |

**Commitments** (verifiable by whoever holds the corresponding artefact; `JCS` is
RFC 8785 with numbers limited to ±(2^53−1)):

| Field | Type | Description |
|-------|------|-------------|
| `contract_hash` | string (64 hex) | Contract hash v2 (Section 6.3). |
| `contract_hash_alg` | string | `"SHA256_JCS_V2"`. |
| `schema_hash` | string (64 hex) | SHA-256(JCS(output_schema)) of the schema the relay enforced. |
| `output_hash` | string (64 hex) | SHA-256(JCS(output)); SHA-256 of zero bytes when no output was accepted. |
| `output` | any JSON, optional | Inline bounded output (convenience). Absent on failure receipts. |
| `input_commitments` | array | One `{participant_id, input_commitment, scheme: "SHA256_N32_JCS_V3"}` per participant, in `contract.participants` order, where `input_commitment = SHA-256("VCAV-INPUT-COMMIT-V3:" ‖ nonce (32 raw bytes) ‖ JCS(context))`. The submitting participant can open its entry with its nonce; the counterparty never receives the nonce and can't. The relay also receives the nonce, with the input, and clears it with the input. |
| `prompt_assembly_version` | string | Prompt assembler version (e.g., `"1.0.0"`). |
| `prompt_template_hash` | string (64 hex), optional | Equals `contract.prompt_template_hash`. |
| `effective_config_hash` | string (64 hex), optional | SHA-256(JCS(preflight_bundle)). |
| `preflight_bundle` | object, optional | `{policy_hash, prompt_template_hash, model_profile_hash, schema_hash, enforcement_parameters}`. |

Receipt field privacy (receipt v3 specification, section 8): values derived from a
participant's input appear in a receipt only through `input_commitments`. No field
holds an unsalted hash of an input, of the assembled prompt or of output that was not
released; `output_hash` covers only released output. v3 therefore has no
`assembled_prompt_hash` or `rejected_output_hash` (v2 fields).

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
| `status` | string or null | Session outcome status. |
| `signal_class` | string or null | Classification of the signal produced. `SINGLE_CALLER_COMPLETED` when one request supplied both inputs (`POST /relay`). `SESSION_COMPLETED` means the two inputs arrived through the session's two role-scoped submit tokens. The relay does not attest who held those tokens: `POST /sessions` returns all four tokens to the creator, so one caller can produce it. Only the inbox lane binds tokens to registry-authenticated agents. |
| `execution_lane` | string enum or null | `standard` (software relay) or `tee` (TEE execution). |
| `channel_capacity_bits_upper_bound` | integer or null | Computed upper bound on the output schema's information capacity (bits). |
| `channel_capacity_measurement_version` | string or null | Algorithm version used to compute the channel capacity bound (e.g., `"enum_cardinality_v1"`). |
| `entropy_budget_bits` | integer or null | Budget declared in the contract. |
| `schema_entropy_ceiling_bits` | integer or null | Schema-level entropy ceiling. |
| `budget_usage` | object, optional | `{scope: "SESSION", bits_used_before: 0, bits_used_after, budget_limit}`. Figures cover this session only. |

Claims are optional and omitted when they have no value.

**TEE attestation** (top-level `tee_attestation` object, present on receipts from the
`selkey-tee` relay, which also sets `execution_lane` to `tee`; every member is optional):

| Field | Type | Description |
|-------|------|-------------|
| `tee_type` | string enum | `Simulated` (testing; the receipt is then `SELF_ASSERTED`) or `SEV-SNP` (AMD SEV-SNP hardware). The type also allows `SGX`, `TDX` and `TrustZone`, which no relay produces. |
| `measurement` | string (hex) | Launch measurement from the attestation report. |
| `quote` | string (base64) | The raw attestation report. |
| `attestation_hash` | string (64 hex) | SHA-256 of the raw attestation report bytes. |
| `receipt_signing_pubkey_hex` | string (64 hex) | Ed25519 public key used to sign the receipt, bound into the TEE attestation. Verifiers MUST NOT use it as the verification key; if present it must equal the pinned key (Section 7.4). The selkey-tee `tee-verifier` checks it against the caller's pinned key (see 11.3). |
| `transcript_hash_hex` | string (128 hex) | SHA-512 hash of the canonical session transcript. For SEV-SNP, this is embedded in the attestation report's `REPORT_DATA` field. |
| `user_data_hex` | string (128 hex) | The report's `REPORT_DATA` (user data) field. |
| `snp_vcek_cert` | string (base64) | DER VCEK certificate, when the relay obtained it, for checking the report against AMD's certificate chain. |

**TEE commitments** (additional fields in `commitments` on selkey-tee receipts, simulated or hardware):

| Field | Type | Description |
|-------|------|-------------|
| `initiator_submission_hash` | string (64 hex) or null | SHA-256 of the initiator's encrypted submission (ciphertext). |
| `responder_submission_hash` | string (64 hex) or null | SHA-256 of the responder's encrypted submission (ciphertext). |

**Assurance levels:**

| Level | Description |
|-------|-------------|
| `SELF_ASSERTED` | Relay signs its own receipt. No external attestation. Current default. |
| `OPERATOR_AUDITED` | Operator publishes a verifiable audit trail alongside the receipt. |
| `PROVIDER_ATTESTED` | Model provider supplied signed inference metadata bound into the receipt. |
| `TEE_ATTESTED` | Hardware TEE attestation binds the receipt to an enclave measurement (prototype; see 11.4). |

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
   relay generates a session ID and four role-scoped tokens, computes the contract hash
   (v2), and returns all to the initiator. Session state: `CREATED`.
2. **Submit inputs.** Each participant submits their input and a fresh
   `commitment_nonce` via `POST /sessions/:id/input` using their submit token. The first submission transitions state to `PARTIAL`. The
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
`SELKEY_SESSION_TTL_SECS` (default: 600 seconds); expired sessions return 401 for all
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
| `from_agent_pubkey` | string (64 hex) or null | The sender's Ed25519 public key from the relay's agent registry (never a request-supplied value). A hint only: recipients compare it with their own pin for the sender. |
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
enforce the check when provided. The hash is contract hash v2; a relay MUST NOT accept
a contract hash computed any other way.

---

## 6. Content Addressing

All content-addressed hashes in the protocol use the same algorithm: RFC 8785 (JSON
Canonicalization Scheme, JCS) applied to the JSON object, followed by SHA-256 of the
UTF-8 bytes. The result is a lowercase hex string of exactly 64 characters.

Receipt v3 values (outputs, schemas, contracts, input contexts, preflight bundles and
the receipt itself) use RFC 8785 with the v3 input restrictions: numbers with
magnitude above 2^53−1, repeated member names and lone surrogates are rejected.

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
| Contract (full object) | `commitments.contract_hash` | Session creation. Contract hash v2. |
| Effective output schema | `commitments.schema_hash` | Before inference. |
| Prompt program | `commitments.prompt_template_hash` | Before inference. Verified against `contract.prompt_template_hash`. |
| Guardian policy | `commitments.preflight_bundle.policy_hash` | Before inference. The policy selected by `contract.enforcement_policy_hash`, or the relay's default policy, from the policies loaded at startup (lockfile-verified, or admission-verified in registry mode; Section 9.5). |
| Model profile | `commitments.preflight_bundle.model_profile_hash` and `claims.model_profile_hash_asserted` | Before inference. `"none"` in the bundle (and the claim omitted) if the session uses no model profile. |
| Relay git SHA (string) | `claims.runtime_hash_asserted` | Build time. `SHA-256(git_sha_string.as_utf8_bytes())`. |

v1 receipts carried these as top-level `guardian_policy_hash`, `model_profile_hash` and
`runtime_hash`; v2 and v3 receipts use the fields above.

### 6.3 Contract Hash v2

```
contract_hash = SHA-256( JCS( normalise(contract) ) )      // SHA256_JCS_V2
```

`normalise` validates the contract against the member set of Section 2.1 and removes
optional members that are absent or `null`. Nothing is added: an empty array stays
`[]`, an empty object stays `{}`, and no defaults are filled in. A contract with any
other member, including a `contract_hash` member, is rejected rather than stripped.

`normalise` is applied to the contract JSON as received (relay) or as sent (client),
never to a value re-serialised from a typed contract structure.

**Worked example.** These two contracts have the same contract hash v2, because
`null` optional members are treated as absent:

```json
{"purpose_code":"MEDIATION","output_schema_id":"test","output_schema":{"type":"object"},"participants":["alice","bob"],"prompt_template_hash":"aaaa...","timing_class":null,"metadata":null}
```

```json
{"output_schema":{"type":"object"},"output_schema_id":"test","participants":["alice","bob"],"prompt_template_hash":"aaaa...","purpose_code":"MEDIATION"}
```

The hashed (canonical) form of both is the second one, with members in RFC 8785
order. Earlier relays hashed contracts with explicit `null` members (contract hash v1);
v3 relays accept only contract hash v2.

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

Outside development mode the relay refuses to start without a configured key. In
development mode (`SELKEY_ENV=dev`) an unset key is replaced by an ephemeral key per
startup; receipts signed by ephemeral keys cannot be verified after a restart.

The key id of a signing key is `ed25519:` + hex(SHA-256(32-byte public key)). The hex
part is the receipt's `operator.operator_key_fingerprint`.

### 7.2 Signing Procedure

The relay signs a v3 receipt by:

1. Constructing the unsigned receipt (all fields except `signature`), from values
   that already satisfy the v3 format (for example `issued_at` as
   `YYYY-MM-DDTHH:MM:SSZ`).
2. Building `message = "VCAV-RECEIPT-V3:" ‖ JCS(unsigned)` (RFC 8785).
3. Computing `digest = SHA-256(message)` and signing the 32-byte digest with
   Ed25519 (RFC 8032).
4. Setting `signature = {alg: "Ed25519", value: base64url_nopad(sig), signed_fields:
   "ALL_EXCEPT_SIGNATURE"}`.

### 7.3 Wire Format

The receipt is returned as a JSON object in the `receipt` field of `POST /relay`
and `GET /sessions/:id/output` responses, with the signature embedded as the
`signature` member. The relay returns no other receipt fields (earlier relays also
returned `receipt_signature` and `receipt_v2`). Aborted sessions that reached
inference carry a signed failure receipt.

### 7.4 Verification Algorithm

A verifier MUST verify a v3 receipt against a relay key from its own configuration
(pinned), never a key taken from the receipt:

```
function verify_receipt_v3(receipt_text, pinned_key):
    // 1. Strict parse: reject repeated member names, lone surrogates,
    //    trailing content and numbers with magnitude above 2^53-1.
    // 2. Shape: receipt_schema_version == "3.0.0" (other 3.x rejected),
    //    receipt_canonicalization == "JCS_RFC8785", no unknown fields,
    //    no null values, valid enums, hex64 hashes, issued_at format,
    //    contract_hash_alg == "SHA256_JCS_V2", scheme == "SHA256_N32_JCS_V3".
    // 3. Signature:
    //    pinned_key is a canonical prime-order point;
    //    operator.operator_key_fingerprint == SHA-256(pinned_key);
    //    tee_attestation.receipt_signing_pubkey_hex, if present, == pinned_key;
    //    digest = SHA-256("VCAV-RECEIPT-V3:" || JCS(receipt without signature));
    //    strict Ed25519: s < L, R a canonical prime-order point,
    //    cofactorless [s]B == R + [k]A.
    // 4. Consistency: inline output hashes to output_hash; preflight bundle
    //    hashes to effective_config_hash; SESSION scope has bits_used_before 0.
    // 5. Participant checks with data the verifier holds: own input (with its
    //    nonce), received output, contract (contract hash v2, schema hash,
    //    participants, prompt template hash, entropy budget).
```

See [receipt-verification-guide.md](receipt-verification-guide.md) for the details
and the conformance vectors.

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
- The output conforms to the schema identified by `commitments.schema_hash` (derived from the effective output schema bound by the contract).
- The guardian policy identified by `commitments.preflight_bundle.policy_hash` was loaded at startup.
- The prompt program identified by `commitments.prompt_template_hash` was used.
- Each participant's input is bound by a salted commitment in
  `commitments.input_commitments`, which that participant can check with its own
  nonce. The counterparty cannot open it.

**What receipts do not prove:**

- The relay is honest (it could have modified inputs or fabricated output).
- The model identified by `claims.model_identity_asserted` was actually called.
- Either party's inputs were private from the relay.
- The output was delivered simultaneously to both parties.

**Assurance levels** extend what receipts prove beyond `SELF_ASSERTED`. See
[Section 2.6](#26-receipt) for the level definitions. The `TEE_ATTESTED` level is
produced by the `selkey-tee` relay on AMD SEV-SNP hardware; that lane is a prototype,
not yet secure (see Section 11.4). `OPERATOR_AUDITED` and `PROVIDER_ATTESTED` are defined in the
schema but are not yet active in production.

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

The relay loads its enforcement policies at startup: lockfile-verified by default, or
digest-checked by registry admission when `SELKEY_REGISTRY_PATH` is set. Each session uses
the policy selected by `contract.enforcement_policy_hash`, or the relay's default policy
(`SELKEY_DEFAULT_POLICY_HASH` in lockfile mode, required when more than one policy is
loaded; `policies.default` in the admission config in registry mode). The hash of
the policy applied is bound into the receipt as `commitments.preflight_bundle.policy_hash`.
A verifier who obtains the policy file can independently compute the hash and confirm
which rules were active.

---

## 10. Entropy Budget

### 10.1 Purpose

The entropy budget is an upper bound on the number of bits of information the output
can reveal. The relay enforces it when the session or invite is created (Section 10.3;
`Gate` by default). The bound is computed from the output schema structure, not from the
actual output — it is a structural property of the schema.

### 10.2 Computation

The relay computes the entropy upper bound from the output schema:

- **Enum fields:** `ceil(log2(cardinality))` bits. A field with 4 values = 2 bits.
- **Array fields:** If the schema includes the `x-vcav-entropy-bits-upper-bound`
  extension property (see [Appendix A](#appendix-a--schema-extension-properties)), that
  value is used. Otherwise, the bound is derived from the item enum and array constraints.
- **Objects:** Sum of all property entropy bounds.

The result is a conservative upper-bound estimate recorded in the receipt as
`claims.channel_capacity_bits_upper_bound` and `claims.schema_entropy_ceiling_bits`
(v1 receipts used `output_entropy_bits`).

### 10.3 Contract Budget

If `contract.entropy_budget_bits` is set, the relay compares the computed bound against
it when the session or invite is created, before any input is submitted. With
`entropy_enforcement` `Gate` (the default when the field is absent) or `Strict`, a bound
above the budget rejects the contract. With `Advisory`, an overrun is logged only.

Independently of the contract, the relay rejects any schema whose bound exceeds its
per-session cap (`SELKEY_MAX_ENTROPY_BITS_PER_SESSION`, default 64 bits). The contract
cannot raise this cap. `budget_usage.budget_limit` in the receipt is the contract budget
capped by the operator limit, or the operator limit when the contract has no budget.

The `GET /capabilities` endpoint declares the default enforcement level in
`entropy_enforcement` (`"GATE"`).

These limits apply per session only; see the threat model's section on probing across
sessions.

### 10.4 Budget Usage Record

The receipt contains a `budget_usage` object (see [Section 2.6](#26-receipt)) with
`scope: "SESSION"`: the bits accounted to this session (`bits_used_after`) and the
budget it was checked against (`budget_limit`). With session scope `bits_used_before`
is always 0; the figures do not describe a cross-session ledger.

### 10.5 Schema Extension Property

The `x-vcav-entropy-bits-upper-bound` JSON Schema extension property on array fields is
a hint to the entropy calculator. Standard JSON Schema validators ignore unknown
extensions — its presence does not affect schema validation behavior.

---

## 11. TEE Execution Lane

### 11.1 Overview

The protocol defines two execution lanes:

- **Software lane** (`standard`, typically with `assurance_level = SELF_ASSERTED`) — the relay runs as a standard process. The
  operator is trusted not to tamper with inputs or fabricate output.
- **TEE lane** (`tee`; `assurance_level = TEE_ATTESTED` on SEV-SNP hardware, `SELF_ASSERTED`
  on the simulated runtime) — the `selkey-tee` relay is meant to run inside a Trusted
  Execution Environment (AMD SEV-SNP confidential VM), where hardware attestation binds
  the session transcript to the attestation report. The lane aims to remove the need to
  trust the relay operator. It is a prototype, not yet secure, and doesn't do so today
  (see Sections 11.4 and 11.5).

The TEE lane aims to run the same session protocol as the software lane. Today it
implements a subset of it, with its own input API; Section 11.5 lists the differences.

### 11.2 TEE Types

| Value | Description |
|-------|-------------|
| `Simulated` | Software simulation for testing. No hardware isolation or attestation. |
| `SEV-SNP` | AMD SEV-SNP confidential VM. The entire VM is the trust boundary. |

### 11.3 Attestation Binding

When running in the TEE lane, the relay:

1. Uses an Ed25519 signing key generated inside the CVM and sealed to the platform. (The
   simulated runtime also accepts a key from `SELKEY_SIGNING_KEY_HEX`; on SEV-SNP the
   relay refuses one.)
2. Builds a canonical transcript of the session (versioned; currently
   `av-tee-transcript-v3`, a length-prefixed encoding) that commits to the contract hash,
   the prompt template hash, the hashes of both encrypted submissions, the output hash,
   the receipt signing key, the provider-reported model identity and `relay_config_hash`:
   the SHA-256 of the relay's stated configuration (provider, provider base URL, requested
   model, source revision and mode flags such as `simulated`).
3. Computes SHA-512 of the transcript (64 bytes) and embeds it in the SEV-SNP
   attestation report's `REPORT_DATA` field.
4. Signs the receipt with that key.
5. Includes `tee_attestation` in the receipt with the raw report (`quote`), the
   measurement, `attestation_hash`, `receipt_signing_pubkey_hex`,
   `transcript_hash_hex`, `user_data_hex` and, when available, the VCEK certificate.

The raw attestation report travels in the receipt; the relay has no separate attestation
endpoint (`GET /tee/info` returns the TEE type, measurement, platform version, receipt
signing key, `transcript_version` and the plaintext `relay_config` with its
`relay_config_hash`). A verifier checks the AMD signature chain and report fields against
its TCB policy, compares the measurement with an allowlist, recomputes the transcript hash
from the receipt and the relay configuration and confirms that it matches `REPORT_DATA`,
and verifies the receipt signature against a relay key it pinned (Section 7.4). Verifiers
MUST NOT use the key embedded in `tee_attestation` as the verification key: `tee-verifier`
checks the signature against the caller's pinned key (`verify_tee_receipt_pinned`), requires
the embedded key to equal it, and reports a receipt checked only against its embedded key
as `ValidUnpinned`, which it doesn't count as valid. A match shows the report was requested
by code in a CVM with that launch measurement (see 11.4). The relay configuration is
operator-asserted: the measurement doesn't cover the relay code, so the hash shows which
configuration the relay states it used, not which it ran.

### 11.4 Trust Properties

The TEE lane is a prototype, not yet secure. At `TEE_ATTESTED` level, the receipt is
intended to additionally prove:

- The relay binary measurement matches the expected value (CVM launch digest).
- The session transcript (contract, encrypted submissions, output) was not tampered with.
- The signing key was generated inside the CVM and never exposed to the host.

Today these don't fully hold. Without measured boot, the CVM launch measurement does
not cover the relay binary (on a GCP N2D confidential VM it most likely covers only the guest firmware),
so a matching measurement doesn't show which relay code ran, and the other two
properties depend on that code. The shipped `selkey-tee` image runs a simulated runtime
with no hardware attestation. Model identity in the transcript is provider-reported: it
is the model ID returned by the provider's API, and nothing verifies which model ran.

### 11.5 Differences from the Software Lane

This section describes the `selkey-tee` prototype as it is today. Check the
[selkey-tee README](https://github.com/vcav-io/selkey-tee) for its current status.

**Runtime and attestation**

- The default container image is built without SEV-SNP support and runs only the
  simulated runtime (no hardware isolation, `SELF_ASSERTED` receipts), and only when
  `SELKEY_ALLOW_SIMULATED=1` is set. A build with the `snp` feature refuses to start if
  SEV-SNP initialisation fails, unless that variable is set. Check `tee_type` (from
  `GET /tee/info` and in the receipt) and `assurance_level`.
- The launch measurement doesn't cover the relay code (Section 11.4), so the relay
  configuration bound into the transcript is operator-asserted.
- Clients don't yet verify attestation before sending inputs. The Selkey client and MCP
  server don't implement the TEE lane's input API.

**Session API**

- Inputs are encrypted to a per-session key held by the relay (X25519 key agreement and
  AES-256-GCM): `POST /sessions` returns the session public key, and each participant
  submits ciphertext. The relay decrypts the inputs inside the CVM.
- Only the bilateral session flow is available: there is no `POST /relay`, no invites or
  inbox, and no operator token. `POST /sessions` is unauthenticated and has none of the
  software relay's rate or session-count limits.

**Contract handling and enforcement**

- The contract is checked at `POST /sessions`, before any input is submitted; a contract
  the relay can't run as specified is rejected with no session created.
- Only the relay's built-in prompt template is supported (no prompt programs).
- There is no schema registry. Only strict inline output schemas are accepted (closed
  objects, bounded strings, arrays and integers; no `$schema`, `$ref` or composition), and
  the output is validated against them as JSON Schema draft 7.
- The relay computes the schema's entropy upper bound and, when the contract sets
  `entropy_budget_bits`, rejects a schema above it (`Gate` by default; `Advisory` only
  logs). The budget is per session only; nothing accumulates across sessions.
- Fields tee-relay doesn't enforce are rejected rather than ignored: `timing_class`,
  `enforcement_policy_hash`, `model_profile_id`, `model_profile_hash`,
  `model_constraints`, `session_ttl_secs` and `invite_ttl_secs`. No guardian enforcement
  policy is applied, and the session lifetime comes from the relay's configuration.

**Receipts**

- Receipts carry no `preflight_bundle`, `effective_config_hash`, channel capacity,
  entropy or `budget_usage` claims.
- Input commitments use the same salted scheme (`SHA256_N32_JCS_V3`), and the
  commitments add `initiator_submission_hash` and `responder_submission_hash`
  (SHA-256 of each ciphertext).
- Output that the schema rejects gets a failure receipt with status `rejected`.
- The TypeScript `selkey/tee` helper (`packages/selkey-client`) recomputes v1, v2 and v3 transcripts with the same selection rules as the Rust `tee-verifier` (a v3 transcript needs the relay configuration, passed as `relay_config`). It does not verify the attestation quote, so its results are receipt-level only; use the Rust `tee-verifier` for full verification.

**Provider and model**

- Anthropic is the only provider. The provider receives the assembled prompt, including
  both inputs, in plaintext, as in the software lane.
- Model identity is provider-reported. The provider endpoint, requested model and mode
  flags are bound into the transcript through `relay_config_hash` (Section 11.3), but
  only as the relay's own statement.

---

## 12. Artefact Registry

### 12.1 Overview

The relay maintains a content-addressed artefact registry. All governance
artefacts — output schemas, guardian policies, model profiles, and prompt
programs — are registered by their SHA-256(JCS) hash before they can be used
in sessions. Relay admission is **fail-closed**: only registered artefacts are
accepted.

### 12.2 Artefact Kinds

| Kind | Description |
|------|-------------|
| Schemas | JSON Schema definitions for session output. |
| Policies | Guardian enforcement policies (SAFE/RICH compatibility validated). |
| Profiles | Model provider and configuration profiles. |
| Prompt programs | Content-addressed prompt assembly templates. |

### 12.3 Content Addressing

Every artefact is identified by `SHA-256(JCS(artefact_json))`. The registry
stores artefacts by hash and validates that the stored content re-hashes to
the same value on load (integrity check).

### 12.4 Contract Composition

The `selkey-contract` CLI composes contracts from registry artefacts:

- `selkey-contract list` — enumerate registered artefacts by kind.
- `selkey-contract build` — assemble a contract from artefact references.
- `selkey-contract validate` — verify that a contract's artefact references resolve
  and that schema/policy compatibility holds (SAFE/RICH validation).

### 12.5 SAFE/RICH Compatibility

Schemas and policies undergo compatibility validation:

- **SAFE** schemas have constrained output (strict enums, bounded arrays) that
  the guardian policy can fully enforce.
- **RICH** schemas permit wider output ranges and may require advisory-only
  enforcement for some fields.

The registry validates compatibility at registration time, not at session time.

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
