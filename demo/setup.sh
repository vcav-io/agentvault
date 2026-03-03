#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# demo/setup.sh — One-command demo setup for AgentVault
#
# Starts the relay, creates isolated agent workspaces in /tmp, generates
# Ed25519 identities, and prints copy-paste instructions.
#
# Usage:
#   ./demo/setup.sh                 # auto-detect relay method
#   ./demo/setup.sh --no-relay      # skip relay (already running)
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MCP_SERVER_DIR="${REPO_ROOT}/packages/agentvault-mcp-server"
MCP_DIST="${MCP_SERVER_DIR}/dist/index.js"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()    { echo -e "${CYAN}[INFO]${NC}  $*" >&2; }
log_success() { echo -e "${GREEN}[OK]${NC}    $*" >&2; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

NO_RELAY=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-relay) NO_RELAY=true; shift ;;
    --stop)
      log_info "Cleaning up demo..."
      # Kill relay if we started it
      if [[ -f /tmp/vcav-demo-relay.pid ]]; then
        kill "$(cat /tmp/vcav-demo-relay.pid)" 2>/dev/null || true
        rm -f /tmp/vcav-demo-relay.pid
      fi
      # Kill any relay on port 3100 and AFAL server on port 3201
      if command -v lsof &>/dev/null; then
        lsof -ti:3100 2>/dev/null | xargs kill 2>/dev/null || true
        lsof -ti:3201 2>/dev/null | xargs kill 2>/dev/null || true
      fi
      # Remove workspace dirs
      rm -rf /tmp/vcav-demo-*
      log_success "Demo cleaned up"
      exit 0
      ;;
    *) log_error "Unknown argument: $1"
       echo "Usage: $0 [--no-relay] [--stop]" >&2
       exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

for cmd in node openssl curl python3; do
  if ! command -v "$cmd" &>/dev/null; then
    log_error "Required command not found: ${cmd}"
    exit 1
  fi
done

# Source .env for API key
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/.env"
  set +a
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  log_error "ANTHROPIC_API_KEY not set. Add it to .env or export it."
  exit 1
fi

# Ensure MCP server is built
if [[ ! -f "${MCP_DIST}" ]]; then
  log_info "Building agentvault-mcp-server..."
  (cd "${MCP_SERVER_DIR}" && npm install --silent && npm run build --silent)
  log_success "MCP server built"
fi

# ---------------------------------------------------------------------------
# Start relay (unless --no-relay or already running)
# ---------------------------------------------------------------------------

RELAY_URL="http://localhost:3100"
RELAY_PID=""

cleanup() {
  if [[ -n "${RELAY_PID}" ]] && kill -0 "${RELAY_PID}" 2>/dev/null; then
    log_info "Stopping relay (pid ${RELAY_PID})"
    kill "${RELAY_PID}" 2>/dev/null || true
    rm -f /tmp/vcav-demo-relay.pid
  fi
}
trap cleanup EXIT INT TERM

