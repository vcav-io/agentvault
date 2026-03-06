<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
  <img alt="AgentVault" src=".github/logo-light.svg" height="48">
</picture>

AgentVault is an open protocol and reference implementation for bounded, verifiable coordination between AI agents. The protocol design is still evolving.

AI agents increasingly act as delegates. When two agents reason together, private context becomes shared state. AgentVault bounds what one agent can disclose to another. Agents submit inputs to a relay, which enforces a schema-bound output and produces a signed receipt. The relay returns a bounded signal, not free text.

---

## Run the demo UI (recommended)

This demo shows the protocol flow end-to-end. Two agents submit private context, the relay produces a schema-bounded mediation signal, and a receipt card appears showing the contract, enforcement layers, and verification data. Fifteen built-in scenarios are included.

```bash
git clone https://github.com/vcav-io/agentvault && cd agentvault

# 1. Add your API key (any provider works)
echo "GEMINI_API_KEY=AIza..." > .env
# or: echo "OPENAI_API_KEY=sk-..." > .env
# or: echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 2. Run the demo (Docker, no build required)
docker compose -f docker/docker-compose.demo.yml up

# 3. Open http://localhost:3200 and click "Start Protocol"
```

No Docker? Build from source:

```bash
./run-demo.sh
```

Requires Rust 1.88+ and Node.js.

See [docs/getting-started.md](docs/getting-started.md) for provider options, model recommendations, and the full walkthrough.

---

```
Agent A input  \
                 → AgentVault relay → schema-bounded signal → receipt
Agent B input  /
```

> **The relay sees both inputs in plaintext.** Counterparty confidentiality is enforced, neither agent sees the other's raw context. Relay confidentiality is not. The bounded output is the point. The relay enforces a JSON Schema that structurally limits what can leave, independent of model behavior. The receipt proves the output satisfied the contract and schema. It does **not** prove the relay did not inspect or log the inputs, or fabricate the output. See [docs/threat-model.md](docs/threat-model.md).

---

## What you just ran

- A **session** was created under a content-addressed **contract**, purpose code, output schema, and prompt template, all identified by SHA-256 hash
- Both agents submitted private context, neither saw the other's raw input
- The relay assembled the prompt, called the model, and **validated the output against the JSON Schema**. Anything that did not conform was rejected, not returned
- The **guardian policy** applied a second enforcement layer, for example blocking raw numerics and currency symbols in string fields, providing defense in depth
- The model produced a **bounded signal**, a compressed summary of private reasoning under a fixed schema, not a conversation or free text summary
- A **signed receipt (v2)** was produced with two sections  
  - **commitments** (cryptographically verifiable), contract hash, schema hash, input commitment hashes, output  
  - **claims** (relay asserted), model identity, token usage, latency  

  The distinction makes explicit what a verifier can check independently versus what requires trusting the relay
- Raw inputs were discarded after receipt construction. Only commitment hashes persist

---

## Verify the receipt

After the run completes, click **Verify Receipt** on any result card.

### What verification proves

- The receipt was signed by the relay that served this session
- The output in the receipt has not been modified since signing
- The contract, schema, prompt template, and guardian policy hashes are internally consistent
- Your input commitment (SHA-256 of your own input) matches what the relay recorded

### What it does not prove

- That the relay actually executed the model it claims to have run
- That the relay did not inspect or log your input

Current assurance level: `SELF_ASSERTED`. The relay asserts its own honesty. No hardware attestation backs the claim.

See [docs/receipt-verification-guide.md](docs/receipt-verification-guide.md) for the full verification algorithm, field reference, and TypeScript/Python examples.

---

## What's in this repo

| Component | Description |
|---|---|
| `agentvault-demo-ui` | Optional browser UI for running and observing bounded-disclosure sessions |
| `agentvault-relay` (Rust) | Stateless relay enforcing schema validation, guardian policy, and receipt signing |
| `agentvault-client` (TypeScript) | Standalone relay client library |
| `agentvault-mcp-server` (TypeScript) | MCP server exposing `agentvault.*` tools for agent integration |

Use the MCP server for agent frameworks, the TypeScript client for direct HTTP integration, or run your own relay for full control.

Shared protocol types and AFAL handshake implementation live in [vault-family-core](https://github.com/vcav-io/vault-family-core).

---

## Why AgentVault exists

AI assistants increasingly act as delegates for their users.

When those agents begin coordinating directly with each other, the private context they carry becomes part of the interaction surface.

AgentVault explores a different approach. Instead of relying on model discretion, it constrains what can be disclosed through coordination contracts, schema-bound outputs, and verifiable receipts.

---

## Go deeper

- [Getting started](docs/getting-started.md) - full walkthrough, provider setup, CLI demo
- [Threat model](docs/threat-model.md) - trust boundaries, adversary analysis, assurance tiers
- [Receipt verification guide](docs/receipt-verification-guide.md) - algorithms, field reference, code examples
- [API reference](docs/api-reference.md) - relay endpoint documentation
- [Protocol spec](docs/protocol-spec.md) - normative specification

---

## Contributing

We welcome:

- protocol design discussion
- threat model critique
- independent implementations
- documentation improvements
- bug reports and usability feedback

If you are building systems that experiment with agent to agent coordination, we would be interested in hearing from you.

To build and test the project locally:

```bash
cargo build --workspace && cargo test --workspace
cargo clippy --workspace -- -D warnings

cd packages/agentvault-client && npm install && npm test
cd packages/agentvault-mcp-server && npm install && npm run build
```

Requires Rust 1.88.0+. See [docs/relay-dev-setup.md](docs/relay-dev-setup.md) for relay development setup.

---

## License

MIT OR Apache-2.0

---

*Not affiliated with any other projects named "AgentVault."*

