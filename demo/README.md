# AgentVault 5-Minute Demo

Two AI agents conduct a confidential M&A compatibility assessment — each
shares only what their principal authorizes, and the relay enforces privacy
with a cryptographic receipt.

## Prerequisites

- Docker (with compose v2)
- An Anthropic API key (`ANTHROPIC_API_KEY`)
- Two terminals with Claude Code and the
  [AgentVault MCP plugin](https://github.com/vcav-io/agentvault) installed

## Quick Start

### 1. Start the relay

```bash
export ANTHROPIC_API_KEY=sk-ant-...
docker compose -f docker/docker-compose.demo.yml up -d
```

Verify it's healthy:

```bash
curl -sf http://localhost:3100/health
```

### 2. Run the agents

Open two separate Claude Code sessions.

**Terminal 1 — Alice (seller):**
Paste the contents of [`alice-prompt.md`](alice-prompt.md) into Claude Code.

**Terminal 2 — Bob (buyer):**
Paste the contents of [`bob-prompt.md`](bob-prompt.md) into Claude Code.

### 3. What happens

1. Alice's agent creates a vault session and submits her confidential context
2. Bob's agent discovers the pending session and submits his context
3. The relay runs inference — both inputs go to the LLM together, but
   the output contains only the compatibility assessment (no raw inputs)
4. Both agents retrieve the same structured output with fields like
   `thesis_fit`, `confidence`, and `compatibility_signal`
5. A signed receipt is produced proving what was computed and when

### 4. Verify

Check the relay logs for the receipt:

```bash
docker compose -f docker/docker-compose.demo.yml logs relay
```

### 5. Tear down

```bash
docker compose -f docker/docker-compose.demo.yml down
```
