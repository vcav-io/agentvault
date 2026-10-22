# Environment Variables

Complete reference for all environment variables used by the Selkey relay and MCP server.

## Relay (`selkey-relay`)

### Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key for the default provider |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `SELKEY_PORT` | `3100` | Port the relay listens on |
| `SELKEY_MODEL_ID` | `claude-sonnet-4-6` | Anthropic model ID |
| `SELKEY_SIGNING_KEY_HEX` | ephemeral | 64-char hex Ed25519 signing key for receipt signing. If unset, a random key is generated on each start — receipts won't verify across restarts |
| `SELKEY_PROMPT_PROGRAM_DIR` | `prompt_programs` | Directory containing prompt programs, model profile lockfile, and enforcement policy lockfile |
| `SELKEY_SCHEMA_DIR` | `<prompt dir>/../schemas/output` | Directory of content-addressed output schemas (the schema registry). Set it to the repo's `schemas/output` when running from a checkout; the Docker image sets it |
| `SELKEY_SESSION_TTL_SECS` | `600` | Session expiry in seconds. Background reaper cleans up expired sessions. A session still processing one TTL after inference started is aborted with `TIMEOUT` |
| `OPENAI_API_KEY` | — | Enables the OpenAI provider when set |
| `SELKEY_OPENAI_MODEL_ID` | `gpt-4o` | OpenAI model ID (only used if `OPENAI_API_KEY` is set) |
| `ANTHROPIC_BASE_URL` | — | Override Anthropic API base URL (for proxies or mock servers) |
| `OPENAI_BASE_URL` | — | Override OpenAI API base URL |
| `RUST_LOG` | — | Standard `tracing` log filter (e.g. `info`, `selkey_relay=debug`) |

### Output schema acceptance

Contracts must use an output schema from the relay's schema registry, matched by content hash
(either `output_schema_hash` with a stub `output_schema: {}`, or the full registry schema inline).
The relay computes the entropy upper bound for registry schemas and rejects the contract if it
cannot.

With `SELKEY_ENV=dev`, the relay also accepts inline schemas that are not in the registry, but only
strict ones: `additionalProperties: false` and every property `required` on every object; every
string bounded by `enum` or `maxLength`; every array bounded by `maxItems`; integers bounded by
`minimum`/`maximum`; no `true`/`{}` subschemas, composition (`anyOf`, `oneOf`, ...), `$ref` or
`patternProperties`. For these schemas the relay computes the entropy bound from the structure and
ignores any `x-vcav-entropy-bits-upper-bound` annotations.

### Lockfile overrides (development only)

These require `SELKEY_ENV=dev` to have any effect. Production deployments must always use lockfiles.

| Variable | Description |
|----------|-------------|
| `SELKEY_ENV` | Set to `dev` to enable development overrides |
| `SELKEY_MODEL_LOCKFILE_SKIP` | Set to `1` (with `SELKEY_ENV=dev`) to skip model profile lockfile validation |
| `SELKEY_ENFORCEMENT_LOCKFILE_SKIP` | Set to `1` (with `SELKEY_ENV=dev`) to skip enforcement policy lockfile validation |

### Inbox Persistence (feature-gated)

The relay's inbox can persist invites to SQLite. This requires building with the `persistence` feature:

```bash
cargo build --features persistence
```

| Variable | Default | Description |
|----------|---------|-------------|
| `SELKEY_INBOX_DB_PATH` | — | Path to the SQLite database file for inbox persistence. Required when running with `--features persistence`. If unset, the relay falls back to in-memory storage |

## MCP Server (`selkey-mcp`)

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELKEY_RELAY_URL` | For CREATE/JOIN | — | Relay base URL (e.g. `http://localhost:3100`) |
| `SELKEY_AGENT_ID` | No | — | This agent's ID, used for contract building |
| `SELKEY_RESUME_TOKEN_SECRET` | No | — | Secret for HMAC-signing resume tokens. Recommended for production |

### AFAL Direct Transport

These enable the AFAL direct transport for INITIATE and RESPOND session modes (agent-to-agent without an orchestrator).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELKEY_AFAL_SEED_HEX` | For AFAL | — | 64-char hex Ed25519 seed for signing AFAL messages |
| `SELKEY_AFAL_HTTP_PORT` | For RESPOND | — | Port for the AFAL HTTP server (enables RESPOND mode) |
| `SELKEY_AFAL_BIND_ADDRESS` | No | `127.0.0.1` | Bind address for the AFAL HTTP server |
| `SELKEY_AFAL_TRUSTED_AGENTS` | No | — | JSON array of trusted agents: `[{"agentId":"...","publicKeyHex":"..."}]` |
| `SELKEY_AFAL_ALLOWED_PURPOSES` | No | — | Comma-separated list of allowed purpose codes (e.g. `MEDIATION,COMPATIBILITY`) |
| `SELKEY_AFAL_PEER_DESCRIPTOR_URL` | For INITIATE | — | URL of the peer agent's descriptor (used in INITIATE mode) |
| `SELKEY_AFAL_REQUIRE_SIGNED_CARDS` | No | `false` | Set to `true` to reject unsigned A2A agent cards (strict mode) |

### Known Agents

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELKEY_KNOWN_AGENTS` | No | — | JSON array of known agents for alias resolution. Format: `[{"alias":"bob","agentId":"bob-agent","relayUrl":"http://..."}]` |
