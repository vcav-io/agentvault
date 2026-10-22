# selkey-mcp

MCP server exposing `selkey.*` tools for agent-to-agent bounded signal sessions via the [Selkey](https://github.com/vcav-io/selkey) relay. Runs over stdio; compatible with any MCP host (Claude Desktop, OpenClaw, or any host that supports the Model Context Protocol).

## Install

```bash
npm install -g selkey-mcp
```

Or run without installing:

```bash
npx -y selkey-mcp
```

To print a ready-to-paste MCP config block:

```bash
selkey-mcp --print-config
```

## Available tools

### `selkey.get_identity`

Returns this agent's identity (`agent_id`) and the list of known agents available for relay sessions. Call this before `selkey.relay_signal` to confirm your agent ID and discover counterparty aliases.

### `selkey.relay_signal`

Runs an Selkey relay session for bounded agent-to-agent signals. Supports four modes: `INITIATE` (create a session and send an invite via AFAL), `RESPOND` (poll for an incoming invite and join), `CREATE` (legacy: create a session and return tokens), and `JOIN` (legacy: join an existing session by token). The relay enforces the contract schema — neither party sees the other's raw input, only the bounded signal and a cryptographic receipt. Available purposes: `MEDIATION` and `COMPATIBILITY`. Resume an in-progress session by passing only `resume_token`.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SELKEY_RELAY_URL` | Yes (CREATE/JOIN/INITIATE) | Relay base URL, e.g. `http://localhost:8080` |
| `SELKEY_AGENT_ID` | Recommended | This agent's ID, used for contract building and idempotency |
| `SELKEY_RESUME_TOKEN_SECRET` | Recommended | HMAC secret for signing resume tokens |
| `SELKEY_KNOWN_AGENTS` | Optional | JSON array of `{agent_id, aliases}` for alias resolution |
| `SELKEY_AFAL_SEED_HEX` | Optional | Ed25519 seed (32-byte hex) — enables AFAL direct mode (INITIATE/RESPOND) |
| `SELKEY_AFAL_HTTP_PORT` | Optional | Port for the AFAL HTTP listener (enables RESPOND mode) |
| `SELKEY_AFAL_BIND_ADDRESS` | Optional | AFAL bind address (default: `127.0.0.1`) |
| `SELKEY_AFAL_TRUSTED_AGENTS` | Optional | JSON array of `{agentId, publicKeyHex}` for AFAL admission |
| `SELKEY_AFAL_ALLOWED_PURPOSES` | Optional | Comma-separated purposes for AFAL RESPOND (default: `MEDIATION`) |
| `SELKEY_AFAL_PEER_DESCRIPTOR_URL` | Optional | Peer descriptor URL for AFAL INITIATE mode |

Without `SELKEY_AFAL_SEED_HEX`, only `CREATE` and `JOIN` (legacy token exchange) modes are available.

## See also

[Selkey repository](https://github.com/vcav-io/selkey)
