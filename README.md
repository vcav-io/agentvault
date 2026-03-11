<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
  <img alt="AgentVault" src=".github/logo-light.svg" height="48">
</picture>

People already share deeply personal context with AI — health concerns, financial anxieties, private doubts. AI agents that carry that context are beginning to coordinate directly with each other.

That creates huge potential utility, but also serious disclosure risk.

The obvious mitigation is to strip agents of context before they coordinate. But context-free agents can only do shallow work. The real opportunity is the opposite: agents reasoning together with full context on things that are genuinely hard to do alone — negotiation, mediation, compatibility, dispute resolution.

AgentVault is built for those cases. It constrains what can be revealed during coordination through fixed contracts, schema-bound outputs, and verifiable receipts. The same protocol runs as a conventional relay (this repo) or inside a hardware-isolated TEE ([av-tee](https://github.com/vcav-io/av-tee)), where AMD SEV-SNP attestation binds the receipt to a measured execution environment.

---

## Run the demo UI (recommended)

This demo shows the protocol flow end-to-end. Two agents submit private context, the relay produces a schema-bounded mediation signal, and a receipt card appears showing the contract, enforcement layers, and verification data. Fifteen built-in scenarios are included.

```bash
git clone https://github.com/vcav-io/agentvault && cd agentvault

# 1. Add your API key (any provider works)
echo "GEMINI_API_KEY=AIza..." > .env
# or: echo "OPENAI_API_KEY=sk-..." > .env
# or: echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 2. Run the demo (Docker, builds the current local source)
docker compose -f docker/docker-compose.demo.yml --env-file .env up --build

# 3. Open http://localhost:3200 and click "Start Protocol"
```

The first build can take a few minutes. This path now builds the checked-out `main`
source, so the demo UI stays aligned with the repo rather than relying on a
previously published image.

No Docker? Build from source:

```bash
./run-demo.sh
```

Requires Rust 1.88+ and Node.js.

See [docs/getting-started.md](docs/getting-started.md) for provider options, model recommendations, and the full walkthrough.

---

```
agents → contract → relay enforcement → bounded signal → receipt
```

> **The relay sees both inputs in plaintext.** Counterparty confidentiality is enforced, neither agent sees the other's raw context. Relay confidentiality is not. The bounded output is the point. The relay enforces a JSON Schema that structurally limits what can leave, independent of model behavior. The receipt proves the output satisfied the contract and schema. It does **not** prove the relay did not inspect or log the inputs, or fabricate the output. The [TEE lane](https://github.com/vcav-io/av-tee) removes this assumption. The same protocol runs inside an AMD SEV-SNP confidential VM (validated on GCP N2D), where hardware attestation binds the receipt to a measured execution environment. See [docs/threat-model.md](docs/threat-model.md).

---

### Current trust model (today)

| | Software lane | TEE lane |
|---|---|---|
| **Counterparty disclosure** | Bounded by schema | Bounded by schema |
| **Relay operator** | Trusted (sees plaintext) | Excluded (hardware-encrypted) |
| **Model provider** | Trusted (sees prompt) | Trusted (sees prompt) |
| **Receipt assurance** | `SELF_ASSERTED` | `TEE_ATTESTED` |

The software lane is available now. The TEE lane has been hardware-validated on GCP N2D (AMD SEV-SNP). See [docs/threat-model.md](docs/threat-model.md) for the full adversary analysis and assurance tier definitions.

---

## What you just ran

- Both agents submitted private context under a fixed contract — neither saw the other's raw input
- The relay validated the model output against a JSON Schema — anything outside the allowed structure was rejected, not returned
- A **guardian policy** applied a second enforcement layer, blocking raw numerics and currency symbols in string fields
- The result was a **bounded signal** — a compressed, schema-constrained output, not free text
- A **signed receipt** records what governed the session — split into **commitments** (independently verifiable) and **claims** (relay-asserted)
- Raw inputs were discarded after signing — only commitment hashes persist

---

## Verify the receipt

After the run completes, click **Verify Signature** on any result card.

### What verification proves

- The receipt was signed by the relay that served this session
- The output in the receipt has not been modified since signing
- The contract, schema, prompt template, and guardian policy hashes are internally consistent
- Your input commitment (SHA-256 of your own input) matches what the relay recorded

### What it does not prove

- That the relay actually executed the model it claims to have run
- That the relay did not inspect or log your input

In the software lane, assurance level is `SELF_ASSERTED` — the relay asserts its own honesty. The [TEE lane](https://github.com/vcav-io/av-tee) raises this to `TEE_ATTESTED`: the same protocol runs inside an AMD SEV-SNP confidential VM (validated on GCP N2D), where attestation binding and transcript hashes are included in the receipt.

See [docs/receipt-verification-guide.md](docs/receipt-verification-guide.md) for the full verification algorithm, field reference, and TypeScript/Python examples.

---

## Build a contract

Contracts compose from registry artefacts. Browse what is available, assemble a contract, and run it:

```bash
# List registered schemas
av-contract list --kind schema

# Build a contract from registry artefacts
av-contract build \
  --schema mediation-triage-v2 \
  --policy safe-string-guard \
  --program bilateral-mediation

# Run it
curl -X POST http://localhost:8080/api/sessions \
  -H "Content-Type: application/json" \
  -d @contract.json
```

The contract builder resolves artefacts, validates compatibility between schemas and policies, and computes the contract hash. See [docs/api-reference.md](docs/api-reference.md) and [docs/protocol-spec.md](docs/protocol-spec.md) for the current public contract and relay references.

---

## What's in this repo

| Component | Description |
|---|---|
| `agentvault-demo-ui` | Optional browser UI for running and observing bounded-disclosure sessions |
| `agentvault-relay` (Rust) | Ephemeral relay enforcing schema validation, guardian policy, and receipt signing (no persistent storage; bilateral sessions hold state in memory until inference completes) |
| `agentvault-client` (TypeScript) | Standalone relay client library |
| `agentvault-mcp-server` (TypeScript) | MCP server exposing `agentvault.*` tools for agent integration |
| Artefact registry | Content-addressed ecosystem of schemas, policies, profiles, and prompt programs |
| Contract CLI (`av-contract`) | Compose and validate contracts from registry artefacts |

Use the MCP server for agent frameworks, the TypeScript client for direct HTTP integration, or run your own relay for full control.

Shared protocol types and AFAL handshake implementation live in [vault-family-core](https://github.com/vcav-io/vault-family-core).

---

## Two execution lanes

The same protocol runs in two lanes: a software lane (this repo) where the relay operator is trusted, and a sealed execution lane ([av-tee](https://github.com/vcav-io/av-tee)) where hardware attestation replaces that trust.

---

## Go deeper

- [Getting started](docs/getting-started.md) - full walkthrough, provider setup, CLI demo
- [Demo integrity rules](docs/architecture/demo-integrity-rules.md) - design constraints for prompts, system prompts, and the demo UI
- [Threat model](docs/threat-model.md) - trust boundaries, adversary analysis, assurance tiers
- [Receipt verification guide](docs/receipt-verification-guide.md) - algorithms, field reference, code examples
- [Schema versioning policy](docs/schema-versioning-policy.md) - schema content addressing and receipt binding
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
