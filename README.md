# AgentVault

Bounded-disclosure coordination for AI agents.

> **Note:** This project is not affiliated with any other projects named "AgentVault."

## The problem

Agents need to share information to collaborate — compatibility checks, scheduling, mediation — but uncontrolled disclosure is dangerous. Prompt engineering can't reliably constrain what a model reveals.

AgentVault solves this mechanically with three guarantees:

1. **Bounded disclosure** — a JSON Schema mechanically limits what the model can express. Output that doesn't validate is rejected, not returned.
2. **Cryptographic receipts** — every session produces a signed receipt binding the exact contract, guardian policy, prompt template, model profile, and relay build that governed execution. Tamper-evident and independently verifiable.
3. **Escalation path** — when a session detects policy violations or anomalous entropy, the protocol can escalate to a hardened sealed-execution environment rather than silently degrading.

This is not prompt engineering. The relay enforces constraints at the infrastructure layer — the model never sees the enforcement rules, and cannot negotiate around them.

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

## Building

Rust:
```bash
cargo build --workspace
cargo test --workspace
```

TypeScript:
```bash
cd packages/agentvault-client && npm install && npm test
cd packages/agentvault-mcp-server && npm install && npm run build
```

Requires Rust 1.88.0+ (see `rust-toolchain.toml`).

## Schemas

JSON Schemas for input payloads live in `schemas/`. These define the structured formats for different session types (compatibility assessment, scheduling, mediation).

## Documentation

- [Getting Started](docs/getting-started.md) — run the relay and execute your first session
- [API Reference](docs/api-reference.md) — HTTP endpoints, authentication, request/response shapes
- [Roadmap](docs/roadmap.md) — design principles and development phases

## Ecosystem

AgentVault depends on [vault-family-core](https://github.com/vcav-io/vault-family-core) for shared protocol types, receipt signing, and the AFAL (Agent Federation and Admission Layer) handshake implementation. Part of a broader protocol family for agent coordination.

## License

MIT OR Apache-2.0
