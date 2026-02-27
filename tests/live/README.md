# Live E2E Test: Two Claude Code Sessions via Async Inbox

Two independent Claude Code sessions (Alice and Bob) communicate through the
relay inbox. Bob discovers Alice's invite through `get_identity` — no
out-of-band instruction needed.

## Invariants

- **Durability**: Bob starts AFTER Alice (30s+ gap). The invite remains PENDING
  in the relay until Bob comes online and polls.
- **No synchrony coincidence**: Alice sends the invite before Bob's session starts.
- **Agent-driven discovery**: Bob finds the invite via `get_identity` returning
  `pending_invites > 0` and follows `next_action`.
- **Token alignment**: Tokens in `agent-*.mcp.json` must match `harness/agents.json`.
- **Digit/currency guard**: The relay's COMPATIBILITY v2 schema enforces the
  digit (Nd) / currency (Sc) GATE rule — output contains no numeric characters
  or currency symbols.

## Setup

```bash
# 1. Build relay
cargo build -p agentvault-relay

# 2. Build MCP server
cd packages/agentvault-mcp-server && npm run build && cd ../..

# 3. Source env (needs ANTHROPIC_API_KEY)
. .env

# 4. Start relay
VCAV_AGENT_REGISTRY_PATH="$(pwd)/tests/live/harness/agents.json" \
VCAV_PROMPT_PROGRAM_DIR="$(pwd)/packages/agentvault-relay/prompt_programs" \
cargo run -p agentvault-relay

# 5. Verify
curl http://localhost:3100/health
```

## Running

### Terminal 1 — Alice (initiator)

```bash
claude --mcp-config tests/live/agent-alice.mcp.json
```

Prompt Alice with context about being an angel investor and ask her to start a
confidential compatibility check with bob. Wait for Alice to confirm the invite
is sent (state = AWAITING). Note the timestamp.

**Wait at least 30 seconds** before starting Bob.

### Terminal 2 — Bob (responder)

```bash
claude --mcp-config tests/live/agent-bob.mcp.json
```

Prompt Bob with context about being an edtech startup founder. Do NOT mention
Alice or any pending invite — Bob should discover it via `get_identity`.

Bob's agent calls `get_identity`, sees `pending_invites: 1` with `next_action`,
and follows it by calling `agentvault.relay_signal` in RESPOND mode.

### Resume Loop

Both agents receive `action_required: CALL_AGAIN` with a `resume_token`.
They call `agentvault.relay_signal` with ONLY the resume token until
`state: COMPLETED`.

## Success Criteria

1. Both agents reach `state: COMPLETED`
2. Output contains bounded COMPATIBILITY signal (enum fields only)
3. Receipt is present with valid signature
4. No sensitive data leaked (Alice's dollar amounts, Bob's ARR/valuation/headcount)
5. Durability proven: invite was PENDING for >= 30 seconds
6. No synchrony coincidence: Alice sent invite before Bob's session started
7. Bob discovered invite via system (`get_identity` returned `pending_invites > 0`)
8. Digit/currency guard active: output contains no Nd or Sc characters
