#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# stack.sh — start_stack / stop_stack with provider mode detection
# ---------------------------------------------------------------------------
#
# Environment vars consumed:
#   ANTHROPIC_API_KEY     → use Anthropic directly
#   OPENAI_API_KEY        → start openai-proxy.mjs on port 3199
#   VCAV_MOCK             → set to "1" (or pass --mock to prep.sh)
#   VCAV_PORT             → relay port (default 3100)
#   VCAV_MODEL_ID         → relay model ID
#   VCAV_SIGNING_KEY_HEX  → hex-encoded Ed25519 relay signing seed
#   VCAV_SESSION_TTL_SECS → session TTL (default 600)

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HARNESS_DIR}/../../.." && pwd)"

# shellcheck source=lib.sh
source "${HARNESS_DIR}/lib.sh"

RELAY_PORT="${VCAV_PORT:-3100}"
PROXY_PORT=3199
RELAY_BIN="${REPO_ROOT}/target/release/agentvault-relay"
PROMPT_PROGRAM_DIR="${REPO_ROOT}/packages/agentvault-relay/prompt_programs"
RELAY_LOG_FILE=""
PROXY_LOG_FILE=""

# PIDs stored in temp files so they survive subshell boundaries
RELAY_PID_FILE=""
PROXY_PID_FILE=""

# ---------------------------------------------------------------------------
# Internal: detect provider mode
# ---------------------------------------------------------------------------

_detect_provider_mode() {
  # Explicit override from --provider flag
  if [[ -n "${VCAV_PROVIDER:-}" ]]; then
    echo "${VCAV_PROVIDER}"
    return
  fi
  if [[ "${VCAV_MOCK:-}" == "1" ]]; then
    echo "mock"
  elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "anthropic"
  elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
    echo "openai"
  else
    echo "none"
  fi
}

# ---------------------------------------------------------------------------
# start_stack: build relay if needed, start provider proxy, start relay
# ---------------------------------------------------------------------------

