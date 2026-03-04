# agentvault-mcp-server

MCP server exposing `agentvault.*` tools for agent-to-agent bounded signal sessions via the [AgentVault](https://github.com/vcav-io/agentvault) relay. Runs over stdio; compatible with any MCP host (Claude Desktop, OpenClaw, or any host that supports the Model Context Protocol).

## Install

```bash
npm install -g agentvault-mcp-server
```

Or run without installing:

```bash
npx -y agentvault-mcp-server
```

To print a ready-to-paste MCP config block:

```bash
agentvault-mcp-server --print-config
```

## Available tools

### `agentvault.get_identity`

Returns this agent's identity (`agent_id`) and the list of known agents available for relay sessions. Call this before `agentvault.relay_signal` to confirm your agent ID and discover counterparty aliases.

### `agentvault.relay_signal`

Runs an AgentVault relay session for bounded agent-to-agent signals. Supports four modes: `INITIATE` (create a session and send an invite via AFAL), `RESPOND` (poll for an incoming invite and join), `CREATE` (legacy: create a session and return tokens), and `JOIN` (legacy: join an existing session by token). The relay enforces the contract schema — neither party sees the other's raw input, only the bounded signal and a cryptographic receipt. Available purposes: `MEDIATION` and `COMPATIBILITY`. Resume an in-progress session by passing only `resume_token`.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `AV_RELAY_URL` | Yes (CREATE/JOIN/INITIATE) | Relay base URL, e.g. `http://localhost:8080` |
| `AV_AGENT_ID` | Recommended | This agent's ID, used for contract building and idempotency |
| `AV_RESUME_TOKEN_SECRET` | Recommended | HMAC secret for signing resume tokens |
| `AV_KNOWN_AGENTS` | Optional | JSON array of `{agent_id, aliases}` for alias resolution |
| `AV_AFAL_SEED_HEX` | Optional | Ed25519 seed (32-byte hex) — enables AFAL direct mode (INITIATE/RESPOND) |
| `AV_AFAL_HTTP_PORT` | Optional | Port for the AFAL HTTP listener (enables RESPOND mode) |
| `AV_AFAL_BIND_ADDRESS` | Optional | AFAL bind address (default: `127.0.0.1`) |
| `AV_AFAL_TRUSTED_AGENTS` | Optional | JSON array of `{agentId, publicKeyHex}` for AFAL admission |
| `AV_AFAL_ALLOWED_PURPOSES` | Optional | Comma-separated purposes for AFAL RESPOND (default: `MEDIATION`) |
| `AV_AFAL_PEER_DESCRIPTOR_URL` | Optional | Peer descriptor URL for AFAL INITIATE mode |

Without `AV_AFAL_SEED_HEX`, only `CREATE` and `JOIN` (legacy token exchange) modes are available.

## See also

[AgentVault repository](https://github.com/vcav-io/agentvault)
