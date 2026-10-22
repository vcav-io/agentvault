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

Verifies a receipt's Ed25519 signature against the relay verifying key. Receipt v3 (`receipt_schema_version` `"3.0.0"`, emitted by current relays) is checked with the strict rules of the receipt v3 specification; v2 and v1 receipts are still accepted. A relay key is required: pass `public_key_hex`, or pin it with `SELKEY_RELAY_VERIFYING_KEY_HEX`. Without either, the tool returns an error. Keys embedded in the receipt (such as `tee_attestation.receipt_signing_pubkey_hex`) are never used as the verification key.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SELKEY_RELAY_URL` | Yes | Relay base URL, e.g. `http://localhost:8080`. The only relay used unless `SELKEY_RELAY_ALLOWLIST` adds others; peer-advertised relays are never used as a fallback. If `SELKEY_RELAY_VERIFYING_KEY_HEX` is set, the relay's `/health` key must match it before input is submitted |
| `SELKEY_AGENT_ID` | Recommended | This agent's ID, used for contract building and idempotency |
| `SELKEY_RESUME_TOKEN_SECRET` | Recommended | HMAC secret for signing resume tokens |
| `SELKEY_KNOWN_AGENTS` | Optional | JSON array of `{agent_id, aliases, public_key_hex?, a2a_send_message_url?}`. Aliases match exactly; an ambiguous alias is an error. `public_key_hex` seeds the agent pin store |
| `SELKEY_RELAY_VERIFYING_KEY_HEX` | Optional | Pinned relay Ed25519 verifying key (64 hex chars) used by `selkey.verify_receipt` |
| `SELKEY_AFAL_SEED_HEX` | Optional | Ed25519 seed (32-byte hex) — enables AFAL direct mode (INITIATE/RESPOND) |
| `SELKEY_AFAL_HTTP_PORT` | Optional | Port for the AFAL HTTP listener (enables RESPOND mode) |
| `SELKEY_AFAL_BIND_ADDRESS` | Optional | AFAL bind address (default: `127.0.0.1`) |
| `SELKEY_AFAL_TRUSTED_AGENTS` | Optional | JSON array of `{agentId, publicKeyHex}`; seeds the agent pin store |
| `SELKEY_AGENT_PIN_MODE` | Optional | `preshared` (default) or `tofu` (first contact needs `selkey-mcp pins confirm` by a person) |
| `SELKEY_AFAL_ALLOWED_PURPOSES` | Optional | Comma-separated purposes for AFAL RESPOND (default: `MEDIATION`). Also used by RESPOND when `expected_purpose` is omitted |
| `SELKEY_RELAY_ALLOWLIST` | Optional | Comma-separated additional relay URLs this agent will use. Peer-supplied relay URLs are only used if they match `SELKEY_RELAY_URL` or this list |
| `SELKEY_AFAL_PEER_DESCRIPTOR_URL` | Optional | Peer descriptor URL for AFAL INITIATE mode |

Without `SELKEY_AFAL_SEED_HEX`, only `CREATE` and `JOIN` (legacy token exchange) modes are available.

## Agent identity pins

Peers are identified by pinned Ed25519 keys stored in `$SELKEY_WORKDIR/.selkey/pins.json` (`0700` directory, `0600` file, refused if group- or world-writable). Every PROPOSE, ADMIT, DENY, COMMIT, `/afal/negotiate` request and IFC signature is verified against `pins[agent_id]`; keys in agent cards, descriptors or messages are only compared with the pin. By default a peer must be pinned in advance (`SELKEY_AFAL_TRUSTED_AGENTS`, `SELKEY_KNOWN_AGENTS` with `public_key_hex`, or `selkey-mcp pins add`). With `SELKEY_AGENT_PIN_MODE=tofu`, first contact returns `NEEDS_CONFIRMATION` with the key fingerprint, and a person confirms it in a terminal with `selkey-mcp pins confirm <agent_id>`; no MCP tool can confirm a pin. A key that differs from the pin fails with both fingerprints until the operator re-pins it or applies a rotation statement signed by the pinned key (`selkey-mcp pins rotate`).

An ADMIT must echo the PROPOSE's `proposal_id`, expire within 10 minutes, and select a model profile the PROPOSE offered. Negotiation selections must name an offered contract, model profile or topic code. Negotiation requests are signed by the sender and accepted only from pinned agents.

## Responder checks

In RESPOND mode the agent rebuilds the contracts it is willing to run from its own configuration (bundled purpose templates, and the local contract-offer catalogue and model profiles) and accepts an invite only if its full contract hash matches one of them. `from` must be supplied by the caller, and `expected_purpose` defaults to the locally allowed purposes, never to the purpose in the invite. Pre-contract negotiation does not widen this set: bespoke or other custom contracts are accepted only when the caller passes their exact hash as `expected_contract_hash`.

When `SELKEY_RELAY_VERIFYING_KEY_HEX` is set, the session receipt must verify against that key before the output is returned; otherwise the result is an error. The receipt must also commit to what this agent holds locally: the output it received, the contract it agreed to (when it holds it), and its own input. Every submission carries a fresh 32-byte `commitment_nonce` generated by the agent, so the receipt's input commitment can only be opened by the party that submitted it; the agent checks its own entry with that nonce, under its own participant id from local configuration (the contract or `SELKEY_AGENT_ID`), never one read from the receipt. A receipt it cannot check this way, or any receipt other than v3, is not accepted. The nonce stays in the agent's memory: it is never logged, returned in tool results or written to state files. Without a pinned key, the output notes that the receipt was not verified.

Both INITIATE and RESPOND use only locally configured relays (`SELKEY_RELAY_URL` and `SELKEY_RELAY_ALLOWLIST`). An invite or COMMIT that names any other relay is refused.

## See also

[Selkey repository](https://github.com/vcav-io/selkey)
