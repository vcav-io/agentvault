#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# stability.sh — Paraphrase stability evaluator for AgentVault relay sessions
#
# Runs drive.sh --variant all for a scenario, then compares v2 enum fields
# across variant outputs to measure surface-rephrasing stability.
#
# Usage:
#   ./tests/live/stability.sh --scenario 03-stac-compatibility --provider anthropic
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="${SCRIPT_DIR}/harness"
RESULTS_BASE="${SCRIPT_DIR}/results"

# shellcheck source=harness/lib.sh
source "${HARNESS_DIR}/lib.sh"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

SCENARIO=""
PROVIDER="anthropic"
RELAY_URL="http://localhost:3100"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)   SCENARIO="${2:-}";   shift 2 ;;
    --provider)   PROVIDER="${2:-}";   shift 2 ;;
    --relay-url)  RELAY_URL="${2:-}";  shift 2 ;;
    *)
      log_error "Unknown argument: $1"
      echo "Usage: $0 --scenario <name> [--provider anthropic|openai] [--relay-url URL]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${SCENARIO}" ]]; then
  log_error "Missing required --scenario flag"
  exit 1
fi

require_cmd node

# ---------------------------------------------------------------------------
# Step 1: Run drive.sh with --variant all
# ---------------------------------------------------------------------------

log_info "Running drive.sh --variant all --scenario ${SCENARIO} --provider ${PROVIDER}"

drive_output=""
drive_output="$("${SCRIPT_DIR}/drive.sh" \
  --scenario "${SCENARIO}" \
  --provider "${PROVIDER}" \
  --relay-url "${RELAY_URL}" \
  --no-relay \
  --variant all 2>&1)" || {
  log_error "drive.sh failed. Output:"
  echo "${drive_output}"
  exit 1
}

echo "${drive_output}"

# ---------------------------------------------------------------------------
# Step 2: Find the most recent variant run directory
# ---------------------------------------------------------------------------

# The variant run creates results/<run_id>/variant_<name>/ directories.
# Find the most recent run_id that has variant subdirs.
LATEST_RUN_DIR=""
for d in "${RESULTS_BASE}"/*/; do
  [[ -d "${d}" ]] || continue
  # Check if it has variant subdirectories
  has_variants=false
  for vd in "${d}"variant_*/; do
    [[ -d "${vd}" ]] && has_variants=true && break
  done
  if [[ "${has_variants}" == "true" ]]; then
    LATEST_RUN_DIR="${d%/}"
  fi
done

if [[ -z "${LATEST_RUN_DIR}" ]]; then
  log_error "No variant run directory found in ${RESULTS_BASE}/"
  exit 1
fi

log_info "Analysing variant outputs in: ${LATEST_RUN_DIR}"

# ---------------------------------------------------------------------------
# Step 3: Write inline Node.js evaluator
# ---------------------------------------------------------------------------

EVALUATOR_SCRIPT="${LATEST_RUN_DIR}/_stability_evaluator.mjs"

cat >"${EVALUATOR_SCRIPT}" <<'EVALMJS'
import fs from 'fs';
import path from 'path';

