# A2A Integration Spec: AgentVault as an A2A Extension

> Status: Implemented (bootstrap + maturity cluster)
> Related: agentvault #214, VFC #15 (AFAL discovery)
> Extension spec: [a2a-extension-spec.md](./a2a-extension-spec.md) — canonical reference for `urn:agentvault:bounded-disclosure:v1`

## Context

Google's Agent-to-Agent (A2A) protocol is becoming a de facto standard for agent
interoperability. It handles discovery (agent cards), task lifecycle, message
exchange, streaming, and authentication. AgentVault's current agent-to-agent
transport (AFAL) is a custom protocol that duplicates some of this infrastructure.

This document specifies how AgentVault integrates with A2A: using A2A for
discovery and, when useful, transport while preserving AgentVault's
bounded-disclosure semantics, bilateral consent, and receipt-verified
governance. AFAL remains the native AgentVault transport throughout.

## Design Principles

1. **A2A is transport, AgentVault is governance.** A2A carries messages between
   agents. AgentVault constrains what flows through the bounded session and
   proves how it was governed. These are distinct layers.
2. **Extension, not fork.** AgentVault capabilities are declared via A2A's
   extension mechanism, not by modifying A2A semantics.
3. **Bilateral consent before context.** A2A is client→agent (asymmetric).
   AgentVault requires bilateral consent before private context is exchanged.
   The integration must preserve this property within A2A's request/response
   model.
4. **Dual transport, shared semantics.** AFAL remains AgentVault's native
   transport. A2A is an interoperability bridge that carries the same bounded
   bootstrap semantics into the wider A2A ecosystem. Agents may support either
   transport or both; neither transport is deprecated in favor of the other.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        A2A Protocol Layer                        │
│  Discovery (Agent Cards) · Task Lifecycle · Message Exchange     │
│  Streaming (SSE) · Auth (OAuth2, mTLS, etc.)                    │
├──────────────────────────────────────────────────────────────────┤
│                   AgentVault A2A Extension                        │
│  Extension URI: urn:agentvault:bounded-disclosure:v1             │
│  Proposal/Admit/Deny via A2A messages                            │
│  Relay session tokens via A2A artifacts                          │
├──────────────────────────────────────────────────────────────────┤
│                     AgentVault Relay                              │
│  Contract · Schema · Guardian · Receipt                          │
│  (unchanged — A2A integration affects bootstrap only)            │
└──────────────────────────────────────────────────────────────────┘
```

## Phase 1: A2A Discovery (Agent Card Extension)

### AgentVault Extension in Agent Card

Agents that support AgentVault bounded-disclosure sessions declare this via
an A2A `AgentExtension`:

```json
{
  "uri": "urn:agentvault:bounded-disclosure:v1",
  "description": "Supports AgentVault bounded-disclosure coordination sessions",
  "required": false,
  "params": {
    "relay_url": "https://relay.example.com",
    "public_key_hex": "a1b2c3d4...64hex",
    "supported_purposes": ["COMPATIBILITY", "MEDIATION"],
    "a2a_send_message_url": "https://agent.example.com/a2a/send-message",
    "afal_endpoint": "https://agent.example.com/afal"
  }
}
```

Fields in `params`:
- `relay_url` — preferred relay for sessions initiated with this agent
- `public_key_hex` — Ed25519 public key for proposal signature verification
- `supported_purposes` — purpose codes this agent accepts
- `a2a_send_message_url` — explicit A2A-native bootstrap endpoint
- `afal_endpoint` (optional) — AFAL HTTP endpoint for agents that support
  both transports. Omit if A2A-only.

### AgentVault Skill Declaration

Each supported purpose maps to an A2A `AgentSkill`:

```json
{
  "id": "agentvault-compatibility",
  "name": "Bounded Compatibility Assessment",
  "description": "Schema-bounded compatibility signal via AgentVault relay",
  "tags": ["agentvault", "bounded-disclosure", "compatibility"],
  "input_modes": ["application/vnd.agentvault.propose+json"],
  "output_modes": ["application/vnd.agentvault.session-tokens+json"]
}
```

### Discovery Flow

1. Client fetches `/.well-known/agent-card.json` from target agent
2. Client checks for `urn:agentvault:bounded-disclosure:v1` in
   `capabilities.extensions`
3. If present, client reads `params` to learn relay URL, public key, and
   supported purposes
4. Client proceeds to Phase 2 (proposal) or Phase 3 (A2A-native transport)

Current implementation note:
- clients prefer the explicit `a2a_send_message_url` when present
- clients still fall back to deriving the A2A message endpoint from `card.url`
  for backward compatibility with earlier Agent Cards

This replaces `GET /afal/descriptor` from the current AFAL flow.

## Phase 2: Dual-Stack (A2A Discovery + AFAL Transport)

The pragmatic first step: use A2A agent cards for discovery, then fall back
to AFAL's propose/admit/commit HTTP endpoints for the session bootstrap.

### Flow

```
Agent A                          Agent B
  │                                │
  │  GET /.well-known/agent-card   │
  │──────────────────────────────►│
  │  ◄── AgentCard (with AV ext)  │
  │                                │
  │  POST /afal/propose            │  ← existing AFAL
  │──────────────────────────────►│
  │  ◄── AfalAdmit / AfalDeny     │
  │                                │
  │  (creates relay session)       │
  │                                │
  │  POST /afal/commit             │  ← existing AFAL
  │──────────────────────────────►│
  │  ◄── ok                        │
  │                                │
  │  ══ both participate via relay ═══
