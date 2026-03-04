# AgentVault Threat Model

> **Issue:** #156 (explicit confidentiality model)
> **Protocol version:** 0.1.0
> **Receipt schema:** v2

---

## 1. Purpose

This document defines the trust model and threat analysis for the AgentVault
bounded-disclosure coordination protocol. It is intended for:

- Operators evaluating whether AgentVault is appropriate for a given deployment
- Developers building on top of AgentVault who need to reason about information flow
- Auditors reviewing claims made about session confidentiality and receipt integrity

This document is a security document, not a marketing document. It names what
AgentVault does not provide with the same precision as what it does provide.

The term "confidentiality" is used below in its technical sense: whether a party
can observe information they are not supposed to observe, not whether they choose
to act on it.

---

## 2. System Model

### 2.1 Participants

Every AgentVault session involves four parties:

| Party | Role |
|-------|------|
| **Alice** | An agent (or its user) submitting a private context as input to the relay |
| **Bob** | A second agent (or its user) submitting a separate private context to the same session |
| **Relay operator** | The entity that runs the AgentVault relay. Controls the infrastructure that processes both inputs and calls the LLM provider. |
| **LLM provider** | The external inference service (OpenAI, Anthropic, etc.) that the relay calls to generate output. The relay submits the assembled prompt; the provider returns model output. |

Alice and Bob are treated symmetrically by the protocol. Either may be the session
initiator. The roles differ only in how inputs and tokens are routed.

### 2.2 Trust Boundary Diagram

```
                        ┌─────────────────────────────────────────────┐
                        │              Relay Operator                  │
                        │                                              │
  Alice ──[input_A]──► │  ┌───────────────────────────────────────┐  │
                        │  │           AgentVault Relay            │  │
  Bob   ──[input_B]──► │  │                                       │  │──[assembled prompt]──► LLM Provider
                        │  │  assemble_prompt(input_A, input_B)    │  │
                        │  │  validate_output(schema)              │ ◄│──[raw LLM output]──────
                        │  │  apply_guardian_policy()              │  │
                        │  │  sign_receipt()                       │  │
                        │  └───────────────────────────────────────┘  │
                        │                                              │
                        └─────────────────────────────────────────────┘
                                          │
                             [bounded_output + receipt]
                                    │            │
                                    ▼            ▼
                                  Alice         Bob
                          (sees own input   (sees own input
                           + bounded output) + bounded output)
```

TLS encrypts all transport paths. The relay operates inside the relay operator's
trust boundary — the operator has administrative access to the relay process, its
keys, and its runtime state.

### 2.3 What Each Party Observes

| Party | Observes |
|-------|----------|
| Alice | Her own input; the bounded output; the signed receipt |
| Bob | His own input; the bounded output; the signed receipt |
| Relay operator | Both inputs in plaintext; the assembled prompt; the raw LLM output; the bounded output; the receipt; all runtime state |
| LLM provider | The assembled prompt (both inputs merged into the prompt template); the raw model output |

The relay operator's visibility is architectural: API-mediated execution requires the
relay to hold both inputs in order to assemble the prompt and call the provider.
This is not a bug or an implementation shortcut — it is the defining characteristic
of the API-mediated tier.

---

## 3. Confidentiality Model

### 3.1 What AgentVault Provides

**Counterparty confidentiality**

Neither Alice nor Bob sees the other's raw input. Alice sees only the bounded
output and the receipt. Bob sees only the bounded output and the receipt. The
relay enforces this by routing inputs and outputs separately.

**Bounded output disclosure**

The output that leaves the relay conforms to the JSON Schema specified in the
contract. The schema is validated by the relay, not by the model — the model does
not know the enforcement rules and cannot negotiate around them. Output that fails
schema validation is rejected and not returned to either party.

In addition to schema validation, the guardian enforcement policy applies a
second layer of checks (e.g., unicode category rules blocking digits and currency
symbols). Output that triggers a GATE-classified rule is rejected with a
constant-shape error response that reveals nothing about which rule fired.

This means the information channel from Alice to Bob (and from Bob to Alice) is
structurally constrained. A free-text output field with no schema constraint carries
unbounded information. An all-enum output schema with a 32-bit entropy budget carries
at most 32 bits. The difference is not a matter of the model choosing to withhold
information — it is a structural property of the schema.

The red-team results in `docs/red-team-report-2026-02-25.md` demonstrate this in
practice: under a free-text schema (v1), one model leaked exact investment ranges
across three providers. Under an all-enum schema (v2), both models produced zero
leaks across seven adversarial scenarios.

**Verifiable session provenance**

Every completed session produces a signed receipt that cryptographically binds:

- The contract hash (the full agreement between parties)
- The output schema hash
- The prompt template hash
- The guardian policy hash
- The model profile hash (if specified)
- The relay build hash
- The bounded output hash
- Input commitment hashes (one per participant)
- The assembled prompt hash

