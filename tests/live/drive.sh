#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# drive.sh — Direct HTTP experiment driver for AgentVault relay sessions
#
# Drives relay sessions via curl, bypassing MCP. Submits pre-defined inputs
# from scenario files, polls for output, and calls verify.sh for validation.
#
# Usage:
#   ./tests/live/drive.sh --scenario 06-accumulation-naive [--sessions 3]
#   ./tests/live/drive.sh --scenario 06-accumulation-naive --no-relay
#   ./tests/live/drive.sh --scenario 06-accumulation-naive --provider openai
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HARNESS_DIR="${SCRIPT_DIR}/harness"
SCENARIOS_DIR="${SCRIPT_DIR}/scenarios"
RESULTS_BASE="${SCRIPT_DIR}/results"

# shellcheck source=harness/lib.sh
source "${HARNESS_DIR}/lib.sh"
setup_cleanup_trap

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

SCENARIO=""
NUM_SESSIONS=1
RELAY_URL="http://localhost:3100"
NO_RELAY=false
PROVIDER=""
SEED=""
EXPERIMENT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)    SCENARIO="${2:-}";      shift 2 ;;
    --sessions)    NUM_SESSIONS="${2:-1}";  shift 2 ;;
    --relay-url)   RELAY_URL="${2:-}";      shift 2 ;;
    --no-relay)    NO_RELAY=true;           shift   ;;
    --provider)    PROVIDER="${2:-}";       shift 2 ;;
    --seed)        SEED="${2:-}";           shift 2 ;;
    --experiment)  EXPERIMENT_ID="${2:-}";  shift 2 ;;
    *)
      log_error "Unknown argument: $1"
      echo "Usage: $0 --scenario <name> [--sessions N] [--relay-url URL] [--no-relay] [--provider anthropic|openai] [--seed N] [--experiment ID]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${SCENARIO}" ]]; then
  log_error "Missing required --scenario flag"
  exit 1
fi

# Auto-generate experiment ID for multi-session runs
if [[ "${NUM_SESSIONS}" -gt 1 && -z "${EXPERIMENT_ID}" ]]; then
  EXPERIMENT_ID="exp-$(date -u '+%Y%m%d-%H%M%S')"
  log_info "Auto-generated experiment ID: ${EXPERIMENT_ID}"
fi

require_cmd curl
require_cmd jq
require_cmd node

SCENARIO_DIR="${SCENARIOS_DIR}/${SCENARIO}"

# ---------------------------------------------------------------------------
# Validate scenario files
# ---------------------------------------------------------------------------

validate_scenario() {
  local missing=()
  for f in criteria.json alice_relay_input.json bob_relay_input_s1.json; do
    [[ -f "${SCENARIO_DIR}/${f}" ]] || missing+=("${f}")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "Scenario '${SCENARIO}' missing relay input files: ${missing[*]}"
    log_error "Create them in ${SCENARIO_DIR}/"
    exit 1
  fi

  PURPOSE="$(jq -r '.purpose' "${SCENARIO_DIR}/criteria.json")"
  CANARY_TOKEN="$(jq -r '.red_team_checks.canary_token // empty' "${SCENARIO_DIR}/criteria.json")"
  BOB_PROFILE="$(jq -r '.bob_profile // "UNKNOWN"' "${SCENARIO_DIR}/criteria.json")"
  DESIRED_PURPOSE="${PURPOSE}"

  log_info "Scenario: ${SCENARIO}  |  Purpose: ${PURPOSE}  |  Sessions: ${NUM_SESSIONS}"
}

# ---------------------------------------------------------------------------
# Canary hygiene check — static files only
# ---------------------------------------------------------------------------

