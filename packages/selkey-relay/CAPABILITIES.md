# Selkey Relay Capabilities

Implementation: selkey-relay
Spec version: vcav-shared-protocol-v1
Execution mode: EVERYDAY (Selkey)

## Execution Lane: API_MEDIATED

- Bounded inter-party disclosure: peers see only schema-bounded output + receipt
- Bounded output: Guardian schema validation before emission
- Entropy enforcement: ADVISORY (computed and recorded, not hard-enforced)
- Prompt template binding: prompt_program_hash in receipt
- Architectural minimisation: in-memory processing, no disk writes (design property)
- Operator-blindness: NOT claimed (relay sees plaintext)
- Non-persistence: NOT claimed (design intent, not structural)
- Constant-shape timing: NOT claimed
- Provider exposure: acknowledged (plaintext sent to API provider)

## Receipt Format

- Schema version: 3.0.0 (receipt v3, the only format emitted)
- Signing: Ed25519 over SHA-256("VCAV-RECEIPT-V3:" || JCS(unsigned receipt))
- Canonicalization: JCS_RFC8785 (RFC 8785, numbers limited to +/-(2^53-1))
- Input commitments: SHA256_N32_JCS_V3, salted with a client-supplied `commitment_nonce`
- Contract hash: SHA256_JCS_V2
- Verification: verifier-core / receipt-core `verify_receipt_v3_json` and the TS client `verifyReceipt`

## MVP Scope

- Single-turn sessions only
- Providers: Anthropic (default) and OpenAI (opt-in via `OPENAI_API_KEY`). Provider
  selected per session; model identity recorded in receipt.
- Mediation and Compatibility purposes (other purposes supported by contract)
- Budget enforcement: ADVISORY — entropy computed per session and recorded in the
  receipt `budget_usage` field; sessions are not hard-rejected for exceeding the
  budget. `budget_enforcement` is set to `"disabled"` in emitted receipts.