A recipient of a receipt who holds the relay's public key can verify that the
receipt was produced by a relay holding the corresponding private key and that none
of the bound fields have been modified since signing. A recipient who also holds
the artefacts (contract, schema, policy) can independently recompute the hashes
and confirm they match.

### 3.2 What AgentVault Does Not Provide

**Relay confidentiality**

The relay sees both inputs in plaintext. This is architectural. An operator running
an AgentVault relay has complete visibility into every session: both inputs, the
assembled prompt, the raw LLM output, and the bounded result. Deploying AgentVault
does not constrain operator access to session data.

Operators who need to limit their own access to session inputs should evaluate the
TEE upgrade path described in Section 5 (PROVIDER_ATTESTED and TEE_ATTESTED tiers).
Those tiers are not yet implemented.

**Provider confidentiality**

The LLM provider sees the assembled prompt, which incorporates both inputs merged
into the prompt template. A provider that logs prompt content has full visibility
into the combined context of both participants. Current provider data retention and
logging policies are outside the scope of this protocol.

**End-to-end encryption of inputs**

Inputs travel over TLS between participants and the relay. TLS protects against
network observers but not against the relay itself. The relay has plaintext access
to all inputs. There is no cryptographic mechanism in the current implementation
that would prevent a relay from reading or logging inputs.

The README notes that encrypted inputs (cryptographic binding of inputs to admitted
terms via AAD) are planned but not yet implemented.

**Faithful execution proof**

The signed receipt proves that a relay holding the signing key produced a
receipt with internally consistent hashes. It does not prove that inference actually
occurred. A malicious relay operator could fabricate a conforming output, compute
the correct hashes for that fabricated output, and sign a receipt that would verify
correctly. Detection requires either:
(a) the fabricated output to be implausible given what the parties know, or
(b) a higher assurance tier (provider attestation or TEE attestation) that binds
   the receipt to an externally verifiable execution event.

At `SELF_ASSERTED` (the current implementation level), the security of the receipt
reduces to trust in the relay operator.

**Model identity verification**

`model_identity` in v1 receipts and `claims.model_identity_asserted` in v2 receipts
are operator assertions, not cryptographic commitments. The relay reports what the
provider API response indicates. A relay operator could configure a relay to claim a
different model than the one actually called. A provider attestation (
`PROVIDER_ATTESTED` assurance tier) would address this, but is not yet implemented.

---

## 4. Adversary Classes

| Adversary | Capability | What AgentVault Prevents | What It Does Not Prevent |
|-----------|-----------|--------------------------|--------------------------|
| Curious counterparty | Sees bounded output only | Raw input disclosure | Inference from output structure, field presence, or value patterns |
| Curious relay operator | Full access to inputs, prompts, and outputs | Nothing — relay is a trusted party in the API-mediated tier | N/A |
| Malicious relay operator | Could fabricate output; could log inputs; could modify artefact hashes before signing | Tamper with a signed receipt after issuance; forge a receipt without the signing key | Undetectable fabrication of plausible output; input logging |
| Network observer | Sees encrypted TLS traffic | Content (via TLS) | Traffic analysis; session timing; request/response size patterns |
| Curious LLM provider | Sees assembled prompt | Nothing — provider is trusted for inference | N/A |
| Malicious LLM provider | Could return fabricated output | Nothing at SELF_ASSERTED level | Receipt claims model identity; provider could supply different output |

### 4.1 Notes on the Counterparty Adversary

The primary use case of AgentVault is protecting each participant from the other.
The guarantees here are strong but not absolute:

- The output schema eliminates unbounded free-text channels.
- Schema shape itself is visible to both parties (it is part of the contract). The
  choice of fields, enum values, and array bounds is information about the domain.
  Schema design is therefore a security decision.
- Timing side channels (response latency correlates with input complexity) are not
  addressed by the protocol. See Section 6.
- Field presence patterns (whether a field is populated, not just its value) can
  carry signal even in all-enum schemas.
- Error patterns (POLICY_GATE vs SCHEMA_VALIDATION vs success) can leak information.
  The relay uses constant-shape error responses for policy gates (Section 8.2 of
  the protocol spec) as a partial mitigation.

### 4.2 Notes on the Malicious Relay Adversary

A malicious relay can:

- Log inputs permanently despite the ephemeral retention policy.
- Fabricate a conforming output and sign a receipt for it.
- Deliver different outputs to Alice and Bob.
- Withhold outputs entirely.

What a malicious relay cannot do:

- Produce a receipt that verifies against a key the operator does not hold.
- Modify a signed receipt without detection.
- Claim a different contract or schema than was actually used (the hashes are over
  the full objects, not just IDs).

The receipt provides evidence of what the relay claimed. It does not guarantee
the relay told the truth. Operator trust is a prerequisite for all current
deployments.

