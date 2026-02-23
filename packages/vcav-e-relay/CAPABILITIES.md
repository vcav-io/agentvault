# AgentVault Relay Capabilities

Implementation: agentvault-relay
Spec version: vcav-shared-protocol-v1
Execution mode: EVERYDAY (AgentVault)

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

- Schema version: 1.0.0
- Signing: Ed25519, domain prefix VCAV-RECEIPT-V1:
- Canonicalization: urn:vcav:vssp:canon:json-sha256-v1
- Verification: compatible with verifier-core Tier 1/2/3

## MVP Scope

- Single-turn sessions only
- Anthropic provider only
- Mediation purpose (other purposes supported by contract)
- Budget enforcement disabled (in-memory, no persistent tracking)
