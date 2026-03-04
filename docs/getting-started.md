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
docker compose -f docker/docker-compose.demo.yml up

# 3. Open http://localhost:3200 and click "Start Demo"
```

To stop: press `Ctrl-C` or `docker compose -f docker/docker-compose.demo.yml down`.

### Option B: Build from source

Requires Rust 1.88+ and Node.js.

```bash
# 1. Add your API key (any provider works)
echo "GEMINI_API_KEY=AIza..." > .env
# or: echo "OPENAI_API_KEY=sk-..." > .env
# or: echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 2. Build and start everything (relay + demo server, opens browser)
./run-demo.sh

# 3. Click "Start Demo" in the browser
```

The script builds the relay from source, starts it, builds the demo UI server, and opens your browser. To stop: press `Ctrl-C`.

### What to expect

1. Alice's agent creates a vault session and submits her private concerns
2. Bob's agent discovers the pending session and submits his private concerns
3. The relay runs inference — both inputs go to the LLM together, but the output contains only the mediation signal (no raw concerns)
4. Both agents retrieve the same structured output — a bounded mediation signal identifying common ground and friction points without exposing either party's private reasoning
5. A signed receipt is produced proving what was computed and when

### Provider notes

The demo supports three LLM providers. You can configure multiple API keys and select the provider in the UI before starting a run.

| Provider | Agent model (default) | Relay model (default) | Approx. cost/run | Notes |
|----------|----------------------|----------------------|-------------------|-------|
| Gemini | gemini-2.5-flash | gemini-2.5-flash | ~$0.01 | Cheapest; quality varies — run `sweep.sh` to verify |
| OpenAI | gpt-4.1-mini | gpt-4.1-mini | ~$0.02 | Reliable tool-calling and mediation |
| Anthropic | claude-haiku-4-5-20251001 | claude-haiku-4-5-20251001 | ~$0.03 | High quality mediation output |

Run `./tests/live/sweep.sh` to test which models pass the mediation quality threshold on your API keys. The sweep prints a summary table with PASS/FAIL per provider+model combo and flags any current default that fails.

**Relay model quality matters more than agent model.** Agents just do tool-calling (check inbox, submit input); the relay model performs the actual mediation inference. If you see `NO_COMMON_GROUND_DETECTED` results, try switching the relay to a different provider.

To set all three keys (enables switching in UI):
```bash
echo "GEMINI_API_KEY=AIza..." >> .env
echo "OPENAI_API_KEY=sk-..." >> .env
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
```

## What just happened

- A **session** was created under a specific **contract** — purpose code, output schema, and prompt template, all content-addressed
- Both agents submitted private context; neither saw the other's raw input
- The relay assembled the prompt, called the model, and **validated the output against the JSON Schema** — anything that didn't conform was rejected, not returned
- The **guardian policy** enforced additional constraints (e.g., no PII leakage, no raw financials in output)
- A **signed receipt** was produced binding the exact contract hash, guardian policy hash, prompt template hash, model profile hash, and relay build hash to the output
- **No transcript was stored** — the relay is stateless; session data exists only for the duration of execution

The output is a bounded mediation signal — not a conversation, not a summary, not free text. The schema structurally limits what can leave the session.

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