---

## 5. Assurance Tiers

The `assurance_level` field in receipt v2 indicates what external attestation, if
any, supplements the relay's self-report. "Receipt verified" must always be
presented together with the assurance level.

| Level | Description | Current Status |
|-------|-------------|----------------|
| `SELF_ASSERTED` | The relay signs its own receipt. Trust the operator. | Implemented |
| `OPERATOR_AUDITED` | The operator publishes an independently verifiable audit trail. Trust is externally checkable but still rests on the operator. | Not yet implemented |
| `PROVIDER_ATTESTED` | The LLM provider co-signs inference metadata, binding `model_identity` to a cryptographic commitment. | Not yet implemented |
| `TEE_ATTESTED` | A hardware enclave (SGX, TDX, SEV-SNP) signs the receipt and binds it to an enclave measurement. The relay operator cannot see inputs or fabricate outputs without breaking the attestation. | Not yet implemented |

All current AgentVault deployments operate at `SELF_ASSERTED`. The operator-audited
tier is the near-term upgrade path. TEE attestation is the intended end state for
deployments where relay confidentiality is a hard requirement.

Receipt v2 includes attestation slots (`provider_attestation`, `tee_attestation`)
that are defined in the schema but not yet populated by any relay implementation.
Their presence in the schema allows the attestation tiers to be added without a
schema breaking change.

---

## 6. Residual Information Channels

AgentVault narrows the information channel from unbounded free text to structured
output. It does not eliminate all information channels.

### 6.1 Output Structure

Even a fully enum-bounded output carries information:

- **Field values** — the enum value selected (e.g., `WITHIN_BAND` vs `TOO_HIGH`)
- **Field presence** — whether an optional field is populated
- **Array contents** — which combination of allowed values appears in an array field
- **Array length** — number of items selected (if the schema allows variable-length arrays)

The entropy budget in the receipt (`output_entropy_bits`) provides a structural upper
bound on the total information content. A 25-bit bounded output carries at most 25 bits
of information about the combined input context. This is a meaningful constraint
compared to unbounded free text (which carries hundreds of bits for a short paragraph).

### 6.2 Timing

Response latency may correlate with input complexity (longer inputs = more tokens =
longer provider latency). A party that can measure round-trip time for multiple sessions
may be able to infer coarse properties of the counterparty's input. The protocol does
not add artificial delays. Operators who need to neutralize timing channels should
add their own constant-time response envelopes.

### 6.3 Error Patterns

Whether a session completes or aborts, and the abort reason code, can leak information:

- `SCHEMA_VALIDATION` abort may indicate the model produced output that didn't conform
  to the schema — some model behaviors may be more likely with certain input types.
- `POLICY_GATE` abort, per Section 8.2 of the protocol spec, returns a constant-shape
  error body with no detail about which rule fired or what triggered it.
- Success vs failure is itself a binary signal.

Constant-shape error responses for auth and policy gate cases mitigate but do not
eliminate this channel.

### 6.4 Schema Shape as a Disclosure Decision

The output schema is visible to both parties (it is embedded in the contract). The
choice of what fields to include, what enum values are available, and what array
cardinalities are permitted is a design decision with security implications. A schema
with a `rejection_reason` enum whose values map closely to Alice's private context
categories is a schema that partially discloses Alice's context through the schema
itself, before any inference runs.

Schema design should be treated as part of the security perimeter, not as a
downstream concern.

---

## 7. Mitigations

### 7.1 Implemented

**Ephemeral input retention**

The relay clears raw participant inputs from persistent state after receipt
construction. Only commitment hashes (SHA-256 of the input, not the input itself)
persist in the receipt. During execution, inputs exist in memory for the duration
of the LLM provider call and are dropped after the receipt is signed.

This limits exposure to the execution window. It does not prevent an operator from
logging inputs out-of-band or from retaining them in infrastructure logs outside
the relay process.

**Contract-level input minimisation**

The contract specifies exactly what information the session requires. Participants
should submit only the context necessary for the session purpose. Less input means
less exposure during the execution window.

**Schema design (narrow the channel)**

All-enum output schemas with explicit entropy budgets are structurally stronger than
free-text schemas. The v2 schema retest (`docs/red-team-report-2026-02-25.md`)
demonstrates that an all-enum schema eliminates the leak surface that free-text fields
provide, regardless of model behavior. Schema design is the most effective mitigation
available to protocol users today.

**Enforcement policy (guardian rules)**

The guardian enforcement policy applies a second enforcement layer on top of schema
validation. Unicode category rules (blocking decimal digits, letter numbers, other
numbers, and currency symbols) provide defense-in-depth against models that produce
numeric or financial content in string fields, even when the schema permits string
values but not numeric ones.

**Content-addressed artefacts (tamper-evidence)**

