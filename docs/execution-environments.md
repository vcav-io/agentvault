# Execution Environments

AgentVault supports two execution lanes for coordinated disclosure sessions.

## Standard Lane

The default execution path. The relay operator has access to session data
in memory during processing.

**Use for:** Development, testing, non-sensitive coordination, demos.

**Trust model:** You trust the relay operator not to exfiltrate session data.

## Confidential Lane (TEE)

Sessions run inside a Trusted Execution Environment (AMD SEV-SNP Confidential
VM). The relay operator cannot read session data in memory.

**Use for:** Sensitive coordination where operator blindness is required.

**Trust model:** You trust the hardware platform and the attested relay binary.
You do NOT need to trust the relay operator.

## Trust Model Table

| Party | Standard Lane | Confidential Lane |
|-------|--------------|-------------------|
| Relay operator | Trusted | Untrusted (operator-blind) |
| LLM provider | Sees prompts/outputs | Sees prompts/outputs |
| Initiator | Encrypted in transit | Encrypted in transit + at rest |
| Responder | Encrypted in transit | Encrypted in transit + at rest |
| Hardware platform | N/A | Trusted (SEV-SNP) |

## Important Limitations

Even in confidential mode:

1. **The LLM provider sees plaintext.** The relay sends prompts to the provider
   API in cleartext. TEE protects data from the *relay operator*, not the
   *model provider*. Provider attestation is a separate concern.

2. **The relay sees plaintext inside the enclave.** The TEE protects against
   external observation, not against the relay code itself. This is why
   measurement verification matters — you're trusting the *specific binary*.

3. **Metadata is visible.** Session timing, message sizes, and connection
   patterns are observable by the operator even in TEE mode.

## Choosing a Lane

| Scenario | Recommended |
|----------|-------------|
| Development and testing | Standard |
| Public demos | Standard |
| Sensitive M&A coordination | Confidential |
| Regulatory compliance requiring operator blindness | Confidential |
| Internal team coordination (trusted operator) | Standard |

## Receipt Verification

Both lanes produce signed receipts. TEE lane receipts additionally contain
`tee_attestation` with measurement, attestation hash, and transcript hash.

- **Standard receipts:** Verify with `agentvault.verify_receipt` (TS)
- **TEE receipts:** `verify_receipt` surfaces TEE fields for introspection.
  Full cryptographic verification (measurement allowlist, transcript hash
  recomputation) requires the `tee-verifier` crate (Rust).
