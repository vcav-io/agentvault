#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# sweep.sh — Model capability sweep for relay mediation quality
#
# Iterates over provider+model combinations from models.json, restarts the
# relay for each, drives a mediation scenario, and evaluates output quality.
#
# Usage:
#   ./tests/live/sweep.sh
#   ./tests/live/sweep.sh --scenario 01-cofounder-mediation
#   ./tests/live/sweep.sh --providers gemini,anthropic
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

SCENARIO="01-cofounder-mediation"
PROVIDER_FILTER=""
RELAY_PORT=3100

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)   SCENARIO="${2:-}";        shift 2 ;;
    --providers)  PROVIDER_FILTER="${2:-}";  shift 2 ;;
    --port)       RELAY_PORT="${2:-3100}";   shift 2 ;;
    *)
      echo "Usage: $0 [--scenario NAME] [--providers gemini,anthropic,openai] [--port PORT]" >&2
      exit 1
      ;;
  esac
done

RELAY_URL="http://localhost:${RELAY_PORT}"
SCENARIO_DIR="${SCENARIOS_DIR}/${SCENARIO}"
MODELS_FILE="${SCRIPT_DIR}/models.json"

require_cmd curl
require_cmd jq
require_cmd cargo

# Validate inputs
if [[ ! -f "${MODELS_FILE}" ]]; then
  log_error "Model matrix not found: ${MODELS_FILE}"
  exit 1
fi
if [[ ! -f "${SCENARIO_DIR}/criteria.json" ]]; then
  log_error "Scenario criteria not found: ${SCENARIO_DIR}/criteria.json"
  exit 1
fi
if [[ ! -f "${SCENARIO_DIR}/alice_relay_input.json" || ! -f "${SCENARIO_DIR}/bob_relay_input_s1.json" ]]; then
  log_error "Scenario missing relay input files: ${SCENARIO_DIR}/"
  exit 1
fi

# Source .env for API keys
if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${REPO_ROOT}/.env"
  set +a
fi

# ---------------------------------------------------------------------------
# Build relay binary once
# ---------------------------------------------------------------------------

RELAY_BIN="${REPO_ROOT}/target/release/agentvault-relay"
log_info "Building relay (release)..."
cargo build --release -p agentvault-relay --manifest-path "${REPO_ROOT}/Cargo.toml" 2>&1 | \
  while IFS= read -r line; do log_info "  cargo: ${line}"; done
log_success "Relay binary ready: ${RELAY_BIN}"

# ---------------------------------------------------------------------------
# Sweep results directory
# ---------------------------------------------------------------------------

SWEEP_TS="$(date -u '+%Y%m%dT%H%M%SZ')"
SWEEP_DIR="${RESULTS_BASE}/sweep-${SWEEP_TS}"
mkdir -p "${SWEEP_DIR}"
log_info "Sweep results: ${SWEEP_DIR}"

# ---------------------------------------------------------------------------
# Provider → env var mapping
# ---------------------------------------------------------------------------

api_key_for_provider() {
  case "$1" in
    anthropic) echo "${ANTHROPIC_API_KEY:-}" ;;
    openai)    echo "${OPENAI_API_KEY:-}" ;;
    gemini)    echo "${GEMINI_API_KEY:-}" ;;
    *)         echo "" ;;
  esac
}

model_env_var_for_provider() {
  case "$1" in
    anthropic) echo "VCAV_MODEL_ID" ;;
    openai)    echo "VCAV_OPENAI_MODEL_ID" ;;
    gemini)    echo "VCAV_GEMINI_MODEL_ID" ;;
    *)         echo "" ;;
  esac
}

# ---------------------------------------------------------------------------
# Run sweep
# ---------------------------------------------------------------------------

# Collect results for summary table
declare -a SUMMARY_PROVIDER=()
declare -a SUMMARY_MODEL=()
declare -a SUMMARY_DEFAULT=()
declare -a SUMMARY_OUTCOME=()
declare -a SUMMARY_QUALITY=()
declare -a SUMMARY_REASON=()

RELAY_PID=""

