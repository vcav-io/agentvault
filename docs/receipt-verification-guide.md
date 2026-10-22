# Receipt Verification Guide

Selkey relay receipts are signed JSON documents that bind a session's inputs,
outputs, and governance artefacts to a specific relay execution. This guide explains
what receipts prove, how to verify them, and how to interpret the fields they contain.

The relay emits **receipt v3** (`receipt_schema_version: "3.0.0"`). The normative
specification of v3 (format, canonicalisation, input commitments, contract hash v2
and verifier rules) is `docs/receipt-v3.md` in
[vault-family-core](https://github.com/vcav-io/vault-family-core), with golden
test vectors in its `data/test-vectors/`. This guide summarises it for
integrators; where they differ, the specification wins. v1 and v2 receipts
issued by older relays remain verifiable (Sections 3 and 4).

For full protocol context see [docs/protocol-spec.md](protocol-spec.md).

---

## Contents

1. [Introduction](#1-introduction)
2. [Receipt Versions](#2-receipt-versions)
3. [Verification Algorithm — v3](#3-verification-algorithm--v3)
4. [Legacy Verification — v1 and v2](#4-legacy-verification--v1-and-v2)
5. [Receipt Field Reference](#5-receipt-field-reference)
6. [Getting the Verification Key](#6-getting-the-verification-key)
7. [Using the MCP Tool](#7-using-the-mcp-tool)
8. [Common Pitfalls](#8-common-pitfalls)

---

## 1. Introduction

### What is a receipt?

Every Selkey session produces a signed receipt. The receipt is a JSON document
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
- The input commitments were computed by the same relay that signed the receipt.
  Each participant can check its own commitment against the input and nonce it
  submitted (see [Own-input check](#own-input-check)).

### What do receipts not prove?

- **Relay honesty.** The relay could have modified inputs before passing them to the
  model or fabricated output without calling a model at all. Receipts prove what the
  relay attests; they do not prove the relay behaved honestly.
- **Model identity.** `claims.model_identity_asserted` is the model ID returned by
  the provider API. The relay asserts it but cannot independently prove it.
- **Input privacy from the relay.** The relay receives participant inputs in
  plaintext. Inputs are not encrypted end-to-end. The relay discards raw inputs
  (and their commitment nonces) after receipt construction, retaining only the
  commitments.
- **Input privacy in the receipt.** Values derived from a participant's input appear
  in a v3 receipt only through the salted input commitments: no field holds an
  unsalted hash of an input, of the assembled prompt or of output that was not
  released (receipt v3 specification, section 8). Each commitment is salted with a
  secret per-submission nonce chosen by that participant, so a party holding the
  receipt cannot test guesses of the other party's input against it. The released
  output itself is derived from both inputs, as the contract intends.
- **Simultaneous delivery.** Receipts do not prove both parties received the output
  at the same time.

### Assurance level is mandatory context

A receipt signature alone is not a full security guarantee. You must also read
`assurance_level` (v2 and v3 receipts) to understand what external evidence backs the
receipt. See [Assurance Levels](#assurance-levels) below.

---

## 2. Receipt Versions

### v3 receipts (current)

v3 keeps the v2 layout (`operator`, `commitments`, `claims`, `signature`) and
changes how every hashed or signed value is encoded:

| Area | v2 | v3 |
|---|---|---|
| `receipt_schema_version` | `2.x.y` | `3.0.0` |
| `receipt_canonicalization` | `JCS_V1` (legacy canonicaliser) | `JCS_RFC8785` (RFC 8785, numbers limited to ±(2^53−1)) |
| Domain separator | `VCAV-RECEIPT-V2:` | `VCAV-RECEIPT-V3:` |
| Ed25519 verification | permissive | strict (prime-order key and `R`, `s < L`, cofactorless) |
| Input commitment | `SHA-256(JCS(context))` | `SHA-256("VCAV-INPUT-COMMIT-V3:" ‖ nonce ‖ JCS(context))` |
| Input commitment entry | `{participant_id, input_hash, hash_alg, canonicalization}` | `{participant_id, input_commitment, scheme: "SHA256_N32_JCS_V3"}` |
| Contract hash | v1 (typed struct, absent optionals as `null`) | v2 (`contract_hash_alg: "SHA256_JCS_V2"`, see [Contract hash v2](#contract-hash-v2)) |
| `issued_at` | any RFC 3339 form | exactly `YYYY-MM-DDTHH:MM:SSZ` |
| `claims.budget_usage` | no scope | required `scope: "SESSION"`, `bits_used_before: 0` |
| Unknown fields, `null` optionals | tolerated by some verifiers | rejected |

```json
{
  "receipt_schema_version": "3.0.0",
  "receipt_canonicalization": "JCS_RFC8785",
  "receipt_id": "...",
  "session_id": "...",
  "issued_at": "2026-10-22T12:00:00Z",
  "assurance_level": "SELF_ASSERTED",
  "operator": { "operator_id": "...", "operator_key_fingerprint": "..." },
  "commitments": {
    "contract_hash": "...",
    "contract_hash_alg": "SHA256_JCS_V2",
    "input_commitments": [
      { "participant_id": "alice", "input_commitment": "...", "scheme": "SHA256_N32_JCS_V3" },
      { "participant_id": "bob", "input_commitment": "...", "scheme": "SHA256_N32_JCS_V3" }
    ],
    "...": "..."
  },
  "claims": { "budget_usage": { "scope": "SESSION", "bits_used_before": 0, "...": "..." } },
  "signature": {
    "alg": "Ed25519",
    "value": "base64url, no padding (86 characters)",
    "signed_fields": "ALL_EXCEPT_SIGNATURE"
  }
}
```

The relay returns the receipt as `receipt` in `POST /relay` and
`GET /sessions/:id/output` responses. Older relays also returned `receipt_signature`
and `receipt_v2`; a v3 relay does not.

### v1 receipts (legacy)

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

### v2 receipts (legacy)

v2 receipts reorganise all fields into two sections — `commitments` (independently
verifiable) and `claims` (relay-asserted). The `receipt_schema_version` field is
`"2.1.0"`. The signature is an object with an `alg` field.

Key signing properties:
- Domain separator: `VCAV-RECEIPT-V2:`
- Signature encoding: base64url string in `signature.value`
- Algorithm: specified in `signature.alg` (Ed25519 is the default for Selkey)
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

The domain separators differ per version, so a valid signature for one version
cannot be read as a valid signature for another, even if the JSON happens to
parse under both schemas.

---

## 3. Verification Algorithm — v3

### Step-by-step

Apply these rules in order and reject the receipt at the first failure
(specification Section 6).

```
1. Dispatch: read receipt_schema_version from the strictly parsed document.
   "3.0.0" -> v3. Any other "3.x" -> reject. "2.x" -> v2 rules. "1.0.0" -> v1.
   Anything else -> reject.
2. Parse and shape:
   - parse the JSON text strictly: reject repeated member names at any depth,
     lone UTF-16 surrogates and trailing content;
   - reject any number with magnitude above 2^53-1;
   - check the v3 shape: required fields present, no unknown fields, no null
     for defined fields, known enum values, receipt_canonicalization ==
     "JCS_RFC8785", contract_hash_alg == "SHA256_JCS_V2", every scheme ==
     "SHA256_N32_JCS_V3", hashes are 64 lowercase hex characters, issued_at is
     YYYY-MM-DDTHH:MM:SSZ, participant_ids unique and non-empty, integer fields
     written as plain integers (no 8.0, 8e0 or -0).
   Evaluate everything below on the validated receipt, never on the raw input.
3. Signature:
   - signature.alg == "Ed25519", signature.signed_fields == "ALL_EXCEPT_SIGNATURE",
     signature.value is canonical base64url without padding, 64 bytes;
   - the verifying key is the PINNED relay key from your configuration, never a key
     taken from the receipt; if tee_attestation.receipt_signing_pubkey_hex is
     present it must equal the pinned key;
   - the pinned key must be a canonical encoding of a prime-order point
     (not small order, no torsion component);
   - operator.operator_key_fingerprint == SHA-256(pinned key bytes) (hex);
   - unsigned  = receipt without the "signature" member
     message   = "VCAV-RECEIPT-V3:" || JCS_RFC8785(unsigned)
     digest    = SHA-256(message)
     verify the Ed25519 signature (R, s) over digest with: s < L, R a canonical
     prime-order point, and the cofactorless equation [s]B = R + [k]A.
4. Internal consistency:
   - if commitments.output is present: output_hash == SHA-256(JCS(output));
   - if preflight_bundle and effective_config_hash are both present:
     effective_config_hash == SHA-256(JCS(preflight_bundle));
   - budget_usage.scope == "SESSION" requires bits_used_before == 0.
5. Participant checks (when you hold the data):
   - own input: see "Own-input check";
   - output: output_hash == SHA-256(JCS(output you received)), and an inline
     commitments.output must equal it (compare JCS bytes);
   - contract: see "Contract check".
```

Steps 1 to 4 make the signature check meaningful; step 5 is what ties the
receipt to *your* session.

### Implementations

- **TypeScript:** `verifyReceipt` from `selkey/verify` (the `selkey-client`
  package) implements v3 including strict Ed25519, the strict parser and the
  participant checks. Prefer it over hand-written code.
- **Rust:** `receipt_core::verify_receipt_v3_json` (rules 1 to 4) and
  `verifier_core::{check_own_input_v3, check_received_output_v3, check_contract_v3}`
  (rule 5) in vault-family-core.
- **Other languages:** use an RFC 8785 library, a JSON parser that rejects
  duplicate member names, and an Ed25519 verifier you can run with the strict
  rules above. Check your implementation against every vector in
  `data/test-vectors/` (`receipt_v3_*`, `input_commitment_v3.json`,
  `contract_hash_v2.json`, `jcs_*`): all positive vectors must verify and all
  negative vectors must be rejected.

### Strict Ed25519 in TypeScript

Ed25519 libraries disagree on edge cases (cofactored vs cofactorless equations),
so v3 requires prime-order `A` and `R`, which makes both equations agree. With
`@noble/curves` 1.x:

```typescript
import { ed25519 } from '@noble/curves/ed25519';

const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function isPrimeOrderPoint(bytes: Uint8Array): boolean {
  try {
    const p = ed25519.ExtendedPoint.fromHex(bytes); // ed25519.Point.fromHex in 2.x
    const reencoded = p.toRawBytes();
    if (reencoded.length !== bytes.length || reencoded.some((b, i) => b !== bytes[i])) {
      return false; // non-canonical encoding
    }
    return !p.isSmallOrder() && p.isTorsionFree();
  } catch {
    return false;
  }
}

function leBytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/** sig: 64 bytes, digest: SHA-256 of the signing message, pinnedKey: 32 bytes. */
function verifyStrictEd25519(sig: Uint8Array, digest: Uint8Array, pinnedKey: Uint8Array): boolean {
  if (sig.length !== 64 || pinnedKey.length !== 32) return false;
  if (!isPrimeOrderPoint(pinnedKey)) return false;
  if (!isPrimeOrderPoint(sig.subarray(0, 32))) return false;
  if (leBytesToBigInt(sig.subarray(32)) >= L) return false;
  return ed25519.verify(sig, digest, pinnedKey, { zip215: false });
}
```

### Own-input check

Each participant generates a fresh 32-byte nonce for its submission, sends it as
`commitment_nonce` (64 lowercase hex characters), and keeps the nonce and the exact
`context` it submitted. After the session:

```
1. Find the single commitments.input_commitments entry whose participant_id is
   your own participant id. Reject if there is none.
2. Recompute SHA-256("VCAV-INPUT-COMMIT-V3:" || nonce (32 raw bytes) || JCS(context))
   and compare it with the entry's input_commitment in constant time.
   Reject on mismatch.
```

A match shows the relay committed to the input you actually sent. Nobody else can
run this check for your entry: without your nonce, the commitment cannot be opened,
so the counterparty learns nothing from it about your input.

### Contract hash v2

```
contract_hash = SHA-256( JCS_RFC8785( normalise(contract) ) )
```

`normalise` accepts only the contract members (`purpose_code`, `output_schema_id`,
`output_schema`, `participants`, `prompt_template_hash`, and the optional
`entropy_budget_bits`, `timing_class`, `metadata`, `model_profile_id`,
`model_profile_hash`, `enforcement_policy_hash`, `output_schema_hash`,
`model_constraints`, `max_completion_tokens`, `session_ttl_secs`,
`invite_ttl_secs`, `entropy_enforcement`, `relay_verifying_key_hex`). Any other
member, including a `contract_hash` member, makes the contract invalid; it is
not stripped. Optional members that are absent or `null` are omitted; nothing is
added. Numbers must be within ±(2^53−1) and integer members are plain integers.

Hash the contract JSON you sent or received, never a re-serialised typed struct.
If you store a contract together with its hash, remove the hash member before
hashing. The relay accepts only contract hash v2: `contract_hash` in
`POST /sessions`, `POST /invites` and invite responses, and
`expected_contract_hash` in submissions, are contract hash v2 values.

### Contract check

A participant that holds the contract should check:

1. `commitments.contract_hash == contract_hash_v2(contract)`;
2. `commitments.schema_hash == contract.output_schema_hash` if the contract has
   one, otherwise `== SHA-256(JCS(contract.output_schema))`;
3. the `participant_id`s of `commitments.input_commitments`, in order, equal
   `contract.participants`;
4. `commitments.prompt_template_hash`, if present, equals
   `contract.prompt_template_hash`;
5. `claims.entropy_budget_bits` equals `contract.entropy_budget_bits` when both
   are present.

---

## 4. Legacy Verification — v1 and v2

Relays no longer issue v1 or v2 receipts. Verifiers keep these paths so that
receipts issued earlier stay verifiable. v1 and v2 input commitments are
unsalted hashes of the inputs.

### v1 step-by-step

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

### v1 TypeScript example

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

### v1 Python example

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

### v2 step-by-step

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
the original artefacts — see [v2 commitment verification](#v2-commitment-verification) below.

### v2 TypeScript example

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

### v2 Python example

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

### v2 commitment verification

After verifying the signature of a v2 receipt, you can optionally verify individual
commitments if you hold the original artefacts. Commitment verification is independent of
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

### v3 top-level fields

| Field | Type | Description |
|---|---|---|
| `receipt_schema_version` | string | Exactly `"3.0.0"` |
| `receipt_canonicalization` | string | Exactly `"JCS_RFC8785"` |
| `receipt_id` | string (UUID) | Unique receipt identifier |
| `session_id` | string | Session this receipt covers |
| `issued_at` | string | UTC, exactly `YYYY-MM-DDTHH:MM:SSZ` |
| `assurance_level` | string | See [Assurance Levels](#assurance-levels) |
| `operator` | object | Relay operator identity |
| `commitments` | object | Independently verifiable hashes |
| `claims` | object | Relay-asserted, not independently verifiable |
| `provider_attestation` | object? | Provider-signed inference metadata (optional) |
| `tee_attestation` | object? | TEE hardware attestation (optional) |
| `signature` | object | Receipt signature |

### Commitments section

Fields in `commitments` can be recomputed by whoever holds the corresponding
artefact. `JCS` below is RFC 8785 with the v3 number limit. Receipt v3 has no
`assembled_prompt_hash` or `rejected_output_hash` (both were v2 fields), and a
verifier rejects a v3 receipt that carries either.

| Field | How to verify |
|---|---|
| `contract_hash` | Contract hash v2 of the contract (see [Contract hash v2](#contract-hash-v2)) |
| `contract_hash_alg` | Exactly `"SHA256_JCS_V2"` |
| `schema_hash` | SHA-256(JCS(output_schema)) of the schema the relay enforced |
| `output_hash` | SHA-256(JCS(output)); SHA-256 of zero bytes on failure receipts |
| `input_commitments[]` | Each participant recomputes its own entry with its nonce (see [Own-input check](#own-input-check)); entries are in `contract.participants` order |
| `prompt_template_hash` | Equals `contract.prompt_template_hash` |
| `effective_config_hash` | SHA-256(JCS(preflight_bundle)) |
| `preflight_bundle.*` | Hash each constituent artefact independently |

The `output` field inside `commitments` is an inline convenience copy of the
session output. When present, verifiers must check that
SHA-256(JCS(commitments.output)) matches `commitments.output_hash`.

Receipts never contain the commitment nonces.

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
| `budget_usage` | `{scope, bits_used_before, bits_used_after, budget_limit}`. `scope` is `"SESSION"`: the figures cover this session only, so `bits_used_before` is `0`. They do not describe a cross-session ledger. |

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

`receipt_signing_pubkey_hex` is part of the receipt, so it is only meaningful once
the quote itself has been verified (platform signature, measurement against an
allowlist, and transcript binding). The TypeScript verifier does not parse or
verify quotes, so it never uses this field as the verification key. A TEE receipt
is verified against the caller-supplied relay key like any other receipt, and if
`receipt_signing_pubkey_hex` is present and differs from that key, the receipt is
invalid.

### Assurance levels

The `assurance_level` field is required in v2 and v3 receipts and describes the strength
of external evidence backing the receipt.

| Value | Meaning |
|---|---|
| `SELF_ASSERTED` | The relay signs its own receipt. No external attestation. Claims are relay assertions only. |
| `OPERATOR_AUDITED` | The operator publishes a verifiable audit trail. Claims can be cross-checked against the audit log. |
| `PROVIDER_ATTESTED` | The model provider supplied signed inference metadata. `claims.model_identity_attested` can be trusted. |
| `TEE_ATTESTED` | Hardware TEE attestation (AMD SEV-SNP) binds the session transcript to the CVM's attestation report. Prototype, not yet secure: the launch measurement doesn't yet cover the relay binary, and model identity remains provider-reported. Produced by the `selkey-tee` relay on real SEV-SNP hardware. |

The software relay operates at `SELF_ASSERTED`. The TEE relay (`selkey-tee`) is a
prototype, not yet secure: its shipped image runs a simulated runtime and issues
`SELF_ASSERTED` receipts, and on real AMD SEV-SNP hardware it issues `TEE_ATTESTED`
receipts whose measurement doesn't yet cover the relay binary.
Never display "receipt verified" without also showing the assurance level — a
`SELF_ASSERTED` receipt is much weaker than a `TEE_ATTESTED` one.

### Operator identity

```json
{
  "operator_id": "relay.selkey.dev",
  "operator_key_fingerprint": "abcd1234...",
  "operator_key_discovery": "https://relay.selkey.dev/.well-known/selkey-keys.json"
}
```

`operator_key_fingerprint` is the SHA-256 hex digest of the raw 32-byte public key.
In v3 verifiers must check it against the pinned key.
`operator_key_discovery` is an optional URI where the operator publishes their
canonical key for pinning — not present in self-asserted deployments.

### Signature object (v2, v3)

```json
{
  "alg": "Ed25519",
  "value": "base64url-encoded-64-bytes",
  "signed_fields": "ALL_EXCEPT_SIGNATURE"
}
```

`signed_fields: "ALL_EXCEPT_SIGNATURE"` indicates that every field in the receipt
except the `signature` object itself is covered by the signature. This is the only
value defined. In v3, `value` is exactly 86 base64url characters without padding,
and decoders must reject padding and non-zero trailing bits.

---

## 6. Getting the Verification Key

Get the relay's verifying key once, over a channel you trust (for example from the relay
operator), and pin it: pass it to the verifier, or set `SELKEY_RELAY_VERIFYING_KEY_HEX`. The
`/health` endpoint below is convenient for local development, but a key fetched from the relay
you're checking is not a trust anchor on its own.

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
3. **Check `operator_key_fingerprint`.** Compute SHA-256 of the 32-byte pinned
   key and compare it to `receipt.operator.operator_key_fingerprint`. v3
   verifiers must reject a mismatch.

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

The `selkey-mcp` package exposes an `selkey.verify_receipt` tool
that wraps the verification logic described above.

### Tool signature

```typescript
{
  "name": "selkey.verify_receipt",
  "arguments": {
    "receipt": { /* receipt JSON object */ },
    "public_key_hex": "a3f2...64-hex-chars...9d01"  // optional if SELKEY_RELAY_VERIFYING_KEY_HEX is set
  }
}
```

A relay verifying key is required. Pass `public_key_hex`, or pin the key for the
MCP server with `SELKEY_RELAY_VERIFYING_KEY_HEX`. If both are present they must
match. With neither, the tool returns an `INVALID_INPUT` error rather than a
verification result. Keys embedded in the receipt (such as
`tee_attestation.receipt_signing_pubkey_hex`) are never used as the verification
key; if one is present and differs from the relay key, `valid` is `false`.

Get the relay key out of band (see [Getting the Verification Key](#6-getting-the-verification-key)),
not from the receipt or the counterparty.

### Tool output

```typescript
{
  "valid": true,
  "schema_version": "3.0.0",
  "assurance_level": "SELF_ASSERTED",    // v2 and v3
  "operator_id": "relay.selkey.dev", // v2 and v3
  "errors": [],
  "warnings": []
}
```

`valid: true` means the receipt passed the signature and format rules for its
version. It does not mean the participant checks ran — those require the
caller's own input and nonce, the received output, or the contract.

### Example MCP invocation

```json
{
  "tool": "selkey.verify_receipt",
  "arguments": {
    "receipt": {
      "receipt_schema_version": "3.0.0",
      "receipt_canonicalization": "JCS_RFC8785",
      "receipt_id": "a1b2c3d4-...",
      "session_id": "e5f6a7b8-...",
      "issued_at": "2026-03-04T12:00:00Z",
      "assurance_level": "SELF_ASSERTED",
      "operator": {
        "operator_id": "relay.selkey.dev",
        "operator_key_fingerprint": "abcd1234..."
      },
      "commitments": {
        "contract_hash": "...",
        "contract_hash_alg": "SHA256_JCS_V2",
        "schema_hash": "...",
        "output_hash": "...",
        "input_commitments": [
          { "participant_id": "alice", "input_commitment": "...", "scheme": "SHA256_N32_JCS_V3" },
          { "participant_id": "bob", "input_commitment": "...", "scheme": "SHA256_N32_JCS_V3" }
        ],
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

Libraries for v3 (`JCS_RFC8785`):
- TypeScript / JavaScript: `canonicalize` 5.x (npm), plus a strict parser that
  rejects duplicate member names, lone surrogates and numbers beyond ±(2^53−1)
- Python: `jcs` (pip)
- Go: `github.com/cyberphone/json-canonicalization`
- Rust: `serde_json_canonicalizer` 0.4.1 (as in `receipt_core::jcs`)

v1 and v2 receipts use the frozen legacy canonicaliser (`JCS_V1`,
`receipt_core::canonicalize`). It differs from RFC 8785 for some inputs (DEL and
C1 characters, exponents, very large integers, key order outside the BMP), so do
not use it for v3.

### Parse strictly before verifying (v3)

`JSON.parse` keeps the last of two repeated member names silently. Two verifiers
could then see different receipts in the same bytes. Reject duplicates, lone
surrogates and out-of-range numbers when parsing, and verify the parsed, validated
receipt rather than the raw text.

### Strip the correct field before canonicalization

For v1, strip the `signature` string field.
For v2 and v3, strip the entire `signature` object — including `alg`, `value`, and
`signed_fields`. Leaving any part of the signature object in the document will
produce a different canonical form and verification will fail.

```typescript
// v1 — strip the string field
const { signature: _removed, ...unsigned } = receiptV1;

// v2 and v3 — strip the entire object
const { signature: _removed, ...unsigned } = receiptV3;
```

### Domain separator must be exact (including the colon)

The domain separator is prepended to the canonical JSON as a plain string — no
null byte, no length prefix, no newline. The colon is part of the separator.

```
v1: "VCAV-RECEIPT-V1:" + canonical_json_string
v2: "VCAV-RECEIPT-V2:" + canonical_json_string
v3: "VCAV-RECEIPT-V3:" + canonical_json_string
```

A missing colon or trailing whitespace will produce a different digest.

### Ed25519 signs the SHA-256 hash, not the canonical bytes directly

The relay does not sign the canonical bytes directly. It signs the SHA-256 hash
of the full signing message (domain separator + canonical JSON). Verify against
the hash, not the raw message.

```typescript
// Correct — verify over the SHA-256 digest
const message = 'VCAV-RECEIPT-V3:' + canonical;
const digest = sha256(utf8ToBytes(message));
verifyStrictEd25519(sigBytes, digest, pubKeyBytes);

// Wrong — will always fail; do not pass raw message bytes
verifyStrictEd25519(sigBytes, utf8ToBytes(message), pubKeyBytes);
```

### Version dispatch is required

Never assume a receipt version. Always read `receipt_schema_version` (v2, v3) or
`schema_version` (v1) and dispatch to the correct verification path. Applying one
version's rules to another version's receipt fails: the domain separators,
canonicalisation and signature encodings differ.

Verifiers must reject receipts with unknown versions (fail-closed). A v3 verifier
accepts only `3.0.0` and rejects other `3.x` values.

### Don't reuse a commitment nonce

Generate a fresh 32-byte nonce with a CSPRNG for every submission. Never log it,
never send it to the counterparty and never put it in shared state; keep it
locally next to your input so you can run the own-input check.

### v2 and v3: base64url encoding, not standard base64

`signature.value` in v2 and v3 receipts is base64url-encoded (URL-safe alphabet, no
padding). Standard base64 decoders may fail on the `-` and `_` characters.
Use a base64url decoder, or replace `-` with `+` and `_` with `/` before
passing to a standard base64 decoder, then add the correct padding.

### Signature verifies the receipt as issued — check assurance level separately

A valid signature only proves the receipt was not tampered with after the relay
signed it. It does not prove the relay was honest during execution. Always
communicate the `assurance_level` alongside any "verified" status.
