#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# drive-catc.sh — Category C meta-protocol leakage test driver
#
# Three test phases:
#   1. Timing side-channel: compare inference duration for short vs long inputs
#   2. Size constancy: compare output sizes for different Bob inputs
#   3. Error shape: verify error responses have uniform structure
#
# Usage:
#   ./tests/live/drive-catc.sh --scenario 03-stac-compatibility --provider anthropic
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HARNESS_DIR="${SCRIPT_DIR}/harness"
SCENARIOS_DIR="${SCRIPT_DIR}/scenarios"
RESULTS_BASE="${SCRIPT_DIR}/results"

# shellcheck source=harness/lib.sh
source "${HARNESS_DIR}/lib.sh"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

SCENARIO="03-stac-compatibility"
PROVIDER="anthropic"
RELAY_URL="http://localhost:3100"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)   SCENARIO="${2:-}";   shift 2 ;;
    --provider)   PROVIDER="${2:-}";   shift 2 ;;
    --relay-url)  RELAY_URL="${2:-}";  shift 2 ;;
    *)
      log_error "Unknown argument: $1"
      echo "Usage: $0 [--scenario <name>] [--provider anthropic|openai] [--relay-url URL]" >&2
      exit 1
      ;;
  esac
done

require_cmd curl
require_cmd jq
require_cmd node

SCENARIO_DIR="${SCENARIOS_DIR}/${SCENARIO}"

# Source .env for API keys
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/.env"
  set +a
fi

# Validate relay is up and VCAV_ENV=dev (metadata endpoint required)
health_check "${RELAY_URL}/health" 10

RUN_ID="catc-$(date -u '+%Y%m%dT%H%M%SZ')"
RUN_DIR="${RESULTS_BASE}/${RUN_ID}"
mkdir -p "${RUN_DIR}"

log_info "Category C test run: ${RUN_ID}"
log_info "Scenario: ${SCENARIO}  Provider: ${PROVIDER}  Relay: ${RELAY_URL}"

# ---------------------------------------------------------------------------
# Helper: build contract
# ---------------------------------------------------------------------------

PURPOSE="$(jq -r '.purpose' "${SCENARIO_DIR}/criteria.json")"

build_contract_json() {
  node --input-type=module -e "
import { buildRelayContract, computeRelayContractHash } from '${REPO_ROOT}/packages/agentvault-client/dist/relay-contracts.js';
const c = buildRelayContract('${PURPOSE}', ['alice', 'bob']);
if (!c) { console.error('Unknown purpose: ${PURPOSE}'); process.exit(1); }
const h = computeRelayContractHash(c);
console.log(JSON.stringify({ contract: c, hash: h }));
"
}

CONTRACT_RESULT="$(build_contract_json)"
CONTRACT_JSON="$(echo "${CONTRACT_RESULT}" | jq -c '.contract')"
CONTRACT_HASH="$(echo "${CONTRACT_RESULT}" | jq -r '.hash')"

# ---------------------------------------------------------------------------
# Helper: run a session and return session_id + read_token
# ---------------------------------------------------------------------------

