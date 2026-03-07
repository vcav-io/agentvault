# Getting Started

## How it works

```
  Agent A                    Relay                    Agent B
    |                          |                          |
    |   submit input --------► | ◄-------- submit input   |
    |                          |                          |
    |                    ┌─────┴─────┐                    |
    |                    │  assemble  │                    |
    |                    │   prompt   │                    |
    |                    │  call LLM  │                    |
    |                    │  validate  │                    |
    |                    │  against   │                    |
    |                    │  schema +  │                    |
    |                    │  guardian  │                    |
    |                    │  policy    │                    |
    |                    └─────┬─────┘                    |
    |                          |                          |
    |   ◄──── output + receipt ┼ receipt + output ────►   |
    |                          |                          |
    ▼                          ▼                          ▼
              Verifier confirms receipt signature
```

Both agents submit structured input. The relay assembles a prompt from a content-addressed template, calls the model, validates the output against a JSON Schema, applies guardian rules, and returns the bounded output with a signed receipt. Neither agent sees the other's raw input.

## Try it (5 minutes)

Two co-founders mediate a strategy disagreement through their AI agents — each shares private concerns that the other never sees directly. The relay produces a bounded mediation signal and a cryptographic receipt.

### Option A: Docker (recommended)

No Rust or Node.js required — just Docker.

```bash
# 1. Add your API key (any provider works)
echo "GEMINI_API_KEY=AIza..." > .env
# or: echo "OPENAI_API_KEY=sk-..." > .env
# or: echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 2. Start the relay and demo UI
docker compose -f docker/docker-compose.demo.yml --env-file .env up

# 3. Open http://localhost:3200 and click "Start Protocol"
```

To stop: press `Ctrl-C` or `docker compose -f docker/docker-compose.demo.yml --env-file .env down`.

### Option B: Build from source

Requires Rust 1.88+ and Node.js.

```bash
# 1. Add your API key (any provider works)
echo "GEMINI_API_KEY=AIza..." > .env
# or: echo "OPENAI_API_KEY=sk-..." > .env
# or: echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 2. Build and start everything (relay + demo server, opens browser)
./run-demo.sh

# 3. Click "Start Protocol" in the browser
```

The script builds the relay from source, starts it, builds the demo UI server, and opens your browser. To stop: press `Ctrl-C`.

### What to expect

The demo UI opens with a **scenario picker** (15 built-in scenarios covering mediation, compatibility, scheduling, and more), **provider and model selectors** so you can switch between Gemini/OpenAI/Anthropic mid-session, and a **canary checking toggle** that tests whether private input leaked into the output.

1. Pick a scenario (or keep the default mediation). Select a provider and model.
2. Click **Start Protocol** — Alice's agent creates a vault session and submits her private concerns
3. Bob's agent discovers the pending session and submits his private concerns
4. The relay runs inference — both inputs go to the LLM together, but the output contains only the mediation signal (no raw concerns)
5. Both agents retrieve the same structured output. The **signal overlay** highlights key fields in the bounded output.
6. A signed receipt is produced proving what was computed and when
7. If canary checking is enabled, the UI scans the output for **canary phrases** — fragments of each agent's private input that should never appear in the bounded signal. A pass means the schema and guardian policy successfully contained disclosure.

### Provider notes

The demo supports three LLM providers. You can configure multiple API keys and select the provider in the UI before starting a run.

| Provider | Agent model (default) | Relay model (default) | Approx. cost/run | Notes |
|----------|----------------------|----------------------|-------------------|-------|
| Gemini | gemini-2.5-flash | gemini-2.5-flash | ~$0.01 | Cheapest stable option; all Gemini models tested pass |
| OpenAI | gpt-4.1-mini | gpt-4.1-mini | ~$0.02 | Reliable; gpt-4.1-nano and gpt-5-nano/mini fail quality |
| Anthropic | claude-haiku-4-5-20251001 | claude-haiku-4-5-20251001 | ~$0.03 | High quality; both haiku and sonnet pass |

Run `./tests/live/sweep.sh` to test which models pass the mediation quality threshold on your API keys. The sweep prints a summary table with PASS/FAIL per provider+model combo and flags any current default that fails.

**Relay model quality matters more than agent model.** Agents just do tool-calling (check inbox, submit input); the relay model performs the actual mediation inference. If you see `NO_COMMON_GROUND_DETECTED` results, try switching the relay to a different provider.

To set all three keys (enables switching in UI):
```bash
echo "GEMINI_API_KEY=AIza..." >> .env
echo "OPENAI_API_KEY=sk-..." >> .env
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
```

## What just happened

At a high level: both agents submitted private input, the relay produced a bounded signal, and a signed receipt proves which rules governed the session. Here is what happened at each layer.

### Contract and content addressing

The session was created under a **contract** that pins every parameter: purpose code, output schema, prompt template, model profile, and enforcement policy. Each component is identified by its SHA-256 hash. The contract itself is hashed (JCS-canonicalized JSON), and that `contract_hash` appears in the receipt. Changing any component — even a single schema field — produces a different hash, so both agents can verify they participated under the same rules.

### Schema-enforced output bounding

The relay does not return free text. The LLM output must parse as valid JSON conforming to the contract's **output schema**. If it doesn't, the session aborts with `SchemaValidation` — nothing is returned. This is the structural bound: the schema defines exactly which fields can leave the session and their types. Enum fields with fixed variants limit the output to a known set of values; the relay measures the **channel capacity** (maximum information the schema can carry) and includes it in the receipt.

### Guardian policy enforcement

After schema validation, the **guardian policy** applies semantic rules — for example, rejecting output that contains PII, raw financial figures, or verbatim fragments of either agent's input. Guardian rules are themselves content-addressed and pinned in the contract. The canary check in the demo UI is a client-side echo of this: it tests whether recognizable fragments of private input survived into the output.

### Receipt and signature

A **v2.1 receipt** is produced binding the contract hash, guardian policy hash, prompt template hash, model profile hash, relay build hash, channel capacity measurement, and the output itself into a single signed envelope. The Ed25519 signature proves that the relay attests to this specific combination. The receipt does not prove relay honesty or input confidentiality from the relay — it proves which rules the relay claims to have applied. Independent verification requires a TEE attestation (see [Protocol Specification](protocol-spec.md)).

### Ephemeral execution

The relay discards raw inputs after receipt construction. Only commitment hashes (SHA-256 of each agent's input) persist in the receipt. Session data does not outlast execution — there is no transcript, no conversation log, no stored context.

## Alternative: CLI demo with Claude Code

If you want to see individual agents running in their own terminals (rather than the browser UI), there's a CLI demo that uses Claude Code:

```bash
# Requires Claude Code (https://claude.ai/code) + Anthropic API key
./demo/setup.sh
```

This creates isolated workspaces for two agents, prints prompts to paste, and lets you watch each agent's reasoning in real time. See [demo/README.md](../demo/README.md) for details.

## Next steps

- [API Reference](api-reference.md) — full endpoint documentation
- [Run the Relay from Source](relay-dev-setup.md) — build and run the relay locally for development
- [Protocol Specification](protocol-spec.md) — formal protocol definition
- [Roadmap](roadmap.md) — design principles and what's coming next
