#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# drive-inbox.sh — Async invite flow test for AgentVault relay
#
# Exercises the full invite → accept → session → output flow via curl,
# proving that the inbox allows asynchronous coordination (no synchrony
# coincidence required).
#
# Usage:
#   ./tests/live/drive-inbox.sh [--scenario 11-async-invite] [--no-relay] [--provider anthropic|openai] [--delay 5]
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

SCENARIO="11-async-invite"
RELAY_URL="http://localhost:3100"
NO_RELAY=false
PROVIDER=""
OFFLINE_DELAY=5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)    SCENARIO="${2:-}";       shift 2 ;;
    --relay-url)   RELAY_URL="${2:-}";      shift 2 ;;
    --no-relay)    NO_RELAY=true;           shift   ;;
    --provider)    PROVIDER="${2:-}";       shift 2 ;;
    --delay)       OFFLINE_DELAY="${2:-5}"; shift 2 ;;
    *)
      log_error "Unknown argument: $1"
      echo "Usage: $0 [--scenario <name>] [--relay-url URL] [--no-relay] [--provider anthropic|openai] [--delay SECS]" >&2
      exit 1
      ;;
  esac
done

require_cmd curl
require_cmd jq
require_cmd node

SCENARIO_DIR="${SCENARIOS_DIR}/${SCENARIO}"
AGENTS_FILE="${HARNESS_DIR}/agents.json"

if [[ ! -f "${AGENTS_FILE}" ]]; then
  log_error "Agent registry not found: ${AGENTS_FILE}"
  exit 1
fi

# Read agent tokens from registry
ALICE_INBOX_TOKEN="$(jq -r '.agents[] | select(.agent_id == "alice") | .inbox_token' "${AGENTS_FILE}")"
BOB_INBOX_TOKEN="$(jq -r '.agents[] | select(.agent_id == "bob") | .inbox_token' "${AGENTS_FILE}")"

if [[ -z "${ALICE_INBOX_TOKEN}" || -z "${BOB_INBOX_TOKEN}" ]]; then
  log_error "Could not read agent tokens from ${AGENTS_FILE}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Validate scenario files
# ---------------------------------------------------------------------------

validate_scenario() {
  local missing=()
  for f in criteria.json alice_relay_input.json bob_relay_input_s1.json; do
    [[ -f "${SCENARIO_DIR}/${f}" ]] || missing+=("${f}")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "Scenario '${SCENARIO}' missing files: ${missing[*]}"
    exit 1
  fi

  PURPOSE="$(jq -r '.purpose' "${SCENARIO_DIR}/criteria.json")"
  log_info "Scenario: ${SCENARIO}  |  Purpose: ${PURPOSE}"
}

# ---------------------------------------------------------------------------
# Provider auto-detection (same as drive.sh)
# ---------------------------------------------------------------------------