if [[ "${NO_RELAY}" == "false" ]]; then
  # Check if relay is already running
  if curl -sf "${RELAY_URL}/health" &>/dev/null; then
    log_success "Relay already running at ${RELAY_URL}"
  else
    # Check for port conflict
    if command -v lsof &>/dev/null; then
      CONFLICT_PID="$(lsof -ti:3100 2>/dev/null | head -1)" || true
      if [[ -n "${CONFLICT_PID}" ]]; then
        log_error "Port 3100 is already in use (pid ${CONFLICT_PID}). Stop it or use --no-relay."
        exit 1
      fi
    fi
    # Build from source
    log_info "Building relay (release)..."
    cargo build --release -p agentvault-relay --manifest-path "${REPO_ROOT}/Cargo.toml" 2>&1 | \
      while IFS= read -r line; do log_info "  cargo: ${line}"; done
    log_success "Relay binary ready"

    RELAY_BIN="${REPO_ROOT}/target/release/agentvault-relay"
    VCAV_PORT=3100 \
    VCAV_PROMPT_PROGRAM_DIR="${REPO_ROOT}/packages/agentvault-relay/prompt_programs" \
    VCAV_ENV=dev \
    VCAV_INBOX_AUTH=off \
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
      "${RELAY_BIN}" &>/tmp/vcav-demo-relay.log &
    RELAY_PID=$!
    echo "${RELAY_PID}" > /tmp/vcav-demo-relay.pid

    # Wait for health
    log_info "Waiting for relay..."
    elapsed=0
    while (( elapsed < 30 )); do
      if curl -sf "${RELAY_URL}/health" &>/dev/null; then break; fi
      sleep 1
      elapsed=$(( elapsed + 1 ))
    done

    if ! curl -sf "${RELAY_URL}/health" &>/dev/null; then
      log_error "Relay failed to start. Check /tmp/vcav-demo-relay.log"
      exit 1
    fi
    log_success "Relay running (pid ${RELAY_PID})"
  fi
else
  if ! curl -sf "${RELAY_URL}/health" &>/dev/null; then
    log_error "Relay not running at ${RELAY_URL}. Start it first or remove --no-relay."
    exit 1
  fi
  log_success "Relay confirmed at ${RELAY_URL}"
fi

# ---------------------------------------------------------------------------
# Kill stale AFAL servers from previous demo runs
# ---------------------------------------------------------------------------

if command -v lsof &>/dev/null; then
  STALE_AFAL="$(lsof -ti:3201 2>/dev/null | head -1)" || true
  if [[ -n "${STALE_AFAL}" ]]; then
    log_info "Killing stale AFAL server on port 3201 (pid ${STALE_AFAL})"
    lsof -ti:3201 2>/dev/null | xargs kill 2>/dev/null || true
    sleep 1
  fi
fi

# ---------------------------------------------------------------------------
# Generate Ed25519 keypairs
# ---------------------------------------------------------------------------

log_info "Generating agent identities..."
KEYS="$(cd "${MCP_SERVER_DIR}" && node --input-type=module <<'EOF'
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import crypto from 'node:crypto';
const a = crypto.randomBytes(32), b = crypto.randomBytes(32);
console.log(JSON.stringify({
  as: bytesToHex(a), ap: bytesToHex(ed25519.getPublicKey(a)),
  bs: bytesToHex(b), bp: bytesToHex(ed25519.getPublicKey(b))
}));
EOF
)"

ALICE_SEED="$(echo "${KEYS}" | python3 -c "import sys,json; print(json.load(sys.stdin)['as'])")"
ALICE_PUB="$(echo "${KEYS}" | python3 -c "import sys,json; print(json.load(sys.stdin)['ap'])")"
BOB_SEED="$(echo "${KEYS}" | python3 -c "import sys,json; print(json.load(sys.stdin)['bs'])")"
ALICE_RESUME="$(openssl rand -hex 32)"
BOB_RESUME="$(openssl rand -hex 32)"

log_success "Identities generated"

# ---------------------------------------------------------------------------
# Create workspaces in /tmp
# ---------------------------------------------------------------------------

DEMO_DIR="$(mktemp -d /tmp/vcav-demo-XXXX)"
mkdir -p "${DEMO_DIR}/alice/.agentvault" "${DEMO_DIR}/bob/.agentvault"

cat >"${DEMO_DIR}/alice/.mcp.json" <<JSON
{
  "mcpServers": {
    "agentvault": {
      "command": "node",
      "args": ["${MCP_DIST}"],
      "env": {
        "VCAV_RELAY_URL": "${RELAY_URL}",
        "VCAV_AGENT_ID": "alice",
        "VCAV_AFAL_SEED_HEX": "${ALICE_SEED}",
        "VCAV_AFAL_PEER_DESCRIPTOR_URL": "http://localhost:3201/afal/descriptor",
        "VCAV_KNOWN_AGENTS": "[{\"agent_id\":\"bob\",\"aliases\":[\"Bob\"]}]",
        "VCAV_RESUME_TOKEN_SECRET": "${ALICE_RESUME}",
        "VCAV_WORKDIR": "${DEMO_DIR}/alice"
      }
    }
  }
}
JSON

