# Execution Environments

Selkey supports two execution lanes for coordinated disclosure sessions.

## Standard Lane

The default execution path. The relay operator has access to session data
in memory during processing.

**Use for:** Development, testing, non-sensitive coordination, demos.

**Trust model:** You trust the relay operator not to exfiltrate session data.

## Confidential Lane (TEE)

**Status: prototype, not yet secure.** Don't use it where operator blindness is
required yet. The shipped `selkey-tee` image runs a simulated runtime with no
hardware isolation, the SEV-SNP measurement doesn't yet cover the relay binary,
and model identity is provider-reported (the model ID returned by the provider's
API; nothing verifies which model ran).

Sessions run inside a Trusted Execution Environment (AMD SEV-SNP Confidential
VM). The goal is that the relay operator cannot read session data in memory.

**Intended use:** Sensitive coordination where operator blindness is required,
once the lane is complete.

**Intended trust model:** You trust the hardware platform and the attested relay
binary, and do not need to trust the relay operator. Until the measurement covers
the relay binary, you still have to trust the operator.

## Trust Model Table

| Party | Standard Lane | Confidential Lane |
|-------|--------------|-------------------|
| Relay operator | Trusted | Trusted for now (goal: operator-blind) |
| LLM provider | Sees prompts/outputs | Sees prompts/outputs |
| Participant inputs in transit | TLS where the deployment provides it (the relay serves plain HTTP) | Encrypted to a per-session key held by the relay in the CVM (clients don't yet verify attestation first) |
| Participant inputs at the relay | Plaintext in relay process memory | Plaintext in CVM memory (encrypted by the hardware on SEV-SNP; no isolation in the simulated runtime) |
| Hardware platform | N/A | Trusted (SEV-SNP) |

## Important Limitations

Even in confidential mode:

1. **The LLM provider sees plaintext.** The relay sends prompts to the provider
   API in cleartext. TEE is intended to protect data from the *relay operator*,
   not the *model provider*. Provider attestation is a separate concern.

2. **The relay sees plaintext inside the enclave.** The TEE protects against
   external observation, not against the relay code itself. This is why
   measurement verification matters — you're trusting the *specific binary*, once
   the measurement covers the relay binary.

3. **Metadata is visible.** Session timing, message sizes, and connection
   patterns are observable by the operator even in TEE mode.

4. **The TEE lane implements only part of the protocol.** It has no invites or
   `POST /relay`, no operator token, no schema registry (strict inline schemas only),
   no guardian policy and only a per-session entropy budget, and it rejects contracts
   that set fields it doesn't enforce. Its input API isn't implemented by the Selkey
   client or MCP server. See
   [protocol-spec.md, Section 11.5](protocol-spec.md#115-differences-from-the-software-lane).

## Choosing a Lane

| Scenario | Recommended |
|----------|-------------|
| Development and testing | Standard |
| Public demos | Standard |
| Sensitive M&A coordination | Confidential, once it is no longer a prototype |
| Regulatory compliance requiring operator blindness | Confidential, once it is no longer a prototype |
| Internal team coordination (trusted operator) | Standard |

## Receipt Verification

Both lanes produce signed receipts. TEE lane receipts additionally contain
`tee_attestation` with measurement, attestation hash, and transcript hash.

- **Standard receipts:** Verify with `selkey.verify_receipt` (TS) against
  the pinned relay verifying key.
- **TEE receipts:** `verify_receipt` surfaces TEE fields for introspection.
  The TS verifier does not verify quotes, so it never trusts
  `tee_attestation.receipt_signing_pubkey_hex`: TEE receipts are verified
  against the caller-supplied relay key, and a differing embedded key makes
  the receipt invalid.
  Full cryptographic verification (SEV-SNP report chain and TCB policy, measurement
  allowlist, transcript hash recomputation against the relay configuration) requires
  the `tee-verifier` crate (Rust), which also verifies against a pinned relay key.
