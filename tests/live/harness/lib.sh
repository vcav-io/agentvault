#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Shared harness library: logging, health check, cleanup, require_cmd
# ---------------------------------------------------------------------------

# Color codes
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_info() {
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo -e "${CYAN}[INFO]${NC} ${ts} $*" >&2
}

log_warn() {
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo -e "${YELLOW}[WARN]${NC} ${ts} $*" >&2
}

log_error() {
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo -e "${RED}[ERROR]${NC} ${ts} $*" >&2
}

log_success() {
  local ts
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo -e "${GREEN}[OK]${NC}   ${ts} $*" >&2
}

# ---------------------------------------------------------------------------
# require_cmd: fail fast if a required command is missing
# ---------------------------------------------------------------------------

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" &>/dev/null; then
    log_error "Required command not found: ${cmd}"
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# health_check: poll GET <url> until HTTP 200 or timeout
# Usage: health_check <url> <max_wait_secs> [interval_secs]
# ---------------------------------------------------------------------------

health_check() {
  local url="$1"
  local max_wait="${2:-30}"
  local interval="${3:-1}"
  local elapsed=0

  log_info "Waiting for ${url} (max ${max_wait}s)..."
  while true; do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${url}" 2>/dev/null || true)"
    if [[ "${code}" == "200" ]]; then
      log_success "${url} responded 200"
      return 0
    fi
    if (( elapsed >= max_wait )); then
      log_error "Timed out waiting for ${url} after ${max_wait}s (last code: ${code})"
      return 1
    fi
    sleep "${interval}"
    elapsed=$(( elapsed + interval ))
  done
}

# ---------------------------------------------------------------------------
# cleanup: register a process PID for cleanup on EXIT/INT/TERM
# Usage: register_pid <pid> [label]
# ---------------------------------------------------------------------------

HARNESS_PIDS=()
HARNESS_PID_LABELS=()

register_pid() {
  local pid="$1"
  local label="${2:-pid-${pid}}"
  HARNESS_PIDS+=("$pid")
  HARNESS_PID_LABELS+=("$label")
}

cleanup_pids() {
  local i
  for (( i=${#HARNESS_PIDS[@]}-1; i>=0; i-- )); do
    local pid="${HARNESS_PIDS[$i]}"
    local label="${HARNESS_PID_LABELS[$i]}"
    if kill -0 "$pid" 2>/dev/null; then
      log_info "Stopping ${label} (pid ${pid})"
      kill "$pid" 2>/dev/null || true
      # Give it up to 3s to exit gracefully
      local waited=0
      while kill -0 "$pid" 2>/dev/null && (( waited < 3 )); do
        sleep 0.5
        waited=$(( waited + 1 ))
      done
      if kill -0 "$pid" 2>/dev/null; then
        log_warn "Force-killing ${label} (pid ${pid})"
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
  done
}

# Install cleanup trap — callers can source this and it will fire on exit
setup_cleanup_trap() {
  trap 'cleanup_pids' EXIT INT TERM
}