Every artefact governing a session (contract, schema, prompt template, policy, model
profile) is content-addressed by SHA-256 over its JCS canonical form. The receipt
binds the hash of each artefact. A party who later obtains the artefacts can confirm
the hashes match. Retroactive substitution of artefacts is detectable.

**Constant-shape error responses**

Policy gate rejections return a fixed-body 422 with no detail. Auth failures return
a fixed-body 401. This prevents callers from reverse-engineering the guardian policy
or enumerating session state through error shapes.

### 7.2 Planned (Not Yet Implemented)

**TEE execution**

A hardware-attested execution environment (VCAV-H) would bind the receipt to an
enclave measurement, preventing relay operators from observing inputs or fabricating
outputs without breaking the attestation.

**Provider attestation**

LLM provider co-signing of inference metadata would upgrade `model_identity_asserted`
(a claim) to `model_identity_attested` (a commitment verifiable against the provider's
public key).

**Encrypted inputs**

Cryptographic binding of inputs to admitted contract terms (via AAD) would prevent
the relay from reading inputs, making relay confidentiality a cryptographic guarantee
rather than a policy commitment.

---

## 8. What "Receipt Verified" Means

Receipt verification is a precise technical claim. The word "verified" must always
appear with the assurance level.

### 8.1 What a Verified Receipt Proves

A receipt that passes signature verification against a trusted public key proves:

1. The receipt was signed by the entity holding the corresponding private key.
2. The receipt content has not been modified since it was signed.
3. The contract hash embedded in the receipt is internally consistent with the other
   commitment hashes.
4. If the verifier holds the artefacts: the contract, schema, policy, and prompt template
   hashes in the receipt match the artefacts the verifier holds.
5. The bounded output hash in the receipt matches the output the verifier received.
6. The input commitment hashes match the canonical hashes of the inputs each participant
   submitted (each participant can verify their own commitment; they cannot verify the
   counterparty's without the counterparty's input).

### 8.2 What a Verified Receipt Does Not Prove

1. **That inference actually occurred.** A malicious relay can fabricate a conforming
   output, compute correct hashes, and produce a verifiable receipt.
2. **That the claimed model was used.** `model_identity` is an operator assertion at
   `SELF_ASSERTED`. The relay reports what the provider API response indicated.
3. **That enforcement code executed correctly.** Schema validation and guardian rules
   ran inside the relay. A compromised relay could skip enforcement and sign a receipt
   claiming they passed.
4. **That the relay did not observe or log inputs.** The receipt contains commitment
   hashes, not inputs. The presence of correct commitment hashes does not mean inputs
   were not logged — it means the relay correctly computed the hashes of whatever
   inputs it processed.
5. **That both parties received the same output simultaneously.** The protocol does not
   enforce fair exchange. The relay delivers outputs to participants independently.

### 8.3 Verification Output Should Include Assurance Level

A receipt verifier should not output a binary "VALID / INVALID" result. The correct
output is:

```
Receipt signature: VALID
Assurance level:   SELF_ASSERTED
Contract hash:     [hash]   matches: YES
Schema hash:       [hash]   matches: YES
Output hash:       [hash]   matches: YES
Input commitment (own): [hash]   matches: YES
```

At `SELF_ASSERTED`, "receipt signature: VALID" means the relay operator's key signed
this receipt. It is a provenance statement, not an integrity guarantee about the
underlying execution.

---

## 9. Scope Boundaries

### 9.1 In Scope

- Information flow between Alice, Bob, relay, and LLM provider
- Guarantees provided by the signed receipt
- Residual information channels through bounded output
- Operator trust requirements

### 9.2 Out of Scope

This document does not cover:

- **Agent identity and authentication** — how Alice and Bob verify each other's
  identities before initiating a session. The protocol spec notes that discovery
  (agents publishing signed descriptors declaring identity and keys) is planned
  but not yet implemented.
- **Key distribution** — how relying parties obtain and pin relay public keys. The
  `operator_key_discovery` URI field in the v2 receipt provides a hook, but the
  key distribution protocol is not yet defined.
- **Fair exchange** — whether both parties receive the output simultaneously or can
  use the output symmetrically. The protocol does not address this.
- **Denial of service** — availability attacks against the relay are not in scope.
- **Client-side security** — how participant agents protect their own inputs before
  submission is out of scope for this document.
- **Compliance** — whether AgentVault satisfies any specific regulatory framework
  is out of scope. This document describes technical properties; compliance analysis
  requires additional legal and operational context.

---

## References

- `docs/protocol-spec.md` — normative protocol specification
- `docs/architecture/contract-receipt-v2.md` — receipt v2 architecture
- `docs/red-team-report-2026-02-25.md` — red team results for bounded disclosure
- `SECURITY.md` — vulnerability disclosure policy
- Issue #156 — explicit confidentiality model (this document)
