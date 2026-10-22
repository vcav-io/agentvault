# OpenClaw VPS Runbook — Selkey Peer-to-Peer Session

This runbook covers deploying the Selkey MCP server and OpenClaw skill on a
VPS for a first peer-to-peer vault session between two independent agents (Alice
and Bob). Follow each step on both VPS hosts unless noted otherwise.

---

## Architecture

```
Alice VPS                          Bob VPS
  OpenClaw                           OpenClaw
    mcporter -> selkey-mcp         mcporter -> selkey-mcp
                     |                                   |
              DirectAfalTransport <--AFAL--> DirectAfalTransport
                     |                                   |
              selkey-relay  (shared or per-host)
```

Transport mode for first test: AFAL direct (no relay hop for invite exchange).
Each agent runs its own MCP server instance. The relay handles vault execution.

---

## Environment Variables

Set these on each VPS before starting the MCP server. Values differ per host.

| Variable | Required | Description |
|----------|----------|-------------|
| `SELKEY_AGENT_ID` | Yes | Unique agent identifier for this host (e.g. `alice-agent`) |
| `SELKEY_RELAY_URL` | Yes | Base URL of the Selkey relay (e.g. `https://relay.example.com`) |
| `SELKEY_AFAL_SEED_HEX` | Yes (AFAL) | Ed25519 seed as 64-char hex — enables AFAL direct transport and INITIATE/RESPOND modes. **Secret: do not commit to version control.** Generate with `openssl rand -hex 32`. |
| `SELKEY_AFAL_PEER_DESCRIPTOR_URL` | INITIATE mode | Peer's AFAL descriptor URL (e.g. `https://bob.example.com:9100/afal/descriptor`) — used by initiator to discover the peer |
| `SELKEY_KNOWN_AGENTS` | Yes | JSON array of peer agents for alias resolution (see format below) |
| `SELKEY_RESUME_TOKEN_SECRET` | Recommended | HMAC secret for signing resume tokens. Generate with `openssl rand -hex 32` |
| `SELKEY_AFAL_HTTP_PORT` | RESPOND mode | Port for AFAL HTTP server — enables inbox for incoming invites |
| `SELKEY_AFAL_BIND_ADDRESS` | Optional | Bind address for AFAL HTTP server (default: `127.0.0.1`) |
| `SELKEY_AFAL_TRUSTED_AGENTS` | Optional | JSON array of trusted agents with their public keys for signature verification (seeds the pin store) |
| `SELKEY_AFAL_ALLOWED_PURPOSES` | Optional | Comma-separated allowed purposes (default: `MEDIATION`). Example: `MEDIATION,COMPATIBILITY` |

### SELKEY_KNOWN_AGENTS format

```json
[
  {
    "agent_id": "bob-agent",
    "aliases": ["bob", "Bob"]
  }
]
```

Add `"public_key_hex": "<peer key>"` to pin the peer's key; the initiator needs a pin
for the peer before it will send a PROPOSE (see "Agent identity pins" in
`docs/environment-variables.md`). Aliases match exactly, without case folding. The peer's
descriptor URL is configured separately via `SELKEY_AFAL_PEER_DESCRIPTOR_URL`.

### SELKEY_AFAL_TRUSTED_AGENTS format

```json
[
  {
    "agentId": "bob-agent",
    "publicKeyHex": "<64-char hex Ed25519 public key>"
  }
]
```

Generate a public key from a seed:

```bash
node -e "
const { ed25519 } = require('@noble/curves/ed25519');
const { hexToBytes, bytesToHex } = require('@noble/hashes/utils');
const seed = process.env.SELKEY_AFAL_SEED_HEX;
console.log(bytesToHex(ed25519.getPublicKey(hexToBytes(seed))));
"
```

---

## Installation Steps

### 1. Install OpenClaw

Confirm OpenClaw is installed and configured:

```bash
ls ~/.openclaw/openclaw.json
openclaw --version
```

Ensure the OpenClaw service is running:

```bash
systemctl status openclaw   # or your init system
```

### 2. Install mcporter

Confirm mcporter is available to the OpenClaw runtime user:

```bash
which mcporter
mcporter --version
```

### 3. Install Selkey MCP Server

```bash
npm install -g selkey-mcp
```

Or run directly without installing:

```bash
npx selkey-mcp --version
```

Confirm the binary resolves:

```bash
which selkey-mcp
```

### 4. Install the OpenClaw Skill

Copy the skill from the repository to OpenClaw's skills directory:

```bash
mkdir -p ~/.openclaw/skills/selkey
cp /path/to/selkey-repo/skills/openclaw/selkey/SKILL.md \
   ~/.openclaw/skills/selkey/SKILL.md
```

### 5. Configure mcporter

Add the Selkey MCP server to mcporter's configuration. Create or update
`~/.mcporter/config.json` (or your mcporter config path):

```json
{
  "servers": {
    "selkey": {
      "command": "selkey-mcp",
      "args": [],
      "env": {
        "SELKEY_AGENT_ID": "alice-agent",
        "SELKEY_RELAY_URL": "https://relay.example.com",
        "SELKEY_AFAL_SEED_HEX": "<your-seed-hex>",
        "SELKEY_AFAL_HTTP_PORT": "9100",
        "SELKEY_AFAL_BIND_ADDRESS": "0.0.0.0",
        "SELKEY_AFAL_PEER_DESCRIPTOR_URL": "https://bob.example.com:9100/afal/descriptor",
        "SELKEY_AFAL_ALLOWED_PURPOSES": "MEDIATION,COMPATIBILITY",
        "SELKEY_AFAL_TRUSTED_AGENTS": "[{\"agentId\":\"bob-agent\",\"publicKeyHex\":\"...\"}]",
        "SELKEY_KNOWN_AGENTS": "[{\"agent_id\":\"bob-agent\",\"aliases\":[\"bob\",\"Bob\"],\"public_key_hex\":\"...\"}]",
        "SELKEY_RESUME_TOKEN_SECRET": "<your-secret>"
      }
    }
  }
}
```