run_catc_session() {
  local alice_input="$1"
  local bob_input="$2"
  local label="$3"

  # Create session
  local create_body
  create_body="$(jq -n --argjson contract "${CONTRACT_JSON}" --arg provider "${PROVIDER}" \
    '{contract: $contract, provider: $provider}')"

  local create_resp_body
  create_resp_body="$(mktemp)"
  local create_http_code
  create_http_code="$(curl -s -o "${create_resp_body}" -w '%{http_code}' -X POST "${RELAY_URL}/sessions" \
    -H "Content-Type: application/json" \
    -d "${create_body}")"
  local create_resp
  create_resp="$(cat "${create_resp_body}")"
  rm -f "${create_resp_body}"

  if [[ "${create_http_code}" != "200" ]]; then
    log_error "[${label}] Session creation failed with HTTP ${create_http_code}: ${create_resp}"
    echo "ERROR"
    return 1
  fi

  local session_id
  session_id="$(echo "${create_resp}" | jq -r '.session_id')"
  local init_submit="$(echo "${create_resp}" | jq -r '.initiator_submit_token')"
  local init_read="$(echo "${create_resp}" | jq -r '.initiator_read_token')"
  local resp_submit="$(echo "${create_resp}" | jq -r '.responder_submit_token')"
  local observed_hash="$(echo "${create_resp}" | jq -r '.contract_hash')"

  if [[ -z "${session_id}" || "${session_id}" == "null" ]]; then
    log_error "[${label}] Failed to create session: ${create_resp}"
    echo "ERROR"
    return 1
  fi

  # Submit Alice
  local alice_body
  alice_body="$(jq -n --argjson ctx "${alice_input}" '{role: "alice", context: $ctx}')"
  local alice_http_code
  alice_http_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${RELAY_URL}/sessions/${session_id}/input" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${init_submit}" \
    -d "${alice_body}")"
  if [[ "${alice_http_code}" != "200" ]]; then
    log_error "[${label}] Alice input submission failed with HTTP ${alice_http_code}"
    echo "ERROR"
    return 1
  fi

  # Submit Bob
  local bob_body
  bob_body="$(jq -n --argjson ctx "${bob_input}" --arg hash "${observed_hash}" \
    '{role: "bob", context: $ctx, expected_contract_hash: $hash}')"
  local bob_http_code
  bob_http_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${RELAY_URL}/sessions/${session_id}/input" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${resp_submit}" \
    -d "${bob_body}")"
  if [[ "${bob_http_code}" != "200" ]]; then
    log_error "[${label}] Bob input submission failed with HTTP ${bob_http_code}"
    echo "ERROR"
    return 1
  fi

  # Poll for completion
  local elapsed=0
  local timeout=120
  while (( elapsed < timeout )); do
    local state
    state="$(curl -s "${RELAY_URL}/sessions/${session_id}/output" \
      -H "Authorization: Bearer ${init_read}" | jq -r '.state')"
    if [[ "${state}" == "COMPLETED" || "${state}" == "ABORTED" ]]; then
      break
    fi
    sleep 2
    elapsed=$(( elapsed + 2 ))
  done

  if (( elapsed >= timeout )); then
    log_error "[${label}] Session timed out after ${timeout}s"
    echo "ERROR"
    return 1
  fi

  # Return session_id:read_token
  echo "${session_id}:${init_read}"
}

# ---------------------------------------------------------------------------
# Phase 1: Timing side-channel
# ---------------------------------------------------------------------------

echo ""
echo "==========================================================="
echo "  Phase 1: Timing Side-Channel Test"
echo "==========================================================="
echo ""

ALICE_SHORT="$(cat "${SCENARIO_DIR}/alice_relay_input.json")"
BOB_BASE="$(cat "${SCENARIO_DIR}/bob_relay_input_s1.json")"

# Create a long version of Alice's input (same facts + padding)
ALICE_LONG="$(node -e "
const short = JSON.parse(process.argv[1]);
const padding = ' Additionally, our company has been operating in the climate technology space for over seven years, during which time we have built extensive relationships with industry partners, regulatory bodies, and research institutions. Our technology platform processes approximately 2.3 petabytes of environmental data annually. We have offices in three countries and have won multiple industry awards for innovation in carbon capture optimization. Our R&D team consists of twelve PhD-level researchers with an average of fifteen years of experience in atmospheric science and computational modeling. We maintain ISO 27001 certification and SOC 2 Type II compliance for our data handling practices.';
const long = short + padding.repeat(10);
console.log(JSON.stringify(long));
" -- "${ALICE_SHORT}")"

SHORT_TIMINGS=()
LONG_TIMINGS=()

for i in 1 2 3; do
  log_info "Timing test: running short-input session ${i}/3..."
  result="$(run_catc_session "${ALICE_SHORT}" "${BOB_BASE}" "timing-short-${i}")"
  sid="${result%%:*}"
  rtok="${result#*:}"
  meta_resp_body_short="$(mktemp)"
  meta_http_short="$(curl -s -o "${meta_resp_body_short}" -w '%{http_code}' "${RELAY_URL}/sessions/${sid}/metadata" -H "Authorization: Bearer ${rtok}")"
  meta="$(cat "${meta_resp_body_short}")"
  rm -f "${meta_resp_body_short}"
  if [[ "${meta_http_short}" != "200" ]]; then
    log_error "  Short session ${i}: metadata fetch failed with HTTP ${meta_http_short}: ${meta}"
    exit 1
  fi
  final_state_short="$(curl -s "${RELAY_URL}/sessions/${sid}/output" -H "Authorization: Bearer ${rtok}" | jq -r '.state // empty')"
  if [[ "${final_state_short}" != "COMPLETED" ]]; then
    log_warn "  Short session ${i}: final state is '${final_state_short}' (not COMPLETED) — skipping from timing data"
    continue
  fi
  t_start="$(echo "${meta}" | jq -r '.timing.inference_start_at // empty')"
  t_end="$(echo "${meta}" | jq -r '.timing.inference_end_at // empty')"
  if [[ -n "${t_start}" && -n "${t_end}" ]]; then
    duration="$(node -e "
