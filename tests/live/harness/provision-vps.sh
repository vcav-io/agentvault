#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# provision-vps.sh — Provision an OpenClaw VPS for Selkey live E2E test
#
# Usage:
#   ./provision-vps.sh <ssh-host> <agent-id> <inbox-token> <anthropic-api-key> <relay-url>
#
# Example:
#   ./provision-vps.sh root@178.128.46.89 alice <alice_inbox_token> sk-ant-... http://localhost:3100
# ---------------------------------------------------------------------------

SSH_HOST="${1:?Usage: $0 <ssh-host> <agent-id> <inbox-token> <anthropic-api-key> <relay-url>}"
AGENT_ID="${2:?Missing agent-id}"
INBOX_TOKEN="${3:?Missing inbox-token}"
ANTHROPIC_API_KEY="${4:?Missing anthropic-api-key}"
RELAY_URL="${5:-http://localhost:3100}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

echo "=== Provisioning ${AGENT_ID} on ${SSH_HOST} ==="

# Step 1: Install Node 22 + system deps
echo "--- Installing Node 22 ---"
ssh "${SSH_HOST}" 'bash -s' <<'INSTALL_NODE'
set -euo pipefail
if command -v node &>/dev/null && [[ "$(node --version)" == v22* ]]; then
  echo "Node 22 already installed: $(node --version)"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  echo "Installed: $(node --version)"
fi
npm --version
INSTALL_NODE

# Step 2: Install OpenClaw
echo "--- Installing OpenClaw ---"
ssh "${SSH_HOST}" 'bash -s' <<'INSTALL_OPENCLAW'
set -euo pipefail
if command -v openclaw &>/dev/null; then
  echo "OpenClaw already installed: $(openclaw --version 2>/dev/null || echo unknown)"
else
  npm install -g openclaw@latest
  echo "Installed OpenClaw"
fi
INSTALL_OPENCLAW

# Step 3: Install mcporter
echo "--- Installing mcporter ---"
ssh "${SSH_HOST}" 'bash -s' <<'INSTALL_MCPORTER'
set -euo pipefail
if command -v mcporter &>/dev/null; then
  echo "mcporter already installed"
else
  npm install -g mcporter@latest
  echo "Installed mcporter"
fi
INSTALL_MCPORTER

# Step 4: Copy and build the MCP server
echo "--- Deploying selkey-mcp ---"
ssh "${SSH_HOST}" 'mkdir -p /opt/selkey-mcp'

# Pack the MCP server and its local dependency, then transfer
mkdir -p /tmp/selkey-pack
(cd "${REPO_ROOT}/packages/selkey-client" && npm pack --pack-destination /tmp/selkey-pack)
(cd "${REPO_ROOT}/packages/selkey-mcp" && npm pack --pack-destination /tmp/selkey-pack)

scp /tmp/selkey-pack/selkey-[0-9]*.tgz "${SSH_HOST}:/opt/selkey-mcp/selkey.tgz"
scp /tmp/selkey-pack/selkey-mcp-*.tgz "${SSH_HOST}:/opt/selkey-mcp/selkey-mcp.tgz"
rm -rf /tmp/selkey-pack

ssh "${SSH_HOST}" 'bash -s' <<'DEPLOY_MCP'
set -euo pipefail
cd /opt/selkey-mcp
# Install from tarballs
npm install --global-style ./selkey.tgz
npm install --global-style ./selkey-mcp.tgz
echo "MCP server deployed"
ls -la node_modules/.package-lock.json 2>/dev/null || true
DEPLOY_MCP

# Step 5: Configure OpenClaw headlessly
echo "--- Configuring OpenClaw for ${AGENT_ID} ---"
ssh "${SSH_HOST}" "bash -s -- '${ANTHROPIC_API_KEY}'" <<'CONFIGURE_OPENCLAW'
set -euo pipefail
ANTHROPIC_API_KEY="$1"
mkdir -p ~/.openclaw

cat > ~/.openclaw/openclaw.json <<OCEOF
{
  "env": {
    "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-6"
      },
      "heartbeat": {
        "every": "2m"
      }
    }
  }
}
OCEOF

echo "OpenClaw configured (heartbeat: 2m for testing)"
CONFIGURE_OPENCLAW

# Step 6: Configure mcporter with selkey MCP server
echo "--- Configuring mcporter ---"
ssh "${SSH_HOST}" "bash -s -- '${AGENT_ID}' '${INBOX_TOKEN}' '${RELAY_URL}'" <<'CONFIGURE_MCPORTER'
set -euo pipefail
AGENT_ID="$1"
INBOX_TOKEN="$2"
RELAY_URL="$3"
mkdir -p ~/.mcporter

cat > ~/.mcporter/mcporter.json <<MPEOF
{
  "mcpServers": {
    "selkey": {
      "command": "node",
      "args": ["/opt/selkey-mcp/node_modules/selkey-mcp/dist/index.js"],
      "env": {
        "SELKEY_INBOX_TRANSPORT": "relay",
        "SELKEY_AGENT_ID": "${AGENT_ID}",
        "SELKEY_INBOX_TOKEN": "${INBOX_TOKEN}",
        "SELKEY_RELAY_URL": "${RELAY_URL}",
        "SELKEY_KNOWN_AGENTS": "[{\"agent_id\":\"alice\",\"aliases\":[\"alice\",\"Alice\"]},{\"agent_id\":\"bob\",\"aliases\":[\"bob\",\"Bob\"]}]",
        "SELKEY_WORKDIR": "/root/.openclaw/workspace"
      }
    }
  }
}
MPEOF

echo "mcporter configured for ${AGENT_ID}"
CONFIGURE_MCPORTER

# Step 7: Install the skill
echo "--- Installing selkey skill ---"
ssh "${SSH_HOST}" 'mkdir -p ~/.openclaw/skills/selkey'
scp "${REPO_ROOT}/skills/openclaw/selkey/SKILL.md" "${SSH_HOST}:~/.openclaw/skills/selkey/SKILL.md"

# Step 8: Set up workspace with HEARTBEAT.md
echo "--- Setting up workspace ---"
ssh "${SSH_HOST}" "bash -s" <<WORKSPACE
set -euo pipefail
mkdir -p ~/workspace
WORKSPACE

scp "${REPO_ROOT}/tests/live/HEARTBEAT.md" "${SSH_HOST}:~/workspace/HEARTBEAT.md"

# Step 9: Verify
echo "--- Verifying installation ---"
ssh "${SSH_HOST}" 'bash -s' <<'VERIFY'
set -euo pipefail
echo "Node: $(node --version)"
echo "OpenClaw: $(openclaw --version 2>/dev/null || echo 'version check failed')"
echo "mcporter: $(mcporter --version 2>/dev/null || echo 'version check failed')"
echo "Skill: $(ls ~/.openclaw/skills/selkey/SKILL.md 2>/dev/null && echo OK || echo MISSING)"
echo "HEARTBEAT.md: $(ls ~/workspace/HEARTBEAT.md 2>/dev/null && echo OK || echo MISSING)"
echo "MCP server: $(ls /opt/selkey-mcp/node_modules/selkey-mcp/dist/index.js 2>/dev/null && echo OK || echo MISSING)"
VERIFY

echo "=== ${AGENT_ID} provisioning complete ==="
