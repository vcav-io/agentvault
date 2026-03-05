> **Note:** This file tracks internal development status and is intended for contributors. It may reference plans, experiments, or in-progress work that has not yet shipped.

# AgentVault Status

**Last Updated:** 2026-03-05

## Current Capabilities

| Component | Description | Status |
|-----------|-------------|--------|
| Relay | Bilateral API-mediated inference with Anthropic + OpenAI + Gemini | Complete |
| Client | `agentvault-client` — standalone fetch-based relay client | Complete |
| MCP Server | `agentvault-mcp-server` — FSM with resume tokens, AFAL shapes | Complete |
| Inbox | Async relay-mediated invites with SSE, 7-day TTL | Complete |
| Enforcement | Content-addressed policy engine with lockfile validation | Complete |
| Schema Versioning | Content-addressed output schemas, versioning policy | Complete |
| Schema Registry | Schema artefacts content-addressed; registry lookup by hash | Complete |
| Contract Enforcement | Model constraints, TTLs, entropy enforcement mode in contract | Complete |
| Docker | Multi-stage Dockerfile, GHCR workflow, demo docker-compose | Complete |
| Testing | Category C driver, paraphrase stability, session metadata endpoint | Complete |
| Red Team | 7 adversarial scenarios, 20/20 pass rate, canary-guarded | Complete |
| Demo UI | Three-panel protocol observatory with receipt v2 cards, contract enforcement display, policy transparency | Complete |
| Model Sweep | e2e-sweep.sh for testing provider/model combos across demo | Complete |
| Receipt v2 | Commitments/claims split, assurance levels, input commitment hashes, channel capacity, status, execution lane, failure receipts | Complete |
| MCP verify_receipt | `agentvault.verify_receipt` tool — v1 + v2 dispatch, shared verifier, commitment recomputation | Complete |
| Key Pinning | Contract-level relay verifying key pinning with contract validation | Complete |
| Input Privacy | Raw inputs cleared from session state after inference (success and error paths) | Complete |

## Open Work

### Active — pre-TEE stabilisation (Wave 3 remaining)

| Issue | Description | Size | Status |
|-------|-------------|------|--------|
| [#186](https://github.com/vcav-io/agentvault/issues/186) | Create docs/provider-notes.md with model sweep results | S | Ready |
| [#179](https://github.com/vcav-io/agentvault/issues/179) | Post-PR follow-ups: README review, receipt docs, STATUS.md | M | Ready |
| [#187](https://github.com/vcav-io/agentvault/issues/187) | Red team template for schema boundary violation testing | S | Ready |

### Architecture / roadmap

| Issue | Description | Size | Status |
|-------|-------------|------|--------|
| [#181](https://github.com/vcav-io/agentvault/issues/181) | Output schema registry: extract inline schemas into content-addressed store | L | Ready |
| [#182](https://github.com/vcav-io/agentvault/issues/182) | Multi-policy selection: let contracts choose from multiple loaded policies | M | Ready |
| [#167](https://github.com/vcav-io/agentvault/issues/167) | Protocol stabilisation (meta) | L | Tracking |

### Website

| Issue | Description | Size | Status |
|-------|-------------|------|--------|
| [#157](https://github.com/vcav-io/agentvault/issues/157) | Website: link demo UI onboarding docs under simulation | S | Ready |
| [#158](https://github.com/vcav-io/agentvault/issues/158) | Website: fix double logo on mobile | S | Ready |

### Backlog (lower priority)

| Issue | Description | Size |
|-------|-------------|------|
| [#166](https://github.com/vcav-io/agentvault/issues/166) | Custom contract builder + SAFE/RICH variants | L |
| [#165](https://github.com/vcav-io/agentvault/issues/165) | Extended accumulation experiment N=20-100 | M |
| [#164](https://github.com/vcav-io/agentvault/issues/164) | Formal registries for schemas, policies, profiles, programs | L |
| [#163](https://github.com/vcav-io/agentvault/issues/163) | Extract inbox protocol types to VFC | S |
| [#162](https://github.com/vcav-io/agentvault/issues/162) | Inbox hardening: timeouts, validation, persistence | M |
| [#161](https://github.com/vcav-io/agentvault/issues/161) | First live async invite session | M |
| [#79](https://github.com/vcav-io/agentvault/issues/79) | Wave 8 follow-up: live verification of testing tooling | M |

## Recently Completed

| Issue | Description | PR |
|-------|-------------|-----|
| [#189](https://github.com/vcav-io/agentvault/issues/189) | Failure receipts — signed v2 receipts for aborted sessions | #199 |
| [#184](https://github.com/vcav-io/agentvault/issues/184) | Relay verifying key pinning in contract + VFC rev bump | #198 |
| [#150](https://github.com/vcav-io/agentvault/issues/150) | Health endpoint redacts provider/model by default | #197 |
| [#183](https://github.com/vcav-io/agentvault/issues/183) | Verifier recomputation of commitment hashes | #196 |
| [#185](https://github.com/vcav-io/agentvault/issues/185) | Clear raw inputs after inference | #195 |
| #188, #190 | v2 receipt claims: channel capacity, execution lane, session status (success path) | #191 |
| — | Demo UI v2 alignment: receipt v2 cards, contract enforcement, policy transparency | #180 |
| — | README rewrite as demo-UI-first on-ramp | #178 |
| [#118](https://github.com/vcav-io/agentvault/issues/118) | Rename VCAV_ env var prefix to AV_ | #177 |
| [#144](https://github.com/vcav-io/agentvault/issues/144) | Receipt verification guide | #176 |
| [#156](https://github.com/vcav-io/agentvault/issues/156) | Threat model, docs alignment, trust model updates | #175 |
| [#147](https://github.com/vcav-io/agentvault/issues/147), [#149](https://github.com/vcav-io/agentvault/issues/149), [#151](https://github.com/vcav-io/agentvault/issues/151) | Contract v2 enforcement — policy, model constraints, TTLs, entropy | #174 |
| [#155](https://github.com/vcav-io/agentvault/issues/155), [#143](https://github.com/vcav-io/agentvault/issues/143) | Receipt v2 + MCP verify_receipt | #174 |
| [#138](https://github.com/vcav-io/agentvault/issues/138) | README audit | #175 |

## Completed Feature Archive

Detailed descriptions of all completed features (live test suite, red team, multi-provider,
schema v2, enforcement policy, inbox, heartbeat integration, schema content-addressing)
are in [archive/2026-03-01-status-archive.md](archive/2026-03-01-status-archive.md).
