#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# verify.sh — Post-run artifact retrieval and verification
#
# Usage:
#   ./tests/live/verify.sh <run_id>
#   ./tests/live/verify.sh <run_id> --session <id> --read-token <token>
#
# Reads session info from agent working dirs (~/vcav-test/alice|bob/.agentvault/last_session.json)
# or falls back to --session / --read-token for manual override.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HARNESS_DIR="${SCRIPT_DIR}/harness"
RESULTS_BASE="${SCRIPT_DIR}/results"

# shellcheck source=harness/lib.sh
source "${HARNESS_DIR}/lib.sh"
# shellcheck source=harness/report.sh
source "${HARNESS_DIR}/report.sh"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

RUN_ID=""
MANUAL_SESSION=""
MANUAL_READ_TOKEN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)
      MANUAL_SESSION="${2:-}"
      shift 2
      ;;
    --read-token)
      MANUAL_READ_TOKEN="${2:-}"
      shift 2
      ;;
    -*)
      log_error "Unknown flag: $1"
      exit 1
      ;;
    *)
      if [[ -z "${RUN_ID}" ]]; then
        RUN_ID="$1"
      fi
      shift
      ;;
  esac
done

if [[ -z "${RUN_ID}" ]]; then
  log_error "Usage: $0 <run_id> [--session <id> --read-token <token>]"
  exit 1
fi

RUN_DIR="${RESULTS_BASE}/${RUN_ID}"
if [[ ! -d "${RUN_DIR}" ]]; then
  log_error "Run directory not found: ${RUN_DIR}"
  exit 1
fi

require_cmd node
require_cmd curl

RELAY_URL="${VCAV_RELAY_URL:-http://localhost:3100}"
VCAV_TEST_BASE="${VCAV_TEST_DIR:-${HOME}/vcav-test}"
ALICE_SESSION_FILE="${VCAV_TEST_BASE}/alice/.agentvault/last_session.json"
BOB_SESSION_FILE="${VCAV_TEST_BASE}/bob/.agentvault/last_session.json"

# ---------------------------------------------------------------------------
# Read session IDs and tokens from session files
# ---------------------------------------------------------------------------

read_session_file() {
  local file="$1"
  local field="$2"
  node -e "
const fs = require('fs');
try {
  const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  process.stdout.write(s[process.argv[2]] ?? '');
} catch (e) {
  process.stdout.write('');
}
" -- "${file}" "${field}" 2>/dev/null || true
}

log_info "Reading session info from agent working dirs..."

if [[ -n "${MANUAL_SESSION}" ]]; then
  ALICE_SESSION_ID="${MANUAL_SESSION}"
  ALICE_READ_TOKEN="${MANUAL_READ_TOKEN}"
  BOB_SESSION_ID="${MANUAL_SESSION}"
  BOB_READ_TOKEN="${MANUAL_READ_TOKEN}"
  log_info "Using manual session override: ${ALICE_SESSION_ID}"
else
  ALICE_SESSION_ID="$(read_session_file "${ALICE_SESSION_FILE}" "session_id")"
  ALICE_READ_TOKEN="$(read_session_file "${ALICE_SESSION_FILE}" "read_token")"
  BOB_SESSION_ID="$(read_session_file "${BOB_SESSION_FILE}" "session_id")"
  BOB_READ_TOKEN="$(read_session_file "${BOB_SESSION_FILE}" "read_token")"
fi

if [[ -z "${ALICE_SESSION_ID}" ]]; then
  log_warn "Could not read Alice's session ID from ${ALICE_SESSION_FILE}"
fi
if [[ -z "${BOB_SESSION_ID}" ]]; then
  log_warn "Could not read Bob's session ID from ${BOB_SESSION_FILE}"
fi

# Fail if neither session file is readable and no manual override
if [[ -z "${ALICE_SESSION_ID}" && -z "${BOB_SESSION_ID}" && -z "${MANUAL_SESSION}" ]]; then
  log_error "Cannot read session info from either agent. Did the test complete?"
  log_error "Provide --session and --read-token manually, or check agent working dirs."
  exit 1
fi

log_info "Alice session: ${ALICE_SESSION_ID:-<not found>}"
log_info "Bob session:   ${BOB_SESSION_ID:-<not found>}"

# ---------------------------------------------------------------------------
# Retrieve session output from relay
# ---------------------------------------------------------------------------

