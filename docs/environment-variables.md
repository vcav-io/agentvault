# Environment Variables

Complete reference for all environment variables used by the AgentVault relay and MCP server.

## Relay (`agentvault-relay`)

### Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for the default provider |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `AV_PORT` | `3100` | Port the relay listens on |
| `AV_MODEL_ID` | `claude-sonnet-4-6` | Anthropic model ID |
| `AV_SIGNING_KEY_HEX` | ephemeral | 64-char hex Ed25519 signing key for receipt signing. If unset, a random key is generated on each start — receipts won't verify across restarts |
| `AV_PROMPT_PROGRAM_DIR` | `prompt_programs` | Directory containing prompt programs, model profile lockfile, and enforcement policy lockfile |
| `AV_SESSION_TTL_SECS` | `600` | Session expiry in seconds. Background reaper cleans up expired sessions |
| `OPENAI_API_KEY` | — | Enables the OpenAI provider when set |
| `AV_OPENAI_MODEL_ID` | `gpt-4o` | OpenAI model ID (only used if `OPENAI_API_KEY` is set) |
| `ANTHROPIC_BASE_URL` | — | Override Anthropic API base URL (for proxies or mock servers) |
| `OPENAI_BASE_URL` | — | Override OpenAI API base URL |
| `RUST_LOG` | — | Standard `tracing` log filter (e.g. `info`, `agentvault_relay=debug`) |

### Lockfile overrides (development only)

These require `AV_ENV=dev` to have any effect. Production deployments must always use lockfiles.

| Variable | Description |
|----------|-------------|
| `AV_ENV` | Set to `dev` to enable development overrides |
| `AV_MODEL_LOCKFILE_SKIP` | Set to `1` (with `AV_ENV=dev`) to skip model profile lockfile validation |
| `AV_ENFORCEMENT_LOCKFILE_SKIP` | Set to `1` (with `AV_ENV=dev`) to skip enforcement policy lockfile validation |

### Inbox Persistence (feature-gated)

The relay's inbox can persist invites to SQLite. This requires building with the `persistence` feature:

```bash
cargo build --features persistence
```

| Variable | Default | Description |
|----------|---------|-------------|
| `AV_INBOX_DB_PATH` | — | Path to the SQLite database file for inbox persistence. Required when running with `--features persistence`. If unset, the relay falls back to in-memory storage |

## MCP Server (`agentvault-mcp-server`)

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AV_RELAY_URL` | For CREATE/JOIN | — | Relay base URL (e.g. `http://localhost:3100`) |
| `AV_AGENT_ID` | No | — | This agent's ID, used for contract building |
| `AV_RESUME_TOKEN_SECRET` | No | — | Secret for HMAC-signing resume tokens. Recommended for production |

### AFAL Direct Transport

These enable the AFAL direct transport for INITIATE and RESPOND session modes (agent-to-agent without an orchestrator).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AV_AFAL_SEED_HEX` | For AFAL | — | 64-char hex Ed25519 seed for signing AFAL messages |
| `AV_AFAL_HTTP_PORT` | For RESPOND | — | Port for the AFAL HTTP server (enables RESPOND mode) |
| `AV_AFAL_BIND_ADDRESS` | No | `127.0.0.1` | Bind address for the AFAL HTTP server |
| `AV_AFAL_TRUSTED_AGENTS` | No | — | JSON array of trusted agents: `[{"agentId":"...","publicKeyHex":"..."}]` |
| `AV_AFAL_ALLOWED_PURPOSES` | No | — | Comma-separated list of allowed purpose codes (e.g. `MEDIATION,COMPATIBILITY`) |
| `AV_AFAL_PEER_DESCRIPTOR_URL` | For INITIATE | — | URL of the peer agent's descriptor (used in INITIATE mode) |
| `AV_AFAL_REQUIRE_SIGNED_CARDS` | No | `false` | Set to `true` to reject unsigned A2A agent cards (strict mode) |

### Known Agents

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AV_KNOWN_AGENTS` | No | — | JSON array of known agents for alias resolution. Format: `[{"alias":"bob","agentId":"bob-agent","relayUrl":"http://..."}]` |