start_stack() {
  local run_dir="${1:-}"

  # -------------------------------------------------------------------------
  # Build relay
  # -------------------------------------------------------------------------
  log_info "Building agentvault-relay (release)..."
  cargo build -p agentvault-relay --release --manifest-path "${REPO_ROOT}/Cargo.toml" \
    2>&1 | while IFS= read -r line; do log_info "  cargo: ${line}"; done
  log_success "Relay binary ready: ${RELAY_BIN}"

  # -------------------------------------------------------------------------
  # Provider mode
  # -------------------------------------------------------------------------
  local mode
  mode="$(_detect_provider_mode)"
  log_info "Provider mode: ${mode}"

  case "${mode}" in
    mock)
      log_info "Starting mock-anthropic.mjs on port ${PROXY_PORT}"
      if [[ -n "${run_dir}" ]]; then
        PROXY_LOG_FILE="${run_dir}/mock-anthropic.log"
      fi
      node "${HARNESS_DIR}/mock-anthropic.mjs" \
        >"${PROXY_LOG_FILE:-/tmp/mock-anthropic.log}" 2>&1 &
      local proxy_pid=$!
      register_pid "${proxy_pid}" "mock-anthropic"
      if [[ -n "${run_dir}" ]]; then
        PROXY_PID_FILE="${run_dir}/mock-anthropic.pid"
        echo "${proxy_pid}" >"${PROXY_PID_FILE}"
      fi
      # Relay must use mock endpoint
      export ANTHROPIC_BASE_URL="http://localhost:${PROXY_PORT}"
      export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-mock-key}"
      ;;
    openai)
      log_info "Starting openai-proxy.mjs on port ${PROXY_PORT}"
      if [[ -n "${run_dir}" ]]; then
        PROXY_LOG_FILE="${run_dir}/openai-proxy.log"
      fi
      node "${HARNESS_DIR}/openai-proxy.mjs" \
        >"${PROXY_LOG_FILE:-/tmp/openai-proxy.log}" 2>&1 &
      local proxy_pid=$!
      register_pid "${proxy_pid}" "openai-proxy"
      if [[ -n "${run_dir}" ]]; then
        PROXY_PID_FILE="${run_dir}/openai-proxy.pid"
        echo "${proxy_pid}" >"${PROXY_PID_FILE}"
      fi
      export ANTHROPIC_BASE_URL="http://localhost:${PROXY_PORT}"
      export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-openai-bridge-key}"
      ;;
    anthropic)
      log_info "Using Anthropic API directly"
      unset ANTHROPIC_BASE_URL 2>/dev/null || true
      ;;
    none)
      log_error "No AI provider configured. Set one of:"
      log_error "  ANTHROPIC_API_KEY=sk-ant-... (use Anthropic directly)"
      log_error "  OPENAI_API_KEY=sk-...        (use OpenAI via proxy)"
      log_error "  VCAV_MOCK=1                  (use mock server)"
      exit 1
      ;;
  esac

  # Wait for proxy to be ready
  if [[ "${mode}" == "mock" || "${mode}" == "openai" ]]; then
    health_check "http://localhost:${PROXY_PORT}/health" 15 1
  fi

  # -------------------------------------------------------------------------
  # Start relay
  # -------------------------------------------------------------------------
  log_info "Starting agentvault-relay on port ${RELAY_PORT}"

  if [[ -n "${run_dir}" ]]; then
    RELAY_LOG_FILE="${run_dir}/relay.log"
    RELAY_PID_FILE="${run_dir}/relay.pid"
  fi

  VCAV_PORT="${RELAY_PORT}" \
  VCAV_PROMPT_PROGRAM_DIR="${VCAV_PROMPT_PROGRAM_DIR:-${PROMPT_PROGRAM_DIR}}" \
  VCAV_MODEL_ID="${VCAV_MODEL_ID:-claude-sonnet-4-5-20250929}" \
  VCAV_SIGNING_KEY_HEX="${VCAV_SIGNING_KEY_HEX:-}" \
  VCAV_SESSION_TTL_SECS="${VCAV_SESSION_TTL_SECS:-600}" \
  "${RELAY_BIN}" \
    >"${RELAY_LOG_FILE:-/tmp/relay.log}" 2>&1 &

  local relay_pid=$!
  register_pid "${relay_pid}" "agentvault-relay"
  if [[ -n "${RELAY_PID_FILE}" ]]; then
    echo "${relay_pid}" >"${RELAY_PID_FILE}"
  fi

  log_info "Relay PID: ${relay_pid}"
  health_check "http://localhost:${RELAY_PORT}/health" 30 1
  log_success "Stack started"
}

# ---------------------------------------------------------------------------
# stop_stack: kill processes and archive logs
# ---------------------------------------------------------------------------

stop_stack() {
  local run_dir="${1:-}"
  log_info "Stopping stack..."

  # Kill relay
  if [[ -n "${RELAY_PID_FILE}" && -f "${RELAY_PID_FILE}" ]]; then
    local relay_pid
    relay_pid="$(cat "${RELAY_PID_FILE}")"
    if kill -0 "${relay_pid}" 2>/dev/null; then
      log_info "Stopping relay (pid ${relay_pid})"
      kill "${relay_pid}" 2>/dev/null || true
    fi
  fi

  # Kill proxy
  if [[ -n "${PROXY_PID_FILE}" && -f "${PROXY_PID_FILE}" ]]; then
    local proxy_pid
    proxy_pid="$(cat "${PROXY_PID_FILE}")"
    if kill -0 "${proxy_pid}" 2>/dev/null; then
      log_info "Stopping proxy (pid ${proxy_pid})"
      kill "${proxy_pid}" 2>/dev/null || true
    fi
  fi

  # Also fire the registered PIDs cleanup
  cleanup_pids

  log_success "Stack stopped"
}
