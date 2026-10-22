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
| `SELKEY_ALLOW_UNAUTHENTICATED` | unset | Set to `1` to let a non-dev relay start on a non-loopback address without `SELKEY_OPERATOR_TOKEN` (only when access is controlled elsewhere) |
| `SELKEY_BIND_ADDR` | `127.0.0.1` | IP address the relay listens on. Loopback by default; set `0.0.0.0` (or a specific interface) to accept remote connections, e.g. inside a container |
| `SELKEY_OPERATOR_TOKEN` | — | Operator bearer token. When set, `POST /relay` and `POST /sessions` require `Authorization: Bearer <token>` |
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

### Network binding and operator access

The relay listens on `127.0.0.1` unless `SELKEY_BIND_ADDR` says otherwise. In Docker, set
`SELKEY_BIND_ADDR=0.0.0.0` inside the container and choose exposure when publishing the port
(the demo compose file publishes `127.0.0.1:3100:3100`).

Outside dev, the relay refuses to start on a non-loopback address unless `SELKEY_OPERATOR_TOKEN`
is set. If access is controlled some other way (for example an authenticating reverse proxy),
set `SELKEY_ALLOW_UNAUTHENTICATED=1` to start anyway.

| Endpoint | `SELKEY_ENV=dev`, no token | Non-dev, no token | `SELKEY_OPERATOR_TOKEN` set |
|---|---|---|---|
| `POST /relay` (one caller supplies both inputs) | open | **disabled** (403) | token required |
| `POST /sessions` | open | open | token required |
| Session input/status/output | per-session tokens | per-session tokens | per-session tokens |
| `POST /invites` and inbox | agent registry tokens | agent registry tokens | agent registry tokens |

When the relay is reachable beyond localhost, set `SELKEY_OPERATOR_TOKEN` (and use the agent
registry for invites). The relay logs a warning at startup if it binds to a non-loopback address
without an operator token.

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
| `SELKEY_RELAY_URL` | For all relay sessions | — | Relay base URL (e.g. `http://localhost:3100`). INITIATE and RESPOND only use locally configured relays: this URL plus `SELKEY_RELAY_ALLOWLIST`. Relay URLs from a peer's Agent Card or invite are never used unless they match. If `SELKEY_RELAY_VERIFYING_KEY_HEX` (64 hex chars) is set, the relay's `/health` `verifying_key_hex` must match it before any input is submitted |
| `SELKEY_RELAY_ALLOWLIST` | No | — | Comma-separated additional relay URLs this agent will use (e.g. when a counterparty's session lives on a different relay you trust) |
| `SELKEY_AGENT_ID` | No | — | This agent's ID, used for contract building |
| `SELKEY_RESUME_TOKEN_SECRET` | No | — | Secret for HMAC-signing resume tokens. Recommended for production |
| `SELKEY_RELAY_VERIFYING_KEY_HEX` | No | — | Pinned relay Ed25519 verifying key (64 hex chars). `selkey.verify_receipt` uses it when no `public_key_hex` argument is given, and rejects an argument that differs from it. Without this or an argument, the tool returns an error |

### AFAL Direct Transport

These enable the AFAL direct transport for INITIATE and RESPOND session modes (agent-to-agent without an orchestrator).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELKEY_AFAL_SEED_HEX` | For AFAL | — | 64-char hex Ed25519 seed for signing AFAL messages |
| `SELKEY_AFAL_HTTP_PORT` | For RESPOND | — | Port for the AFAL HTTP server (enables RESPOND mode) |
| `SELKEY_AFAL_BIND_ADDRESS` | No | `127.0.0.1` | Bind address for the AFAL HTTP server |
| `SELKEY_AFAL_TRUSTED_AGENTS` | No | — | JSON array of trusted agents: `[{"agentId":"...","publicKeyHex":"..."}]`. Seeds the agent pin store (see below) |
| `SELKEY_AFAL_ALLOWED_PURPOSES` | No | `MEDIATION` | Comma-separated list of allowed purpose codes (e.g. `MEDIATION,COMPATIBILITY`). Also the purposes RESPOND accepts when `expected_purpose` is omitted |
| `SELKEY_AFAL_PEER_DESCRIPTOR_URL` | For INITIATE | — | URL of the peer agent's descriptor (used in INITIATE mode) |
| `SELKEY_AFAL_REQUIRE_SIGNED_CARDS` | No | — | No longer has an effect. An A2A agent card is used only if its `card_signature` verifies under the peer's pinned key; endpoints and relay hints are never taken from an unsigned card (discovery falls back to the signed AFAL descriptor) |
| `SELKEY_AGENT_PIN_MODE` | No | `preshared` | `preshared`: peers must be pinned in advance. `tofu`: on first contact the peer's key is recorded as pending and the call fails with `NEEDS_CONFIRMATION` until a person runs `selkey-mcp pins confirm <agent_id>` in a terminal |

### Known Agents

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELKEY_KNOWN_AGENTS` | No | — | JSON array of known agents: `[{"agent_id":"bob-agent","aliases":["Bob"],"public_key_hex":"...","a2a_send_message_url":"..."}]`. Aliases match exactly (no case folding); an alias that names more than one agent is an error. `public_key_hex` seeds the agent pin store |

### Agent identity pins

The MCP server keeps one pin store at `$SELKEY_WORKDIR/.selkey/pins.json` (directory `0700`, file `0600`; the server refuses to start if the file is group- or world-writable). It is seeded from `SELKEY_AFAL_TRUSTED_AGENTS` and the `public_key_hex` entries of `SELKEY_KNOWN_AGENTS`. Stored pins take precedence: if a configured key differs from a stored pin (for example after a CLI re-pin or a rotation), the server refuses to start and shows both fingerprints; set `SELKEY_AGENT_PIN_RESEED=true` to let the configured keys replace the stored pins. The running server re-reads `pins.json` when it changes, so `selkey-mcp pins` commands take effect without a restart. Every PROPOSE, ADMIT, DENY, COMMIT, negotiation request and IFC signature from a peer is verified against the pinned key for its `agent_id`, never against a key in the peer's card, descriptor or message. A peer that presents a different key is rejected with both fingerprints (`ed25519:` + hex SHA-256 of the raw key).

Manage pins with:

```bash
selkey-mcp pins list
selkey-mcp pins add <agent_id> <public_key_hex> [--alias <alias>]
selkey-mcp pins remove <agent_id>
selkey-mcp pins confirm <agent_id>      # tofu mode: interactive terminal only
selkey-mcp pins rotate <statement.json> <new_public_key_hex>
```

A rotation statement is `{agent_id, old_fpr, new_fpr, issued_at, signature}`, signed by the currently pinned key with the AFAL signing rules and the domain prefix `VCAV-KEY-ROTATION-V1:`. A statement is refused if it was applied before or its `issued_at` is not newer than the last rotation applied for that agent.

`pins confirm` requires an interactive terminal and is not available as an MCP tool, so a model using the MCP tools cannot confirm a pin. It does not stop a model that has its own shell or terminal access; do not give such a model access to the terminal where pins are confirmed.
