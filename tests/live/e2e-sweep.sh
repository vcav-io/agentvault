#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# e2e-sweep.sh — End-to-end demo sweep for agent + relay model combos
#
# Tests the full demo flow (agent composition + relay inference) using the
# demo server's HTTP API. Iterates over agent models per provider, using
# the cheapest passing relay model from the relay-only sweep.
#
# Usage:
#   ./tests/live/e2e-sweep.sh
#   ./tests/live/e2e-sweep.sh --providers gemini,anthropic
#   ./tests/live/e2e-sweep.sh --relay-port 3100 --demo-port 3200
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HARNESS_DIR="${SCRIPT_DIR}/harness"
SCENARIOS_DIR="${SCRIPT_DIR}/scenarios"
RESULTS_BASE="${SCRIPT_DIR}/results"

# shellcheck source=harness/lib.sh
source "${HARNESS_DIR}/lib.sh"
# shellcheck source=harness/report.sh
source "${HARNESS_DIR}/report.sh"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

PROVIDER_FILTER=""
RELAY_PORT=3100
DEMO_PORT=3200

while [[ $# -gt 0 ]]; do
  case "$1" in
    --providers)   PROVIDER_FILTER="${2:-}";  shift 2 ;;
    --relay-port)  RELAY_PORT="${2:-3100}";   shift 2 ;;
    --demo-port)   DEMO_PORT="${2:-3200}";    shift 2 ;;
    *)
      echo "Usage: $0 [--providers gemini,anthropic,openai] [--relay-port PORT] [--demo-port PORT]" >&2
      exit 1
      ;;
  esac
done

RELAY_URL="http://localhost:${RELAY_PORT}"
DEMO_URL="http://localhost:${DEMO_PORT}"
MODELS_FILE="${SCRIPT_DIR}/models.json"

require_cmd curl
require_cmd jq
require_cmd cargo
require_cmd node
require_cmd npm

# ---------------------------------------------------------------------------
# Validate inputs
# ---------------------------------------------------------------------------

if [[ ! -f "${MODELS_FILE}" ]]; then
  log_error "Model matrix not found: ${MODELS_FILE}"
  exit 1
fi

# Validate both scenarios exist
for scenario in 01-cofounder-mediation 12-freelance-negotiation; do
  scenario_dir="${SCENARIOS_DIR}/${scenario}"
  if [[ ! -f "${scenario_dir}/criteria.json" ]]; then
    log_error "Scenario criteria not found: ${scenario_dir}/criteria.json"
    exit 1
  fi
  # e2e sweep uses prompt files (alice_prompt.txt/sender_prompt.txt), not relay input files
done

# Source .env for API keys
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/.env"
  set +a
fi

# ---------------------------------------------------------------------------
# Build relay binary and demo server
# ---------------------------------------------------------------------------

RELAY_BIN="${REPO_ROOT}/target/release/agentvault-relay"
log_info "Building relay (release)..."
cargo build --release -p agentvault-relay --manifest-path "${REPO_ROOT}/Cargo.toml" 2>&1 | \
  while IFS= read -r line; do log_info "  cargo: ${line}"; done
log_success "Relay binary ready: ${RELAY_BIN}"

log_info "Building demo server..."
(cd "${REPO_ROOT}/packages/agentvault-demo-ui" && npm run build 2>&1) | \
  while IFS= read -r line; do log_info "  npm: ${line}"; done
log_success "Demo server built"

# ---------------------------------------------------------------------------
# Sweep results directory
# ---------------------------------------------------------------------------

SWEEP_TS="$(date -u '+%Y%m%dT%H%M%SZ')"
SWEEP_DIR="${RESULTS_BASE}/e2e-sweep-${SWEEP_TS}"
mkdir -p "${SWEEP_DIR}"
log_info "E2E sweep results: ${SWEEP_DIR}"

# ---------------------------------------------------------------------------
# Provider helpers
# ---------------------------------------------------------------------------

api_key_for_provider() {
  case "$1" in
    anthropic) echo "${ANTHROPIC_API_KEY:-}" ;;
    openai)    echo "${OPENAI_API_KEY:-}" ;;
    gemini)    echo "${GEMINI_API_KEY:-}" ;;
    *)         echo "" ;;
  esac
}

