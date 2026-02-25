#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# prep.sh — Main preparation script for AgentVault live test suite
#
# Usage:
#   ./tests/live/prep.sh <scenario>           # run a named scenario
#   ./tests/live/prep.sh --smoke              # run smoke scenario
#   ./tests/live/prep.sh --all                # run all scenarios
#
# Flags:
#   --mock       use mock-anthropic.mjs (no real API key required)
#   --provider   specify provider: anthropic|openai|mock
#   --smoke      shorthand for running the smoke scenario
#   --all        run all scenarios in tests/live/scenarios/
#
# Environment:
#   ANTHROPIC_API_KEY, OPENAI_API_KEY, VCAV_MOCK, VCAV_TEST_DIR
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HARNESS_DIR="${SCRIPT_DIR}/harness"
SCENARIOS_DIR="${SCRIPT_DIR}/scenarios"
RESULTS_BASE="${SCRIPT_DIR}/results"
MCP_SERVER_DIR="${REPO_ROOT}/packages/agentvault-mcp-server"

# shellcheck source=harness/lib.sh
source "${HARNESS_DIR}/lib.sh"
# shellcheck source=harness/stack.sh
source "${HARNESS_DIR}/stack.sh"
# shellcheck source=harness/provision.sh
source "${HARNESS_DIR}/provision.sh"
# shellcheck source=harness/workspace.sh
source "${HARNESS_DIR}/workspace.sh"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

SCENARIO=""
FLAG_MOCK=0
FLAG_ALL=0
FLAG_SMOKE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mock)
      export VCAV_MOCK=1
      FLAG_MOCK=1
      shift
      ;;
    --provider)
      case "${2:-}" in
        anthropic) unset VCAV_MOCK 2>/dev/null || true ;;
        openai)    unset VCAV_MOCK 2>/dev/null || true ;;
        mock)      export VCAV_MOCK=1; FLAG_MOCK=1 ;;
        *)
          log_error "Unknown provider: ${2:-}. Use: anthropic, openai, mock"
          exit 1
          ;;
      esac
      shift 2
      ;;
    --smoke)
      FLAG_SMOKE=1
      SCENARIO="01-cofounder-mediation"
      shift
      ;;
    --all)
      FLAG_ALL=1
      shift
      ;;
    -*)
      log_error "Unknown flag: $1"
      exit 1
      ;;
    *)
      SCENARIO="$1"
      shift
      ;;
  esac
done

if [[ -z "${SCENARIO}" && "${FLAG_ALL}" -eq 0 ]]; then
  log_error "Usage: $0 <scenario> | --smoke | --all [--mock | --provider <p>]"
  exit 1
fi

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

log_info "Running preflight checks..."
require_cmd cargo
require_cmd node
require_cmd npm
require_cmd openssl
require_cmd curl
require_cmd git

# Verify we're in the repo root
if [[ ! -f "${REPO_ROOT}/Cargo.toml" ]]; then
  log_error "Cannot find Cargo.toml in ${REPO_ROOT}. Run from repo root."
  exit 1
fi

# cargo metadata check
log_info "Checking cargo workspace..."
cargo metadata --no-deps --manifest-path "${REPO_ROOT}/Cargo.toml" --format-version 1 \
  >/dev/null 2>&1 || { log_error "cargo metadata failed"; exit 1; }

# Build MCP server TypeScript
log_info "Building agentvault-mcp-server..."
(cd "${MCP_SERVER_DIR}" && npm install --silent && npm run build --silent)
log_success "agentvault-mcp-server built"

# ---------------------------------------------------------------------------
# Resolve scenarios to run
# ---------------------------------------------------------------------------

