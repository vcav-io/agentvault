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
    local _alice_raw
    _alice_raw="$(node -e "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(s.session_id??'unknown')}catch(e){if(e.code!=='ENOENT')process.stderr.write('session_id extraction failed: '+e.message+'\n');process.stdout.write('unknown')}" -- "${alice_session_file}" 2>/dev/null)" || {
      log_warn "alice session_id extraction crashed — using fallback 'unknown'"
      _alice_raw="unknown"
    }
    alice_session_id="\"${_alice_raw}\""
  fi
  if [[ -f "${bob_session_file}" ]]; then
    local _bob_raw
    _bob_raw="$(node -e "const fs=require('fs');try{const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(s.session_id??'unknown')}catch(e){if(e.code!=='ENOENT')process.stderr.write('session_id extraction failed: '+e.message+'\n');process.stdout.write('unknown')}" -- "${bob_session_file}" 2>/dev/null)" || {
      log_warn "bob session_id extraction crashed — using fallback 'unknown'"
      _bob_raw="unknown"
    }
    bob_session_id="\"${_bob_raw}\""
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
});" 2>/dev/null)" || {
      log_warn "pass_count extraction crashed — report may show 0/0 counts"
      pass_count=0
    }
    fail_count="$(echo "${checks_json}" | node -e "
const s=[];process.stdin.on('data',c=>s.push(c));
process.stdin.on('end',()=>{
  const checks=JSON.parse(s.join(''));
  process.stdout.write(String(checks.filter(c=>!c.passed).length));
});" 2>/dev/null)" || {
      log_warn "fail_count extraction crashed — report may show 0/0 counts"
      fail_count=0
    }
    if [[ "${pass_count}" -eq 0 && "${fail_count}" -eq 0 && "${checks_json}" != "[]" ]]; then
      log_warn "pass/fail extraction returned 0/0 but checks were present — possible parse error"
    fi
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

  # Append Red Team Assessment table if red_team checks are present
  local has_red_team
  has_red_team="$(echo "${checks_json}" | node -e "
const s=[];process.stdin.on('data',c=>s.push(c));
process.stdin.on('end',()=>{
  const checks=JSON.parse(s.join(''));
  const rt=checks.filter(c=>c.name && c.name.startsWith('red_team_'));
  process.stdout.write(rt.length > 0 ? 'true' : 'false');
});" 2>/dev/null)" || {
    log_warn "has_red_team detection crashed — Red Team Assessment section may be silently omitted"
    has_red_team="false"
  }

  if [[ "${has_red_team}" == "true" ]]; then
    echo "" >>"${run_dir}/report.md"
    echo "## Red Team Assessment" >>"${run_dir}/report.md"
    echo "" >>"${run_dir}/report.md"
    echo "| Check | Result | Failure Class | Evidence |" >>"${run_dir}/report.md"
    echo "|-------|--------|---------------|----------|" >>"${run_dir}/report.md"

    echo "${checks_json}" | node -e "
const s=[];process.stdin.on('data',c=>s.push(c));
process.stdin.on('end',()=>{
  const checks=JSON.parse(s.join(''));
  const rt=checks.filter(c=>c.name && c.name.startsWith('red_team_'));
  for(const c of rt){
    const result = c.passed ? 'PASS' : '**FAIL**';
    // Extract failure class from detail if present (format: '... [P0]')
    const fcMatch = (c.detail || '').match(/\[([A-Z0-9_-]+)\]\$/);
    const fc = fcMatch ? fcMatch[1] : (c.passed ? '\u2014' : 'unknown');
    // Clean detail of the failure class tag for the evidence column
    const evidence = (c.detail || '\u2014').replace(/\\s*\\[[A-Z0-9_-]+\\]\$/, '');
    process.stdout.write('| ' + c.name.replace('red_team_', '') + ' | ' + result + ' | ' + fc + ' | ' + evidence + ' |\\n');
  }
});" 2>/dev/null >>"${run_dir}/report.md" || {
      log_warn "Red team table rendering crashed — table body may be empty (headers only)"
    }

    log_info "Red Team Assessment table appended to report.md"
  fi

  log_success "Report written: ${run_dir}/report.md"

  # Update latest.json symlink
  local latest_link="${RESULTS_DIR}/latest.json"
  ln -sfn "${run_dir}/report.json" "${latest_link}"
  log_info "Updated symlink: ${latest_link} -> ${run_dir}/report.json"
}