cleanup_relay() {
  if [[ -n "${RELAY_PID}" ]] && kill -0 "${RELAY_PID}" 2>/dev/null; then
    kill "${RELAY_PID}" 2>/dev/null || true
    local waited=0
    while kill -0 "${RELAY_PID}" 2>/dev/null && (( waited < 3 )); do
      sleep 0.5
      waited=$(( waited + 1 ))
    done
    if kill -0 "${RELAY_PID}" 2>/dev/null; then
      kill -9 "${RELAY_PID}" 2>/dev/null || true
    fi
    RELAY_PID=""
  fi
}

trap 'cleanup_relay' EXIT INT TERM

NUM_MODELS="$(jq length "${MODELS_FILE}")"
COMBO_IDX=0

for (( i=0; i<NUM_MODELS; i++ )); do
  provider="$(jq -r ".[$i].provider" "${MODELS_FILE}")"
  model="$(jq -r ".[$i].model" "${MODELS_FILE}")"
  tier="$(jq -r ".[$i].tier" "${MODELS_FILE}")"
  is_default="$(jq -r ".[$i].default // false" "${MODELS_FILE}")"

  # Filter by provider if requested
  if [[ -n "${PROVIDER_FILTER}" ]]; then
    if ! echo ",${PROVIDER_FILTER}," | grep -q ",${provider},"; then
      continue
    fi
  fi

  # Skip if no API key for this provider
  api_key="$(api_key_for_provider "${provider}")"
  if [[ -z "${api_key}" ]]; then
    log_warn "Skipping ${provider}/${model} — no API key"
    continue
  fi

  COMBO_IDX=$(( COMBO_IDX + 1 ))
  default_flag=""
  if [[ "${is_default}" == "true" ]]; then
    default_flag="*"
  fi

  log_info "━━━ [${COMBO_IDX}] ${provider}/${model} (${tier}${default_flag:+ default}) ━━━"

  # Clean up any previous relay
  cleanup_relay

  # Start relay with the target model
  model_env="$(model_env_var_for_provider "${provider}")"
  relay_log="${SWEEP_DIR}/${provider}_${model}.relay.log"

  env \
    VCAV_PORT="${RELAY_PORT}" \
    VCAV_PROMPT_PROGRAM_DIR="${REPO_ROOT}/packages/agentvault-relay/prompt_programs" \
    VCAV_ENV=dev \
    VCAV_INBOX_AUTH=off \
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
    OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
    GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
    "${model_env}=${model}" \
    "${RELAY_BIN}" > "${relay_log}" 2>&1 &
  RELAY_PID=$!
  log_info "Relay PID: ${RELAY_PID} (model env: ${model_env}=${model})"

  if ! health_check "${RELAY_URL}/health" 30; then
    log_error "Relay failed to start for ${provider}/${model}"
    SUMMARY_PROVIDER+=("${provider}")
    SUMMARY_MODEL+=("${model}")
    SUMMARY_DEFAULT+=("${default_flag}")
    SUMMARY_OUTCOME+=("ERROR")
    SUMMARY_QUALITY+=("FAIL")
    SUMMARY_REASON+=("relay_start_failed")
    cleanup_relay
    continue
  fi

  # Run drive.sh --no-relay
  run_exit=0
  "${SCRIPT_DIR}/drive.sh" \
    --scenario "${SCENARIO}" \
    --no-relay \
    --provider "${provider}" \
    --relay-url "${RELAY_URL}" || run_exit=$?

  # Find the most recent run directory (drive.sh creates timestamped dirs)
  latest_run="$(ls -dt "${RESULTS_BASE}"/20* 2>/dev/null | head -1)"
  if [[ -z "${latest_run}" || ! -f "${latest_run}/alice_output.json" ]]; then
    log_error "No output found for ${provider}/${model}"
    SUMMARY_PROVIDER+=("${provider}")
    SUMMARY_MODEL+=("${model}")
    SUMMARY_DEFAULT+=("${default_flag}")
    SUMMARY_OUTCOME+=("ERROR")
    SUMMARY_QUALITY+=("FAIL")
    SUMMARY_REASON+=("no_output")
    cleanup_relay
    continue
  fi

  # Extract output fields (mediation schema)
  med_signal="$(jq -r '.output.mediation_signal // "MISSING"' "${latest_run}/alice_output.json")"
  common_ground="$(jq -r '.output.common_ground_code // "MISSING"' "${latest_run}/alice_output.json")"
  next_step="$(jq -r '.output.next_step_signal // "MISSING"' "${latest_run}/alice_output.json")"
  confidence="$(jq -r '.output.confidence_band // "MISSING"' "${latest_run}/alice_output.json")"

  # Run quality check
  quality_result="$(check_quality "${latest_run}/alice_output.json" "${SCENARIO_DIR}/criteria.json")" || true
  quality_pass="$(echo "${quality_result}" | jq -r '.pass')"
  quality_label="PASS"
  fail_reason=""
  if [[ "${quality_pass}" != "true" ]]; then
    quality_label="FAIL"
    # Collect failing check names
    fail_reason="$(echo "${quality_result}" | jq -r '[.checks[] | select(.passed == false) | .name] | join(",")')"
  fi

  # Write run.json provenance
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  jq -n \
    --arg provider "${provider}" \
    --arg model "${model}" \
    --arg scenario "${SCENARIO}" \
    --arg timestamp "${timestamp}" \
    --arg med_signal "${med_signal}" \
    --arg common_ground "${common_ground}" \
    --arg next_step "${next_step}" \
    --arg confidence "${confidence}" \
    --argjson quality_pass "${quality_pass}" \
    --argjson is_default "$(echo "${is_default}" | jq -R 'if . == "true" then true else false end')" \
    --argjson quality_result "${quality_result}" \
    '{
      provider: $provider,
      model: $model,
      scenario: $scenario,
      timestamp: $timestamp,
      output: {
        mediation_signal: $med_signal,
        common_ground_code: $common_ground,
        next_step_signal: $next_step,
        confidence_band: $confidence
      },
      quality_pass: $quality_pass,
      quality_checks: $quality_result,
      is_current_default: $is_default
    }' > "${SWEEP_DIR}/${provider}_${model}.run.json"

  log_info "Result: signal=${med_signal} ground=${common_ground} next=${next_step} conf=${confidence} → ${quality_label}"

  SUMMARY_PROVIDER+=("${provider}")
  SUMMARY_MODEL+=("${model}")
  SUMMARY_DEFAULT+=("${default_flag}")
  SUMMARY_OUTCOME+=("${med_signal}")
  SUMMARY_QUALITY+=("${quality_label}")
  SUMMARY_REASON+=("${fail_reason}")

  # Stop relay before next iteration
  cleanup_relay
