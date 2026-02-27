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

## Multi-Provider Support

**Status: Implemented** (PR #18, #19)

The relay now supports both Anthropic and OpenAI providers. OpenAI is optional — configured via `OPENAI_API_KEY`, `VCAV_OPENAI_MODEL_ID` (default `gpt-4o`), and `OPENAI_BASE_URL` env vars.

- `provider/openai.rs` — OpenAI Chat Completions provider with strict schema enforcement
- `relay.rs` — match-based provider dispatch (replaces hardcoded Anthropic)
- Receipts record dynamic `model_identity` (provider + model_id) instead of hardcoded `"anthropic"`
- `drive.sh` — extracts `model_provider` and `model_id` into `run_metadata.json`, `runs.jsonl`, and experiment manifest

See `docs/red-team-report-2026-02-25.md` for cross-model comparison results.

## COMPATIBILITY Schema v2

**Status: Implemented**

Replaced free-text `overlap_summary` field with orthogonal enum dimensions to eliminate
unconstrained information channel identified in red team testing (see `docs/red-team-report-2026-02-25.md`).

- Output schema: `vcav_e_compatibility_signal_v2` — all fields are bounded enums or bounded arrays of enums
- Dimensions: `thesis_fit`, `size_fit`, `stage_fit`, `confidence`, `primary_reasons`, `blocking_reasons`, `next_step`
- Entropy budget: 32 bits (advisory), up from 8 bits
- New prompt program with anti-covert-encoding instructions
- `accumulate.sh` updated for v2 signal extraction and forbidden-token scanning
- `verify.sh` digit/currency regression guard scoped to string values

## Honest Runtime Hashing

**Status: Implemented** (Phase 1, item 4)

- `build.rs` — runs `git rev-parse HEAD` at build time, emits `VCAV_GIT_SHA` env var; falls back to `"unknown"` when `.git/` is absent
- `relay.rs` — `runtime_hash` is now `SHA256(GIT_SHA)` rather than a fake version string
- `model_weights_hash` and `inference_config_hash` use honest static sentinel values (`api-mediated-no-local-weights`, `api-mediated-no-local-inference`) reflecting the API-mediated nature of the relay
- Health endpoint (`GET /health`) now returns `git_sha` field
- Receipts no longer claim unverifiable runtime provenance

## RelayEnforcementPolicy (Phase 2, Phase A)

**Status: Implemented** (2026-02-26)

`RelayEnforcementPolicy` is a first-class, content-addressed artefact. The existing
hardcoded digit/currency guard is unchanged (Phase A: declared only — enforcement
wired in Phase B).

- `src/enforcement_policy.rs` — `RelayEnforcementPolicy`, `EnforcementRule`, `RuleType` (enum),
  `RuleScopeKind` (enum), `EnforcementClass` (enum), `EntropyConstraints`,
  `content_hash()` (RFC 8785 JCS), `load_enforcement_policy()`,
  `validate_enforcement_lockfile()` (fail-closed), `generate_enforcement_lockfile()`,
  `derive_required_capabilities()`, `validate_capabilities()`
- `src/error.rs` — `RelayError::EnforcementPolicy(String)` variant
- `src/lib.rs` — `AppState.enforcement_policy_hash` field
- `src/relay.rs` — `guardian_policy_hash` now uses real enforcement policy content hash
  (comment: "Phase A: declared only — enforcement wired in Phase B")
- `src/main.rs` — startup validates lockfile (fail-closed), loads policy, validates
  capabilities, logs `policy_id` + `hash`
- `prompt_programs/relay_policies/compatibility_safe_v1.json` — example policy
- `prompt_programs/relay_policies/relay_policies.lock` — committed lockfile
- `examples/gen_enforcement_lockfile.rs` — CLI: `cargo run --example gen_enforcement_lockfile -- <dir>`
- 17 unit tests covering: serde round-trip, unknown rule type rejected, example policy
  deserializes, content hash determinism, capability derivation, lockfile (valid/mismatch/
  missing-fails/dev-override/skip-without-dev), generate round-trip,
  `test_receipt_binds_declared_enforcement_hash`

### Lockfile dev override
Missing lockfile fails closed by default. To skip in development:
set BOTH `VCAV_ENFORCEMENT_LOCKFILE_SKIP=1` AND `VCAV_ENV=dev`.

### What Phase A does NOT do
- Does not change enforcement behaviour (hardcoded guard still runs independently)
- Does not read rules from policy config at runtime
- Does not enforce `model_profile_allowlist` or `provider_allowlist`

## Model Profile Immutability (Phase 1, item 3)

**Status: Implemented** (2026-02-26)

Lockfile (`model_profiles.lock`) pins each profile ID to its expected content hash.
The relay refuses to start if any lockfile entry's computed hash doesn't match.

- `validate_model_profile_lockfile(dir)` in `prompt_program.rs` — reads lockfile,
  verifies each listed profile's hash, returns hard error on mismatch, graceful Ok
  on missing lockfile (dev environments)
- `generate_model_profile_lockfile(dir)` in `prompt_program.rs` — scans `*.json`
  files, deserializes valid `ModelProfile` entries, writes lockfile
- Startup integration in `main.rs` — validates before binding to port, exits with code 1 on mismatch
- `examples/gen_lockfile.rs` — CLI helper: `cargo run --example gen_lockfile -- <dir>`
- `prompt_programs/model_profiles.lock` committed with `api-claude-sonnet-v1` hash
- 5 unit tests: valid lockfile, hash mismatch, missing lockfile, extra unlisted profile, generate round-trip

## Async Invites & Inbox (Phase 2b, item 11)

**Status: Implemented** (PR #36, 2026-02-27)

Relay-mediated async inbox eliminating the synchrony coincidence. Alice deposits
invites while Bob is offline; Bob discovers them on next poll.

- `src/inbox_types.rs` — Versioned wire types (`version: "1"`), state machine,
  caller-dependent token redaction
- `src/inbox.rs` — `InboxStore` (7-day TTL, two-phase expiry, SSE broadcast)
- `src/inbox_handlers.rs` — 7 endpoints (POST /invites, GET /inbox,
  GET /invites/:id, POST accept/decline/cancel, GET /inbox/events SSE)
- `src/agent_registry.rs` — Static agent auth (JSON file, fail-closed)
- `packages/agentvault-client/src/inbox.ts` — HTTP client functions
- `packages/agentvault-mcp-server/src/relay-inbox-transport.ts` — `RelayInboxTransport`
- `relaySignal.ts` — FSM integration for INITIATE and RESPOND modes
- `tests/live/drive-inbox.sh` — Live test with offline delay proof
- 141 unit tests, 34 integration tests, 27 TS tests

### Open

- [x] Deterministic policy gate — relay-side digit/currency guard (GATE rule, Unicode Nd/Sc categories, scoped to COMPAT v2)
- [ ] Client-side enum rendering — deterministic template converting enum tuples to human-friendly sentences
- [ ] Derivable `next_step` — make it a function of other fields rather than model-chosen
- [ ] Safe-default fallback refactor — replace `2>/dev/null || echo "safe"` with fail-safe defaults (#14)
- [ ] Paraphrase stability tooling (variant B prompts per scenario)
- [ ] Category C (meta-protocol leakage) — blocked on relay metadata observer endpoint
- [ ] CI integration for TypeScript packages
- [ ] Extract inbox protocol types to VFC — blocked on first live session (see roadmap item 11c)
- [ ] Inbox hardening: `relayFetch` timeout wrapping, `res.json()` runtime validation, mutex splitting, persistent storage