detect_provider() {
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
# Start relay (with agent registry)
# ---------------------------------------------------------------------------

RELAY_PID=""

start_relay() {
  if [[ "${NO_RELAY}" == "true" ]]; then
    log_info "Skipping relay startup (--no-relay)"
    health_check "${RELAY_URL}/health" 10
    return
  fi

  detect_provider

  local relay_bin="${REPO_ROOT}/target/release/agentvault-relay"
  log_info "Building relay (release)..."
  cargo build --release -p agentvault-relay --manifest-path "${REPO_ROOT}/Cargo.toml" 2>&1 | \
    while IFS= read -r line; do log_info "  cargo: ${line}"; done
  log_success "Relay binary ready: ${relay_bin}"

  local relay_port
  relay_port="$(echo "${RELAY_URL}" | grep -oE '[0-9]+$')"

  local relay_log="${RESULTS_BASE}/_drive_inbox_relay.log"
  AV_PORT="${relay_port}" \
  AV_PROMPT_PROGRAM_DIR="${REPO_ROOT}/packages/agentvault-relay/prompt_programs" \
  AV_AGENT_REGISTRY_PATH="${AGENTS_FILE}" \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
    "${relay_bin}" > "${relay_log}" 2>&1 &
  RELAY_PID=$!
  register_pid "${RELAY_PID}" "relay"
  log_info "Relay PID: ${RELAY_PID} (with agent registry)"

  health_check "${RELAY_URL}/health" 30
}

# ---------------------------------------------------------------------------
# Build contract
# ---------------------------------------------------------------------------

CONTRACT_JSON=""
CONTRACT_HASH=""

build_contract() {
  local result
  result="$(node --input-type=module -e "
import { buildRelayContract, computeRelayContractHash } from '${REPO_ROOT}/packages/agentvault-client/dist/relay-contracts.js';
const c = buildRelayContract('${PURPOSE}', ['alice', 'bob']);
if (!c) { console.error('Unknown purpose: ${PURPOSE}'); process.exit(1); }
const h = computeRelayContractHash(c);
console.log(JSON.stringify({ contract: c, hash: h }));
")"

  CONTRACT_JSON="$(echo "${result}" | jq -c '.contract')"
  CONTRACT_HASH="$(echo "${result}" | jq -r '.hash')"

  log_info "Contract hash: ${CONTRACT_HASH}"
}

# ---------------------------------------------------------------------------
# Assert helper
# ---------------------------------------------------------------------------

TOTAL_CHECKS=0
CHECKS_PASSED=0
CHECKS_FAILED=0

assert_eq() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  TOTAL_CHECKS=$(( TOTAL_CHECKS + 1 ))
  if [[ "${actual}" == "${expected}" ]]; then
    log_success "PASS: ${label}"
    CHECKS_PASSED=$(( CHECKS_PASSED + 1 ))
  else
    log_error "FAIL: ${label} — expected '${expected}', got '${actual}'"
    CHECKS_FAILED=$(( CHECKS_FAILED + 1 ))
  fi
}

assert_not_empty() {
  local label="$1"
  local actual="$2"
  TOTAL_CHECKS=$(( TOTAL_CHECKS + 1 ))
  if [[ -n "${actual}" && "${actual}" != "null" ]]; then
    log_success "PASS: ${label}"
    CHECKS_PASSED=$(( CHECKS_PASSED + 1 ))
  else
    log_error "FAIL: ${label} — value is empty or null"
    CHECKS_FAILED=$(( CHECKS_FAILED + 1 ))
  fi
}

# Wrapper around curl that checks HTTP status code.
# Usage: relay_curl [-X METHOD] URL [curl args...]
# Returns response body on stdout. Fails the script on 4xx/5xx.
relay_curl() {
  local tmpfile
  tmpfile="$(mktemp)"
  local http_code
  http_code="$(curl -s -o "${tmpfile}" -w '%{http_code}' "$@")"
  local body
  body="$(cat "${tmpfile}")"
  rm -f "${tmpfile}"

  if [[ "${http_code}" -ge 400 ]]; then
    log_error "HTTP ${http_code} from: $*"
    log_error "Response body: ${body}"
    exit 1
  fi
  echo "${body}"
}

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

validate_scenario
start_relay
build_contract

run_id="$(date -u '+%Y%m%dT%H%M%SZ')-inbox"
run_dir="${RESULTS_BASE}/${run_id}"
mkdir -p "${run_dir}"

# Copy scenario files for verify.sh
scenario_subdir="${run_dir}/${SCENARIO}"
mkdir -p "${scenario_subdir}"
cp "${SCENARIO_DIR}/criteria.json" "${scenario_subdir}/"
echo "${CONTRACT_JSON}" | jq . > "${run_dir}/contract.json"

echo ""
echo "==========================================================="
echo "  AgentVault Async Invite Flow Test"
echo "  Scenario:  ${SCENARIO}"
echo "  Purpose:   ${PURPOSE}"
echo "  Provider:  ${PROVIDER}"
echo "  Relay:     ${RELAY_URL}"
echo "  Delay:     ${OFFLINE_DELAY}s (simulated offline)"
echo "==========================================================="
echo ""

