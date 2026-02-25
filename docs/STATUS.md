# AgentVault Status

## Live Test Suite

**Status: Implemented**

The live test suite described in `docs/plans/agent_vault_live_test_suite_brief.md` has been implemented.

### Completed

- [x] MCP server: `agentvault.get_identity` tool (returns agent_id + known counterparties)
- [x] MCP server: session pointer file write (`.agentvault/last_session.json` after session create/join)
- [x] Harness infrastructure (`tests/live/harness/`):
  - `lib.sh` — shared bash functions (logging, health check, cleanup)
  - `stack.sh` — relay + provider proxy lifecycle management
  - `mock-anthropic.mjs` — schema-driven mock Anthropic API server
  - `openai-proxy.mjs` — OpenAI-to-Anthropic translation proxy
  - `provision.sh` — Ed25519 keygen + MCP config generation
  - `workspace.sh` — agent working directory setup + isolation
  - `report.sh` — JSON/MD report generation
- [x] Orchestration scripts:
  - `tests/live/prep.sh` — build, start stack, provision, print operator instructions
  - `tests/live/verify.sh` — session retrieval, Tier 1/2 privacy checks, report generation
- [x] Scenario fixtures (4 scenarios):
  - `01-cofounder-mediation` — co-founder strategy disagreement (MEDIATION)
  - `02-employment-reference` — one-way confidential reference (MEDIATION)
  - `03-stac-compatibility` — M&A compatibility check (COMPATIBILITY)
  - `04-adversarial-extraction` — adversarial extraction resistance (COMPATIBILITY, negative test)

### Pending / Extensions

- [ ] Paraphrase stability tooling (variant B prompts per scenario)
- [ ] Multi-run flake analysis (Scenario 01 x20)
- [ ] Protocol-level leakage probes
- [ ] Tier 3 semantic privacy checks (embedding-based, deferred)
- [ ] CI integration for TypeScript packages
