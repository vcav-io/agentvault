# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added

- Package READMEs for `agentvault-client` and `agentvault-mcp-server`.

---

## [0.2.0] — 2026-02-26 (Phase 2A)

### Added

- **RelayEnforcementPolicy (Phase A):** `RelayEnforcementPolicy` introduced as a
  first-class, content-addressed artefact (`src/enforcement_policy.rs`). Includes
  `RuleType`, `RuleScopeKind`, and `EnforcementClass` enums; RFC 8785 JCS
  content-hashing; lockfile validation (fail-closed by default); reverse lockfile
  check; capability derivation from rules; and receipt binding
  (`guardian_policy_hash`). 28 unit tests. Example policy:
  `prompt_programs/relay_policies/compatibility_safe_v1.json`. Dev override
  requires both `VCAV_ENV=dev` and `VCAV_ENFORCEMENT_LOCKFILE_SKIP=1`.
  (PR #26)
- **OpenClaw skill and VPS runbook:** `skills/openclaw/agentvault/SKILL.md`
  documents the full INITIATE/RESPOND flow, resume loop, completion, failure,
  session state file, protocol rules, and display rules for use with the
  OpenClaw agent. `docs/guides/openclaw-vps-runbook.md` provides a VPS
  deployment checklist. (PR #25)

---

## [0.1.1] — 2026-02-26 (Phase 1)

### Added

- **All-enum COMPATIBILITY schema v2:** Removed free-text `overlap_summary`
  field identified as a covert channel. Replaced with orthogonal enum
  dimensions: `thesis_fit`, `size_fit`, `stage_fit`, `confidence`,
  `primary_reasons`, `blocking_reasons`, `next_step`. Schema ID:
  `vcav_e_compatibility_signal_v2`. `additionalProperties: false`. Entropy
  budget raised to 32 bits advisory. (PR #20)
- **Relay-side digit/currency GATE rule:** Post-schema-validation guard rejects
  output containing Unicode numeric characters (category Nd) or currency
  symbols (category Sc). Scoped to `vcav_e_compatibility_signal_v2`. Defense-in-
  depth backstop against schema regression or provider structured-output bugs.
  Constant-shape `OUTPUT_POLICY_VIOLATION` error; no offending content in logs.
  7 unit tests. (PR #22)
- **Model profile immutability:** Lockfile (`model_profiles.lock`) pins each
  profile ID to its content hash. Relay refuses to start on mismatch. Generated
  by `cargo run --example gen_lockfile -- <dir>`. (PR #24)
- **Honest runtime hashing:** `build.rs` embeds `GIT_SHA` at build time.
  `runtime_hash` in receipts is now `SHA256(GIT_SHA)`. `model_weights_hash` and
  `inference_config_hash` use sentinel values reflecting the API-mediated relay.
  Health endpoint returns `git_sha`. (PR #23)
- **OpenAI provider:** Relay now supports both Anthropic and OpenAI providers.
  Provider selected per session. Receipts record `model_identity` (provider +
  model ID) dynamically. Configured via `OPENAI_API_KEY`, `VCAV_OPENAI_MODEL_ID`
  (default `gpt-4o`), and `OPENAI_BASE_URL`. (PR #18, #19)
- **Red team test suite:** Adversarial scenarios (extraction, credential
  exfiltration, cross-session accumulation, encoding reflection, social
  engineering). 20/20 runs pass with v2 all-enum schema across Anthropic and
  OpenAI providers. `drive.sh` and `accumulate.sh` scripts. Tier 3
  evidence-based failure attribution in `verify.sh`. (PR #13, #21)
- **Live test suite harness:** `tests/live/` with `harness/`, `prep.sh`,
  `verify.sh`, and four scenarios (cofounder-mediation, employment-reference,
  stac-compatibility, adversarial-extraction). (PR #11)
- **`agentvault.get_identity` MCP tool:** Returns agent ID and known agent list
  before initiating a relay session.

### Changed

- Receipts record dynamic `model_identity` (provider + model ID) instead of a
  hardcoded `"anthropic"` string.
- COMPATIBILITY contract updated to schema v2 (`vcav_e_compatibility_signal_v2`)
  with new prompt template hash and entropy budget.

### Fixed

- Entrypoint guard now resolves npm bin symlinks correctly so `--print-config`
  is gated to direct execution only.
- Contract mismatch session state transitions handled correctly.
- AFAL session integrity fix and harness field-name corrections.

---

## [0.1.0] — 2026-02-24

Initial release. Extracted from the [vcav monorepo](https://github.com/vcav-io/vcav)
as a standalone repository.

### Added

- `agentvault-relay` 0.1.0 (Rust): stateless API-mediated relay with receipt signing
- `agentvault-client` (TypeScript): standalone fetch-based relay client
- `agentvault-mcp-server` (TypeScript): MCP server exposing `agentvault.*` tools