if [[ "${FLAG_ALL}" -eq 1 ]]; then
  mapfile -t SCENARIOS < <(find "${SCENARIOS_DIR}" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)
  if [[ ${#SCENARIOS[@]} -eq 0 ]]; then
    log_error "No scenarios found in ${SCENARIOS_DIR}"
    exit 1
  fi
  log_info "Running all scenarios: ${SCENARIOS[*]}"
else
  SCENARIOS=("${SCENARIO}")
fi

# ---------------------------------------------------------------------------
# Create run directory
# ---------------------------------------------------------------------------

RUN_TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
RUN_DIR="${RESULTS_BASE}/${RUN_TIMESTAMP}"
mkdir -p "${RUN_DIR}"
log_info "Run directory: ${RUN_DIR}"

# ---------------------------------------------------------------------------
# Register cleanup
# ---------------------------------------------------------------------------

setup_cleanup_trap

# ---------------------------------------------------------------------------
# Start the stack
# ---------------------------------------------------------------------------

# Generate relay signing key if not already set
if [[ -z "${VCAV_SIGNING_KEY_HEX:-}" ]]; then
  export VCAV_SIGNING_KEY_HEX
  VCAV_SIGNING_KEY_HEX="$(openssl rand -hex 32)"
  log_info "Generated relay signing key"
fi

log_info "Starting infrastructure stack..."
start_stack "${RUN_DIR}"

# ---------------------------------------------------------------------------
# Set up workspaces
# ---------------------------------------------------------------------------

log_info "Setting up agent workspaces..."
setup_workspace

# ---------------------------------------------------------------------------
# Provision identities
# ---------------------------------------------------------------------------

log_info "Provisioning Ed25519 identities..."
provision_agents "${ALICE_DIR}" "${BOB_DIR}" "http://localhost:${RELAY_PORT}" "${RUN_DIR}"

# ---------------------------------------------------------------------------
# For each scenario: copy prompts and print operator instructions
# ---------------------------------------------------------------------------

for sc in "${SCENARIOS[@]}"; do
  SC_DIR="${SCENARIOS_DIR}/${sc}"

  if [[ ! -d "${SC_DIR}" ]]; then
    log_error "Scenario not found: ${SC_DIR}"
    exit 1
  fi

  # Detect prompt file naming convention
  # Support both alice/bob and sender/receiver naming
  local_alice_prompt=""
  local_bob_prompt=""

  for f in alice_prompt.txt sender_prompt.txt; do
    if [[ -f "${SC_DIR}/${f}" ]]; then
      local_alice_prompt="${SC_DIR}/${f}"
      break
    fi
  done

  for f in bob_prompt.txt receiver_prompt.txt; do
    if [[ -f "${SC_DIR}/${f}" ]]; then
      local_bob_prompt="${SC_DIR}/${f}"
      break
    fi
  done

  if [[ -z "${local_alice_prompt}" || -z "${local_bob_prompt}" ]]; then
    log_error "Scenario '${sc}' missing prompt files. Expected: alice_prompt.txt + bob_prompt.txt (or sender/receiver)"
    exit 1
  fi

  # Copy prompts to run dir
  SC_RUN_DIR="${RUN_DIR}/${sc}"
  mkdir -p "${SC_RUN_DIR}"
  cp "${local_alice_prompt}" "${SC_RUN_DIR}/alice_prompt.txt"
  cp "${local_bob_prompt}"   "${SC_RUN_DIR}/bob_prompt.txt"

  # Copy criteria if present
  if [[ -f "${SC_DIR}/criteria.json" ]]; then
    cp "${SC_DIR}/criteria.json" "${SC_RUN_DIR}/criteria.json"
  fi

  log_success "Scenario '${sc}' prompts staged to ${SC_RUN_DIR}"
done

# ---------------------------------------------------------------------------
# Print operator instructions
# ---------------------------------------------------------------------------

_provider_display() {
  if [[ "${VCAV_MOCK:-}" == "1" ]]; then echo "mock"
  elif [[ -n "${OPENAI_API_KEY:-}" ]]; then echo "openai (via proxy)"
  elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then echo "anthropic (direct)"
  else echo "unknown"; fi
}

# Print instructions for each scenario
for sc in "${SCENARIOS[@]}"; do
  SC_RUN="${RUN_DIR}/${sc}"
  cat <<INSTRUCTIONS

═══════════════════════════════════════════════════════
  AgentVault Live Test — Scenario: ${sc}
  Run ID: ${RUN_TIMESTAMP}
  Provider: $(_provider_display)
═══════════════════════════════════════════════════════

  Terminal B (Bob — RESPONDER, start FIRST):
    cd ${BOB_DIR}
    claude

    Then paste the contents of:
    ${SC_RUN}/bob_prompt.txt

  Terminal A (Alice — INITIATOR, start SECOND):
    cd ${ALICE_DIR}
    claude

    Then paste the contents of:
    ${SC_RUN}/alice_prompt.txt

  IMPORTANT: Start Bob first (responder), then Alice (initiator).
  Do not type anything else — observe only.

  When both sessions complete (or after 10 minutes), run:
    ./tests/live/verify.sh ${RUN_TIMESTAMP}

  Logs:
    relay:  ${RUN_DIR}/relay.log
    proxy:  ${RUN_DIR}/mock-anthropic.log (if mock mode)

═══════════════════════════════════════════════════════

INSTRUCTIONS
done

log_info "prep.sh complete — stack is running in background. Press Ctrl-C to stop."

# Keep the script alive so the stack stays up (trap will clean up on exit)
while true; do
  sleep 10
done