const s = new Date(process.argv[1]).getTime();
const e = new Date(process.argv[2]).getTime();
process.stdout.write(String((e - s) / 1000));
" -- "${t_start}" "${t_end}")"
    SHORT_TIMINGS+=("${duration}")
    log_info "  Short session ${i}: ${duration}s"
  else
    log_error "  Short session ${i}: metadata not available (is VCAV_ENV=dev set?)"
    exit 1
  fi
done

for i in 1 2 3; do
  log_info "Timing test: running long-input session ${i}/3..."
  result="$(run_catc_session "${ALICE_LONG}" "${BOB_BASE}" "timing-long-${i}")"
  sid="${result%%:*}"
  rtok="${result#*:}"
  meta_resp_body_long="$(mktemp)"
  meta_http_long="$(curl -s -o "${meta_resp_body_long}" -w '%{http_code}' "${RELAY_URL}/sessions/${sid}/metadata" -H "Authorization: Bearer ${rtok}")"
  meta="$(cat "${meta_resp_body_long}")"
  rm -f "${meta_resp_body_long}"
  if [[ "${meta_http_long}" != "200" ]]; then
    log_error "  Long session ${i}: metadata fetch failed with HTTP ${meta_http_long}: ${meta}"
    exit 1
  fi
  final_state_long="$(curl -s "${RELAY_URL}/sessions/${sid}/output" -H "Authorization: Bearer ${rtok}" | jq -r '.state // empty')"
  if [[ "${final_state_long}" != "COMPLETED" ]]; then
    log_warn "  Long session ${i}: final state is '${final_state_long}' (not COMPLETED) — skipping from timing data"
    continue
  fi
  t_start="$(echo "${meta}" | jq -r '.timing.inference_start_at // empty')"
  t_end="$(echo "${meta}" | jq -r '.timing.inference_end_at // empty')"
  if [[ -n "${t_start}" && -n "${t_end}" ]]; then
    duration="$(node -e "
const s = new Date(process.argv[1]).getTime();
const e = new Date(process.argv[2]).getTime();
process.stdout.write(String((e - s) / 1000));
" -- "${t_start}" "${t_end}")"
    LONG_TIMINGS+=("${duration}")
    log_info "  Long session ${i}: ${duration}s"
  else
    log_error "  Long session ${i}: metadata not available (is VCAV_ENV=dev set?)"
    exit 1
  fi
done

if [[ ${#SHORT_TIMINGS[@]} -eq 0 || ${#LONG_TIMINGS[@]} -eq 0 ]]; then
  log_error "No COMPLETED sessions collected for timing analysis (short=${#SHORT_TIMINGS[@]}, long=${#LONG_TIMINGS[@]}). All sessions may have been aborted."
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 2: Size constancy
# ---------------------------------------------------------------------------

echo ""
echo "==========================================================="
echo "  Phase 2: Size Constancy Test"
echo "==========================================================="
echo ""

SIZE_BYTES=()
SIZE_LABELS=("baseline")
SIZE_INPUTS=("${BOB_BASE}")

for surface_file in "${SCENARIO_DIR}"/bob_relay_input_s1_surface_*.json; do
  [[ -f "${surface_file}" ]] || continue
  variant_name="$(basename "${surface_file}" .json | sed 's/^bob_relay_input_s1_//')"
  SIZE_LABELS+=("${variant_name}")
  SIZE_INPUTS+=("$(cat "${surface_file}")")
done

for idx in "${!SIZE_LABELS[@]}"; do
  label="${SIZE_LABELS[$idx]}"
  input="${SIZE_INPUTS[$idx]}"
  log_info "Size test: running ${label}..."
  result="$(run_catc_session "${ALICE_SHORT}" "${input}" "size-${label}")"
  sid="${result%%:*}"
  rtok="${result#*:}"
  meta_resp_body_size="$(mktemp)"
  meta_http_size="$(curl -s -o "${meta_resp_body_size}" -w '%{http_code}' "${RELAY_URL}/sessions/${sid}/metadata" -H "Authorization: Bearer ${rtok}")"
  meta="$(cat "${meta_resp_body_size}")"
  rm -f "${meta_resp_body_size}"
  if [[ "${meta_http_size}" != "200" ]]; then
    log_error "  ${label}: metadata fetch failed with HTTP ${meta_http_size}: ${meta}"
    exit 1
  fi
  ob="$(echo "${meta}" | jq -r '.sizes.output_bytes // "null"')"
  SIZE_BYTES+=("${ob}")
  log_info "  ${label}: output_bytes=${ob}"
done

# ---------------------------------------------------------------------------
# Phase 3: Error shape
# ---------------------------------------------------------------------------

echo ""
echo "==========================================================="
echo "  Phase 3: Error Shape Test"
echo "==========================================================="
echo ""

ERROR_SHAPES=()

# Test 1: missing context field
log_info "Error test 1: missing context field..."
err1="$(curl -s -X POST "${RELAY_URL}/sessions/nonexistent/input" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid" \
  -d '{"role": "alice"}')"
shape1="$(echo "${err1}" | jq -r 'keys | sort | join(",")')"
ERROR_SHAPES+=("${shape1}")
log_info "  Shape: ${shape1}"

# Test 2: empty string context
log_info "Error test 2: empty string context..."
err2="$(curl -s -X POST "${RELAY_URL}/sessions/nonexistent/input" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid" \
  -d '{"role": "alice", "context": ""}')"
shape2="$(echo "${err2}" | jq -r 'keys | sort | join(",")')"
ERROR_SHAPES+=("${shape2}")
log_info "  Shape: ${shape2}"

# Test 3: invalid JSON
log_info "Error test 3: invalid JSON body..."
err3="$(curl -s -X POST "${RELAY_URL}/sessions/nonexistent/input" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid" \
  -d 'not-json')"
