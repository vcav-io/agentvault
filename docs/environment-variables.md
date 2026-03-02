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
| `VCAV_PORT` | `3100` | Port the relay listens on |
| `VCAV_MODEL_ID` | `claude-sonnet-4-6` | Anthropic model ID |
| `VCAV_SIGNING_KEY_HEX` | ephemeral | 64-char hex Ed25519 signing key for receipt signing. If unset, a random key is generated on each start — receipts won't verify across restarts |
| `VCAV_PROMPT_PROGRAM_DIR` | `prompt_programs` | Directory containing prompt programs, model profile lockfile, and enforcement policy lockfile |
| `VCAV_SESSION_TTL_SECS` | `600` | Session expiry in seconds. Background reaper cleans up expired sessions |
| `OPENAI_API_KEY` | — | Enables the OpenAI provider when set |
| `VCAV_OPENAI_MODEL_ID` | `gpt-4o` | OpenAI model ID (only used if `OPENAI_API_KEY` is set) |
| `ANTHROPIC_BASE_URL` | — | Override Anthropic API base URL (for proxies or mock servers) |
| `OPENAI_BASE_URL` | — | Override OpenAI API base URL |
| `RUST_LOG` | — | Standard `tracing` log filter (e.g. `info`, `agentvault_relay=debug`) |

### Lockfile overrides (development only)

These require `VCAV_ENV=dev` to have any effect. Production deployments must always use lockfiles.

| Variable | Description |
|----------|-------------|
| `VCAV_ENV` | Set to `dev` to enable development overrides |
| `VCAV_MODEL_LOCKFILE_SKIP` | Set to `1` (with `VCAV_ENV=dev`) to skip model profile lockfile validation |
| `VCAV_ENFORCEMENT_LOCKFILE_SKIP` | Set to `1` (with `VCAV_ENV=dev`) to skip enforcement policy lockfile validation |

## MCP Server (`agentvault-mcp-server`)

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VCAV_RELAY_URL` | For CREATE/JOIN | — | Relay base URL (e.g. `http://localhost:3100`) |
| `VCAV_AGENT_ID` | No | — | This agent's ID, used for contract building |
| `VCAV_RESUME_TOKEN_SECRET` | No | — | Secret for HMAC-signing resume tokens. Recommended for production |

### AFAL Direct Transport

These enable the AFAL direct transport for INITIATE and RESPOND session modes (agent-to-agent without an orchestrator).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VCAV_AFAL_SEED_HEX` | For AFAL | — | 64-char hex Ed25519 seed for signing AFAL messages |
| `VCAV_AFAL_HTTP_PORT` | For RESPOND | — | Port for the AFAL HTTP server (enables RESPOND mode) |
| `VCAV_AFAL_BIND_ADDRESS` | No | `127.0.0.1` | Bind address for the AFAL HTTP server |
| `VCAV_AFAL_TRUSTED_AGENTS` | No | — | JSON array of trusted agents: `[{"agentId":"...","publicKeyHex":"..."}]` |
| `VCAV_AFAL_ALLOWED_PURPOSES` | No | — | Comma-separated list of allowed purpose codes (e.g. `MEDIATION,COMPATIBILITY`) |
| `VCAV_AFAL_PEER_DESCRIPTOR_URL` | For INITIATE | — | URL of the peer agent's descriptor (used in INITIATE mode) |

### Known Agents

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VCAV_KNOWN_AGENTS` | No | — | JSON array of known agents for alias resolution. Format: `[{"alias":"bob","agentId":"bob-agent","relayUrl":"http://..."}]` |
