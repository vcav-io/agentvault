# OpenClaw VPS Runbook — AgentVault Peer-to-Peer Session

This runbook covers deploying the AgentVault MCP server and OpenClaw skill on a
VPS for a first peer-to-peer vault session between two independent agents (Alice
and Bob). Follow each step on both VPS hosts unless noted otherwise.

---

## Architecture

```
Alice VPS                          Bob VPS
  OpenClaw                           OpenClaw
    mcporter -> agentvault-mcp         mcporter -> agentvault-mcp
                     |                                   |
              DirectAfalTransport <--AFAL--> DirectAfalTransport
                     |                                   |
              agentvault-relay  (shared or per-host)
```

Transport mode for first test: AFAL direct (no relay hop for invite exchange).
Each agent runs its own MCP server instance. The relay handles vault execution.

---

## Environment Variables

Set these on each VPS before starting the MCP server. Values differ per host.

| Variable | Required | Description |
|----------|----------|-------------|
| `AV_AGENT_ID` | Yes | Unique agent identifier for this host (e.g. `alice-agent`) |
| `AV_RELAY_URL` | Yes | Base URL of the AgentVault relay (e.g. `https://relay.example.com`) |
| `AV_AFAL_SEED_HEX` | Yes (AFAL) | Ed25519 seed as 64-char hex — enables AFAL direct transport and INITIATE/RESPOND modes. **Secret: do not commit to version control.** Generate with `openssl rand -hex 32`. |
| `AV_AFAL_PEER_DESCRIPTOR_URL` | INITIATE mode | Peer's AFAL descriptor URL (e.g. `https://bob.example.com:9100/afal/descriptor`) — used by initiator to discover the peer |
| `AV_KNOWN_AGENTS` | Yes | JSON array of peer agents for alias resolution (see format below) |
| `AV_RESUME_TOKEN_SECRET` | Recommended | HMAC secret for signing resume tokens. Generate with `openssl rand -hex 32` |
| `AV_AFAL_HTTP_PORT` | RESPOND mode | Port for AFAL HTTP server — enables inbox for incoming invites |
| `AV_AFAL_BIND_ADDRESS` | Optional | Bind address for AFAL HTTP server (default: `127.0.0.1`) |
| `AV_AFAL_TRUSTED_AGENTS` | Optional | JSON array of trusted agents with their public keys for signature verification |
| `AV_AFAL_ALLOWED_PURPOSES` | Optional | Comma-separated allowed purposes (default: `MEDIATION`). Example: `MEDIATION,COMPATIBILITY` |

### AV_KNOWN_AGENTS format

```json
[
  {
    "agent_id": "bob-agent",
    "aliases": ["bob", "Bob"]
  }
]
```

Note: `AV_KNOWN_AGENTS` entries have only `agent_id` and `aliases`. The peer's
descriptor URL is configured separately via `AV_AFAL_PEER_DESCRIPTOR_URL`.

### AV_AFAL_TRUSTED_AGENTS format

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
const seed = process.env.AV_AFAL_SEED_HEX;
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

### 3. Install AgentVault MCP Server

```bash
npm install -g agentvault-mcp-server
```

Or run directly without installing:

```bash
npx agentvault-mcp-server --version
```

Confirm the binary resolves:

```bash
which agentvault-mcp-server
```

### 4. Install the OpenClaw Skill

Copy the skill from the repository to OpenClaw's skills directory:

```bash
mkdir -p ~/.openclaw/skills/agentvault
cp /path/to/av-repo/skills/openclaw/agentvault/SKILL.md \
   ~/.openclaw/skills/agentvault/SKILL.md
```

### 5. Configure mcporter

Add the AgentVault MCP server to mcporter's configuration. Create or update
`~/.mcporter/config.json` (or your mcporter config path):