# Relay model env var per provider
model_env_var_for_provider() {
  case "$1" in
    anthropic) echo "AV_MODEL_ID" ;;
    openai)    echo "AV_OPENAI_MODEL_ID" ;;
    gemini)    echo "AV_GEMINI_MODEL_ID" ;;
    *)         echo "" ;;
  esac
}

# Relay models to test per provider (newline-separated).
# First model is the "default" from relay sweep; extras are matrix expansion.
relay_models_for_provider() {
  case "$1" in
    anthropic) echo "claude-haiku-4-5-20251001" ;;
    openai)    printf '%s\n' "gpt-5-mini" "gpt-5-nano" "gpt-4.1-mini" ;;
    gemini)    echo "gemini-2.5-flash" ;;
    *)         echo "" ;;
  esac
}

# Backward-compat: return just the first (default) relay model
relay_model_for_provider() {
  relay_models_for_provider "$1" | head -1
}

# ---------------------------------------------------------------------------
# Scenario prompts loader
# ---------------------------------------------------------------------------

load_scenario_prompts() {
  local scenario="$1"
  local scenario_dir="${SCENARIOS_DIR}/${scenario}"

  # S01 uses alice_prompt.txt / bob_prompt.txt
  # S02 uses sender_prompt.txt / receiver_prompt.txt
  if [[ -f "${scenario_dir}/alice_prompt.txt" ]]; then
    ALICE_PROMPT="$(cat "${scenario_dir}/alice_prompt.txt")"
    BOB_PROMPT="$(cat "${scenario_dir}/bob_prompt.txt")"
  elif [[ -f "${scenario_dir}/sender_prompt.txt" ]]; then
    ALICE_PROMPT="$(cat "${scenario_dir}/sender_prompt.txt")"
    BOB_PROMPT="$(cat "${scenario_dir}/receiver_prompt.txt")"
  else
    log_error "No prompt files found in ${scenario_dir}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Run a single e2e scenario
#
# Uses the demo server HTTP API: POST /api/start, poll /api/status, extract
# results from the JSONL run file.
#
# Returns: 0 if quality checks pass, 1 otherwise
# Sets: E2E_MED_SIGNAL, E2E_COMMON_GROUND, E2E_CONFIDENCE, E2E_NEXT_STEP,
#       E2E_ALICE_INPUT_LEN, E2E_BOB_INPUT_LEN, E2E_FAIL_REASON
# ---------------------------------------------------------------------------

run_e2e_scenario() {
  local scenario="$1"
  local agent_provider="$2"
  local agent_model="$3"
  local scenario_dir="${SCENARIOS_DIR}/${scenario}"

  E2E_MED_SIGNAL="MISSING"
  E2E_COMMON_GROUND="MISSING"
  E2E_CONFIDENCE="MISSING"
  E2E_NEXT_STEP="MISSING"
  E2E_ALICE_INPUT_LEN=0
  E2E_BOB_INPUT_LEN=0
  E2E_FAIL_REASON=""

  # Load scenario prompts
  load_scenario_prompts "${scenario}" || return 1

  # POST /api/start with provider override and prompts
  local start_body
  start_body="$(jq -n \
    --arg ap "${agent_provider}" \
    --arg am "${agent_model}" \
    --arg alice "${ALICE_PROMPT}" \
    --arg bob "${BOB_PROMPT}" \
    '{agentProvider: $ap, agentModel: $am, alicePrompt: $alice, bobPrompt: $bob}')"

  local start_resp
  start_resp="$(curl -s -X POST "${DEMO_URL}/api/start" \
    -H "Content-Type: application/json" \
    -d "${start_body}")"

  local start_ok
  start_ok="$(echo "${start_resp}" | jq -r '.ok // false')"
  if [[ "${start_ok}" != "true" ]]; then
    E2E_FAIL_REASON="start_failed: $(echo "${start_resp}" | jq -r '.error // "unknown"')"
    return 1
  fi

  local run_file
  run_file="$(echo "${start_resp}" | jq -r '.runFile')"
  log_info "  Run file: ${run_file}"

  # Poll /api/status until both agents idle with turnCount > 2 (timeout 180s)
  local elapsed=0
  local timeout=180
  local alice_turns=0 bob_turns=0 alice_status="" bob_status=""

  while (( elapsed < timeout )); do
    local status_resp
    status_resp="$(curl -s "${DEMO_URL}/api/status")"
    alice_turns="$(echo "${status_resp}" | jq -r '.alice.turnCount')"
    bob_turns="$(echo "${status_resp}" | jq -r '.bob.turnCount')"
    alice_status="$(echo "${status_resp}" | jq -r '.alice.status')"
    bob_status="$(echo "${status_resp}" | jq -r '.bob.status')"

    # Both idle with enough turns means the demo completed
    if [[ "${alice_status}" == "idle" && "${bob_status}" == "idle" \
          && "${alice_turns}" -gt 2 && "${bob_turns}" -gt 2 ]]; then
      break
    fi

    sleep 3
    elapsed=$(( elapsed + 3 ))
  done

  if (( elapsed >= timeout )); then
    E2E_FAIL_REASON="timeout (alice=${alice_status}:${alice_turns}, bob=${bob_status}:${bob_turns})"
    # Reset before returning
    curl -s -X POST "${DEMO_URL}/api/reset" > /dev/null 2>&1 || true
    return 1
  fi

  log_info "  Agents settled: alice=${alice_turns} turns, bob=${bob_turns} turns (~${elapsed}s)"

  # Extract relay output and agent inputs from JSONL run file
  local runs_dir="${REPO_ROOT}/packages/agentvault-demo-ui/runs"
  local jsonl_path="${runs_dir}/${run_file}"

  if [[ ! -f "${jsonl_path}" ]]; then
    E2E_FAIL_REASON="run_file_missing"
    curl -s -X POST "${DEMO_URL}/api/reset" > /dev/null 2>&1 || true
    return 1
  fi

  # Extract relay output from the COMPLETED tool_result event
  local output_json
  output_json="$(grep 'mediation_signal' "${jsonl_path}" | head -1 | jq -c '.payload.result.data.output.output // empty' 2>/dev/null || echo "")"

  if [[ -z "${output_json}" || "${output_json}" == "null" ]]; then
    # Check for INSUFFICIENT_SIGNAL or other status
    local any_output
    any_output="$(grep '"state":"COMPLETED"' "${jsonl_path}" | head -1 | jq -c '.payload.result.data.output.output // empty' 2>/dev/null || echo "")"
    if [[ -n "${any_output}" && "${any_output}" != "null" ]]; then
      output_json="${any_output}"
    else
      E2E_FAIL_REASON="no_relay_output"
      curl -s -X POST "${DEMO_URL}/api/reset" > /dev/null 2>&1 || true
      return 1
    fi
  fi

  E2E_MED_SIGNAL="$(echo "${output_json}" | jq -r '.mediation_signal // "MISSING"')"
  E2E_COMMON_GROUND="$(echo "${output_json}" | jq -r '.common_ground_code // "MISSING"')"
  E2E_CONFIDENCE="$(echo "${output_json}" | jq -r '.confidence_band // "MISSING"')"
  E2E_NEXT_STEP="$(echo "${output_json}" | jq -r '.next_step_signal // "MISSING"')"

  # Extract agent-composed my_input from tool_call events
  local alice_input bob_input
  alice_input="$(grep '"tool_call"' "${jsonl_path}" | grep '"agent":"alice"' | grep 'relay_signal' | grep 'my_input' | head -1 | jq -r '.payload.args.my_input // ""' 2>/dev/null || echo "")"
  bob_input="$(grep '"tool_call"' "${jsonl_path}" | grep '"agent":"bob"' | grep 'relay_signal' | grep 'my_input' | head -1 | jq -r '.payload.args.my_input // ""' 2>/dev/null || echo "")"

  E2E_ALICE_INPUT_LEN="${#alice_input}"
  E2E_BOB_INPUT_LEN="${#bob_input}"

  # Write output file for quality check
  local output_file="${SWEEP_DIR}/${agent_provider}_${agent_model}_${scenario}.output.json"
  echo "${output_json}" | jq --arg ms "${E2E_MED_SIGNAL}" --arg cg "${E2E_COMMON_GROUND}" \
    --arg cb "${E2E_CONFIDENCE}" --arg ns "${E2E_NEXT_STEP}" \
    '{output: {mediation_signal: $ms, common_ground_code: $cg, confidence_band: $cb, next_step_signal: $ns}}' \
    > "${output_file}"

  # Run quality check
  local quality_result quality_pass
  quality_result="$(check_quality "${output_file}" "${scenario_dir}/criteria.json")" || true
  quality_pass="$(echo "${quality_result}" | jq -r '.pass')"

  if [[ "${quality_pass}" != "true" ]]; then
    E2E_FAIL_REASON="$(echo "${quality_result}" | jq -r '[.checks[] | select(.passed == false) | .name] | join(",")')"
  fi

  # Reset demo server for next run
  curl -s -X POST "${DEMO_URL}/api/reset" > /dev/null 2>&1 || true
  # Wait for reset to complete
  sleep 3

  if [[ "${quality_pass}" == "true" ]]; then
    return 0
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Process management
# ---------------------------------------------------------------------------

RELAY_PID=""
DEMO_PID=""

cleanup_all() {
  if [[ -n "${DEMO_PID}" ]] && kill -0 "${DEMO_PID}" 2>/dev/null; then
    kill "${DEMO_PID}" 2>/dev/null || true
    local w=0
    while kill -0 "${DEMO_PID}" 2>/dev/null && (( w < 3 )); do sleep 0.5; w=$(( w+1 )); done
    kill -0 "${DEMO_PID}" 2>/dev/null && kill -9 "${DEMO_PID}" 2>/dev/null || true
    DEMO_PID=""
  fi
  if [[ -n "${RELAY_PID}" ]] && kill -0 "${RELAY_PID}" 2>/dev/null; then
    kill "${RELAY_PID}" 2>/dev/null || true
    local w=0
    while kill -0 "${RELAY_PID}" 2>/dev/null && (( w < 3 )); do sleep 0.5; w=$(( w+1 )); done
    kill -0 "${RELAY_PID}" 2>/dev/null && kill -9 "${RELAY_PID}" 2>/dev/null || true
    RELAY_PID=""
  fi
}

trap 'cleanup_all' EXIT INT TERM

# ---------------------------------------------------------------------------
# Main sweep
# ---------------------------------------------------------------------------

# Collect results for summary table
declare -a SUM_PROVIDER=()
declare -a SUM_AGENT_MODEL=()
declare -a SUM_RELAY_MODEL=()
declare -a SUM_S01_SIGNAL=()
declare -a SUM_S12_SIGNAL=()
declare -a SUM_RESULT=()
declare -a SUM_ALICE_LEN=()
declare -a SUM_BOB_LEN=()
declare -a SUM_ACTUAL_RELAY_PROVIDER=()

# Get unique providers from models.json
PROVIDERS="$(jq -r '[.[].provider] | unique[]' "${MODELS_FILE}")"

for current_provider in ${PROVIDERS}; do
  # Filter by provider if requested
  if [[ -n "${PROVIDER_FILTER}" ]]; then
    if ! echo ",${PROVIDER_FILTER}," | grep -q ",${current_provider},"; then
      continue
    fi
  fi

  # Skip if no API key
  api_key="$(api_key_for_provider "${current_provider}")"
  if [[ -z "${api_key}" ]]; then
    log_warn "Skipping ${current_provider} — no API key"
    continue
  fi

  model_env="$(model_env_var_for_provider "${current_provider}")"

  # Relay model loop: test each relay model for this provider
  while IFS= read -r relay_model; do
    [[ -n "${relay_model}" ]] || continue

    log_info "━━━ Provider: ${current_provider} (relay: ${relay_model}) ━━━"

    # Kill any previous relay/demo
    cleanup_all

    # Start relay with ONLY the current provider's API key (isolation).
    # This ensures auto_select_provider() picks the intended provider,
    # not Anthropic by default when all keys are present.
    relay_log="${SWEEP_DIR}/${current_provider}_${relay_model}_relay.log"
    relay_env_args=(
      "AV_PORT=${RELAY_PORT}"
      "AV_PROMPT_PROGRAM_DIR=${REPO_ROOT}/packages/agentvault-relay/prompt_programs"
      "AV_ENV=dev"
      "AV_INBOX_AUTH=off"
      "${model_env}=${relay_model}"
    )
    # Set ONLY the current provider's key.
    case "${current_provider}" in
      anthropic) relay_env_args+=("ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}") ;;
      openai)    relay_env_args+=("OPENAI_API_KEY=${OPENAI_API_KEY}") ;;
      gemini)    relay_env_args+=("GEMINI_API_KEY=${GEMINI_API_KEY}") ;;
    esac
    # Start relay in a subshell with ALL provider keys unset first,
    # then only the intended one re-added via env. This prevents the
    # relay from inheriting keys from the shell's environment.
    (
      unset ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY
      env "${relay_env_args[@]}" "${RELAY_BIN}" > "${relay_log}" 2>&1
    ) &
    RELAY_PID=$!

    if ! health_check "${RELAY_URL}/health" 30; then
      log_error "Relay failed to start for ${current_provider}/${relay_model}"
      continue
    fi

    # Verify relay provider isolation via /health endpoint
    relay_health="$(curl -s "${RELAY_URL}/health")"
    actual_relay_provider="$(echo "${relay_health}" | jq -r '.provider // "unknown"')"
    actual_relay_model="$(echo "${relay_health}" | jq -r '.model_id // "unknown"')"
    log_info "Relay /health: provider=${actual_relay_provider} model_id=${actual_relay_model}"
    if [[ "${actual_relay_provider}" != "${current_provider}" ]]; then
      log_error "Relay provider mismatch! Expected ${current_provider}, got ${actual_relay_provider}"
      continue
    fi

    # Start demo server (all API keys, no PROVIDER env — we use /api/start param)
    demo_log="${SWEEP_DIR}/${current_provider}_${relay_model}_demo.log"
    env \
      DEMO_PORT="${DEMO_PORT}" \
      AV_RELAY_URL="${RELAY_URL}" \
      ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
      OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
      GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
      PROVIDER="${current_provider}" \
      node "${REPO_ROOT}/packages/agentvault-demo-ui/dist/server.js" > "${demo_log}" 2>&1 &
    DEMO_PID=$!

    if ! health_check "${DEMO_URL}/api/status" 30; then
      log_error "Demo server failed to start for ${current_provider}/${relay_model}"
      continue
    fi

    # Inner loop: agent models for this provider
    NUM_MODELS="$(jq length "${MODELS_FILE}")"
    for (( i=0; i<NUM_MODELS; i++ )); do
      mp="$(jq -r ".[$i].provider" "${MODELS_FILE}")"
      [[ "${mp}" == "${current_provider}" ]] || continue

      agent_model="$(jq -r ".[$i].model" "${MODELS_FILE}")"
      tier="$(jq -r ".[$i].tier" "${MODELS_FILE}")"

      log_info "── Agent: ${agent_model} (${tier}) ──"

      s01_signal="MISSING"
      s12_signal="MISSING"
      s01_pass=false
      s12_pass=false
      s01_reason=""
      s12_reason=""
      alice_len=0
      bob_len=0

      # Scenario 01: cofounder mediation
      log_info "  Running 01-cofounder-mediation..."
      s01_exit=0
      run_e2e_scenario "01-cofounder-mediation" "${current_provider}" "${agent_model}" || s01_exit=$?
      s01_signal="${E2E_MED_SIGNAL}"
      s01_reason="${E2E_FAIL_REASON}"
      alice_len="${E2E_ALICE_INPUT_LEN}"
      bob_len="${E2E_BOB_INPUT_LEN}"
      if [[ ${s01_exit} -eq 0 ]]; then
        s01_pass=true
        log_success "  S01: ${s01_signal} (alice=${alice_len}c, bob=${bob_len}c)"
      else
        log_warn "  S01: ${s01_signal} — ${s01_reason}"
      fi

      # Scenario 12: freelance negotiation
      log_info "  Running 12-freelance-negotiation..."
      s12_exit=0
      run_e2e_scenario "12-freelance-negotiation" "${current_provider}" "${agent_model}" || s12_exit=$?
      s12_signal="${E2E_MED_SIGNAL}"
      s12_reason="${E2E_FAIL_REASON}"
      # Use s12 lengths if s01 had zero (agent may not have composed input)
      if [[ ${alice_len} -eq 0 ]]; then
        alice_len="${E2E_ALICE_INPUT_LEN}"
        bob_len="${E2E_BOB_INPUT_LEN}"
      fi
      if [[ ${s12_exit} -eq 0 ]]; then
        s12_pass=true
        log_success "  S12: ${s12_signal}"
      else
        log_warn "  S12: ${s12_signal} — ${s12_reason}"
      fi

      # Determine overall result
      result="FAIL"
      if [[ "${s01_pass}" == "true" && "${s12_pass}" == "true" ]]; then
        result="PASS"
      elif [[ "${s01_pass}" == "true" || "${s12_pass}" == "true" ]]; then
        result="PARTIAL"
      fi

      log_info "  Result: ${result}"

      # Record results
      SUM_PROVIDER+=("${current_provider}")
      SUM_AGENT_MODEL+=("${agent_model}")
      SUM_RELAY_MODEL+=("${relay_model}")
      SUM_S01_SIGNAL+=("${s01_signal}")
      SUM_S12_SIGNAL+=("${s12_signal}")
      SUM_RESULT+=("${result}")
      SUM_ALICE_LEN+=("${alice_len}")
      SUM_BOB_LEN+=("${bob_len}")
      SUM_ACTUAL_RELAY_PROVIDER+=("${actual_relay_provider}")

      # Write per-model result
      jq -n \
        --arg provider "${current_provider}" \
        --arg agent_model "${agent_model}" \
        --arg relay_model "${relay_model}" \
        --arg actual_relay_provider "${actual_relay_provider}" \
        --arg s01_signal "${s01_signal}" \
        --arg s12_signal "${s12_signal}" \
        --arg result "${result}" \
        --arg s01_reason "${s01_reason}" \
        --arg s12_reason "${s12_reason}" \
        --argjson alice_len "${alice_len}" \
        --argjson bob_len "${bob_len}" \
        '{
          provider: $provider,
          agent_model: $agent_model,
          relay_model: $relay_model,
          actual_relay_provider: $actual_relay_provider,
          s01: {signal: $s01_signal, reason: (if $s01_reason == "" then null else $s01_reason end)},
          s12: {signal: $s12_signal, reason: (if $s12_reason == "" then null else $s12_reason end)},
          result: $result,
          alice_input_len: $alice_len,
          bob_input_len: $bob_len
        }' > "${SWEEP_DIR}/${current_provider}_${relay_model}_${agent_model}.e2e.json"
    done

    # Kill demo server before next relay model
    if [[ -n "${DEMO_PID}" ]] && kill -0 "${DEMO_PID}" 2>/dev/null; then
      kill "${DEMO_PID}" 2>/dev/null || true
      sleep 1
      kill -0 "${DEMO_PID}" 2>/dev/null && kill -9 "${DEMO_PID}" 2>/dev/null || true
      DEMO_PID=""
    fi

    # Kill relay before next relay model
    if [[ -n "${RELAY_PID}" ]] && kill -0 "${RELAY_PID}" 2>/dev/null; then
      kill "${RELAY_PID}" 2>/dev/null || true
      sleep 1
      kill -0 "${RELAY_PID}" 2>/dev/null && kill -9 "${RELAY_PID}" 2>/dev/null || true
      RELAY_PID=""
    fi

  done < <(relay_models_for_provider "${current_provider}")