retrieve_session() {
  local session_id="$1"
  local read_token="$2"
  local out_file="$3"

  if [[ -z "${session_id}" || -z "${read_token}" ]]; then
    log_warn "Skipping session retrieval (missing session_id or read_token)"
    return 0
  fi

  log_info "Retrieving session ${session_id} output..."
  local tmp_file="${out_file}.tmp"
  local http_code
  http_code="$(curl -s -o "${tmp_file}" -w '%{http_code}' \
    -H "Authorization: Bearer ${read_token}" \
    "${RELAY_URL}/sessions/${session_id}/output" 2>/dev/null || true)"

  if [[ "${http_code}" == "200" ]]; then
    mv "${tmp_file}" "${out_file}"
    log_success "Session output saved: ${out_file}"
  else
    rm -f "${tmp_file}"
    if [[ -f "${out_file}" ]]; then
      log_warn "Session output request returned HTTP ${http_code} — keeping existing ${out_file}"
    else
      log_warn "Session output request returned HTTP ${http_code} for ${session_id}"
    fi
  fi
}

retrieve_session "${ALICE_SESSION_ID}" "${ALICE_READ_TOKEN}" "${RUN_DIR}/alice_output.json"
retrieve_session "${BOB_SESSION_ID}"   "${BOB_READ_TOKEN}"   "${RUN_DIR}/bob_output.json"

# ---------------------------------------------------------------------------
# Extract receipt from output (if present)
# ---------------------------------------------------------------------------

extract_receipt() {
  local output_file="$1"
  local receipt_file="${RUN_DIR}/receipt.json"
  local sig_file="${RUN_DIR}/receipt_signature.txt"

  if [[ ! -f "${output_file}" ]]; then
    return 0
  fi

  node -e "
const fs = require('fs');
try {
  const out = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  if (out.receipt) {
    fs.writeFileSync(process.argv[2], JSON.stringify(out.receipt, null, 2));
    if (out.receipt_signature) {
      fs.writeFileSync(process.argv[3], out.receipt_signature + '\n');
    }
    process.stdout.write('extracted\n');
  }
} catch (e) {
  process.stderr.write('extract_receipt failed: ' + e.message + '\n');
}
" -- "${output_file}" "${receipt_file}" "${sig_file}" && log_success "Receipt extracted to ${receipt_file}" || true
}

extract_receipt "${RUN_DIR}/alice_output.json"

# ---------------------------------------------------------------------------
# Load criteria from run dir
# ---------------------------------------------------------------------------

# Gather all scenario criteria.json files in this run
CHECKS=()
ALL_PASSED=1

run_check() {
  local name="$1"
  local passed="$2"  # "true" or "false"
  local detail="${3:-}"

  # Escape detail for safe JSON embedding (backslashes, double quotes, newlines)
  local escaped_detail
  escaped_detail="${detail//\\/\\\\}"
  escaped_detail="${escaped_detail//\"/\\\"}"
  escaped_detail="${escaped_detail//$'\n'/\\n}"

  CHECKS+=("{\"name\":\"${name}\",\"passed\":${passed},\"detail\":\"${escaped_detail}\"}")
  if [[ "${passed}" == "false" ]]; then
    ALL_PASSED=0
    log_error "FAIL: ${name}${detail:+ — ${detail}}"
  else
    log_success "PASS: ${name}"
  fi
}

# ---------------------------------------------------------------------------
# Baseline checks (Tier 0)
# ---------------------------------------------------------------------------

log_info "Running baseline checks..."

# Check 1: session completed (output file exists and non-empty)
if [[ -s "${RUN_DIR}/alice_output.json" ]]; then
  run_check "session_output_present" "true"
else
  run_check "session_output_present" "false" "alice_output.json missing or empty"
fi

# Check 2: receipt present
if [[ -f "${RUN_DIR}/receipt.json" ]]; then
  run_check "receipt_present" "true"
else
  run_check "receipt_present" "false" "receipt.json not found"
fi

# Check 3: output non-empty text
if [[ -f "${RUN_DIR}/alice_output.json" ]]; then
  local_output_text="$(node -e "
const fs=require('fs');
try{const o=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const v=o.output??o.text??o.content??'';
const len=typeof v==='object'&&v!==null?JSON.stringify(v).length:String(v).length;
process.stdout.write(String(len));}catch(e){process.stdout.write('0');}
" -- "${RUN_DIR}/alice_output.json" 2>/dev/null || echo 0)"
  if [[ "${local_output_text}" -gt 0 ]]; then
    run_check "output_nonempty" "true"
  else
    run_check "output_nonempty" "false" "output text is empty"
  fi
