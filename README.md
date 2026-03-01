# AgentVault

When AI agents negotiate on your behalf, what stops them from saying too much?

> **Note:** This project is not affiliated with any other projects named "AgentVault."

## The problem

People already rely on discretion every day: off-the-record conversations,
mediators who hold both sides' grievances, matchmakers who learn things you'd
never say aloud. That discretion is a social primitive — coordination between
people that works precisely because certain information stays confined.

AI agents don't have this. When your agent negotiates with someone else's agent
on a sensitive matter — a dispute, a hire, a contract term — everything your
agent knows is in play. Its reasoning, your position, what you're willing to
concede. The other side's agent can probe freely, and any free-text response is
a channel.

**A concrete example.** Alice and Bob are in a workplace dispute. Each has asked
their AI assistant to help navigate it. The assistants begin coordinating
directly. Alice's assistant knows she's exhausted and would accept a minor
accommodation to resolve things quickly. Bob's assistant, in the course of
normal negotiation dialogue, can surface that in minutes — not by hacking
anything, but by asking reasonable clarifying questions and reading the shape of
the responses. Alice's bottom line is now Bob's leverage.

The obvious fixes don't work:

| Approach | What it does | Why it fails |
|----------|--------------|--------------|
| Prompt engineering ("be discreet") | Tells the model to be careful | Models comply, then reveal via tone, framing, or what they decline to say |
| Output filtering / redaction | Blocks sensitive patterns post-generation | The model already processed the data; covert channels live in word choice, length, and structure |
| Free-text with careful instructions | Limits what the model says | Any variable-length, open-ended response is an information channel by construction |

The problem isn't model behaviour. It's that free-text communication has
unbounded expressive capacity. You can't constrain what leaks without
constraining the channel itself.

**Why now.** Every major platform is building agent ecosystems. Agents are
already being asked to negotiate prices, screen candidates, manage schedules,
and mediate disputes — tasks where what your agent knows about you is exactly
what the other side wants to learn. The infrastructure assumption underlying all
of it is that agent-to-agent communication is fine to leave as free-form text.
That assumption has a short shelf life. HTTPS was overkill for blogs until
agents started handling contracts.

AgentVault solves this mechanically:

1. **Bounded disclosure** — a JSON Schema limits what the model can express.
   Output that doesn't validate is rejected, not returned.
2. **Cryptographic receipts** — every session produces a signed receipt binding
   the exact contract, guardian policy, prompt template, model profile, and relay
   build that governed execution. Tamper-evident and independently verifiable.
3. **Escalation path** — when a session detects policy violations or anomalous
   entropy, the protocol can escalate to a hardened sealed-execution environment
   rather than silently degrading.

The relay enforces constraints at the infrastructure layer — the model never sees
the enforcement rules, and cannot negotiate around them.

## How it works

1. **Discovery** — agents publish signed descriptors declaring their identity, capabilities, and cryptographic keys
2. **Proposal** — an initiator proposes a session to a responder, referencing specific terms (purpose, schema, model profile)
3. **Admission** — the responder admits or denies (denial is constant-shape with no reason field, preventing information leakage)
4. **Commitment** — the initiator commits encrypted input, cryptographically bound to the admitted terms via AAD
5. **Relay execution** — both inputs submitted to the relay, which assembles a prompt from a content-addressed template, calls the model, validates output against the schema, and applies guardian rules
6. **Receipt** — the relay signs a receipt binding the full provenance chain: contract hash, guardian policy hash, prompt template hash, model profile hash, relay build hash, and the bounded output

Every artefact in the chain — contracts, schemas, prompt templates, model profiles, guardian policies — is content-addressed (SHA-256 over RFC 8785 JCS canonicalization). The receipt proves which exact versions governed the session.

## What's in this repo

| Package | Language | Description |
|---------|----------|-------------|
| `agentvault-relay` | Rust | Stateless API-mediated relay with schema validation, guardian policy enforcement, and Ed25519 receipt signing |
| `agentvault-client` | TypeScript | Standalone relay client library (fetch-based, no orchestrator dependencies) |
| `agentvault-mcp-server` | TypeScript | MCP server exposing `agentvault.*` tools for agent integration |

## Getting started

```bash
# Build
cargo build --workspace

# Run tests
cargo test --workspace
```

See [Getting Started](docs/getting-started.md) for running the relay and
executing your first session.

Requires Rust 1.88.0+ (see `rust-toolchain.toml`).

### TypeScript packages

```bash
cd packages/agentvault-client && npm install && npm test
cd packages/agentvault-mcp-server && npm install && npm run build
```

## Documentation

- [Getting Started](docs/getting-started.md) — run the relay and execute your first session
- [API Reference](docs/api-reference.md) — HTTP endpoints, authentication, request/response shapes
- [Environment Variables](docs/environment-variables.md) — configuration reference
- [Testing Guide](docs/testing.md) — running and writing tests
- [Roadmap](docs/roadmap.md) — design principles and development phases

JSON Schemas for input payloads live in `schemas/`.

Claude Code skills for contributor workflows live in `skills/`.

## Ecosystem

AgentVault depends on [vault-family-core](https://github.com/vcav-io/vault-family-core) for shared protocol types, receipt signing, and the AFAL (Agent Federation and Admission Layer) handshake implementation. Part of a broader protocol family for agent coordination.

## License

MIT OR Apache-2.0
