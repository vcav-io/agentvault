# Getting Started

## What this demo shows

AgentVault lets two AI agents coordinate over private context without revealing that context directly to each other. In this demo, each side submits sensitive input, the relay computes a bounded structured result under a fixed contract, and both sides receive the same output plus a signed receipt proving what governed the session.

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

No Rust or Node.js required. Just Docker.

```bash
# 1. Add your API key (set multiple to switch providers in the UI)
echo "GEMINI_API_KEY=AIza..." > .env
# echo "OPENAI_API_KEY=sk-..." >> .env
# echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env

# 2. Start the relay and demo UI
docker compose -f docker/docker-compose.demo.yml --env-file .env up

# 3. Open http://localhost:3200 and click "Start Protocol"
```

To stop:

```bash
docker compose -f docker/docker-compose.demo.yml --env-file .env down
```

### Option B: Build from source

Requires Rust 1.88+ and Node.js.

```bash
# 1. Add your API key (set multiple to switch providers in the UI)
echo "GEMINI_API_KEY=AIza..." > .env
# echo "OPENAI_API_KEY=sk-..." >> .env
# echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env

# 2. Build and start everything
./run-demo.sh
```

Then click **Start Protocol** in the browser.

### What to expect

The demo UI opens with:

- A **scenario picker** with 15 built-in scenarios
- **Provider and model selectors**
- An optional **canary checking toggle** to test whether private input leaked into the output

Typical flow:

1. Pick a scenario and model.
2. Click **Start Protocol**.
3. Each side submits private input through its agent.
4. The relay runs inference and returns a bounded structured output, not the raw private inputs.
5. Both agents receive the same output and a signed receipt.
6. If canary checking is enabled, the UI scans the output for phrases that should never have escaped from private input.

### Important trust note

This demo uses the software lane. The relay still sees plaintext inputs during execution. The receipt proves what contract, schema, policy, and build the relay claims to have used. It does not by itself prove confidentiality from the relay or model provider. A TEE-backed execution path is already implemented separately in [av-tee](https://github.com/vcav-io/av-tee) for a narrower trust surface.

## What just happened

At a high level, both agents submitted private input, the relay produced a bounded signal, and a signed receipt proves which rules governed the session.

### Contract and content addressing

Each session runs under a **contract** that pins the purpose, output schema, prompt template, model profile, and enforcement policy. Each component is content-addressed by SHA-256. The contract itself is hashed (JCS-canonicalized JSON), and that `contract_hash` appears in the receipt.

If any component changes, the hash changes too. That lets both agents verify they participated under the same rules.

### Schema-enforced output bounding

The relay does not return free text. The model output must parse as valid JSON and conform to the contract's **output schema**. If it does not, the session aborts.

This is the main structural bound. The schema defines exactly which fields can leave the session and what form they can take.

### Guardian policy enforcement

After schema validation, the **guardian policy** applies semantic checks — for example, rejecting output that contains PII, raw financial figures, or verbatim fragments of either agent's input.

The canary check in the demo UI is a client-side test for the same basic failure mode: did recognizable private text leak into the bounded output?

### Receipt and signature

A **v2.1 receipt** binds the contract hash, guardian policy hash, prompt template hash, model profile hash, relay build hash, channel capacity measurement, and output into a signed envelope.

The Ed25519 signature proves that the relay attests to this specific combination.

### Ephemeral execution

The relay discards raw inputs after receipt construction. Only commitment hashes of each agent's input persist in the receipt.

## Provider support

You can configure multiple API keys and switch providers in the UI before starting a run.

| Provider | Agent model (default) | Relay model (default) | Approx. cost/run | Notes |
|----------|----------------------|----------------------|-------------------|-------|
| Gemini | gemini-2.5-flash | gemini-2.5-flash | ~$0.01 | Cheapest stable option |
| OpenAI | gpt-4.1-mini | gpt-4.1-mini | ~$0.02 | Reliable default |
| Anthropic | claude-haiku-4-5-20251001 | claude-haiku-4-5-20251001 | ~$0.03 | High quality |

## Alternative: CLI demo with Claude Code

If you want to watch individual agents run in separate terminals rather than in the browser UI, there is a CLI demo using Claude Code:

```bash
./demo/setup.sh
```

See [demo/README.md](../demo/README.md) for details.

## Next steps

- [API Reference](api-reference.md) — full endpoint documentation
- [Run the Relay from Source](relay-dev-setup.md) — build and run the relay locally for development
- [Protocol Specification](protocol-spec.md) — formal protocol definition
- [Roadmap](roadmap.md) — design principles and what is coming next