# =========================================================================
# Step 1: Alice creates invite
# =========================================================================

log_info "Step 1: Alice creates invite for Bob..."

create_body="$(jq -n \
  --argjson contract "${CONTRACT_JSON}" \
  --arg provider "${PROVIDER}" \
  '{
    to_agent_id: "bob",
    contract: $contract,
    provider: $provider,
    purpose_code: "COMPATIBILITY"
  }')"

create_resp="$(relay_curl -X POST "${RELAY_URL}/invites" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ALICE_INBOX_TOKEN}" \
  -d "${create_body}")"

invite_id="$(echo "${create_resp}" | jq -r '.invite_id')"
invite_hash="$(echo "${create_resp}" | jq -r '.contract_hash')"
invite_status="$(echo "${create_resp}" | jq -r '.status')"

assert_not_empty "invite_id returned" "${invite_id}"
assert_eq "invite status is PENDING" "${invite_status}" "PENDING"
assert_eq "invite contract hash matches" "${invite_hash}" "${CONTRACT_HASH}"

log_info "Invite created: ${invite_id}"

# =========================================================================
# Step 2: Alice checks invite detail (sender view, pre-accept)
# =========================================================================

log_info "Step 2: Alice checks invite detail (sender, pre-accept)..."

alice_detail="$(relay_curl "${RELAY_URL}/invites/${invite_id}" \
  -H "Authorization: Bearer ${ALICE_INBOX_TOKEN}")"

assert_eq "sender sees PENDING status" \
  "$(echo "${alice_detail}" | jq -r '.status')" "PENDING"
assert_eq "sender sees no session_id pre-accept" \
  "$(echo "${alice_detail}" | jq -r '.session_id // "null"')" "null"
assert_eq "sender sees no submit_token pre-accept" \
  "$(echo "${alice_detail}" | jq -r '.submit_token // "null"')" "null"

# =========================================================================
# Step 3: Deliberate offline delay (proves non-coincidence)
# =========================================================================

log_info "Step 3: Simulating Bob offline for ${OFFLINE_DELAY}s..."
sleep "${OFFLINE_DELAY}"
log_success "Offline delay complete — Bob now comes online"

# =========================================================================
# Step 4: Bob polls inbox, discovers invite
# =========================================================================

log_info "Step 4: Bob polls inbox..."

inbox_resp="$(relay_curl "${RELAY_URL}/inbox?status=PENDING" \
  -H "Authorization: Bearer ${BOB_INBOX_TOKEN}")"

inbox_count="$(echo "${inbox_resp}" | jq '.invites | length')"
assert_eq "Bob's inbox has 1 pending invite" "${inbox_count}" "1"

discovered_id="$(echo "${inbox_resp}" | jq -r '.invites[0].invite_id')"
assert_eq "discovered invite matches" "${discovered_id}" "${invite_id}"

discovered_purpose="$(echo "${inbox_resp}" | jq -r '.invites[0].purpose_code')"
assert_eq "discovered purpose is COMPATIBILITY" "${discovered_purpose}" "COMPATIBILITY"

log_info "Bob discovered invite: ${discovered_id}"

# =========================================================================
# Step 5: Bob checks invite detail (recipient view, pre-accept)
# =========================================================================

log_info "Step 5: Bob checks invite detail (recipient, pre-accept)..."

bob_detail="$(relay_curl "${RELAY_URL}/invites/${invite_id}" \
  -H "Authorization: Bearer ${BOB_INBOX_TOKEN}")"

assert_eq "recipient sees PENDING status" \
  "$(echo "${bob_detail}" | jq -r '.status')" "PENDING"
assert_eq "recipient sees from=alice" \
  "$(echo "${bob_detail}" | jq -r '.from_agent_id')" "alice"
