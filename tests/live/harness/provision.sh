#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# provision.sh — Ed25519 keygen + MCP config generation for alice/bob
# ---------------------------------------------------------------------------
#
# Generates two Ed25519 key pairs using node + @noble/curves (same dep as
# agentvault-mcp-server), creates resume token secrets, and writes .mcp.json
# into each agent's working directory.
#
# Usage: source this file or call provision_agents <alice_dir> <bob_dir> <relay_url>

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HARNESS_DIR}/../../.." && pwd)"
MCP_SERVER_DIST="${REPO_ROOT}/packages/agentvault-mcp-server/dist/index.js"

# shellcheck source=lib.sh
source "${HARNESS_DIR}/lib.sh"

# ---------------------------------------------------------------------------
# generate_ed25519_keypair: output two lines: <seed_hex> <pubkey_hex>
# ---------------------------------------------------------------------------

_generate_keypair() {
  # Run from MCP server dir so @noble/curves resolves from its node_modules
  (cd "${REPO_ROOT}/packages/agentvault-mcp-server" && node --input-type=module <<'EOF'
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import crypto from 'node:crypto';

const seed = crypto.randomBytes(32);
const pubkey = ed25519.getPublicKey(seed);
process.stdout.write(bytesToHex(seed) + ' ' + bytesToHex(pubkey) + '\n');
EOF
  )
}

# ---------------------------------------------------------------------------
# provision_agents: generate keys + write .mcp.json for alice and bob
#
# Args:
#   $1 alice_dir  — working dir for alice
#   $2 bob_dir    — working dir for bob
#   $3 relay_url  — e.g. http://localhost:3100
#   $4 run_dir    — results run dir for storing keys
# ---------------------------------------------------------------------------

provision_agents() {
  local alice_dir="$1"
  local bob_dir="$2"
  local relay_url="$3"
  local run_dir="${4:-}"

  require_cmd node

  log_info "Generating Ed25519 key pair for alice..."
  local alice_keys
  alice_keys="$(_generate_keypair)"
  local alice_seed
  alice_seed="$(echo "${alice_keys}" | awk '{print $1}')"
  local alice_pubkey
  alice_pubkey="$(echo "${alice_keys}" | awk '{print $2}')"

  log_info "Generating Ed25519 key pair for bob..."
  local bob_keys
  bob_keys="$(_generate_keypair)"
  local bob_seed
  bob_seed="$(echo "${bob_keys}" | awk '{print $1}')"
  local bob_pubkey
  bob_pubkey="$(echo "${bob_keys}" | awk '{print $2}')"

  local alice_resume_secret
  alice_resume_secret="$(openssl rand -hex 32)"
  local bob_resume_secret
  bob_resume_secret="$(openssl rand -hex 32)"

  # Persist keys to run_dir for debugging (never commit these)
  if [[ -n "${run_dir}" ]]; then
    cat >"${run_dir}/identities.json" <<JSON
{
  "alice": {
    "agent_id": "alice",
    "seed_hex": "${alice_seed}",
    "pubkey_hex": "${alice_pubkey}"
  },
  "bob": {
    "agent_id": "bob",
    "seed_hex": "${bob_seed}",
    "pubkey_hex": "${bob_pubkey}"
  }
}
JSON
    log_info "Identity keys written to ${run_dir}/identities.json"
  fi

  # VCAV_KNOWN_AGENTS: aliases for get_identity tool (not crypto keys)
  # Inner quotes escaped for embedding in heredoc JSON string values
  local alice_known_agents='[{\"agent_id\":\"bob\",\"aliases\":[\"Bob\"]}]'
  local bob_known_agents='[{\"agent_id\":\"alice\",\"aliases\":[\"Alice\"]}]'

  # -------------------------------------------------------------------------
  # Alice's .mcp.json (INITIATOR role)
  # Startup order is independent — PROPOSE_RETRY retries for up to 120s if the
  # peer is unreachable. Either agent can start first. (Confirmed in live testing.)
  # Bob's AFAL HTTP port is 3201.
  # -------------------------------------------------------------------------
  mkdir -p "${alice_dir}"
  cat >"${alice_dir}/.mcp.json" <<JSON
{
  "mcpServers": {
    "agentvault": {
      "command": "node",
      "args": ["${MCP_SERVER_DIST}"],
      "env": {
        "VCAV_RELAY_URL": "${relay_url}",
        "VCAV_AGENT_ID": "alice",
        "VCAV_AFAL_SEED_HEX": "${alice_seed}",
        "VCAV_AFAL_PEER_DESCRIPTOR_URL": "http://localhost:3201/afal/descriptor",
        "VCAV_KNOWN_AGENTS": "${alice_known_agents}",
        "VCAV_RESUME_TOKEN_SECRET": "${alice_resume_secret}",
        "VCAV_WORKDIR": "${alice_dir}"
      }
    }
  }
}
JSON
  log_success "Alice .mcp.json written to ${alice_dir}/.mcp.json"

  # -------------------------------------------------------------------------
  # Bob's .mcp.json (RESPONDER role)
  # VCAV_AFAL_HTTP_PORT=3201 starts bob's AFAL HTTP server for descriptor
  # serving and incoming PROPOSE messages.
  # -------------------------------------------------------------------------
  mkdir -p "${bob_dir}"
  cat >"${bob_dir}/.mcp.json" <<JSON
{
  "mcpServers": {
    "agentvault": {
      "command": "node",
      "args": ["${MCP_SERVER_DIST}"],
      "env": {
        "VCAV_RELAY_URL": "${relay_url}",
        "VCAV_AGENT_ID": "bob",
        "VCAV_AFAL_SEED_HEX": "${bob_seed}",
        "VCAV_AFAL_HTTP_PORT": "3201",
        "VCAV_AFAL_TRUSTED_AGENTS": "[{\"agentId\":\"alice\",\"publicKeyHex\":\"${alice_pubkey}\"}]",
        "VCAV_AFAL_ALLOWED_PURPOSES": "MEDIATION,COMPATIBILITY",
        "VCAV_KNOWN_AGENTS": "${bob_known_agents}",
        "VCAV_RESUME_TOKEN_SECRET": "${bob_resume_secret}",
        "VCAV_WORKDIR": "${bob_dir}"
      }
    }
  }
}
JSON
  log_success "Bob .mcp.json written to ${bob_dir}/.mcp.json"
}