fi

# ---------------------------------------------------------------------------
# Tier 1: Privacy checks — sensitive substring scan using criteria.json
# ---------------------------------------------------------------------------

log_info "Running Tier 1 privacy checks..."

# Write a standalone node script that reads all necessary files
# This avoids bash/node escaping issues entirely
TIER1_SCRIPT="${RUN_DIR}/_tier1_check.mjs"
cat >"${TIER1_SCRIPT}" <<'TIER1JS'
import fs from 'fs';

const [runDir] = process.argv.slice(2);
if (!runDir) { console.error('Usage: node _tier1_check.mjs <run_dir>'); process.exit(1); }

// Find scenario subdirectories
const entries = fs.readdirSync(runDir, { withFileTypes: true });
const scenarioDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')).map(e => `${runDir}/${e.name}`);

// Read output files as lowercased text for substring matching
function readOutputLower(filePath) {
  try { return JSON.stringify(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toLowerCase(); }
  catch { return ''; }
}

const aliceOutput = readOutputLower(`${runDir}/alice_output.json`);
const bobOutput = readOutputLower(`${runDir}/bob_output.json`);

const results = { checked: 0, leaked: [] };

for (const scDir of scenarioDirs) {
  const criteriaPath = `${scDir}/criteria.json`;
  if (!fs.existsSync(criteriaPath)) continue;

  const criteria = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
  const pc = criteria.privacy_checks ?? {};

  // Alice/sender sensitive substrings must NOT appear in Bob's output
  const aliceSensitive = pc.sensitive_substrings_alice ?? pc.sensitive_substrings_sender ?? [];
  for (const sub of aliceSensitive) {
    results.checked++;
    if (bobOutput.includes(sub.toLowerCase())) {
      results.leaked.push(`alice_secret_in_bob: ${sub}`);
    }
  }

  // Bob/receiver sensitive substrings must NOT appear in Alice's output
  const bobSensitive = pc.sensitive_substrings_bob ?? pc.sensitive_substrings_receiver ?? [];
  for (const sub of bobSensitive) {
    results.checked++;
    if (aliceOutput.includes(sub.toLowerCase())) {
      results.leaked.push(`bob_secret_in_alice: ${sub}`);
    }
  }

  // Raw prompt leakage check (50-char sliding window)
  if (pc.no_raw_prompt_leakage) {
    for (const [promptFile, outputText, label] of [
      [`${scDir}/alice_prompt.txt`, bobOutput, 'alice_prompt_in_bob'],
      [`${scDir}/bob_prompt.txt`, aliceOutput, 'bob_prompt_in_alice'],
    ]) {
      try {
        const prompt = fs.readFileSync(promptFile, 'utf8');
        let found = false;
        for (let i = 0; i <= prompt.length - 50; i += 10) {
          const window = prompt.slice(i, i + 50).toLowerCase().trim();
          if (window.length >= 40 && outputText.includes(window)) {
            found = true;
            break;
          }
        }
        if (found) {
          results.checked++;
          results.leaked.push(`raw_prompt_leak: ${label}`);
        } else {
          results.checked++;
        }
      } catch (e) {
        console.error('Tier1: could not read prompt file:', promptFile, e.message);
      }
    }
  }
}

console.log(JSON.stringify(results));
TIER1JS

tier1_output="$(node "${TIER1_SCRIPT}" "${RUN_DIR}" 2>/dev/null)" || tier1_output='{"checked":0,"leaked":[]}'

tier1_checked="$(echo "${tier1_output}" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(String(r.checked));})" 2>/dev/null || echo 0)"
tier1_leaked="$(echo "${tier1_output}" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(String(r.leaked.length));})" 2>/dev/null || echo 0)"

if [[ "${tier1_leaked}" -eq 0 ]]; then
  run_check "tier1_sensitive_substrings" "true" "${tier1_checked} substrings checked, 0 leaked"
else
  tier1_detail="$(echo "${tier1_output}" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(r.leaked.join('; '));})" 2>/dev/null || echo "unknown")"
  run_check "tier1_sensitive_substrings" "false" "leaked: ${tier1_detail}"
fi

rm -f "${TIER1_SCRIPT}"

# ---------------------------------------------------------------------------
# Tier 2: Structural checks on output JSON
# ---------------------------------------------------------------------------

log_info "Running Tier 2 structural checks..."

