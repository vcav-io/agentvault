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

### `selkey.verify_receipt`

Verifies a receipt's Ed25519 signature against the relay verifying key. A relay key is required: pass `public_key_hex`, or pin it with `SELKEY_RELAY_VERIFYING_KEY_HEX`. Without either, the tool returns an error. Keys embedded in the receipt (such as `tee_attestation.receipt_signing_pubkey_hex`) are never used as the verification key.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SELKEY_RELAY_URL` | Yes | Relay base URL, e.g. `http://localhost:8080`. The only relay used unless `SELKEY_RELAY_ALLOWLIST` adds others; peer-advertised relays are never used as a fallback. If `SELKEY_RELAY_VERIFYING_KEY_HEX` is set, the relay's `/health` key must match it before input is submitted |
| `SELKEY_AGENT_ID` | Recommended | This agent's ID, used for contract building and idempotency |
| `SELKEY_RESUME_TOKEN_SECRET` | Recommended | HMAC secret for signing resume tokens |
| `SELKEY_KNOWN_AGENTS` | Optional | JSON array of `{agent_id, aliases}` for alias resolution |
| `SELKEY_RELAY_VERIFYING_KEY_HEX` | Optional | Pinned relay Ed25519 verifying key (64 hex chars) used by `selkey.verify_receipt` |
| `SELKEY_AFAL_SEED_HEX` | Optional | Ed25519 seed (32-byte hex) — enables AFAL direct mode (INITIATE/RESPOND) |
| `SELKEY_AFAL_HTTP_PORT` | Optional | Port for the AFAL HTTP listener (enables RESPOND mode) |
| `SELKEY_AFAL_BIND_ADDRESS` | Optional | AFAL bind address (default: `127.0.0.1`) |
| `SELKEY_AFAL_TRUSTED_AGENTS` | Optional | JSON array of `{agentId, publicKeyHex}` for AFAL admission |
| `SELKEY_AFAL_ALLOWED_PURPOSES` | Optional | Comma-separated purposes for AFAL RESPOND (default: `MEDIATION`). Also used by RESPOND when `expected_purpose` is omitted |
| `SELKEY_RELAY_ALLOWLIST` | Optional | Comma-separated additional relay URLs this agent will use. Peer-supplied relay URLs are only used if they match `SELKEY_RELAY_URL` or this list |
| `SELKEY_AFAL_PEER_DESCRIPTOR_URL` | Optional | Peer descriptor URL for AFAL INITIATE mode |

Without `SELKEY_AFAL_SEED_HEX`, only `CREATE` and `JOIN` (legacy token exchange) modes are available.

## Responder checks

In RESPOND mode the agent rebuilds the contracts it is willing to run from its own configuration (bundled purpose templates, and the local contract-offer catalogue and model profiles) and accepts an invite only if its full contract hash matches one of them. `from` must be supplied by the caller, and `expected_purpose` defaults to the locally allowed purposes, never to the purpose in the invite. Pre-contract negotiation does not widen this set: bespoke or other custom contracts are accepted only when the caller passes their exact hash as `expected_contract_hash`.

When `SELKEY_RELAY_VERIFYING_KEY_HEX` is set, the session receipt must verify against that key before the output is returned; otherwise the result is an error. Without a pinned key, the output notes that the receipt was not verified.

Both INITIATE and RESPOND use only locally configured relays (`SELKEY_RELAY_URL` and `SELKEY_RELAY_ALLOWLIST`). An invite or COMMIT that names any other relay is refused.

## See also

[Selkey repository](https://github.com/vcav-io/selkey)