done

# ---------------------------------------------------------------------------
# Print summary table
# ---------------------------------------------------------------------------

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Model Capability Sweep — ${SCENARIO}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "%-12s %-35s %-8s %-25s %-8s %s\n" "Provider" "Model" "Default" "mediation_signal" "quality" ""
printf "%-12s %-35s %-8s %-25s %-8s %s\n" "--------" "-----" "-------" "----------------" "-------" ""

for (( j=0; j<${#SUMMARY_PROVIDER[@]}; j++ )); do
  flag=""
  if [[ "${SUMMARY_DEFAULT[$j]}" == "*" ]]; then
    flag="*"
  fi

  note=""
  if [[ "${SUMMARY_DEFAULT[$j]}" == "*" && "${SUMMARY_QUALITY[$j]}" == "FAIL" ]]; then
    note="← current default fails"
  fi
  if [[ -n "${SUMMARY_REASON[$j]}" ]]; then
    note="${note:+${note} }(${SUMMARY_REASON[$j]})"
  fi

  printf "%-12s %-35s %-8s %-25s %-8s %s\n" \
    "${SUMMARY_PROVIDER[$j]}" \
    "${SUMMARY_MODEL[$j]}" \
    "${flag}" \
    "${SUMMARY_OUTCOME[$j]}" \
    "${SUMMARY_QUALITY[$j]}" \
    "${note}"
done

echo ""
echo "Results saved to: ${SWEEP_DIR}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Write summary.json
jq -n \
  --arg scenario "${SCENARIO}" \
  --arg timestamp "${SWEEP_TS}" \
  --arg results_dir "${SWEEP_DIR}" \
  --argjson count "${#SUMMARY_PROVIDER[@]}" \
  '{
    scenario: $scenario,
    timestamp: $timestamp,
    results_dir: $results_dir,
    models_tested: $count
  }' > "${SWEEP_DIR}/summary.json"