assert_eq "recipient sees no session_id pre-accept" \
  "$(echo "${bob_detail}" | jq -r '.session_id // "null"')" "null"

# =========================================================================
# Step 6: Bob accepts invite → session created
# =========================================================================

log_info "Step 6: Bob accepts invite..."

accept_resp="$(relay_curl -X POST "${RELAY_URL}/invites/${invite_id}/accept" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${BOB_INBOX_TOKEN}" \
  -d "{\"expected_contract_hash\": \"${CONTRACT_HASH}\"}")"

session_id="$(echo "${accept_resp}" | jq -r '.session_id')"
bob_submit_token="$(echo "${accept_resp}" | jq -r '.responder_submit_token')"
bob_read_token="$(echo "${accept_resp}" | jq -r '.responder_read_token')"
accept_invite_hash="$(echo "${accept_resp}" | jq -r '.contract_hash')"

assert_not_empty "session_id from accept" "${session_id}"
assert_not_empty "responder_submit_token from accept" "${bob_submit_token}"
assert_not_empty "responder_read_token from accept" "${bob_read_token}"
assert_eq "accept contract hash matches" "${accept_invite_hash}" "${CONTRACT_HASH}"

log_info "Session created via accept: ${session_id}"

# =========================================================================
# Step 7: Verify post-accept invite status (both parties)
# =========================================================================

log_info "Step 7: Verifying post-accept invite status..."

# Alice (sender) polls invite detail — should see ACCEPTED + initiator tokens
alice_post="$(relay_curl "${RELAY_URL}/invites/${invite_id}" \
  -H "Authorization: Bearer ${ALICE_INBOX_TOKEN}")"

assert_eq "sender sees ACCEPTED" \
  "$(echo "${alice_post}" | jq -r '.status')" "ACCEPTED"
assert_eq "sender sees session_id" \
  "$(echo "${alice_post}" | jq -r '.session_id')" "${session_id}"
assert_not_empty "sender has submit_token" \
  "$(echo "${alice_post}" | jq -r '.submit_token')"
assert_not_empty "sender has read_token" \
  "$(echo "${alice_post}" | jq -r '.read_token')"

alice_submit_token="$(echo "${alice_post}" | jq -r '.submit_token')"
alice_read_token="$(echo "${alice_post}" | jq -r '.read_token')"

# Token isolation: sender and recipient tokens must be different
assert_not_empty "alice submit != bob submit (different roles)" "$(
  if [[ "${alice_submit_token}" != "${bob_submit_token}" ]]; then echo "different"; else echo ""; fi
)"

# Bob (recipient) polls invite detail — should see ACCEPTED + responder tokens
bob_post="$(relay_curl "${RELAY_URL}/invites/${invite_id}" \
  -H "Authorization: Bearer ${BOB_INBOX_TOKEN}")"

assert_eq "recipient sees ACCEPTED" \
  "$(echo "${bob_post}" | jq -r '.status')" "ACCEPTED"
assert_eq "recipient sees same session_id" \
  "$(echo "${bob_post}" | jq -r '.session_id')" "${session_id}"

# =========================================================================
# Step 8: Submit inputs to session (via session tokens from invite)
# =========================================================================

log_info "Step 8: Submitting inputs to session..."

alice_context="$(cat "${SCENARIO_DIR}/alice_relay_input.json")"
bob_context="$(cat "${SCENARIO_DIR}/bob_relay_input_s1.json")"

# Alice submits input using initiator tokens from invite detail
alice_input_body="$(jq -n --argjson ctx "${alice_context}" \
  '{role: "alice", context: $ctx}')"

alice_input_resp="$(relay_curl -X POST "${RELAY_URL}/sessions/${session_id}/input" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${alice_submit_token}" \
  -d "${alice_input_body}")"
log_info "Alice input submitted: $(echo "${alice_input_resp}" | jq -r '.state')"