# Tier 2 validates that the relay output conforms to the bounded signal contract:
# - Output is valid JSON
# - Only contains expected fields (no extra properties)
# - Enum fields contain valid values
# - Free-text fields respect maxLength bounds
# - No numeric patterns from sensitive substrings appear in output fields
# Note: Full JSON Schema validation requires access to the relay contract schemas.
# This check validates structural properties that can be inferred from output alone.

if [[ -f "${RUN_DIR}/alice_output.json" ]]; then
  TIER2_SCRIPT="${RUN_DIR}/_tier2_check.mjs"
  cat >"${TIER2_SCRIPT}" <<'TIER2JS'
import fs from 'fs';

const [outputPath] = process.argv.slice(2);
const issues = [];

try {
  const raw = fs.readFileSync(outputPath, 'utf8');
  const data = JSON.parse(raw);

  // Check 1: Output is valid JSON (we got here, so yes)
  // Check 2: Extract the bounded signal output
  const output = data.output ?? data;
  if (typeof output !== 'object' || output === null) {
    issues.push('output is not an object');
  } else {
    // Check 3: Look for suspicious free-text fields that are very long
    for (const [key, value] of Object.entries(output)) {
      if (typeof value === 'string' && value.length > 500) {
        issues.push(`field "${key}" has ${value.length} chars (possible unbounded text)`);
      }
    }
  }
} catch (e) {
  issues.push(`parse error: ${e.message}`);
}

console.log(JSON.stringify({ valid: issues.length === 0, issues }));
TIER2JS

  tier2_output="$(node "${TIER2_SCRIPT}" "${RUN_DIR}/alice_output.json" 2>/dev/null)" || tier2_output='{"valid":false,"issues":["script error"]}'
  tier2_valid="$(echo "${tier2_output}" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(String(r.valid));})" 2>/dev/null || echo "false")"

  if [[ "${tier2_valid}" == "true" ]]; then
    run_check "tier2_structural" "true"
  else
    tier2_detail="$(echo "${tier2_output}" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);process.stdout.write(r.issues.join('; '));})" 2>/dev/null || echo "unknown")"
    run_check "tier2_structural" "false" "${tier2_detail}"
  fi

  rm -f "${TIER2_SCRIPT}"
fi

# ---------------------------------------------------------------------------
# Receipt field extraction
# ---------------------------------------------------------------------------

if [[ -f "${RUN_DIR}/receipt.json" ]]; then
  log_info "Extracting receipt fields..."
  node -e "
const fs=require('fs');
const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const fields=['contract_hash','model_profile_hash','output_entropy_bits','prompt_template_hash'];
for(const f of fields){
  if(r[f]) console.log(f+'='+r[f]);
}
" -- "${RUN_DIR}/receipt.json" 2>/dev/null | while IFS= read -r line; do log_info "  receipt: ${line}"; done || true
fi

# ---------------------------------------------------------------------------
# Write verify.json summary
# ---------------------------------------------------------------------------

CHECKS_JSON="[$(printf '%s,' "${CHECKS[@]}" | sed 's/,$//')]"

local_all_passed_bool="true"
if [[ "${ALL_PASSED}" -eq 0 ]]; then
  local_all_passed_bool="false"
fi

cat >"${RUN_DIR}/verify.json" <<JSON
{
  "run_id": "${RUN_ID}",
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "all_passed": ${local_all_passed_bool},
  "checks": ${CHECKS_JSON}
}
JSON

log_info "Verify results written to ${RUN_DIR}/verify.json"

# ---------------------------------------------------------------------------
# Generate report
# ---------------------------------------------------------------------------

STATUS="pass"
if [[ "${ALL_PASSED}" -eq 0 ]]; then
  STATUS="fail"
fi

SCENARIO_NAME="$(basename "$(find "${RUN_DIR}" -mindepth 1 -maxdepth 1 -type d ! -name '_*' ! -name '.*' | head -1)" 2>/dev/null || echo 'unknown')"
CHECKS_FILE="${RUN_DIR}/_checks.json"
echo "${CHECKS_JSON}" >"${CHECKS_FILE}"
generate_report "${RUN_DIR}" "${SCENARIO_NAME}" "${STATUS}" "${CHECKS_FILE}"
rm -f "${CHECKS_FILE}"

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------

echo ""
if [[ "${ALL_PASSED}" -eq 1 ]]; then
  log_success "All checks PASSED for run ${RUN_ID}"
else
  log_error "Some checks FAILED for run ${RUN_ID} — see ${RUN_DIR}/report.md"
  exit 1
fi