```json
{
  "servers": {
    "agentvault": {
      "command": "agentvault-mcp-server",
      "args": [],
      "env": {
        "AV_AGENT_ID": "alice-agent",
        "AV_RELAY_URL": "https://relay.example.com",
        "AV_AFAL_SEED_HEX": "<your-seed-hex>",
        "AV_AFAL_HTTP_PORT": "9100",
        "AV_AFAL_BIND_ADDRESS": "0.0.0.0",
        "AV_AFAL_PEER_DESCRIPTOR_URL": "https://bob.example.com:9100/afal/descriptor",
        "AV_AFAL_ALLOWED_PURPOSES": "MEDIATION,COMPATIBILITY",
        "AV_AFAL_TRUSTED_AGENTS": "[{\"agentId\":\"bob-agent\",\"publicKeyHex\":\"...\"}]",
        "AV_KNOWN_AGENTS": "[{\"agent_id\":\"bob-agent\",\"aliases\":[\"bob\",\"Bob\"]}]",
        "AV_RESUME_TOKEN_SECRET": "<your-secret>"
      }
    }
  }
}
```

Alternatively, export environment variables in the shell that runs OpenClaw/mcporter,
then use the minimal config:

```json
{
  "servers": {
    "agentvault": {
      "command": "agentvault-mcp-server",
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

Expected output includes `agentvault` in the list.

### [ ] mcporter can list AgentVault tools

```bash
mcporter list-tools
```

Expected output includes both:
- `agentvault.get_identity`
- `agentvault.relay_signal`

### [ ] Identity returns a valid response

```bash
mcporter call agentvault.get_identity '{}'
```

Expected: JSON response containing `agent_id` matching `AV_AGENT_ID`, and
`known_agents` array (may be empty if `AV_KNOWN_AGENTS` is not set).

### [ ] AFAL HTTP server reachable (if RESPOND mode enabled)

If `AV_AFAL_HTTP_PORT` is set, confirm the endpoint is reachable from the
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

Confirm `AV_AFAL_HTTP_PORT` is open in the host firewall:

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
   coordination with Bob. OpenClaw uses the `agentvault` skill to handle
   protocol steps autonomously.

3. On Bob's side: provide a corresponding natural-language request. OpenClaw
   polls for the incoming invite and responds.

4. Both agents complete the vault session without out-of-band coordination.

### Success criteria

- No manual coordination between operators during the session
- No protocol instructions in user prompts
- Session reaches `state: COMPLETED` on both sides
- Guardian receipt produced and verifiable
- `./.agentvault/last_session.json` written on both hosts

### Collecting artefacts

After a successful session, collect:

```bash
# Session pointer
cat ./.agentvault/last_session.json

# MCP server logs (if captured)
cat /var/log/agentvault-mcp.log
```

---

## Troubleshooting

### `agentvault` skill not listed by `openclaw skills list --eligible`

- Confirm the file is at `~/.openclaw/skills/agentvault/SKILL.md`
- Confirm the frontmatter is valid YAML with `name` and `description` fields
- Restart OpenClaw after placing the skill

### `agentvault.get_identity` not in `mcporter list-tools`

- Confirm `agentvault-mcp-server` is installed and on PATH
- Confirm mcporter config references the correct command
- Run `agentvault-mcp-server` manually to check for startup errors

### `agentvault.get_identity` returns error

- Check `AV_AGENT_ID` is set and non-empty
- Check the MCP server process is not crashing on startup

### AFAL transport not activating (INITIATE/RESPOND modes unavailable)

- Confirm `AV_AFAL_SEED_HEX` is set (64-char hex, 32 bytes)
- Confirm `AV_AGENT_ID` is set
- Check MCP server stderr for: `AFAL Direct Transport active`
- Without these, only `CREATE`/`JOIN` (legacy) modes are available

### Invite not received (RESPOND mode stuck)

- Confirm `AV_AFAL_HTTP_PORT` is set and the port is open in firewall
- Confirm the initiator has the correct peer descriptor URL in `AV_KNOWN_AGENTS`
- Confirm `AV_AFAL_TRUSTED_AGENTS` includes the initiator's agent ID and public key
- Check AFAL HTTP server is bound to a reachable address (`AV_AFAL_BIND_ADDRESS`)

### Session fails with `state: FAILED`

- Read `user_message` in the response for the cause
- Check relay URL is reachable from both hosts
- Confirm both agents used the same `purpose` / `expected_purpose`
