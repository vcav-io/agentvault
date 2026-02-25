#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# report.sh — JSON/MD report generation
# ---------------------------------------------------------------------------
#
# Usage: generate_report <run_dir> <scenario_name> [pass|fail]

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HARNESS_DIR}/../../.." && pwd)"
RESULTS_DIR="${REPO_ROOT}/tests/live/results"

# shellcheck source=lib.sh
source "${HARNESS_DIR}/lib.sh"

# ---------------------------------------------------------------------------
# generate_report: create report.json + report.md in run_dir
#
# Args:
#   $1 run_dir       — timestamped results directory
#   $2 scenario      — scenario name
#   $3 status        — "pass" | "fail" | "partial"
#   $4 checks_file   — optional path to JSON file with check results
# ---------------------------------------------------------------------------

generate_report() {
  local run_dir="$1"
  local scenario="${2:-unknown}"
  local status="${3:-unknown}"
  local checks_file="${4:-}"

  require_cmd node

  local run_id
  run_id="$(basename "${run_dir}")"
  local timestamp
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # Read check results if provided
  local checks_json="[]"
  if [[ -n "${checks_file}" && -f "${checks_file}" ]]; then
    checks_json="$(cat "${checks_file}")"
  fi

  # Read session info from output files if present
  local alice_session_id="null"
  local bob_session_id="null"
  local alice_session_file="${ALICE_DIR:-${HOME}/vcav-test/alice}/.agentvault/last_session.json"
  local bob_session_file="${BOB_DIR:-${HOME}/vcav-test/bob}/.agentvault/last_session.json"

  if [[ -f "${alice_session_file}" ]]; then
    alice_session_id="\"$(node -e "const s=require('${alice_session_file}');process.stdout.write(s.session_id??'unknown')" 2>/dev/null || echo "unknown")\""
  fi
  if [[ -f "${bob_session_file}" ]]; then
    bob_session_id="\"$(node -e "const s=require('${bob_session_file}');process.stdout.write(s.session_id??'unknown')" 2>/dev/null || echo "unknown")\""
  fi

  # Collect receipt fields if available
  local receipt_json="null"
  if [[ -f "${run_dir}/receipt.json" ]]; then
    receipt_json="$(cat "${run_dir}/receipt.json")"
  fi

  # Collect verify results if available
  local verify_json="null"
  if [[ -f "${run_dir}/verify.json" ]]; then
    verify_json="$(cat "${run_dir}/verify.json")"
  fi

  # Write report.json
  cat >"${run_dir}/report.json" <<JSON
{
  "run_id": "${run_id}",
  "timestamp": "${timestamp}",
  "scenario": "${scenario}",
  "status": "${status}",
  "relay_url": "http://localhost:3100",
  "agents": {
    "alice": {
      "session_id": ${alice_session_id}
    },
    "bob": {
      "session_id": ${bob_session_id}
    }
  },
  "receipt": ${receipt_json},
  "verify": ${verify_json},
  "checks": ${checks_json}
}
JSON

  log_success "Report written: ${run_dir}/report.json"

  # Write report.md
  local pass_count=0
  local fail_count=0
  if [[ "${checks_json}" != "[]" ]]; then
    pass_count="$(echo "${checks_json}" | node -e "
const s=[];process.stdin.on('data',c=>s.push(c));
process.stdin.on('end',()=>{
  const checks=JSON.parse(s.join(''));
  process.stdout.write(String(checks.filter(c=>c.passed).length));
});" 2>/dev/null || echo 0)"
    fail_count="$(echo "${checks_json}" | node -e "
const s=[];process.stdin.on('data',c=>s.push(c));
process.stdin.on('end',()=>{
  const checks=JSON.parse(s.join(''));
  process.stdout.write(String(checks.filter(c=>!c.passed).length));
});" 2>/dev/null || echo 0)"
  fi

  cat >"${run_dir}/report.md" <<MARKDOWN
# AgentVault Live Test Report

| Field | Value |
|-------|-------|
| Run ID | \`${run_id}\` |
| Timestamp | ${timestamp} |
| Scenario | \`${scenario}\` |
| Status | **${status}** |

## Agents

| Agent | Session ID |
|-------|-----------|
| alice | ${alice_session_id} |
| bob   | ${bob_session_id}  |

## Check Summary

- Passed: ${pass_count}
- Failed: ${fail_count}

## Receipt

\`\`\`json
${receipt_json}
\`\`\`

## Verify Output

\`\`\`json
${verify_json}
\`\`\`
MARKDOWN

  log_success "Report written: ${run_dir}/report.md"

  # Update latest.json symlink
  local latest_link="${RESULTS_DIR}/latest.json"
  ln -sfn "${run_dir}/report.json" "${latest_link}"
  log_info "Updated symlink: ${latest_link} -> ${run_dir}/report.json"
}