const [runDir] = process.argv.slice(2);
if (!runDir) {
  console.error('Usage: node _stability_evaluator.mjs <run_dir>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Collect variant outputs
// ---------------------------------------------------------------------------

const variantDirs = fs.readdirSync(runDir)
  .filter(d => d.startsWith('variant_') && fs.statSync(path.join(runDir, d)).isDirectory())
  .sort();

if (variantDirs.length < 2) {
  console.error(`Need at least 2 variants, found ${variantDirs.length}`);
  process.exit(1);
}

const variants = [];
for (const vdir of variantDirs) {
  const variantName = vdir.replace(/^variant_/, '');
  const bobOutput = path.join(runDir, vdir, 'bob_output.json');
  if (!fs.existsSync(bobOutput)) {
    console.error(`Missing: ${bobOutput}`);
    continue;
  }
  const data = JSON.parse(fs.readFileSync(bobOutput, 'utf8'));
  const output = data.output ?? data;
  variants.push({ name: variantName, output });
}

if (variants.length < 2) {
  console.error(`Only ${variants.length} valid variant(s) found — need at least 2`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Field tiers
// ---------------------------------------------------------------------------

const HIGH_SIGNAL = ['thesis_fit', 'confidence', 'compatibility_signal'];
const SUPPORTING  = ['size_fit', 'stage_fit', 'next_step'];
const AGGREGATE   = ['primary_reasons', 'blocking_reasons'];

// ---------------------------------------------------------------------------
// Compute per-field agreement
// ---------------------------------------------------------------------------

function computeAgreement(fieldName, variants) {
  const values = variants.map(v => {
    const val = v.output[fieldName];
    if (Array.isArray(val)) return JSON.stringify(val.sort());
    return String(val ?? 'null');
  });

  // Mode: most common value
  const counts = {};
  for (const v of values) {
    counts[v] = (counts[v] || 0) + 1;
  }
  const mode = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const agreementRate = mode[1] / values.length;

  return {
    field: fieldName,
    values: variants.map((v, i) => ({ variant: v.name, value: values[i] })),
    mode: mode[0],
    mode_count: mode[1],
    total: values.length,
    agreement_rate: agreementRate,
  };
}

const fieldResults = {};

for (const field of [...HIGH_SIGNAL, ...SUPPORTING, ...AGGREGATE]) {
  fieldResults[field] = computeAgreement(field, variants);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const highSignalAgree = HIGH_SIGNAL.every(f => fieldResults[f].agreement_rate === 1.0);
const verdict = highSignalAgree ? 'STABLE' : 'UNSTABLE';

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const report = {
  run_dir: runDir,
  variant_count: variants.length,
  variants: variants.map(v => v.name),
  verdict,
  high_signal_all_agree: highSignalAgree,
  field_results: fieldResults,
};

const reportJsonPath = path.join(runDir, 'stability_report.json');
fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2) + '\n');

// Markdown report
let md = `# Paraphrase Stability Report\n\n`;
md += `**Verdict: ${verdict}**\n\n`;
md += `Variants tested: ${variants.length} (${variants.map(v => v.name).join(', ')})\n\n`;
md += `## High-Signal Fields\n\n`;
md += `| Field | Agreement | Mode | Values |\n`;
md += `|-------|-----------|------|--------|\n`;
for (const f of HIGH_SIGNAL) {
  const r = fieldResults[f];
  const vals = r.values.map(v => `${v.variant}=${v.value}`).join(', ');
  md += `| ${f} | ${(r.agreement_rate * 100).toFixed(0)}% | ${r.mode} | ${vals} |\n`;
}
md += `\n## Supporting Fields\n\n`;
md += `| Field | Agreement | Mode | Values |\n`;
md += `|-------|-----------|------|--------|\n`;
for (const f of SUPPORTING) {
  const r = fieldResults[f];
  const vals = r.values.map(v => `${v.variant}=${v.value}`).join(', ');
  md += `| ${f} | ${(r.agreement_rate * 100).toFixed(0)}% | ${r.mode} | ${vals} |\n`;
}
md += `\n## Aggregate Fields\n\n`;
md += `| Field | Agreement | Mode |\n`;
md += `|-------|-----------|------|\n`;
for (const f of AGGREGATE) {
  const r = fieldResults[f];
  md += `| ${f} | ${(r.agreement_rate * 100).toFixed(0)}% | ${r.mode} |\n`;
}

const reportMdPath = path.join(runDir, 'stability_report.md');
fs.writeFileSync(reportMdPath, md + '\n');

// Stdout for bash
console.log(JSON.stringify({ verdict, high_signal_all_agree: highSignalAgree, variant_count: variants.length }));
EVALMJS

# ---------------------------------------------------------------------------
# Step 4: Run the evaluator
# ---------------------------------------------------------------------------

log_info "Running stability evaluator..."

eval_output=""
eval_output="$(node "${EVALUATOR_SCRIPT}" "${LATEST_RUN_DIR}" 2>&1)" || {
  log_error "Evaluator failed. Output: ${eval_output}"
  rm -f "${EVALUATOR_SCRIPT}"
  exit 1
}

rm -f "${EVALUATOR_SCRIPT}"

# Extract verdict from last line
result_json="$(printf '%s\n' "${eval_output}" | tail -1)"
verdict="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).verdict)" -- "${result_json}" 2>/dev/null)" || verdict="UNKNOWN"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

echo ""
log_info "Reports written to: ${LATEST_RUN_DIR}"
log_info "  stability_report.json"
log_info "  stability_report.md"
echo ""

case "${verdict}" in
  STABLE)
    log_success "Verdict: STABLE — all high-signal fields agree across variants"
    ;;
  UNSTABLE)
    log_warn "Verdict: UNSTABLE — high-signal field disagreement detected"
    exit 1
    ;;
  *)
    log_error "Verdict: UNKNOWN — analysis error"
    exit 1
    ;;
esac