done

# ---------------------------------------------------------------------------
# Print summary table
# ---------------------------------------------------------------------------

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  E2E Agent+Relay Sweep"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "%-12s %-30s %-30s %-14s %-22s %-22s %-8s %-10s %-10s\n" \
  "Provider" "Agent Model" "Relay Model" "Relay (actual)" "S01 signal" "S12 signal" "Result" "Alice len" "Bob len"
printf "%-12s %-30s %-30s %-14s %-22s %-22s %-8s %-10s %-10s\n" \
  "--------" "-----------" "-----------" "--------------" "----------" "----------" "------" "---------" "-------"

for (( j=0; j<${#SUM_PROVIDER[@]}; j++ )); do
  printf "%-12s %-30s %-30s %-14s %-22s %-22s %-8s %-10s %-10s\n" \
    "${SUM_PROVIDER[$j]}" \
    "${SUM_AGENT_MODEL[$j]}" \
    "${SUM_RELAY_MODEL[$j]}" \
    "${SUM_ACTUAL_RELAY_PROVIDER[$j]}" \
    "${SUM_S01_SIGNAL[$j]}" \
    "${SUM_S12_SIGNAL[$j]}" \
    "${SUM_RESULT[$j]}" \
    "${SUM_ALICE_LEN[$j]}" \
    "${SUM_BOB_LEN[$j]}"
done

echo ""
echo "Results saved to: ${SWEEP_DIR}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Write summary.json
jq -n \
  --arg timestamp "${SWEEP_TS}" \
  --arg results_dir "${SWEEP_DIR}" \
  --argjson count "${#SUM_PROVIDER[@]}" \
  '{
    sweep_type: "e2e",
    timestamp: $timestamp,
    results_dir: $results_dir,
    combos_tested: $count,
    scenarios: ["01-cofounder-mediation", "12-freelance-negotiation"]
  }' > "${SWEEP_DIR}/summary.json"
