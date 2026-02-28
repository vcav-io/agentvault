# Live E2E Test: Async Inbox

## Protocol Validation (drive-inbox.sh)

`drive-inbox.sh` validates the async inbox wire format end-to-end against a real
provider. It exercises the full invite → accept → session → output flow via HTTP,
proving durability and correctness without requiring an agent runtime.

```bash
./tests/live/drive-inbox.sh --provider anthropic --delay 10
```

This is the gate for roadmap item 11a: wire format validation before type extraction.

## Two-Agent Live Test (OpenClaw)

The two-agent test requires **OpenClaw**, not Claude Code. Claude Code is
request-response — the agent only acts when the human presses Enter. There is no
event loop to discover an invite that arrives while the agent is idle.

OpenClaw's **heartbeat** solves this: a background loop (default 30 minutes) reads
`HEARTBEAT.md` and decides whether to act. When the heartbeat fires, the agent
calls `get_identity`, sees `pending_invites > 0`, and follows `next_action`
autonomously. No timing coincidence, no out-of-band instruction.

### HEARTBEAT.md

Copy `tests/live/HEARTBEAT.md` to each OpenClaw agent's workspace:

```markdown
# Heartbeat checklist

- Check for pending AgentVault invites: call `agentvault.get_identity`. If `pending_invites > 0`, follow `next_action` (call `agentvault.relay_signal` in RESPOND mode).
```

### Flow

1. **Alice** gets prompted → skill fires → calls `get_identity` → initiates
   COMPATIBILITY → invite sits in relay durably
2. **Bob is idle.** No human involved. Next heartbeat fires → reads `HEARTBEAT.md`
   → calls `get_identity` → sees `pending_invites: 1` → follows `next_action`
   → resume loop runs to completion
3. **No timing coincidence.** The invite waits. The heartbeat finds it.

### Setup

See `docs/guides/openclaw-vps-runbook.md` for full deployment instructions.

Token alignment: inbox tokens in mcporter env config must match
`tests/live/harness/agents.json`.

### Success Criteria

1. Both agents reach `state: COMPLETED`
2. Output contains bounded COMPATIBILITY signal (enum fields only)
3. Receipt is present with valid signature
4. No sensitive data leaked
5. Durability proven: invite survived while Bob was offline
6. No synchrony coincidence: Alice sent invite before Bob's heartbeat discovered it
7. Bob discovered invite via `get_identity` returning `pending_invites > 0`
8. Digit/currency guard active: output contains no Nd or Sc characters
