# Receipt Verification Guide

AgentVault relay receipts are signed JSON documents that bind a session's inputs,
outputs, and governance artefacts to a specific relay execution. This guide explains
what receipts prove, how to verify them, and how to interpret the fields they contain.

For full protocol context see [docs/protocol-spec.md](protocol-spec.md).

---

## Contents

1. [Introduction](#1-introduction)
2. [Receipt Versions](#2-receipt-versions)
3. [Verification Algorithm — v1](#3-verification-algorithm--v1)
4. [Verification Algorithm — v2](#4-verification-algorithm--v2)
5. [Receipt Field Reference](#5-receipt-field-reference)
6. [Getting the Verification Key](#6-getting-the-verification-key)
7. [Using the MCP Tool](#7-using-the-mcp-tool)
8. [Common Pitfalls](#8-common-pitfalls)

---

## 1. Introduction

### What is a receipt?

Every AgentVault session produces a signed receipt. The receipt is a JSON document
issued by the relay after execution completes. It records what contract governed
the session, what inputs were committed, what output was produced, and which relay
signed it.

### What do receipts prove?

A valid receipt signature proves:

- The output was produced by a relay holding the corresponding private key.
- The contract, output schema, and prompt template bound into the receipt are the
  exact ones that governed execution (via content hashes).
- The output in the receipt is the output the relay produced — it has not been
  altered after signing.
- The input commitments (participant input hashes) were computed by the same relay
  that signed the receipt.

### What do receipts not prove?

- **Relay honesty.** The relay could have modified inputs before passing them to the
  model or fabricated output without calling a model at all. Receipts prove what the
  relay attests; they do not prove the relay behaved honestly.
- **Model identity.** `claims.model_identity_asserted` is the model ID returned by
  the provider API. The relay asserts it but cannot independently prove it.
- **Input privacy.** The relay receives participant inputs in plaintext. Inputs are
  not encrypted end-to-end. The relay discards raw inputs after receipt construction,
  retaining only commitment hashes.
- **Simultaneous delivery.** Receipts do not prove both parties received the output
  at the same time.

### Assurance level is mandatory context

A receipt signature alone is not a full security guarantee. You must also read
`assurance_level` (v2 receipts) to understand what external evidence backs the
receipt. See [Assurance Levels](#assurance-levels) below.

---

## 2. Receipt Versions

### v1 receipts

v1 receipts have a flat field layout. The `schema_version` field is `"1.0.0"`.
The signature is a hex-encoded string in the `signature` field.

Key signing properties:
- Domain separator: `VCAV-RECEIPT-V1:`
- Signature encoding: hex string (128 characters / 64 bytes)
- Algorithm: Ed25519
- Signed over: SHA-256 of `"VCAV-RECEIPT-V1:" + JCS(receipt_without_signature)`

```json
{
  "schema_version": "1.0.0",
  "session_id": "...",
  "contract_hash": "...",
  "output_schema_hash": "...",
  "output": { "..." : "..." },
  "signature": "a3f2...hex...9d01"
}
```

### v2 receipts

v2 receipts reorganise all fields into two sections — `commitments` (independently
verifiable) and `claims` (relay-asserted). The `receipt_schema_version` field is
`"2.1.0"`. The signature is an object with an `alg` field.

Key signing properties:
- Domain separator: `VCAV-RECEIPT-V2:`
- Signature encoding: base64url string in `signature.value`
- Algorithm: specified in `signature.alg` (Ed25519 is the default for AgentVault)
- Signed over: SHA-256 of `"VCAV-RECEIPT-V2:" + JCS(receipt_without_signature_object)`

```json
{
  "receipt_schema_version": "2.1.0",
  "receipt_canonicalization": "JCS_V1",
  "receipt_id": "...",
  "session_id": "...",
  "assurance_level": "SELF_ASSERTED",
  "operator": { "operator_id": "...", "operator_key_fingerprint": "..." },
  "commitments": { "..." : "..." },
  "claims": { "..." : "..." },
  "signature": {
    "alg": "Ed25519",
    "value": "base64url...",
    "signed_fields": "ALL_EXCEPT_SIGNATURE"
  }
}
```

The domain separator change ensures that a valid v1 signature cannot be
misinterpreted as a valid v2 signature even if the JSON happens to parse under
both schemas.

---

## 3. Verification Algorithm — v1

### Step-by-step

```
1. Parse the receipt JSON into a document object.
2. Extract the `signature` field (hex string). If absent, reject.
3. Remove the `signature` field from the document.
4. JCS-canonicalize the remaining document (RFC 8785).
5. Build the signing message:
      message = "VCAV-RECEIPT-V1:" + canonical_json_string
6. Compute: digest = SHA-256(message)
7. Hex-decode the signature and the verifying key.
8. Verify Ed25519(digest, signature_bytes, public_key_bytes).
```

### TypeScript example

Uses `@noble/curves`, `@noble/hashes`, and `json-canonicalize`.

```typescript
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';

function verifyReceiptV1(
  receipt: Record<string, unknown>,
  publicKeyHex: string,
): boolean {
  // 1. Extract and remove the signature field
  const sigHex = receipt['signature'];
  if (typeof sigHex !== 'string') {
    throw new Error('Missing or non-string signature field');
  }
  const { signature: _removed, ...unsigned } = receipt;

  // 2. JCS-canonicalize
  const canonical = canonicalize(unsigned);

  // 3. Build message and digest
  const message = 'VCAV-RECEIPT-V1:' + canonical;
  const digest = sha256(utf8ToBytes(message));

  // 4. Decode and verify
  const sigBytes = hexToBytes(sigHex);
  const pubKeyBytes = hexToBytes(publicKeyHex);
  return ed25519.verify(sigBytes, digest, pubKeyBytes);
}
```

### Python example

Uses `PyNaCl` and `jcs` (RFC 8785 canonicalization).

```python
import hashlib
import binascii
import jcs  # pip install jcs
import nacl.signing  # pip install pynacl


def verify_receipt_v1(receipt: dict, public_key_hex: str) -> bool:
    # 1. Extract and remove the signature field
    sig_hex = receipt.get('signature')
    if not isinstance(sig_hex, str):
        raise ValueError('Missing or non-string signature field')
    unsigned = {k: v for k, v in receipt.items() if k != 'signature'}

    # 2. JCS-canonicalize (RFC 8785)
    canonical_bytes = jcs.canonicalize(unsigned)  # returns bytes

    # 3. Build message and digest
    message = b'VCAV-RECEIPT-V1:' + canonical_bytes
    digest = hashlib.sha256(message).digest()

    # 4. Decode and verify
    sig_bytes = binascii.unhexlify(sig_hex)
    pub_key_bytes = binascii.unhexlify(public_key_hex)
    verify_key = nacl.signing.VerifyKey(pub_key_bytes)
    try:
        verify_key.verify(digest, sig_bytes)
        return True
    except nacl.exceptions.BadSignatureError:
        return False
```

---

## 4. Verification Algorithm — v2

### Step-by-step

```
1. Parse the receipt JSON.
2. Check receipt_canonicalization == "JCS_V1". Reject any other value.
3. Extract the `signature` object. If absent or not an object, reject.
4. Read signature.alg. Currently only "Ed25519" is supported.
5. Remove the entire `signature` object from the document.
6. JCS-canonicalize the remaining document (RFC 8785).
7. Build the signing message:
      message = "VCAV-RECEIPT-V2:" + canonical_json_string
8. Compute: digest = SHA-256(message)
9. Base64url-decode signature.value.
10. Hex-decode the verifying key.
11. Verify Ed25519(digest, signature_bytes, public_key_bytes).
```

After signature verification, you may optionally verify commitments if you hold
the original artefacts — see [Commitment Verification](#commitment-verification) below.

### TypeScript example

```typescript
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function verifyReceiptV2(
  receipt: Record<string, unknown>,
  publicKeyHex: string,
): boolean {
  // 1. Check canonicalization marker
  if (receipt['receipt_canonicalization'] !== 'JCS_V1') {
    throw new Error('Unsupported receipt_canonicalization');
  }

  // 2. Extract the signature object
  const sigObj = receipt['signature'];
  if (typeof sigObj !== 'object' || sigObj === null) {
    throw new Error('Missing or invalid signature object');
  }
  const sig = sigObj as Record<string, unknown>;

  if (sig['alg'] !== 'Ed25519') {
    throw new Error(`Unsupported signature algorithm: ${String(sig['alg'])}`);
  }
  const sigValue = sig['value'];
  if (typeof sigValue !== 'string') {
    throw new Error('signature.value must be a string');
  }

  // 3. Remove the signature object
  const { signature: _removed, ...unsigned } = receipt;

  // 4. JCS-canonicalize
  const canonical = canonicalize(unsigned);

  // 5. Build message and digest
  const message = 'VCAV-RECEIPT-V2:' + canonical;
  const digest = sha256(utf8ToBytes(message));

  // 6. Decode and verify
  const sigBytes = base64urlToBytes(sigValue);
  const pubKeyBytes = hexToBytes(publicKeyHex);
  return ed25519.verify(sigBytes, digest, pubKeyBytes);
}
```

### Python example

```python
import hashlib
import binascii
import base64
import jcs
import nacl.signing


def base64url_decode(s: str) -> bytes:
    # Add padding if needed
    remainder = len(s) % 4
    if remainder:
        s += '=' * (4 - remainder)
    return base64.urlsafe_b64decode(s)


def verify_receipt_v2(receipt: dict, public_key_hex: str) -> bool:
    # 1. Check canonicalization marker
    if receipt.get('receipt_canonicalization') != 'JCS_V1':
        raise ValueError('Unsupported receipt_canonicalization')

    # 2. Extract the signature object
    sig_obj = receipt.get('signature')
    if not isinstance(sig_obj, dict):
        raise ValueError('Missing or invalid signature object')

    alg = sig_obj.get('alg')
    if alg != 'Ed25519':
        raise ValueError(f'Unsupported signature algorithm: {alg}')
    sig_value = sig_obj.get('value')
    if not isinstance(sig_value, str):
        raise ValueError('signature.value must be a string')

    # 3. Remove the signature object
    unsigned = {k: v for k, v in receipt.items() if k != 'signature'}

    # 4. JCS-canonicalize
    canonical_bytes = jcs.canonicalize(unsigned)

    # 5. Build message and digest
    message = b'VCAV-RECEIPT-V2:' + canonical_bytes
    digest = hashlib.sha256(message).digest()

    # 6. Decode and verify
    sig_bytes = base64url_decode(sig_value)
    pub_key_bytes = binascii.unhexlify(public_key_hex)
    verify_key = nacl.signing.VerifyKey(pub_key_bytes)
    try:
        verify_key.verify(digest, sig_bytes)
        return True
    except nacl.exceptions.BadSignatureError:
        return False
```

### Commitment verification

After verifying the signature, you can optionally verify individual commitments
if you hold the original artefacts. Commitment verification is independent of
signature verification — it checks that the hashes in the receipt match the
source documents.

```typescript
import { canonicalize } from 'json-canonicalize';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';

function sha256hex(data: string): string {
  return bytesToHex(sha256(utf8ToBytes(data)));
}

// Recompute contract_hash and compare to commitments.contract_hash
function verifyContractHash(
  contract: Record<string, unknown>,
  receipt: Record<string, unknown>,
): boolean {
  const canonical = canonicalize(contract);
  const computed = sha256hex(canonical);
  const commitments = receipt['commitments'] as Record<string, unknown>;
  return computed === commitments['contract_hash'];
}

// Recompute output_hash from inline output and compare
function verifyOutputHash(
  output: Record<string, unknown>,
  receipt: Record<string, unknown>,
): boolean {
  const canonical = canonicalize(output);
  const computed = sha256hex(canonical);
  const commitments = receipt['commitments'] as Record<string, unknown>;
  return computed === commitments['output_hash'];
}

// Verify a participant's input commitment
function verifyInputCommitment(
  participantId: string,
  participantInput: Record<string, unknown>,
  receipt: Record<string, unknown>,
): boolean {
  const canonical = canonicalize(participantInput);
  const computed = sha256hex(canonical);
  const commitments = receipt['commitments'] as Record<string, unknown>;
  const inputCommitments = commitments['input_commitments'] as Array<Record<string, unknown>>;
  const entry = inputCommitments.find((ic) => ic['participant_id'] === participantId);
  if (!entry) return false;
  return computed === entry['input_hash'];
}
```

---

## 5. Receipt Field Reference

### v2 top-level fields

| Field | Type | Description |
|---|---|---|
| `receipt_schema_version` | string | Always `"2.1.0"` for v2 receipts |
| `receipt_canonicalization` | string | Always `"JCS_V1"` |
| `receipt_id` | string (UUID) | Unique receipt identifier |
| `session_id` | string (UUID) | Session this receipt covers |
| `issued_at` | string (ISO 8601) | Timestamp the relay signed the receipt |
| `assurance_level` | string | See [Assurance Levels](#assurance-levels) |
| `operator` | object | Relay operator identity |
| `commitments` | object | Independently verifiable hashes |
| `claims` | object | Relay-asserted, not independently verifiable |
| `provider_attestation` | object? | Provider-signed inference metadata (optional) |
| `tee_attestation` | object? | TEE hardware attestation (optional) |
| `signature` | object | Receipt signature |

### Commitments section

All fields in `commitments` are independently verifiable — a third party with
access to the original inputs can recompute them.

| Field | How to verify |
|---|---|
| `contract_hash` | Recompute SHA-256(JCS(contract_document)) |
| `schema_hash` | Recompute SHA-256(JCS(output_schema)) |
| `output_hash` | Recompute SHA-256(JCS(output)) |
| `input_commitments[]` | Each participant recomputes SHA-256(JCS(own_input)) |
| `assembled_prompt_hash` | Recompute SHA-256(assembled_prompt_bytes) — requires the relay's prompt assembly implementation |
| `prompt_template_hash` | Recompute SHA-256(prompt_template_bytes) |
| `effective_config_hash` | Recompute SHA-256(JCS(preflight_bundle)) |
| `preflight_bundle.*` | Hash each constituent artefact independently |

The `output` field inside `commitments` is an inline convenience copy of the
session output. When present, verifiers must check that
SHA-256(JCS(commitments.output)) matches `commitments.output_hash`.

### Claims section

All fields in `claims` are relay-asserted. The relay includes them as a service
to consumers, but a third party cannot independently verify them without additional
attestation infrastructure.

| Field | Meaning |
|---|---|
| `model_identity_asserted` | Model ID returned by the provider API |
| `model_identity_attested` | Model ID from provider-signed metadata (requires `provider_attestation`) |
| `model_profile_hash_asserted` | Hash of the model profile document used |
| `runtime_hash_asserted` | SHA-256 of the relay software build |
| `runtime_hash_attested` | Same, TEE-attested (requires `tee_attestation`) |
| `budget_enforcement_mode` | How token/entropy budget was enforced: `enforced`, `advisory`, `disabled` |
| `provider_latency_ms` | Wall-clock time for the provider API call |
| `token_usage` | Prompt, completion, and total token counts |
| `relay_software_version` | Semver of the relay that issued the receipt |
| `status` | Session outcome status |
| `signal_class` | Classification of the signal produced |
| `execution_lane` | `standard` (software) or `tee` (TEE) |
| `channel_capacity_bits_upper_bound` | Computed upper bound on schema information capacity (bits) |
| `channel_capacity_measurement_version` | Algorithm version for capacity computation (e.g., `"enum_cardinality_v1"`) |
| `entropy_budget_bits` | Budget declared in the contract |
| `schema_entropy_ceiling_bits` | Schema-level entropy ceiling |
| `budget_usage` | `{pair_id, bits_used_before, bits_used_after, budget_limit, enforcement_tier}` |

### TEE attestation fields

Present when `claims.execution_lane` is `tee`. The `tee_attestation`
object is a top-level receipt field alongside `commitments` and `claims`.

| Field | Meaning |
|---|---|
| `tee_type` | `Simulated` (testing) or `SevSnp` (AMD SEV-SNP hardware) |
| `attestation_hash` | SHA-256 of the platform attestation report |
| `receipt_signing_pubkey_hex` | Ed25519 public key bound into the TEE attestation |
| `transcript_hash_hex` | SHA-512 of the canonical session transcript (embedded in SEV-SNP `user_data`) |

TEE commitments add `initiator_submission_hash` and `responder_submission_hash` to
the `commitments` object, binding each participant's raw submission into the
attestation chain.

### Assurance levels

The `assurance_level` field is required in v2 receipts and describes the strength
of external evidence backing the receipt.

| Value | Meaning |
|---|---|
| `SELF_ASSERTED` | The relay signs its own receipt. No external attestation. Claims are relay assertions only. |
| `OPERATOR_AUDITED` | The operator publishes a verifiable audit trail. Claims can be cross-checked against the audit log. |
| `PROVIDER_ATTESTED` | The model provider supplied signed inference metadata. `claims.model_identity_attested` can be trusted. |
| `TEE_ATTESTED` | Hardware TEE attestation (AMD SEV-SNP) binds the receipt to the CVM measurement. The relay binary, signing key, and session transcript are hardware-verified. Operational via `av-tee` relay. |

The software relay operates at `SELF_ASSERTED`. The TEE relay (`av-tee`) operates
at `TEE_ATTESTED` on AMD SEV-SNP hardware (validated on GCP N2D instances).
Never display "receipt verified" without also showing the assurance level — a
`SELF_ASSERTED` receipt is much weaker than a `TEE_ATTESTED` one.

### Operator identity

```json
{
  "operator_id": "relay.agentvault.dev",
  "operator_key_fingerprint": "abcd1234...",
  "operator_key_discovery": "https://relay.agentvault.dev/.well-known/av-keys.json"
}
```

`operator_key_fingerprint` is the SHA-256 hex digest of the raw 32-byte public key.
`operator_key_discovery` is an optional URI where the operator publishes their
canonical key for pinning — not present in self-asserted deployments.

### Signature object (v2)

```json
{
  "alg": "Ed25519",
  "value": "base64url-encoded-64-bytes",
  "signed_fields": "ALL_EXCEPT_SIGNATURE"
}
```

`signed_fields: "ALL_EXCEPT_SIGNATURE"` indicates that every field in the receipt
except the `signature` object itself is covered by the signature. This is the only
value currently issued.

---

## 6. Getting the Verification Key

### From the relay /health endpoint

The relay exposes its Ed25519 verifying key at the `/health` endpoint:

```
GET http://localhost:4840/health
```

```json
{
  "status": "ok",
  "version": "0.8.0",
  "verifying_key_hex": "a3f2...64-hex-chars...9d01"
}
```

`verifying_key_hex` is 64 hex characters (32 bytes), the raw Ed25519 public key.

### Key pinning considerations

In the current `SELF_ASSERTED` implementation, the key in `/health` is the relay's
self-reported key. There is no external certificate authority binding the key to
the operator identity.

For production use, consider:

1. **Fetch the key once and pin it.** Do not re-fetch the key on each verification
   — a compromised relay could swap keys mid-session.
2. **Record the key alongside the receipt.** Store `verifying_key_hex` at session
   time so you can verify the receipt offline later.
3. **Use `operator_key_fingerprint` (v2) as a consistency check.** After fetching
   the key, compute SHA-256 of the 32-byte key and compare to
   `receipt.operator.operator_key_fingerprint`. A mismatch means the key you
   fetched does not match the key embedded in the receipt.

```typescript
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

function checkKeyFingerprint(
  publicKeyHex: string,
  receipt: Record<string, unknown>,
): boolean {
  const keyBytes = hexToBytes(publicKeyHex);
  const fingerprint = bytesToHex(sha256(keyBytes));
  const operator = receipt['operator'] as Record<string, unknown>;
  return fingerprint === operator['operator_key_fingerprint'];
}
```

---

## 7. Using the MCP Tool

The `agentvault-mcp-server` package exposes an `agentvault.verify_receipt` tool
that wraps the verification logic described above.

### Tool signature

```typescript
{
  "name": "agentvault.verify_receipt",
  "arguments": {
    "receipt": { /* receipt JSON object */ },
    "public_key_hex": "a3f2...optional...",  // omit to fetch from relay
    "relay_url": "http://localhost:4840"      // default if public_key_hex omitted
  }
}
```

If `public_key_hex` is omitted, the tool fetches it from `relay_url/health`.
Pass `public_key_hex` explicitly when verifying offline or when you have pinned
the key.

### Tool output

```typescript
{
  "valid": true,
  "schema_version": "2.1.0",
  "assurance_level": "SELF_ASSERTED",    // v2 only
  "operator_id": "relay.agentvault.dev", // v2 only
  "errors": [],
  "warnings": []
}
```

`valid: true` means the Ed25519 signature verified. It does not mean commitments
were verified — that requires the caller to hold the original artefacts.

### Example MCP invocation

```json
{
  "tool": "agentvault.verify_receipt",
  "arguments": {
    "receipt": {
      "receipt_schema_version": "2.1.0",
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
        "input_commitments": [],
        "assembled_prompt_hash": "...",
        "prompt_assembly_version": "1.0.0"
      },
      "claims": {},
      "signature": {
        "alg": "Ed25519",
        "value": "base64url...",
        "signed_fields": "ALL_EXCEPT_SIGNATURE"
      }
    },
    "public_key_hex": "a3f2...64-hex..."
  }
}
```

---

## 8. Common Pitfalls

### Use JCS (RFC 8785), not pretty-print or JSON.stringify

The verification algorithm requires JCS canonicalization. Standard JSON serializers
do not sort object keys deterministically. Using `JSON.stringify` or pretty-print
JSON will produce a different byte sequence and signature verification will fail.

Correct libraries:
- TypeScript / JavaScript: `json-canonicalize` (npm)
- Python: `jcs` (pip), or `canonicaljson`
- Go: `github.com/cyberphone/json-canonicalization`
- Rust: canonicalization wrapper over `serde_json` with deterministic key ordering
  (as in `receipt-core::canonicalize`)

### Strip the correct field before canonicalization

For v1, strip the `signature` string field.
For v2, strip the entire `signature` object — including `alg`, `value`, and
`signed_fields`. Leaving any part of the signature object in the document will
produce a different canonical form and verification will fail.

```typescript
// v1 — strip the string field
const { signature: _removed, ...unsigned } = receiptV1;

// v2 — strip the entire object
const { signature: _removed, ...unsigned } = receiptV2;
```

### Domain separator must be exact (including the colon)

The domain separator is prepended to the canonical JSON as a plain string — no
null byte, no length prefix, no newline. The colon is part of the separator.

```
v1: "VCAV-RECEIPT-V1:" + canonical_json_string
v2: "VCAV-RECEIPT-V2:" + canonical_json_string
```

A missing colon or trailing whitespace will produce a different digest.

### Ed25519 signs the SHA-256 hash, not the canonical bytes directly

The relay does not sign the canonical bytes directly. It signs the SHA-256 hash
of the full signing message (domain separator + canonical JSON). Verify against
the hash, not the raw message.

```typescript
// Correct — verify over the SHA-256 digest
const message = 'VCAV-RECEIPT-V1:' + canonical;
const digest = sha256(utf8ToBytes(message));
ed25519.verify(sigBytes, digest, pubKeyBytes);

// Wrong — will always fail; do not pass raw message bytes
ed25519.verify(sigBytes, utf8ToBytes(message), pubKeyBytes);
```

### Version dispatch is required

Never assume a receipt version. Always read `receipt_schema_version` (v2) or
`schema_version` (v1) and dispatch to the correct verification path. Applying v1
verification to a v2 receipt will fail because v2's `signature` field is an
object, not a string, and the domain separator is different.

Verifiers must reject receipts with unknown versions (fail-closed).

### v2: base64url encoding, not standard base64

`signature.value` in v2 receipts is base64url-encoded (URL-safe alphabet, no
padding). Standard base64 decoders may fail on the `-` and `_` characters.
Use a base64url decoder, or replace `-` with `+` and `_` with `/` before
passing to a standard base64 decoder, then add the correct padding.

### Signature verifies the receipt as issued — check assurance level separately

A valid signature only proves the receipt was not tampered with after the relay
signed it. It does not prove the relay was honest during execution. Always
communicate the `assurance_level` alongside any "verified" status.