```

This phase requires minimal code changes:
- Agent card serving (new endpoint or static file)
- AFAL descriptor fields mapped into agent card extension params
- Client checks agent card first, falls back to `/afal/descriptor` if no
  A2A support

## Phase 3: A2A-Native Transport

Offer an A2A-native bootstrap path alongside AFAL's HTTP endpoints by carrying
AgentVault-specific message parts over A2A `SendMessage`.

### Media Types

| Type | Direction | Content |
|------|-----------|---------|
| `application/vnd.agentvault.propose+json` | Initiator → Responder | AfalPropose equivalent |
| `application/vnd.agentvault.admit+json` | Responder → Initiator | AfalAdmit equivalent |
| `application/vnd.agentvault.deny+json` | Responder → Initiator | AfalDeny equivalent |
| `application/vnd.agentvault.session-tokens+json` | Initiator → Responder | Relay session credentials |
| `application/vnd.agentvault.topic-alignment-proposal+json` | Initiator → Responder | Bounded topic-alignment proposal |
| `application/vnd.agentvault.topic-alignment-selection+json` | Responder → Initiator | Topic-alignment response |
| `application/vnd.agentvault.contract-offer-proposal+json` | Initiator → Responder | Pre-contract negotiation proposal |
| `application/vnd.agentvault.contract-offer-selection+json` | Responder → Initiator | Contract offer selection response |

### Proposal via A2A SendMessage

```json
{
  "jsonrpc": "2.0",
  "method": "SendMessage",
  "params": {
    "message": {
      "message_id": "msg-001",
      "role": "user",
      "parts": [
        {
          "data": { /* AfalPropose fields */ },
          "media_type": "application/vnd.agentvault.propose+json"
        }
      ],
      "extensions": ["urn:agentvault:bounded-disclosure:v1"]
    },
    "configuration": {
      "accepted_output_modes": [
        "application/vnd.agentvault.admit+json",
        "application/vnd.agentvault.deny+json"
      ]
    }
  }
}
```

### Admit/Deny Response

The responder returns a minimal completed Task with the admission decision as a
message part.

### Session Token Delivery

After creating the relay session, the initiator sends a follow-up
`SendMessage` with the session tokens.

Current implementation note:
- AgentVault implements a narrow A2A task lifecycle for bootstrap:
  proposal admission/denial, bounded topic alignment, bounded contract
  negotiation, and session-token delivery
- AFAL and A2A-native bootstrap carry the same AgentVault concepts; A2A is not
  the canonical source of those semantics

### Bilateral Consent in A2A's Asymmetric Model

A2A is client→agent (one side initiates, the other responds). AgentVault
requires bilateral consent. The integration maps this as:

1. **Initiator sends proposal** — this is the A2A "client" role
2. **Responder admits or denies** — this is the A2A "agent" role
3. **Both have consented** before any private context reaches the relay

### What A2A Auth Replaces

AFAL currently uses Ed25519 signed proposals verified against a trusted agents
allowlist. In A2A-native transport:

- **Agent identity** — verified via A2A's auth mechanisms (OAuth2, mTLS, etc.)
- **Proposal integrity** — the proposal carries a `signature` field (Ed25519
  over JCS-canonical proposal fields), verified against the public key in the
  agent card extension params
- **Trusted agents** — the allowlist maps to A2A security requirements

## What Does Not Change

Regardless of whether AFAL or A2A carries the bootstrap messages:

- **The relay is unchanged.**
- **Contracts are unchanged.**
- **Receipts are unchanged.**
- **Schema enforcement is unchanged.**
- **Guardian policies are unchanged.**

The A2A integration affects only how agents find each other and exchange
pre-session governance messages.

## Migration Path

| Phase | What | AFAL Status | A2A Status |
|-------|------|-------------|------------|
| Current | Discovery + dual-stack bootstrap + A2A-native bootstrap | Supported | Supported |
| Current | Signed agent cards (#308), relay arbitration (#310), task ID plumbing (#311a), stateful task lifecycle (#311b) | Supported | Implemented |
| Current | Bounded topic alignment + bounded pre-contract negotiation | Supported | Supported |

For full details on extension parameters, media types, task lifecycle states,
relay arbitration semantics, signed card verification, and backward
compatibility guarantees, see the
[A2A Extension Spec](./a2a-extension-spec.md).
