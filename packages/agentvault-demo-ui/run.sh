#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# packages/agentvault-demo-ui/run.sh — Start the AgentVault demo UI
#
# Builds the relay, starts it, builds the demo server, and opens browser.
#
# Usage:
#   ./packages/agentvault-demo-ui/run.sh           # full setup
#   ./packages/agentvault-demo-ui/run.sh --no-relay # skip relay (already running)
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DEMO_DIR="${SCRIPT_DIR}"
MCP_SERVER_DIR="${REPO_ROOT}/packages/agentvault-mcp-server"

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
    *) log_error "Unknown argument: $1"
       echo "Usage: $0 [--no-relay]" >&2
       exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

for cmd in node cargo; do
  if ! command -v "$cmd" &>/dev/null; then
    log_error "Required command not found: ${cmd}"
    exit 1
  fi
done

# Source .env for API key
if [[ -f "${DEMO_DIR}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${DEMO_DIR}/.env"
  set +a
elif [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/.env"
  set +a
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]] && [[ -z "${OPENAI_API_KEY:-}" ]] && [[ -z "${GEMINI_API_KEY:-}" ]]; then
  log_error "No API key found. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY in .env"
  exit 1
fi

# ---------------------------------------------------------------------------
# Build dependencies
# ---------------------------------------------------------------------------

# Build MCP server (required for tool registry)
if [[ ! -f "${MCP_SERVER_DIR}/dist/tool-registry.js" ]]; then
  log_info "Building agentvault-mcp-server..."
  (cd "${MCP_SERVER_DIR}" && npm install --silent && npm run build --silent)
  log_success "MCP server built"
fi

# Build demo UI
log_info "Building demo UI..."
(cd "${DEMO_DIR}" && npm install --silent && npm run build --silent)
log_success "Demo UI built"

# ---------------------------------------------------------------------------
# Start relay (unless --no-relay or already running)
# ---------------------------------------------------------------------------

RELAY_URL="http://localhost:3100"
RELAY_PID=""

cleanup() {
  if [[ -n "${RELAY_PID}" ]] && kill -0 "${RELAY_PID}" 2>/dev/null; then
    log_info "Stopping relay (pid ${RELAY_PID})"
    kill "${RELAY_PID}" 2>/dev/null || true
  fi
  # Kill stale AFAL servers
  if command -v lsof &>/dev/null; then
    lsof -ti:3201 2>/dev/null | xargs kill 2>/dev/null || true
    lsof -ti:3202 2>/dev/null | xargs kill 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "${NO_RELAY}" == "false" ]]; then
  if curl -sf "${RELAY_URL}/health" &>/dev/null; then
    log_success "Relay already running at ${RELAY_URL}"
  else
    log_info "Building relay..."
    cargo build --release -p agentvault-relay --manifest-path "${REPO_ROOT}/Cargo.toml" 2>&1 | \
      while IFS= read -r line; do log_info "  cargo: ${line}"; done
    log_success "Relay binary ready"

    RELAY_BIN="${REPO_ROOT}/target/release/agentvault-relay"
    VCAV_PORT=3100 \
    VCAV_PROMPT_PROGRAM_DIR="${REPO_ROOT}/packages/agentvault-relay/prompt_programs" \
    VCAV_ENV=dev \
    VCAV_INBOX_AUTH=off \
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
    GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
      "${RELAY_BIN}" &>/tmp/vcav-demo-relay.log &
    RELAY_PID=$!

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

# Kill stale AFAL servers from previous runs
if command -v lsof &>/dev/null; then
  for afal_port in 3201 3202; do
    STALE_AFAL="$(lsof -ti:${afal_port} 2>/dev/null | head -1)" || true
    if [[ -n "${STALE_AFAL}" ]]; then
      log_info "Killing stale AFAL server on port ${afal_port} (pid ${STALE_AFAL})"
      lsof -ti:${afal_port} 2>/dev/null | xargs kill 2>/dev/null || true
      sleep 1
    fi
  done
fi

# ---------------------------------------------------------------------------
# Start demo server
# ---------------------------------------------------------------------------

log_info "Starting demo UI server..."
VCAV_RELAY_URL="${RELAY_URL}" \
  node "${DEMO_DIR}/dist/server.js" &
DEMO_PID=$!

# Wait for server
sleep 2
if ! curl -sf "http://localhost:3200" &>/dev/null; then
  sleep 3
  if ! curl -sf "http://localhost:3200" &>/dev/null; then
    log_error "Demo UI server failed to start. Check the output above for errors."
    exit 1
  fi
fi

log_success "Demo UI running at http://localhost:3200"

# Try to open browser
if command -v open &>/dev/null; then
  open "http://localhost:3200"
elif command -v xdg-open &>/dev/null; then
  xdg-open "http://localhost:3200"
fi

cat <<EOF

${BOLD}═══════════════════════════════════════════════════════════════${NC}
${BOLD}  AgentVault Demo UI${NC}
${BOLD}═══════════════════════════════════════════════════════════════${NC}

  Open ${BOLD}http://localhost:3200${NC} in your browser.
  Click "Start Protocol" to run the co-founder mediation scenario.

  ${BOLD}Relay:${NC}     ${RELAY_URL}
  ${BOLD}Demo UI:${NC}   http://localhost:3200
  ${BOLD}Relay log:${NC} /tmp/vcav-demo-relay.log

  Press Ctrl-C to stop.
${BOLD}═══════════════════════════════════════════════════════════════${NC}

EOF

# Wait for demo server
wait "${DEMO_PID}" 2>/dev/null || true
