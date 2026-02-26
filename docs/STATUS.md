# AgentVault Status

## Live Test Suite

**Status: Implemented**

The live test suite described in `docs/plans/agent_vault_live_test_suite_brief.md` has been implemented.

### Harness Infrastructure

- `tests/live/harness/` — lib.sh, stack.sh, mock-anthropic.mjs, openai-proxy.mjs, provision.sh, workspace.sh, report.sh
- `tests/live/prep.sh` — build, start stack, provision, print operator instructions
- `tests/live/verify.sh` — session retrieval, Tier 1/2/3 privacy + red team checks, report generation
- MCP server: `agentvault.get_identity` tool, session pointer file write

### Scenarios

| # | Scenario | Contract | Purpose |
|---|----------|----------|---------|
| 01 | cofounder-mediation | MEDIATION | Co-founder strategy disagreement |
| 02 | employment-reference | MEDIATION | One-way confidential reference |
| 03 | stac-compatibility | COMPATIBILITY | M&A compatibility check |
| 04 | adversarial-extraction | COMPATIBILITY | Adversarial extraction resistance (negative test) |

## Red Team Test Suite

**Status: Implemented** (PR #13)

Adversarial scenarios and multi-run accumulation evaluator, per `docs/plans/agent_vault_red_team_test_plan_v_1.md`.

### Scenarios

| # | Scenario | Category | Bob Profile |
|---|----------|----------|-------------|
| 05 | tool-exfiltration | A (tool-mediated) | — |
| 06 | accumulation-naive | B (cross-session) | NAIVE |
| 07 | accumulation-strategic | B (cross-session) | STRATEGIC |
| 08 | accumulation-expert | B (cross-session) | EXPERT |
| 09 | encoding-reflection | Secondary (M1) | — |
| 10 | social-engineering | Secondary (M2) | — |

### Scripts

- `tests/live/prep-multi.sh` — multi-run experiment orchestration (manifest, canary workspace audit, belief state injection)
- `tests/live/accumulate.sh` — post-experiment evaluator (canary scan, signal extraction, interval narrowing, reconstruction accuracy)

### Verification

- Tier 3 in `verify.sh` — evidence-based failure attribution (P0/M0/P1_CANARY/P1_RECONSTRUCTION), canary CI guard
- Red Team Assessment table in `report.sh`

## Multi-Provider Support

**Status: Implemented** (PR #18, #19)

The relay now supports both Anthropic and OpenAI providers. OpenAI is optional — configured via `OPENAI_API_KEY`, `VCAV_OPENAI_MODEL_ID` (default `gpt-4o`), and `OPENAI_BASE_URL` env vars.

- `provider/openai.rs` — OpenAI Chat Completions provider with strict schema enforcement
- `relay.rs` — match-based provider dispatch (replaces hardcoded Anthropic)
- Receipts record dynamic `model_identity` (provider + model_id) instead of hardcoded `"anthropic"`
- `drive.sh` — extracts `model_provider` and `model_id` into `run_metadata.json`, `runs.jsonl`, and experiment manifest

See `docs/red-team-report-2026-02-25.md` for cross-model comparison results.

### Open

- [ ] Safe-default fallback refactor — replace `2>/dev/null || echo "safe"` with fail-safe defaults (#14)
- [ ] Paraphrase stability tooling (variant B prompts per scenario)
- [ ] Category C (meta-protocol leakage) — blocked on relay metadata observer endpoint
- [ ] CI integration for TypeScript packages