# Bob submits input using responder tokens from accept response
bob_input_body="$(jq -n --argjson ctx "${bob_context}" --arg hash "${CONTRACT_HASH}" \
  '{role: "bob", context: $ctx, expected_contract_hash: $hash}')"

bob_input_resp="$(relay_curl -X POST "${RELAY_URL}/sessions/${session_id}/input" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${bob_submit_token}" \
  -d "${bob_input_body}")"
log_info "Bob input submitted: $(echo "${bob_input_resp}" | jq -r '.state')"

# =========================================================================
# Step 9: Poll for output
# =========================================================================

log_info "Step 9: Polling for output (timeout 120s)..."

elapsed=0
timeout=120
poll_count=0
output_resp=""
current_state=""

while (( elapsed < timeout )); do
  output_resp="$(curl -s "${RELAY_URL}/sessions/${session_id}/output" \
    -H "Authorization: Bearer ${alice_read_token}")"
  current_state="$(echo "${output_resp}" | jq -r '.state')"
  poll_count=$(( poll_count + 1 ))

  if [[ "${current_state}" == "COMPLETED" || "${current_state}" == "ABORTED" ]]; then
    break
  fi

  sleep 2
  elapsed=$(( elapsed + 2 ))
done

if [[ "${current_state}" == "COMPLETED" ]]; then
  log_success "Session COMPLETED (${poll_count} polls, ~${elapsed}s)"
elif [[ "${current_state}" == "ABORTED" ]]; then
  abort_reason="$(echo "${output_resp}" | jq -r '.abort_reason // "unknown"')"
  log_error "Session ABORTED: ${abort_reason}"
else
  log_error "Session timed out in state: ${current_state}"
fi

assert_eq "session completed" "${current_state}" "COMPLETED"

# =========================================================================
# Step 10: Write output files and run verification
# =========================================================================

log_info "Step 10: Saving output and running verification..."

echo "${output_resp}" | jq . > "${run_dir}/alice_output.json"
cp "${run_dir}/alice_output.json" "${run_dir}/bob_output.json"

# Verify receipt present
has_receipt="$(echo "${output_resp}" | jq 'has("receipt")')"
assert_eq "output has receipt" "${has_receipt}" "true"

has_signature="$(echo "${output_resp}" | jq 'has("receipt_signature")')"
assert_eq "output has receipt_signature" "${has_signature}" "true"

# Run verify.sh for standard privacy/structural checks
log_info "Running verify.sh..."
verify_exit=0
"${SCRIPT_DIR}/verify.sh" "${run_id}" --session "${session_id}" --read-token "${alice_read_token}" || verify_exit=$?

# =========================================================================
# Step 11: Verify idempotent re-accept
# =========================================================================

log_info "Step 11: Verifying idempotent re-accept..."

reaccept_resp="$(relay_curl -X POST "${RELAY_URL}/invites/${invite_id}/accept" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${BOB_INBOX_TOKEN}" \
  -d "{\"expected_contract_hash\": \"${CONTRACT_HASH}\"}")"

reaccept_session="$(echo "${reaccept_resp}" | jq -r '.session_id')"
assert_eq "re-accept returns same session_id" "${reaccept_session}" "${session_id}"

# =========================================================================
# Summary
# =========================================================================

echo ""
echo "==========================================================="
echo "  Async Invite Flow Test Results"
echo "  Checks: ${CHECKS_PASSED} passed, ${CHECKS_FAILED} failed (${TOTAL_CHECKS} total)"
echo "  Verify: $(if [[ ${verify_exit} -eq 0 ]]; then echo "PASSED"; else echo "FAILED"; fi)"
echo "  Invite: ${invite_id}"
echo "  Session: ${session_id}"
echo "==========================================================="
echo ""

if [[ ${CHECKS_FAILED} -gt 0 || ${verify_exit} -ne 0 ]]; then
  exit 1
fi
