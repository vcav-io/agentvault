# STATUS.md Archive

> Completed feature descriptions moved from STATUS.md to reduce clutter.

## Archived completed items (2026-03-06)

| Issue | Description | PR |
|-------|-------------|-----|
| — | TEE receipt introspection + execution environments docs | #203 |
| [#189](https://github.com/vcav-io/agentvault/issues/189) | Failure receipts — signed v2 receipts for aborted sessions | #199 |
| [#184](https://github.com/vcav-io/agentvault/issues/184) | Relay verifying key pinning in contract + VFC rev bump | #198 |
| [#150](https://github.com/vcav-io/agentvault/issues/150) | Health endpoint redacts provider/model by default | #197 |
| [#183](https://github.com/vcav-io/agentvault/issues/183) | Verifier recomputation of commitment hashes | #196 |
| [#185](https://github.com/vcav-io/agentvault/issues/185) | Clear raw inputs after inference | #195 |
| #188, #190 | v2 receipt claims: channel capacity, execution lane, session status (success path) | #191 |
| [#186](https://github.com/vcav-io/agentvault/issues/186) | Provider notes with current-gen model sweep results | — |
| [#187](https://github.com/vcav-io/agentvault/issues/187) | Red team template for schema boundary violation testing | — |
| [#179](https://github.com/vcav-io/agentvault/issues/179) | Post-PR follow-ups: README v2 updates, model defaults refresh | — |
| — | Demo UI v2 alignment: receipt v2 cards, contract enforcement, policy transparency | #180 |
| — | README rewrite as demo-UI-first on-ramp | #178 |
| [#118](https://github.com/vcav-io/agentvault/issues/118) | Rename VCAV_ env var prefix to AV_ | #177 |
| [#144](https://github.com/vcav-io/agentvault/issues/144) | Receipt verification guide | #176 |
| [#156](https://github.com/vcav-io/agentvault/issues/156) | Threat model, docs alignment, trust model updates | #175 |
| [#147](https://github.com/vcav-io/agentvault/issues/147), [#149](https://github.com/vcav-io/agentvault/issues/149), [#151](https://github.com/vcav-io/agentvault/issues/151) | Contract v2 enforcement — policy, model constraints, TTLs, entropy | #174 |
| [#155](https://github.com/vcav-io/agentvault/issues/155), [#143](https://github.com/vcav-io/agentvault/issues/143) | Receipt v2 + MCP verify_receipt | #174 |
| [#138](https://github.com/vcav-io/agentvault/issues/138) | README audit | #175 |

---

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

---

## Red Team Test Suite

**Status: Complete** (PR #13, full suite executed 2026-02-26)

Adversarial scenarios and multi-run accumulation evaluator, per `docs/plans/agent_vault_red_team_test_plan_v_1.md`.
Full results: `docs/red-team-report-2026-02-25.md`.

### Scenarios

| # | Scenario | Category | Bob Profile | Anthropic | OpenAI |
|---|----------|----------|-------------|-----------|--------|
| 04 | adversarial-extraction | A (extraction) | — | PASS | PASS |
| 05 | credential-exfiltration | A (credential) | — | PASS | PASS |
| 06 | accumulation-naive | B (cross-session) | NAIVE | PASS | PASS |
| 07 | accumulation-strategic | B (cross-session) | STRATEGIC | PASS | PASS |
| 08 | accumulation-expert | B (cross-session) | EXPERT | PASS | PASS |
| 09 | encoding-reflection | Secondary (M1) | — | PASS | PASS |
| 10 | social-engineering | Secondary (M2) | — | PASS | PASS |

20/20 runs pass with v2 all-enum schema. Per-scenario canary tokens (HELIODOR-RTXX-739).

### Scripts

- `tests/live/drive.sh` — direct HTTP experiment driver (single + multi-session)
- `tests/live/accumulate.sh` — post-experiment evaluator (canary scan, signal extraction, interval narrowing, reconstruction accuracy)

### Verification

- Tier 3 in `verify.sh` — evidence-based failure attribution (P0/M0/P1_CANARY/P1_RECONSTRUCTION), canary CI guard
- Red Team Assessment table in `report.sh`

---

## Multi-Provider Support

**Status: Implemented** (PR #18, #19)

The relay now supports both Anthropic and OpenAI providers. OpenAI is optional — configured via `OPENAI_API_KEY`, `VCAV_OPENAI_MODEL_ID` (default `gpt-4o`), and `OPENAI_BASE_URL` env vars.

- `provider/openai.rs` — OpenAI Chat Completions provider with strict schema enforcement
- `relay.rs` — match-based provider dispatch (replaces hardcoded Anthropic)
- Receipts record dynamic `model_identity` (provider + model_id) instead of hardcoded `"anthropic"`
- `drive.sh` — extracts `model_provider` and `model_id` into `run_metadata.json`, `runs.jsonl`, and experiment manifest

---

## COMPATIBILITY Schema v2

**Status: Implemented**

Replaced free-text `overlap_summary` field with orthogonal enum dimensions to eliminate
unconstrained information channel identified in red team testing.

- Output schema: `vcav_e_compatibility_signal_v2` — all fields are bounded enums or bounded arrays of enums
- Dimensions: `thesis_fit`, `size_fit`, `stage_fit`, `confidence`, `primary_reasons`, `blocking_reasons`, `next_step`
- Entropy budget: 32 bits (advisory), up from 8 bits
- New prompt program with anti-covert-encoding instructions

---

## Honest Runtime Hashing

**Status: Implemented** (Phase 1, item 4)

- `build.rs` — runs `git rev-parse HEAD` at build time, emits `VCAV_GIT_SHA` env var
- `relay.rs` — `runtime_hash` is now `SHA256(GIT_SHA)` rather than a fake version string
- `model_weights_hash` and `inference_config_hash` use honest static sentinel values

---

## RelayEnforcementPolicy (Phase 2, Phase A + B)

**Status: Implemented** (Phase A: 2026-02-26, Phase B: 2026-02-28)

`RelayEnforcementPolicy` is a first-class, content-addressed artefact. Phase B wired
the output guard to read rules from the policy config at runtime, replacing the
hardcoded digit/currency guard.

- `src/enforcement_policy.rs` — full policy engine with JCS content hashing
- `src/relay.rs` — `validate_output_enforcement_rules()` reads rules from policy config
- 28 unit tests + 12 policy gate tests

### Lockfile dev override
Missing lockfile fails closed by default. To skip in development:
set BOTH `VCAV_ENFORCEMENT_LOCKFILE_SKIP=1` AND `VCAV_ENV=dev`.

---

## Model Profile Immutability (Phase 1, item 3)

**Status: Implemented** (2026-02-26)

Lockfile (`model_profiles.lock`) pins each profile ID to its expected content hash.
The relay refuses to start if any lockfile entry's computed hash doesn't match.

---

## Async Invites & Inbox (Phase 2b, item 11)

**Status: Implemented** (PR #36, 2026-02-27)

Relay-mediated async inbox eliminating the synchrony coincidence. Alice deposits
invites while Bob is offline; Bob discovers them on next poll.

- 7 endpoints (POST /invites, GET /inbox, GET /invites/:id, POST accept/decline/cancel, GET /inbox/events SSE)
- 141 unit tests, 34 integration tests, 27 TS tests

---

## get_identity Inbox Status (PR #41, 2026-02-28)

**Status: Implemented**

`get_identity` now polls the inbox (when `RelayInboxTransport` is active) and returns
`pending_invites`, `next_action`, and `inbox_hint`.

---

## Heartbeat-Safe relay_signal (Phase 2c)

**Status: Implemented** (2026-02-28)

Refactored `relay_signal` from blocking polling loops to single-check-then-return
for OpenClaw heartbeat compatibility.

---

## Schema Content-Addressing (Wave 7)

**Status: Implemented** (AV PR #72, VFC PR #20)

Output schemas are standalone content-addressed artefacts. Receipts bind
`output_schema_hash` (JCS+SHA-256 of schema content) for offline verification.