shape3="$(echo "${err3}" | jq -r 'keys | sort | join(",")' 2>/dev/null || echo "non-json")"
ERROR_SHAPES+=("${shape3}")
log_info "  Shape: ${shape3}"

# ---------------------------------------------------------------------------
# Write report via inline Node.js
# ---------------------------------------------------------------------------

REPORT_SCRIPT="${RUN_DIR}/_catc_report.mjs"

cat >"${REPORT_SCRIPT}" <<'REPORTMJS'
import fs from 'fs';
import path from 'path';

const [runDir, shortTimingsStr, longTimingsStr, sizeBytesStr, sizeLabelsStr, errorShapesStr] = process.argv.slice(2);

const shortTimings = shortTimingsStr.split(',').map(Number);
const longTimings = longTimingsStr.split(',').map(Number);
const sizeBytes = sizeBytesStr.split(',').map(s => s === 'null' ? null : Number(s));
const sizeLabels = sizeLabelsStr.split(',');
const errorShapes = errorShapesStr.split('|');

// Phase 1: Timing
const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
const stddev = arr => {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / arr.length);
};

const shortMean = mean(shortTimings);
const longMean = mean(longTimings);
const ratio = longMean / (shortMean || 1);
const shortStd = stddev(shortTimings);
const longStd = stddev(longTimings);

let timingVerdict;
if (ratio < 1.3) timingVerdict = 'PASS';
else if (ratio <= 2.0) timingVerdict = 'ADVISORY';
else timingVerdict = 'FAIL';

// Phase 2: Size — compute max delta across all variant pairs
let maxSizeDelta = null;
const validSizes = sizeBytes.filter(s => s !== null);
if (validSizes.length >= 2) {
  maxSizeDelta = 0;
  for (let i = 0; i < validSizes.length; i++) {
    for (let j = i + 1; j < validSizes.length; j++) {
      maxSizeDelta = Math.max(maxSizeDelta, Math.abs(validSizes[i] - validSizes[j]));
    }
  }
}
const sizeVerdict = maxSizeDelta !== null && maxSizeDelta < 64 ? 'PASS' : (maxSizeDelta === null ? 'UNKNOWN' : 'FAIL');

// Phase 3: Error shape
const uniqueShapes = [...new Set(errorShapes)];
const errorVerdict = uniqueShapes.length === 1 ? 'PASS' : 'FAIL';

// Overall
const verdicts = [timingVerdict, sizeVerdict, errorVerdict];
const overall = verdicts.every(v => v === 'PASS')
  ? 'PASS'
  : verdicts.some(v => v === 'FAIL')
    ? 'FAIL'
    : 'ADVISORY';

const report = {
  run_id: path.basename(runDir),
  timing: {
    verdict: timingVerdict,
    short_timings_s: shortTimings,
    long_timings_s: longTimings,
    short_mean_s: shortMean,
    long_mean_s: longMean,
    short_stddev_s: shortStd,
    long_stddev_s: longStd,
    ratio: ratio,
    caveat: 'LLM API run-to-run variance is typically 20-30%. Results need multiple runs across different times of day for confidence.',
  },
  size: {
    verdict: sizeVerdict,
    labels: sizeLabels,
    output_bytes: sizeBytes,
    max_delta_bytes: maxSizeDelta,
  },
  error_shape: {
    verdict: errorVerdict,
    shapes: errorShapes,
    unique_shapes: uniqueShapes,
  },
  overall_verdict: overall,
};

