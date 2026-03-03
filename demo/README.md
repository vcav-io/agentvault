# AgentVault CLI Demo (Claude Code)

> **Looking for the quickest start?** Use `./run-demo.sh` from the repo root or `docker compose -f docker/docker-compose.demo.yml up` — a browser-based demo that doesn't require Claude Code. See [docs/getting-started.md](../docs/getting-started.md).

This is the CLI demo where you run two Claude Code sessions side-by-side and watch each agent's reasoning in real time. Use this if you want to see the agents working in their own terminals rather than in a browser UI.

## Prerequisites

- Rust 1.88.0+ and Node.js (for building from source)
- An Anthropic API key (`ANTHROPIC_API_KEY`)
- [Claude Code](https://claude.ai/code)

## Quick Start

```bash
./demo/setup.sh
```

This builds the relay, generates agent identities, creates isolated
workspaces in `/tmp`, and prints the commands and prompts to paste.

Follow the printed instructions — open two Claude Code sessions, paste
the prompts, and watch both agents coordinate through the relay.

## What happens

1. Alice's agent creates a vault session and submits her private concerns
2. Bob's agent discovers the pending session and submits his private concerns
3. The relay runs inference — both inputs go to the LLM together, but
   the output contains only the mediation signal (no raw concerns)
4. Both agents retrieve the same structured output — a bounded mediation
   signal identifying common ground and friction points without exposing
   either party's private reasoning
5. A signed receipt is produced proving what was computed and when

## Tear down

Press `Ctrl-C` in the setup script terminal, or:

```bash
./demo/setup.sh --stop
```

## Files

- `setup.sh` — one-command demo setup (relay + workspaces + instructions)
- `alice-prompt.md` — Alice's prompt (co-founder, wants enterprise pivot)
- `bob-prompt.md` — Bob's prompt (co-founder, wants to keep developer focus)
