#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# workspace.sh — agent working directory setup and isolation
# ---------------------------------------------------------------------------
#
# Base directory: VCAV_TEST_DIR env var or ~/vcav-test/
# Agent dirs: alice/ and bob/
# Cleans each dir except .mcp.json, then verifies safety.

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib.sh
source "${HARNESS_DIR}/lib.sh"

VCAV_TEST_BASE="${VCAV_TEST_DIR:-${HOME}/vcav-test}"

# ---------------------------------------------------------------------------
# setup_workspace: create and clean agent directories
#
# Args: none (reads VCAV_TEST_BASE)
# Side-effects: sets ALICE_DIR and BOB_DIR in caller's environment
# ---------------------------------------------------------------------------

setup_workspace() {
  ALICE_DIR="${VCAV_TEST_BASE}/alice"
  BOB_DIR="${VCAV_TEST_BASE}/bob"
  export ALICE_DIR BOB_DIR

  _prepare_agent_dir "${ALICE_DIR}" "alice"
  _prepare_agent_dir "${BOB_DIR}" "bob"

  log_success "Workspace ready: ${VCAV_TEST_BASE}"
}

# ---------------------------------------------------------------------------
# _prepare_agent_dir: create dir, run safety checks, clean state
# ---------------------------------------------------------------------------

_prepare_agent_dir() {
  local dir="$1"
  local agent="$2"

  # Create if missing
  if [[ ! -d "${dir}" ]]; then
    mkdir -p "${dir}"
    log_info "Created agent dir: ${dir}"
  fi

  # Safety: must not be a symlink
  if [[ -L "${dir}" ]]; then
    log_error "SAFETY: ${dir} is a symlink — refusing to clean"
    exit 1
  fi

  # Safety: must not be inside a git repo (we don't want to stomp .git)
  if git -C "${dir}" rev-parse --git-dir &>/dev/null 2>&1; then
    log_error "SAFETY: ${dir} is inside a git repository — refusing to clean"
    exit 1
  fi

  # Safety: must be under VCAV_TEST_BASE
  local real_dir real_base
  real_dir="$(cd "${dir}" && pwd -P)"
  real_base="$(cd "${VCAV_TEST_BASE}" && pwd -P)"
  case "${real_dir}" in
    "${real_base}"/*) ;;
    *)
      log_error "SAFETY: ${dir} (real: ${real_dir}) is not under base ${real_base}"
      exit 1
      ;;
  esac

  # Preserve .mcp.json if it exists
  local mcp_backup=""
  if [[ -f "${dir}/.mcp.json" ]]; then
    mcp_backup="$(mktemp)"
    cp "${dir}/.mcp.json" "${mcp_backup}"
  fi

  # Clean contents (not the directory itself)
  log_info "Cleaning agent dir: ${dir}"
  find "${dir}" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true

  # Restore .mcp.json
  if [[ -n "${mcp_backup}" ]]; then
    cp "${mcp_backup}" "${dir}/.mcp.json"
    rm -f "${mcp_backup}"
    log_info "Preserved .mcp.json for ${agent}"
  fi

  # Create required subdirs
  mkdir -p "${dir}/.agentvault"

  log_success "Agent dir ready: ${dir}"
}

# ---------------------------------------------------------------------------
# verify_workspace: check dirs exist and are clean
# ---------------------------------------------------------------------------

verify_workspace() {
  local ok=1

  for dir in "${ALICE_DIR:-}" "${BOB_DIR:-}"; do
    if [[ -z "${dir}" ]]; then
      log_error "ALICE_DIR or BOB_DIR not set — run setup_workspace first"
      ok=0
      continue
    fi
    if [[ ! -d "${dir}" ]]; then
      log_error "Agent dir missing: ${dir}"
      ok=0
    fi
    if [[ -L "${dir}" ]]; then
      log_error "Agent dir is a symlink: ${dir}"
      ok=0
    fi
  done

  if [[ "${ok}" -eq 0 ]]; then
    return 1
  fi
  log_success "Workspace verified"
}
