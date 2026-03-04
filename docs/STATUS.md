> **Note:** This file tracks internal development status and is intended for contributors. It may reference plans, experiments, or in-progress work that has not yet shipped.

# AgentVault Status

**Last Updated:** 2026-03-04

## Current Capabilities

| Component | Description | Status |
|-----------|-------------|--------|
| Relay | Bilateral API-mediated inference with Anthropic + OpenAI | Complete |
| Client | `agentvault-client` — standalone fetch-based relay client | Complete |
| MCP Server | `agentvault-mcp-server` — FSM with resume tokens, AFAL shapes | Complete |
| Inbox | Async relay-mediated invites with SSE, 7-day TTL | Complete |
| Enforcement | Content-addressed policy engine with lockfile validation | Complete |
| Schema Versioning | Content-addressed output schemas, versioning policy | Complete |
| Docker | Multi-stage Dockerfile, GHCR workflow, demo docker-compose | Complete |
| Testing | Category C driver, paraphrase stability, session metadata endpoint | Complete |
| Red Team | 7 adversarial scenarios, 20/20 pass rate, canary-guarded | Complete |
| Demo Safety | Receipt card + verify button, enforcement policy card, model profile enforcement | In PR #140 |
| Model Sweep | e2e-sweep.sh for testing provider/model combos across demo | In PR #140 |

## In-Flight PRs

| PR | Description | Status |
|----|-------------|--------|
| [#140](https://github.com/vcav-io/agentvault/pull/140) | Demo safety guarantees + model capability sweep | Needs final e2e verification after bug fixes |

### PR #140 remaining items
- OpenAI tool_call validation fix (committed but not yet e2e verified)
- Browser refresh reconnection handling (committed but not yet e2e verified)
- Both fixes need a clean run: reset → start → complete → verify signature → green checkmark

## Open Work

| Issue | Description | Size | Status |
|-------|-------------|------|--------|
| [#146](https://github.com/vcav-io/agentvault/issues/146) | Reduce demo startup friction (scripts, env, docs) | M | Ready |
| [#145](https://github.com/vcav-io/agentvault/issues/145) | Optimal model families per provider (cost/quality balance) | M | Ready |
| [#144](https://github.com/vcav-io/agentvault/issues/144) | Receipt Verification Guide for integrators | M | Ready |
| [#143](https://github.com/vcav-io/agentvault/issues/143) | `agentvault.verify_receipt` MCP tool | M | Ready |
| [#142](https://github.com/vcav-io/agentvault/issues/142) | Demo UI: make three panels equal width | S | Ready |
| [#141](https://github.com/vcav-io/agentvault/issues/141) | Demo UI: let users select provider and model | M | Ready |
| [#138](https://github.com/vcav-io/agentvault/issues/138) | README: audit How It Works steps | M | Ready |
| [#136](https://github.com/vcav-io/agentvault/issues/136) | Demo UI: missing favicon returns 404 | S | Ready |
| [#135](https://github.com/vcav-io/agentvault/issues/135) | Add red teaming mode to demo UI | L | Ready |
| [#134](https://github.com/vcav-io/agentvault/issues/134) | Allow model selection in demo UI | M | Ready |
| [#133](https://github.com/vcav-io/agentvault/issues/133) | Verify all three providers give good demo results | M | In progress (sweep script done) |
| [#81](https://github.com/vcav-io/agentvault/issues/81) | Responder read token test for metadata endpoint | S | Ready |
| [#82](https://github.com/vcav-io/agentvault/issues/82) | HTTP status checks on drive-catc.sh curls | S | Ready |
| [#83](https://github.com/vcav-io/agentvault/issues/83) | Exclude aborted sessions from timing data | S | Ready |
| [#84](https://github.com/vcav-io/agentvault/issues/84) | stability.sh verdict parsing diagnostics | S | Ready |
| [#79](https://github.com/vcav-io/agentvault/issues/79) | Wave 8 follow-up: live verification of testing tooling | M | Ready |
| [#80](https://github.com/vcav-io/agentvault/issues/80) | Pre-publication cleanup: tracked internal files | M | Ready |
| [#77](https://github.com/vcav-io/agentvault/issues/77) | README problem motivation for public launch | M | Ready |
| [#76](https://github.com/vcav-io/agentvault/issues/76) | Pre-publication: package.json metadata and CI | M | Ready |

## Completed Feature Archive

Detailed descriptions of all completed features (live test suite, red team, multi-provider,
schema v2, enforcement policy, inbox, heartbeat integration, schema content-addressing)
are in [archive/2026-03-01-status-archive.md](archive/2026-03-01-status-archive.md).
