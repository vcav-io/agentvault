<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
  <img alt="Selkey" src=".github/logo-light.svg" height="48">
</picture>

**Selkey is a trusted intermediary for AI agents.** Two agents agree a contract (purpose, prompt hash, and a JSON Schema for the answer), each sends its private context to a relay, and the relay runs a model over both inputs. It releases only output that matches the schema exactly, and both sides get a signed receipt that commits to what was agreed, what went in, and what came out. Neither agent sees the other's raw input.

> **Status:** research software. The software lane works today; its receipts are `SELF_ASSERTED` (the relay's own word about what it ran). The TEE lane ([selkey-tee](https://github.com/vcav-io/selkey-tee)) is a **prototype, not yet secure**: the shipped image runs a simulated runtime with no hardware isolation, the SEV-SNP measurement doesn't yet cover the relay binary, clients don't yet verify attestation before sending inputs, and model identity is provider-reported.

People already share deeply personal context with AI — health concerns, financial anxieties, private doubts. AI agents that carry that context are beginning to coordinate directly with each other.

That creates huge potential utility, but also serious disclosure risk.

The obvious mitigation is to strip agents of context before they coordinate. But context-free agents can only do shallow work. The real opportunity is the opposite: agents reasoning together with full context on things that are genuinely hard to do alone — negotiation, mediation, compatibility, dispute resolution.

Selkey is built for those cases. It constrains what can be revealed during coordination through fixed contracts, schema-bound outputs, and verifiable receipts. The same protocol runs as a conventional relay (this repo) or, as a prototype, inside an AMD SEV-SNP confidential VM ([selkey-tee](https://github.com/vcav-io/selkey-tee)).

---

## Run the demo UI (recommended)

This demo shows the protocol flow end-to-end. Two agents submit private context, the relay produces a schema-bounded mediation signal, and a receipt card appears showing the contract, enforcement layers, and verification data. Fourteen built-in scenarios (including two red-team cases) and a blank template are included.

```bash
git clone https://github.com/vcav-io/selkey && cd selkey

# 1. Add your API key (any provider works)
echo "GEMINI_API_KEY=AIza..." > .env
# or: echo "OPENAI_API_KEY=sk-..." > .env
# or: echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 2. Run the demo (pulls prebuilt images from ghcr.io)
docker compose -f docker/docker-compose.demo.yml --env-file .env up

# 3. Open http://127.0.0.1:3200 and click "Start Protocol"
```

The demo publishes the relay (3100) and UI (3200) on `127.0.0.1` only. It runs the relay with `SELKEY_ENV=dev` and no inbox auth, and the UI streams both agents' sessions, so don't expose these ports beyond your machine. To run a relay for other people, see [docs/environment-variables.md](docs/environment-variables.md#network-binding-and-operator-access) (`SELKEY_BIND_ADDR`, `SELKEY_OPERATOR_TOKEN`).

With prebuilt images you should be running in under five minutes. If the images can't be pulled, Compose builds them from your checkout instead. To update later, run `docker compose -f docker/docker-compose.demo.yml pull`.

To always build from your checkout, add `--build` (about 10 minutes cold):

```bash
docker compose -f docker/docker-compose.demo.yml --env-file .env up --build
```

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

> **The relay sees both inputs in plaintext.** Counterparty confidentiality is enforced, neither agent sees the other's raw context. Relay confidentiality is not. The bounded output is the point. The relay enforces a JSON Schema that structurally limits what can leave, independent of model behavior. The receipt proves the output satisfied the contract and schema. It does **not** prove the relay did not inspect or log the inputs, or fabricate the output. The [TEE lane](https://github.com/vcav-io/selkey-tee) aims to remove this assumption by running the same protocol inside an AMD SEV-SNP confidential VM, but it is a prototype and doesn't remove it yet. See [docs/threat-model.md](docs/threat-model.md).

---

### Current trust model (today)

| | Software lane | TEE lane (prototype, not yet secure) |
|---|---|---|
| **Counterparty disclosure** | Bounded by schema | Bounded by schema |
| **Relay operator** | Trusted (sees plaintext) | Trusted for now (goal: excluded by hardware encryption and attestation) |
| **Model provider** | Trusted (sees prompt) | Trusted (sees prompt) |
| **Model identity** | Provider-reported | Provider-reported |
| **Receipt assurance** | `SELF_ASSERTED` | `SELF_ASSERTED` from the shipped image (simulated runtime); `TEE_ATTESTED` on real SEV-SNP, prototype only |

The software lane is available now. The TEE lane is a prototype, not yet secure: the SEV-SNP runtime has been exercised on GCP N2D, but the shipped image runs a simulated runtime with no hardware isolation, the SEV-SNP measurement doesn't yet cover the relay binary, clients don't yet verify attestation before sending inputs, and model identity is provider-reported (the relay records the model ID returned by the provider's API; nothing binds or verifies which model ran). See [docs/threat-model.md](docs/threat-model.md) for the full adversary analysis and assurance tier definitions.

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

- The receipt was signed by the relay key given to the verifier (the verifier never trusts a key embedded in the receipt). The demo uses `SELKEY_RELAY_VERIFYING_KEY_HEX` if set, and otherwise the configured relay's `/health` key, which is fine locally but isn't a trust anchor: pin the key for real use
- The output in the receipt has not been modified since signing
- The contract, schema, prompt template, and guardian policy hashes are internally consistent
- Your client can check that your input commitment (salted with a nonce only your client knows) matches the input it sent

### What it does not prove

- That the relay actually executed the model it claims to have run
- That the relay did not inspect or log your input

In the software lane, assurance level is `SELF_ASSERTED` — the relay asserts its own honesty. The [TEE lane](https://github.com/vcav-io/selkey-tee) is a prototype, not yet secure. On real SEV-SNP hardware its receipts carry `TEE_ATTESTED` with attestation and transcript hashes, but the measurement doesn't yet cover the relay binary, so they don't yet prove which relay code ran or that the relay didn't see your input.

See [docs/receipt-verification-guide.md](docs/receipt-verification-guide.md) for the full verification algorithm, field reference, and TypeScript/Python examples.

---

## What's in this repo

| Component | Description |
|---|---|
| `selkey-demo-ui` | Optional browser UI for running and observing bounded-disclosure sessions |
| `selkey-relay` (Rust) | Ephemeral relay enforcing schema validation, guardian policy, and receipt signing (no persistent storage; bilateral sessions hold state in memory until inference completes) |
| `selkey` (TypeScript, `packages/selkey-client`) | Standalone relay client library |
| `selkey-mcp` (TypeScript) | MCP server exposing `selkey.*` tools for agent integration |
| Artefact registry | Content-addressed ecosystem of schemas, policies, profiles, and prompt programs |
| Contract CLI (`selkey-contract`) | Compose and validate contracts from registry artefacts |

Use the MCP server for agent frameworks, the TypeScript client for direct HTTP integration, or run your own relay for full control.

Shared protocol types and AFAL handshake implementation live in [vault-family-core](https://github.com/vcav-io/vault-family-core).

---

## Two execution lanes

The same protocol runs in two lanes: a software lane (this repo) where the relay operator is trusted, and a sealed execution lane ([selkey-tee](https://github.com/vcav-io/selkey-tee)) where hardware attestation is meant to replace that trust. The sealed lane is a prototype, not yet secure.

---

## Related work

- [NDAI Agreements](https://arxiv.org/abs/2502.07924) (Stephenson, Miller et al., Feb 2025): TEE-resident agents, with disclosure conditional on a deal.
- [Security awareness in LLM agents: the NDAI zone case](https://arxiv.org/abs/2603.19011) (Bottazzi & Park, Mar 2026): a follow-up to NDAI Agreements.
- [AgentCrypt](https://arxiv.org/abs/2512.08104) (Karthikeyan, Guo, Veloso et al., Dec 2025): tiered privacy and homomorphic encryption for agent collaboration.

Selkey's contribution is a working protocol: contracts that bind the prompt and output schema, the schema as the security boundary, signed receipts that commit to inputs and output, MCP and A2A integration, and both software and TEE lanes.

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

cd packages/selkey-client && npm install && npm test
cd packages/selkey-mcp && npm install && npm run build
```

Requires Rust 1.88.0+. See [docs/relay-dev-setup.md](docs/relay-dev-setup.md) for relay development setup.

---

## License

MIT OR Apache-2.0, at your option. See [LICENSE-MIT](LICENSE-MIT) and [LICENSE-APACHE](LICENSE-APACHE).