canary_hygiene_check() {
  if [[ -z "${CANARY_TOKEN}" ]]; then return 0; fi

  local violations=()
  for f in bob_relay_input_s1.json bob_relay_input_template.json; do
    local fpath="${SCENARIO_DIR}/${f}"
    [[ -f "${fpath}" ]] || continue
    if grep -qF "${CANARY_TOKEN}" "${fpath}"; then
      violations+=("${f}")
    fi
  done

  if [[ ${#violations[@]} -gt 0 ]]; then
    log_error "CANARY HYGIENE FAILURE: canary token '${CANARY_TOKEN}' found in static Bob files: ${violations[*]}"
    log_error "The canary must only appear in alice_relay_input.json"
    exit 1
  fi

  log_success "Canary hygiene check passed (static files)"
}

# ---------------------------------------------------------------------------
# Provider auto-detection
# ---------------------------------------------------------------------------

detect_provider() {
  # Source .env if present (always — relay needs API keys even with explicit --provider)
  if [[ -f "${REPO_ROOT}/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${REPO_ROOT}/.env"
    set +a
  fi

  if [[ -n "${PROVIDER}" ]]; then return; fi

  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    PROVIDER="anthropic"
  elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
    PROVIDER="openai"
  else
    log_error "No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env or use --provider"
    exit 1
  fi
  log_info "Provider: ${PROVIDER} (auto-detected)"
}

# ---------------------------------------------------------------------------
# Start relay
# ---------------------------------------------------------------------------

RELAY_PID=""

start_relay() {
  if [[ "${NO_RELAY}" == "true" ]]; then
    log_info "Skipping relay startup (--no-relay)"
    health_check "${RELAY_URL}/health" 10
    return
  fi

  detect_provider

  # Build relay (skip if binary is current)
  local relay_bin="${REPO_ROOT}/target/release/agentvault-relay"
  log_info "Building relay (release)..."
  cargo build --release -p agentvault-relay --manifest-path "${REPO_ROOT}/Cargo.toml" 2>&1 | \
    while IFS= read -r line; do log_info "  cargo: ${line}"; done
  log_success "Relay binary ready: ${relay_bin}"

  # Determine relay port from URL
  local relay_port
  relay_port="$(echo "${RELAY_URL}" | grep -oE '[0-9]+$')"

  # Start relay
  local relay_log="${RESULTS_BASE}/_drive_relay.log"
  VCAV_PORT="${relay_port}" \
  VCAV_PROMPT_PROGRAM_DIR="${REPO_ROOT}/packages/agentvault-relay/prompt_programs" \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
    "${relay_bin}" > "${relay_log}" 2>&1 &
  RELAY_PID=$!
  register_pid "${RELAY_PID}" "relay"
  log_info "Relay PID: ${RELAY_PID}"

  health_check "${RELAY_URL}/health" 30
}

# ---------------------------------------------------------------------------
# Build contract via agentvault-client
# ---------------------------------------------------------------------------

CONTRACT_JSON=""
CONTRACT_HASH=""
PROMPT_TEMPLATE_HASH=""

build_contract() {
  local result
  result="$(node --input-type=module -e "
import { buildRelayContract, computeRelayContractHash } from '${REPO_ROOT}/packages/agentvault-client/dist/relay-contracts.js';
const c = buildRelayContract('${PURPOSE}', ['alice', 'bob']);
if (!c) { console.error('Unknown purpose: ${PURPOSE}'); process.exit(1); }
const h = computeRelayContractHash(c);
console.log(JSON.stringify({ contract: c, hash: h, prompt_template_hash: c.prompt_template_hash }));
")"

  CONTRACT_JSON="$(echo "${result}" | jq -c '.contract')"
  CONTRACT_HASH="$(echo "${result}" | jq -r '.hash')"
  PROMPT_TEMPLATE_HASH="$(echo "${result}" | jq -r '.prompt_template_hash')"

  log_info "Contract hash: ${CONTRACT_HASH}"
  log_info "Prompt template hash: ${PROMPT_TEMPLATE_HASH}"
}

# ---------------------------------------------------------------------------
# Run a single session
# ---------------------------------------------------------------------------

PREV_OUTPUT_FILE=""

run_session() {
  local session_num="$1"
  local run_id
  run_id="$(date -u '+%Y%m%dT%H%M%SZ')"

  # --- Determine run directory ---
  # Always use results/<run_id>/ for verify.sh compatibility.
  # Experiments track run_ids via runs.jsonl.
  local run_dir="${RESULTS_BASE}/${run_id}"
  mkdir -p "${run_dir}"

  # Copy scenario files into run dir (verify.sh expects scenario subdir)
  local scenario_subdir="${run_dir}/${SCENARIO}"
  mkdir -p "${scenario_subdir}"
  cp "${SCENARIO_DIR}/criteria.json" "${scenario_subdir}/"
  [[ -f "${SCENARIO_DIR}/alice_prompt.txt" ]] && cp "${SCENARIO_DIR}/alice_prompt.txt" "${scenario_subdir}/"
  [[ -f "${SCENARIO_DIR}/bob_prompt.txt" ]]   && cp "${SCENARIO_DIR}/bob_prompt.txt" "${scenario_subdir}/"

  # Save contract
  echo "${CONTRACT_JSON}" | jq . > "${run_dir}/contract.json"

  log_info "Session ${session_num}/${NUM_SESSIONS}  |  Run: ${run_id}"

  # --- Prepare Bob's input ---
  local bob_context
  if [[ "${session_num}" -gt 1 && -f "${SCENARIO_DIR}/bob_relay_input_template.json" && -n "${PREV_OUTPUT_FILE}" && -f "${PREV_OUTPUT_FILE}" ]]; then
    # Extract specific structured fields from previous output
    local prev_signal prev_summary
    prev_signal="$(jq -r '.output.compatibility_signal // .output.mediation_signal // "UNKNOWN"' "${PREV_OUTPUT_FILE}")"
    prev_summary="$(jq -r '.output.overlap_summary // .output.next_step_signal // "no summary available"' "${PREV_OUTPUT_FILE}")"

    # Read template and substitute
    local template
    template="$(cat "${SCENARIO_DIR}/bob_relay_input_template.json")"
    template="${template//\{\{COMPAT_SIGNAL\}\}/${prev_signal}}"
    template="${template//\{\{OVERLAP_SUMMARY\}\}/${prev_summary}}"
    bob_context="${template}"
    log_info "Bob input: adapted from template (prev signal: ${prev_signal})"
  else
    bob_context="$(cat "${SCENARIO_DIR}/bob_relay_input_s1.json")"
    log_info "Bob input: session 1 baseline"
  fi

  local alice_context
  alice_context="$(cat "${SCENARIO_DIR}/alice_relay_input.json")"

  # --- Create session ---
  local create_body
  create_body="$(jq -n --argjson contract "${CONTRACT_JSON}" --arg provider "${PROVIDER}" \
    '{contract: $contract, provider: $provider}')"

  local create_resp
  create_resp="$(curl -s -X POST "${RELAY_URL}/sessions" \
    -H "Content-Type: application/json" \
    -d "${create_body}")"

  local session_id observed_hash
  session_id="$(echo "${create_resp}" | jq -r '.session_id')"
  observed_hash="$(echo "${create_resp}" | jq -r '.contract_hash')"

  if [[ -z "${session_id}" || "${session_id}" == "null" ]]; then
    log_error "Failed to create session: ${create_resp}"
    return 1
  fi

  local init_submit_token init_read_token resp_submit_token resp_read_token
  init_submit_token="$(echo "${create_resp}" | jq -r '.initiator_submit_token')"
  init_read_token="$(echo "${create_resp}" | jq -r '.initiator_read_token')"
  resp_submit_token="$(echo "${create_resp}" | jq -r '.responder_submit_token')"
  resp_read_token="$(echo "${create_resp}" | jq -r '.responder_read_token')"

  # Contract hash verification
  if [[ "${observed_hash}" != "${CONTRACT_HASH}" ]]; then
    log_warn "Contract hash mismatch! Expected: ${CONTRACT_HASH}, Observed: ${observed_hash}"
  fi

  log_info "Session created: ${session_id}"

  # --- Submit Alice's input ---
  # Matches SubmitInputRequest (packages/agentvault-relay/src/types.rs:97)
  local alice_body
  alice_body="$(jq -n --argjson ctx "${alice_context}" '{role: "alice", context: $ctx}')"

  local alice_resp
  alice_resp="$(curl -s -X POST "${RELAY_URL}/sessions/${session_id}/input" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${init_submit_token}" \
    -d "${alice_body}")"
  log_info "Alice input submitted: $(echo "${alice_resp}" | jq -r '.state')"

  # --- Submit Bob's input ---
  local bob_body
  bob_body="$(jq -n --argjson ctx "${bob_context}" --arg hash "${observed_hash}" \
    '{role: "bob", context: $ctx, expected_contract_hash: $hash}')"

  local bob_resp
  bob_resp="$(curl -s -X POST "${RELAY_URL}/sessions/${session_id}/input" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${resp_submit_token}" \
    -d "${bob_body}")"
  log_info "Bob input submitted: $(echo "${bob_resp}" | jq -r '.state')"

  # --- Poll for output ---
  local t_start poll_count timeout state_transitions abort_reason
  t_start="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  poll_count=0
  timeout=120
  state_transitions=()
  abort_reason=""

  log_info "Polling for output (timeout ${timeout}s)..."
  local elapsed=0
  local output_resp=""
  local current_state=""

  while (( elapsed < timeout )); do
    output_resp="$(curl -s "${RELAY_URL}/sessions/${session_id}/output" \
      -H "Authorization: Bearer ${init_read_token}")"
    current_state="$(echo "${output_resp}" | jq -r '.state')"
    poll_count=$(( poll_count + 1 ))
    state_transitions+=("${current_state}")

    if [[ "${current_state}" == "COMPLETED" || "${current_state}" == "ABORTED" ]]; then
      break
    fi

    sleep 2
    elapsed=$(( elapsed + 2 ))
  done

  local t_end
  t_end="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  if [[ "${current_state}" == "ABORTED" ]]; then
    abort_reason="$(echo "${output_resp}" | jq -r '.abort_reason // "unknown"')"
    log_error "Session ABORTED: ${abort_reason}"
  elif [[ "${current_state}" == "COMPLETED" ]]; then
    log_success "Session COMPLETED (${poll_count} polls, ~${elapsed}s)"
  else
    log_error "Session timed out in state: ${current_state}"
    abort_reason="TIMEOUT"
  fi

  # --- Write output files ---
  # Relay outputs are shared, not per-party. Both files contain the same response.
  echo "${output_resp}" | jq . > "${run_dir}/alice_output.json"
  cp "${run_dir}/alice_output.json" "${run_dir}/bob_output.json"

  # Save for next session's adaptive Bob
  PREV_OUTPUT_FILE="${run_dir}/alice_output.json"

  # --- Extract model identity from receipt ---
  local model_provider model_id_actual
  model_provider="$(jq -r '.receipt.model_identity.provider // empty' "${run_dir}/alice_output.json")"
  model_id_actual="$(jq -r '.receipt.model_identity.model_id // empty' "${run_dir}/alice_output.json")"

  # --- Write run metadata ---
  local transitions_json
  transitions_json="$(printf '%s\n' "${state_transitions[@]}" | jq -R . | jq -s .)"

  jq -n \
    --arg session_id "${session_id}" \
    --arg contract_hash "${CONTRACT_HASH}" \
    --arg prompt_template_hash "${PROMPT_TEMPLATE_HASH}" \
    --arg desired_purpose "${DESIRED_PURPOSE}" \
    --arg observed_contract_hash "${observed_hash}" \
    --arg provider "${PROVIDER}" \
    --arg model_provider "${model_provider}" \
    --arg model_id "${model_id_actual}" \
    --arg t_start "${t_start}" \
    --arg t_end "${t_end}" \
    --arg duration_s "${elapsed}" \
    --argjson state_transitions "${transitions_json}" \
    --arg abort_reason "${abort_reason}" \
    --arg poll_count "${poll_count}" \
    --arg seed "${SEED}" \
    --arg session_num "${session_num}" \
    '{
      session_id: $session_id,
      session_num: ($session_num | tonumber),
      contract_hash: $contract_hash,
      prompt_template_hash: $prompt_template_hash,
      desired_purpose: $desired_purpose,
      observed_contract_hash: $observed_contract_hash,
      provider: $provider,
      model_provider: (if $model_provider == "" then null else $model_provider end),
      model_id: (if $model_id == "" then null else $model_id end),
      t_start: $t_start,
      t_end: $t_end,
      duration_s: ($duration_s | tonumber),
      state_transitions: $state_transitions,
      abort_reason: (if $abort_reason == "" then null else $abort_reason end),
      poll_count: ($poll_count | tonumber),
      seed: (if $seed == "" then null else $seed end)
    }' > "${run_dir}/run_metadata.json"

  # --- Run verification ---
  log_info "Running verification..."
  local verify_exit=0
  "${SCRIPT_DIR}/verify.sh" "${run_id}" --session "${session_id}" --read-token "${init_read_token}" || verify_exit=$?

  # --- Update experiment manifest and runs.jsonl ---
  if [[ -n "${EXPERIMENT_ID}" ]]; then
    local exp_dir="${RESULTS_BASE}/experiments/${EXPERIMENT_ID}"
    mkdir -p "${exp_dir}"

    local run_status="pass"
    [[ ${verify_exit} -ne 0 ]] && run_status="fail"

    # Append to runs.jsonl
    jq -n -c \
      --arg session_num "${session_num}" \
      --arg run_id "${run_id}" \
      --arg status "${run_status}" \
      --arg duration_s "${elapsed}" \
      --arg contract_hash "${CONTRACT_HASH}" \
      --arg provider "${PROVIDER}" \
      --arg model_id "${model_id_actual}" \
      '{session_num: ($session_num | tonumber), run_id: $run_id, status: $status, duration_s: ($duration_s | tonumber), contract_hash: $contract_hash, provider: $provider, model_id: (if $model_id == "" then null else $model_id end)}' \
      >> "${exp_dir}/runs.jsonl"

    # Append session entry to manifest.json
    local session_entry
    session_entry="$(jq -n \
      --arg session_number "${session_num}" \
      --arg session_id "${session_id}" \
      --arg run_dir "${run_dir}" \
      --arg run_id "${run_id}" \
      --arg bob_profile "${BOB_PROFILE}" \
      --arg session_start_ts "${t_start}" \
      --arg session_end_ts "${t_end}" \
      --arg status "${run_status}" \
      --arg model_id "${model_id_actual}" \
      '{
        session_number: ($session_number | tonumber),
        session_id: $session_id,
        run_dir: $run_dir,
        run_id: $run_id,
        bob_profile: $bob_profile,
        session_start_ts: $session_start_ts,
        session_end_ts: $session_end_ts,
        status: $status,
        model_id: (if $model_id == "" then null else $model_id end)
      }')"
    local manifest="${exp_dir}/manifest.json"
    jq --argjson entry "${session_entry}" '.sessions += [$entry]' "${manifest}" > "${manifest}.tmp" \
      && mv "${manifest}.tmp" "${manifest}"
  fi

  return ${verify_exit}
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

validate_scenario
canary_hygiene_check
start_relay
build_contract

# ---------------------------------------------------------------------------
# Write experiment manifest (before session loop)
# ---------------------------------------------------------------------------

if [[ -n "${EXPERIMENT_ID}" ]]; then
  EXP_DIR="${RESULTS_BASE}/experiments/${EXPERIMENT_ID}"
  mkdir -p "${EXP_DIR}"

  GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
  EXP_START_TS="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # Read full criteria.json for embedding in manifest
  CRITERIA_JSON="$(cat "${SCENARIO_DIR}/criteria.json")"

  jq -n \
    --arg experiment_id "${EXPERIMENT_ID}" \
    --arg scenario "${SCENARIO}" \
    --arg purpose "${PURPOSE}" \
    --arg bob_profile "${BOB_PROFILE}" \
    --arg canary_token "${CANARY_TOKEN}" \
    --argjson quantitative_secret "$(jq '.quantitative_secret // null' "${SCENARIO_DIR}/criteria.json")" \
    --arg desired_contract "${CONTRACT_HASH}" \
    --arg contract_hash "${CONTRACT_HASH}" \
    --arg prompt_template_hash "${PROMPT_TEMPLATE_HASH}" \
    --arg provider "${PROVIDER}" \
    --arg total_sessions "${NUM_SESSIONS}" \
    --arg seed "${SEED}" \
    --arg git_sha "${GIT_SHA}" \
    --arg started_at "${EXP_START_TS}" \
    --arg relay_url "${RELAY_URL}" \
    --argjson criteria "${CRITERIA_JSON}" \
    '{
      experiment_id: $experiment_id,
      scenario: $scenario,
      purpose: $purpose,
      bob_profile: $bob_profile,
      canary_token: $canary_token,
      quantitative_secret: $quantitative_secret,
      desired_contract: $desired_contract,
      contract_hash: $contract_hash,
      prompt_template_hash: $prompt_template_hash,
      provider: $provider,
      total_sessions: ($total_sessions | tonumber),
      seed: (if $seed == "" then null else $seed end),
      git_sha: $git_sha,
      started_at: $started_at,
      relay_url: $relay_url,
      criteria: $criteria,
      sessions: []
    }' > "${EXP_DIR}/manifest.json"

  log_info "Experiment manifest: ${EXP_DIR}/manifest.json"
fi

echo ""
echo "==========================================================="
echo "  AgentVault Direct HTTP Driver"
echo "  Scenario:  ${SCENARIO}"
echo "  Purpose:   ${PURPOSE}"
echo "  Sessions:  ${NUM_SESSIONS}"
echo "  Provider:  ${PROVIDER}"
echo "  Relay:     ${RELAY_URL}"
[[ -n "${SEED}" ]] && echo "  Seed:      ${SEED}"
[[ -n "${EXPERIMENT_ID}" ]] && echo "  Experiment: ${EXPERIMENT_ID}"
echo "==========================================================="
echo ""

SESSION_RESULTS=()
TOTAL_PASS=0
TOTAL_FAIL=0

for (( i=1; i<=NUM_SESSIONS; i++ )); do
  session_exit=0
  run_session "${i}" || session_exit=$?

  if [[ ${session_exit} -eq 0 ]]; then
    SESSION_RESULTS+=("session ${i}: PASS")
    TOTAL_PASS=$(( TOTAL_PASS + 1 ))
  else
    SESSION_RESULTS+=("session ${i}: FAIL")
    TOTAL_FAIL=$(( TOTAL_FAIL + 1 ))
  fi

  # Run accumulate.sh after each session (tracks cross-session evolution)
  if [[ -n "${EXPERIMENT_ID}" && -f "${SCRIPT_DIR}/accumulate.sh" ]]; then
    log_info "Running accumulation evaluator..."
    "${SCRIPT_DIR}/accumulate.sh" "${EXPERIMENT_ID}" || log_warn "accumulate.sh returned non-zero"
  fi

  # Brief pause between sessions
  if [[ "${i}" -lt "${NUM_SESSIONS}" ]]; then
    sleep 1
  fi
done

# Stamp experiment completion time
if [[ -n "${EXPERIMENT_ID}" ]]; then
  local_manifest="${RESULTS_BASE}/experiments/${EXPERIMENT_ID}/manifest.json"
  if [[ -f "${local_manifest}" ]]; then
    jq --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" '.completed_at = $ts' "${local_manifest}" > "${local_manifest}.tmp" \
      && mv "${local_manifest}.tmp" "${local_manifest}"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "==========================================================="
echo "  Results: ${TOTAL_PASS} passed, ${TOTAL_FAIL} failed (${NUM_SESSIONS} total)"
for r in "${SESSION_RESULTS[@]}"; do
  echo "    ${r}"
done
echo "==========================================================="

if [[ ${TOTAL_FAIL} -gt 0 ]]; then
  exit 1
fi