cat >"${DEMO_DIR}/bob/.mcp.json" <<JSON
{
  "mcpServers": {
    "agentvault": {
      "command": "node",
      "args": ["${MCP_DIST}"],
      "env": {
        "VCAV_RELAY_URL": "${RELAY_URL}",
        "VCAV_AGENT_ID": "bob",
        "VCAV_AFAL_SEED_HEX": "${BOB_SEED}",
        "VCAV_AFAL_HTTP_PORT": "3201",
        "VCAV_AFAL_TRUSTED_AGENTS": "[{\"agentId\":\"alice\",\"publicKeyHex\":\"${ALICE_PUB}\"}]",
        "VCAV_AFAL_ALLOWED_PURPOSES": "MEDIATION,COMPATIBILITY",
        "VCAV_KNOWN_AGENTS": "[{\"agent_id\":\"alice\",\"aliases\":[\"Alice\"]}]",
        "VCAV_RESUME_TOKEN_SECRET": "${BOB_RESUME}",
        "VCAV_WORKDIR": "${DEMO_DIR}/bob"
      }
    }
  }
}
JSON

log_success "Workspaces created: ${DEMO_DIR}"

# ---------------------------------------------------------------------------
# Read prompts
# ---------------------------------------------------------------------------

ALICE_PROMPT="$(cat "${SCRIPT_DIR}/alice-prompt.md")"
BOB_PROMPT="$(cat "${SCRIPT_DIR}/bob-prompt.md")"

# ---------------------------------------------------------------------------
# Print instructions
# ---------------------------------------------------------------------------

cat <<INSTRUCTIONS

${BOLD}═══════════════════════════════════════════════════════════════${NC}
${BOLD}  AgentVault Demo — Co-founder Mediation${NC}
${BOLD}═══════════════════════════════════════════════════════════════${NC}

  Open two terminals and start Claude Code in each.
  Either terminal can go first.

  ${BOLD}Terminal 1 — Alice:${NC}
    cd ${DEMO_DIR}/alice
    claude --mcp-config .mcp.json

    Then paste this prompt:
    ┌─────────────────────────────────────────────────────────┐
$(echo "${ALICE_PROMPT}" | sed 's/^/    │ /')
    └─────────────────────────────────────────────────────────┘

  ${BOLD}Terminal 2 — Bob:${NC}
    cd ${DEMO_DIR}/bob
    claude --mcp-config .mcp.json

    Then paste this prompt:
    ┌─────────────────────────────────────────────────────────┐
$(echo "${BOB_PROMPT}" | sed 's/^/    │ /')
    └─────────────────────────────────────────────────────────┘

  ${BOLD}What to expect:${NC}
    Both agents coordinate through the relay. Each submits
    private context that the other never sees. The relay
    produces a bounded mediation signal and a signed receipt.
    Typical completion time: under 60 seconds.

  ${BOLD}Relay log:${NC} /tmp/vcav-demo-relay.log
  ${BOLD}Workspaces:${NC} ${DEMO_DIR}

  Press Ctrl-C to stop the relay and clean up.
${BOLD}═══════════════════════════════════════════════════════════════${NC}

INSTRUCTIONS

# Keep relay alive until user exits
if [[ -n "${RELAY_PID}" ]]; then
  wait "${RELAY_PID}" 2>/dev/null || true
else
  # Relay was already running or --no-relay; just wait for Ctrl-C
  log_info "Demo ready. Press Ctrl-C when done."
  while true; do sleep 10; done
fi