fs.writeFileSync(path.join(runDir, 'category_c_report.json'), JSON.stringify(report, null, 2) + '\n');

// Markdown
let md = `# Category C Meta-Protocol Leakage Report\n\n`;
md += `**Overall: ${overall}**\n\n`;

md += `## Phase 1: Timing Side-Channel\n\n`;
md += `**Verdict: ${timingVerdict}** (ratio: ${ratio.toFixed(2)}x)\n\n`;
md += `| Group | Runs | Mean (s) | Std Dev (s) |\n`;
md += `|-------|------|----------|-------------|\n`;
md += `| Short input | ${shortTimings.map(t => t.toFixed(1)).join(', ')} | ${shortMean.toFixed(2)} | ${shortStd.toFixed(2)} |\n`;
md += `| Long input | ${longTimings.map(t => t.toFixed(1)).join(', ')} | ${longMean.toFixed(2)} | ${longStd.toFixed(2)} |\n`;
md += `\n> **Caveat:** ${report.timing.caveat}\n\n`;

md += `## Phase 2: Size Constancy\n\n`;
md += `**Verdict: ${sizeVerdict}** (max delta: ${maxSizeDelta !== null ? maxSizeDelta + ' bytes' : 'N/A'})\n\n`;
md += `| Variant | Output Bytes |\n`;
md += `|---------|-------------|\n`;
for (let i = 0; i < sizeLabels.length; i++) {
  md += `| ${sizeLabels[i]} | ${sizeBytes[i] ?? 'N/A'} |\n`;
}
md += `\n`;

md += `## Phase 3: Error Shape\n\n`;
md += `**Verdict: ${errorVerdict}** (${uniqueShapes.length} unique shape(s))\n\n`;
md += `| Test | Shape |\n`;
md += `|------|-------|\n`;
md += `| Missing context | ${errorShapes[0]} |\n`;
md += `| Empty context | ${errorShapes[1]} |\n`;
md += `| Invalid JSON | ${errorShapes[2]} |\n`;

fs.writeFileSync(path.join(runDir, 'category_c_report.md'), md + '\n');

console.log(JSON.stringify({ overall, timing: timingVerdict, size: sizeVerdict, error: errorVerdict }));
REPORTMJS

SHORT_STR="$(IFS=,; echo "${SHORT_TIMINGS[*]}")"
LONG_STR="$(IFS=,; echo "${LONG_TIMINGS[*]}")"
SIZE_STR="$(IFS=,; echo "${SIZE_BYTES[*]}")"
SIZE_LABELS_STR="$(IFS=,; echo "${SIZE_LABELS[*]}")"
ERROR_STR="$(IFS='|'; echo "${ERROR_SHAPES[*]}")"

report_output="$(node "${REPORT_SCRIPT}" "${RUN_DIR}" "${SHORT_STR}" "${LONG_STR}" "${SIZE_STR}" "${SIZE_LABELS_STR}" "${ERROR_STR}" 2>&1)" || {
  log_error "Report generation failed: ${report_output}"
  rm -f "${REPORT_SCRIPT}"
  exit 1
}

rm -f "${REPORT_SCRIPT}"

result_json="$(printf '%s\n' "${report_output}" | tail -1)"
overall="$(echo "${result_json}" | jq -r '.overall')"

echo ""
log_info "Reports written to: ${RUN_DIR}"
log_info "  category_c_report.json"
log_info "  category_c_report.md"
echo ""

timing_v="$(echo "${result_json}" | jq -r '.timing')"
size_v="$(echo "${result_json}" | jq -r '.size')"
error_v="$(echo "${result_json}" | jq -r '.error')"

log_info "Phase 1 (Timing): ${timing_v}"
log_info "Phase 2 (Size):   ${size_v}"
log_info "Phase 3 (Error):  ${error_v}"
echo ""

case "${overall}" in
  PASS)
    log_success "Overall: PASS — no Category C leakage detected"
    ;;
  ADVISORY)
    log_warn "Overall: ADVISORY — some phases need attention"
    ;;
  FAIL)
    log_error "Overall: FAIL — Category C leakage detected"
    exit 1
    ;;
esac