The initiator only uses peer endpoints on the origin of `SELKEY_AFAL_PEER_DESCRIPTOR_URL`
or on an origin listed in `SELKEY_AFAL_PEER_ENDPOINT_ORIGINS`. A responder currently
advertises its endpoints as `http://<SELKEY_AFAL_BIND_ADDRESS>:<SELKEY_AFAL_HTTP_PORT>`
(here `http://0.0.0.0:9100`), which differs from its public URL. Until the advertised
address can be configured, peers on different hosts are limited: the advertised origin
must be reachable from the initiator and listed in its `SELKEY_AFAL_PEER_ENDPOINT_ORIGINS`.

Alternatively, export environment variables in the shell that runs OpenClaw/mcporter,
then use the minimal config:

```json
{
  "servers": {
    "selkey": {
      "command": "selkey-mcp",
      "args": []
    }
  }
}
```

---

## Pre-Flight Checklist

Run these checks on both VPS hosts before starting a live session.

### [ ] OpenClaw running

```bash
openclaw status
# or
systemctl status openclaw
```

Expected: service active and accepting requests.

### [ ] Skill listed as eligible

```bash
openclaw skills list --eligible
```

Expected output includes `selkey` in the list.

### [ ] mcporter can list Selkey tools

```bash
mcporter list-tools
```

Expected output includes both:
- `selkey.get_identity`
- `selkey.relay_signal`

### [ ] Identity returns a valid response

```bash
mcporter call selkey.get_identity '{}'
```

Expected: JSON response containing `agent_id` matching `SELKEY_AGENT_ID`, and
`known_agents` array (may be empty if `SELKEY_KNOWN_AGENTS` is not set).

### [ ] AFAL HTTP server reachable (if RESPOND mode enabled)

If `SELKEY_AFAL_HTTP_PORT` is set, confirm the endpoint is reachable from the
peer host:

```bash
# Run from Bob's VPS to check Alice's AFAL endpoint
curl -f https://alice.example.com:9100/afal/descriptor
```

Expected: JSON descriptor response with `agent_id` and `identity_key`.

### [ ] Tool schemas validate

```bash
mcporter list-tools --verbose
```

Confirm both tools show full input schemas without errors.

### [ ] Firewall rules (AFAL direct transport)

Confirm `SELKEY_AFAL_HTTP_PORT` is open in the host firewall:

```bash
# ufw example
ufw allow 9100/tcp

# iptables example
iptables -A INPUT -p tcp --dport 9100 -j ACCEPT
```

---

## Running the First Session

With both VPS hosts passing all pre-flight checks:

1. Start both OpenClaw agents.

2. On Alice's side: provide a natural-language request that requires vault
   coordination with Bob. OpenClaw uses the `selkey` skill to handle
   protocol steps autonomously.

3. On Bob's side: provide a corresponding natural-language request. OpenClaw
   polls for the incoming invite and responds.

4. Both agents complete the vault session without out-of-band coordination.

### Success criteria

- No manual coordination between operators during the session
- No protocol instructions in user prompts
- Session reaches `state: COMPLETED` on both sides
- Guardian receipt produced and verifiable
- `./.selkey/last_session.json` written on both hosts

### Collecting artefacts

After a successful session, collect:

```bash
# Session pointer
cat ./.selkey/last_session.json

# MCP server logs (if captured)
cat /var/log/selkey-mcp.log
```

---

## Troubleshooting

### `selkey` skill not listed by `openclaw skills list --eligible`

- Confirm the file is at `~/.openclaw/skills/selkey/SKILL.md`
- Confirm the frontmatter is valid YAML with `name` and `description` fields
- Restart OpenClaw after placing the skill

### `selkey.get_identity` not in `mcporter list-tools`

- Confirm `selkey-mcp` is installed and on PATH
- Confirm mcporter config references the correct command
- Run `selkey-mcp` manually to check for startup errors

### `selkey.get_identity` returns error

- Check `SELKEY_AGENT_ID` is set and non-empty
- Check the MCP server process is not crashing on startup

### AFAL transport not activating (INITIATE/RESPOND modes unavailable)

- Confirm `SELKEY_AFAL_SEED_HEX` is set (64-char hex, 32 bytes)
- Confirm `SELKEY_AGENT_ID` is set
- Check MCP server stderr for: `AFAL Direct Transport active`
- Without these, only `CREATE`/`JOIN` (legacy) modes are available

### Invite not received (RESPOND mode stuck)

- Confirm `SELKEY_AFAL_HTTP_PORT` is set and the port is open in firewall
- Confirm the initiator has the correct peer descriptor URL in `SELKEY_KNOWN_AGENTS`
- Confirm `SELKEY_AFAL_TRUSTED_AGENTS` includes the initiator's agent ID and public key
- Check AFAL HTTP server is bound to a reachable address (`SELKEY_AFAL_BIND_ADDRESS`)

### Session fails with `state: FAILED`

- Read `user_message` in the response for the cause
- Check relay URL is reachable from both hosts
- Confirm both agents used the same `purpose` / `expected_purpose`
