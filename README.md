<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
  <img alt="AgentVault" src=".github/logo-light.svg" height="48">
</picture>

AI agents are becoming delegates.
We have no infrastructure for private coordination between them.

People already share deeply personal context with AI — health concerns, financial anxieties, private doubts. Those agents increasingly act on their users' behalf.

The next step is inevitable: agents coordinating directly with each other.

When that happens, the full private context they carry becomes part of the interaction surface.

---

**The problem is not misalignment.
The problem is channel capacity.**

When agents coordinate in free text, the channel has no bounds. There is no structural limit on what one agent can disclose to another — no schema constraining the output, no contract governing the terms, no receipt proving what was said. Discretion, where it exists at all, relies on the model choosing to withhold.

The obvious mitigation is to strip agents of context before they coordinate.
But context-free agents can only do shallow work.

The real opportunity is the opposite: agents reasoning together with full context to help with things that are genuinely hard to do alone — negotiation, mediation, compatibility, dispute resolution.

That makes the infrastructure problem harder, not easier.

We built TLS for web traffic.
We built enclaves for confidential computation.
We built nothing for agent-to-agent reasoning.

---

## AgentVault is a coordination primitive for bounded disclosure.

It allows agents to reason freely inside a constrained execution environment, while strictly limiting what can leave.

This does not eliminate all covert channels. Structured outputs still carry signal through field presence, value ranges, and schema shape. What AgentVault eliminates is the *unbounded* channel — the open-ended free-text surface where fine-grained private reasoning leaks by default. The residual channel is narrow, auditable, and governed by explicit contracts.

That is a structural shift from implicit leakage to explicit governance.

---

## What AgentVault Enforces

**Bounded disclosure**
Outputs are constrained by JSON Schema. Anything that does not validate is rejected, not returned. The channel is structurally narrowed.

**Cryptographic receipts**
Every session produces a signed receipt binding the exact contract, prompt template, guardian policy, model profile, and relay build that governed execution. Coordination becomes auditable and independently verifiable.

**Infrastructure-level enforcement**
Constraints are enforced by the relay, not by the model. The model never sees the enforcement rules and cannot negotiate around them.

**Escalation when required**
Sessions that exceed policy or entropy thresholds can escalate to a hardened sealed-execution environment rather than silently degrading.

AgentVault is not an agent.
It is infrastructure for agent-to-agent coordination under bounded disclosure.
It is designed to be embedded inside agent frameworks, not replace them.

---

## How It Works

1. **Discovery** — agents publish signed descriptors declaring identity, capabilities, and cryptographic keys
2. **Proposal** — one agent proposes a session referencing a specific contract, schema, and model profile
3. **Admission** — the counterparty admits or denies using constant-shape responses, preventing leakage through the denial itself
4. **Commitment** — encrypted inputs are bound to the admitted terms via AAD
5. **Relay execution** — the relay assembles the prompt from content-addressed artefacts, calls the model, validates output against schema, and applies guardian policy
6. **Receipt** — the relay signs a receipt binding the full provenance chain and the bounded output

Every artefact — contracts, schemas, prompt templates, guardian policies, model profiles — is content-addressed (SHA-256 over canonical JSON) and versioned. The receipt proves exactly which rules governed the session.

---

## Why This Matters

Delegation changes power.

When people act directly, their discretion is personal, contextual, and deniable — shaped by judgment in the moment. When agents act for them, discretion must be mechanical. It has to be built in, not assumed.

If agent ecosystems are going to mediate real human stakes — relationships, contracts, employment, governance — we need structural guarantees about what can and cannot be revealed. Human discretion is inconsistent by design. Agent discretion needs to be consistent by construction.

AgentVault defines that primitive.

---

## Repository Structure

| Package | Language | Description |
|---|---|---|
| `agentvault-relay` | Rust | Stateless relay enforcing schema validation, guardian policy, and receipt signing |
| `agentvault-client` | TypeScript | Standalone relay client library |
| `agentvault-mcp-server` | TypeScript | MCP server exposing `agentvault.*` tools for integration |

Shared protocol types and AFAL handshake implementation live in [vault-family-core](https://github.com/vcav-io/vault-family-core).

---

## Getting Started

```bash
# Build
cargo build --workspace

# Run tests
cargo test --workspace
```

TypeScript packages:

```bash
cd packages/agentvault-client && npm install && npm test
cd packages/agentvault-mcp-server && npm install && npm run build
```

See [docs/getting-started.md](docs/getting-started.md) to run your first session.

Requires Rust 1.88.0+.

---

## License

MIT OR Apache-2.0

---

*Not affiliated with any other projects named "AgentVault."*
