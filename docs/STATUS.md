> **Note:** This file tracks internal development status and is intended for contributors. It may reference plans, experiments, or in-progress work that has not yet shipped.

# AgentVault Status

**Last Updated:** 2026-03-07

## Current Capabilities

| Component | Description | Status |
|-----------|-------------|--------|
| Relay | Bilateral API-mediated inference with Anthropic + OpenAI + Gemini | Complete |
| Client | `agentvault-client` — standalone fetch-based relay client | Complete |
| MCP Server | `agentvault-mcp-server` — FSM with resume tokens, AFAL shapes | Complete |
| Inbox | Async relay-mediated invites with SSE, 7-day TTL | Complete |
| Enforcement | Content-addressed policy engine with lockfile validation, multi-policy selection | Complete |
| Schema Versioning | Content-addressed output schemas, versioning policy | Complete |
| Schema Registry | Schema artefacts content-addressed; registry lookup by hash, hash-only contract refs | Complete |
| Contract Enforcement | Model constraints, TTLs, entropy enforcement mode in contract | Complete |
| Docker | Multi-stage Dockerfile, GHCR workflow, demo docker-compose | Complete |
| Testing | Category C driver, paraphrase stability, session metadata endpoint | Complete |
| Red Team | 8 adversarial scenarios (incl. schema boundary), 20/20 pass rate, canary-guarded | Complete |
| Demo UI | Three-panel protocol observatory with receipt v2 cards, contract enforcement display, policy transparency | Complete |
| Model Sweep | e2e-sweep.sh for testing provider/model combos across demo | Complete |
| Receipt v2 | Commitments/claims split, assurance levels, input commitment hashes, channel capacity, status, execution lane, failure receipts | Complete |
| MCP verify_receipt | `agentvault.verify_receipt` tool — v1 + v2 dispatch, shared verifier, commitment recomputation | Complete |
| Key Pinning | Contract-level relay verifying key pinning with contract validation | Complete |
| Input Privacy | Raw inputs cleared from session state after inference (success and error paths) | Complete |
| TEE Receipt Introspection | `verify_receipt` surfaces `tee_info` from v2 TEE receipts (tee_type, measurement, attestation_hash, transcript_hash) | Complete |
| Execution Environments | Two-lane framing (standard vs confidential), trust model table, limitations docs | Complete |

## Open Work — Prioritised Cross-Repo Backlog

### Tier 1 — High-value, next up

| Repo | Issue | Description | Size | Notes |
|------|-------|-------------|------|-------|
| agentvault | [#164](https://github.com/vcav-io/agentvault/issues/164) | Formal registries for schemas, policies, profiles, programs | L | Umbrella; #181 done, next concrete steps |
| agentvault | [#205](https://github.com/vcav-io/agentvault/issues/205) | Update README to reflect TEE lane | S | Blocked on av-tee Phase 2 |
| website | [#41](https://github.com/vcav-io/website/issues/41) | SEO Phase 4: technical authority content | L | Phases 1-3 complete; unblocked |

### Tier 2 — Important, medium-term

| Repo | Issue | Description | Size |
|------|-------|-------------|------|
| av-tee | [#8](https://github.com/vcav-io/av-tee/issues/8) | Env var parse failures silently use defaults | S |
| av-tee | [#9](https://github.com/vcav-io/av-tee/issues/9) | API key absence only detected at inference time | S |
| av-tee | [#10](https://github.com/vcav-io/av-tee/issues/10) | Echo mode collapses all errors to `()` | S |
| av-tee | [#14](https://github.com/vcav-io/av-tee/issues/14) | Implement quote verification in tee-verifier | M |
| agentvault | [#154](https://github.com/vcav-io/agentvault/issues/154) | PKI / key pinning for relay verifying keys | M |
| VFC | [#15](https://github.com/vcav-io/vault-family-core/issues/15) | AFAL Agent Discovery: DNS-like resolution | L |
| agentvault | [#167](https://github.com/vcav-io/agentvault/issues/167) | Protocol stabilisation (meta) | L |

### Tier 3 — Backlog

| Repo | Issue | Description | Size |
|------|-------|-------------|------|
| av-tee | [#13](https://github.com/vcav-io/av-tee/issues/13) | Implement SEV-SNP CvmRuntime (real hardware) | L |
| av-tee | [#11](https://github.com/vcav-io/av-tee/issues/11) | Document transcript_binding field | S |
| av-tee | [#15](https://github.com/vcav-io/av-tee/issues/15) | Live transparency log for enclave measurements | L |
| av-tee | [#16](https://github.com/vcav-io/av-tee/issues/16) | TypeScript tee-verifier | M |
| agentvault | [#166](https://github.com/vcav-io/agentvault/issues/166) | Custom contract builder + SAFE/RICH variants | L |
| agentvault | [#165](https://github.com/vcav-io/agentvault/issues/165) | Extended accumulation experiment N=20-100 | M |
| agentvault | [#162](https://github.com/vcav-io/agentvault/issues/162) | Inbox hardening: timeouts, validation, persistence | M |
| agentvault | [#163](https://github.com/vcav-io/agentvault/issues/163) | Extract inbox protocol types to VFC | S |
| agentvault | [#161](https://github.com/vcav-io/agentvault/issues/161) | First live async invite session | M |
| website | [#42](https://github.com/vcav-io/website/issues/42) | SEO Phase 5: IA and authority signals | L |
| website | [#29](https://github.com/vcav-io/website/issues/29) | Align simulation visual style with demo UI | S |
| vcav | [#770](https://github.com/vcav-io/vcav/issues/770) | Move session.run() to spawn_blocking | S |

## Recently Completed

| Issue | Description | PR |
|-------|-------------|-----|
| [#182](https://github.com/vcav-io/agentvault/issues/182), [#181](https://github.com/vcav-io/agentvault/issues/181) | Multi-policy selection + schema registry improvements (PolicyRegistry, hash-only contract refs, discovery endpoints) | #211 |
| av-tee [#14](https://github.com/vcav-io/av-tee/issues/14) | Quote verification in tee-verifier — `QuoteVerifier` trait, simulated + SNP parse-only, receipt-bound cross-checks | av-tee #19, #20 |
| av-tee [#8](https://github.com/vcav-io/av-tee/issues/8), [#9](https://github.com/vcav-io/av-tee/issues/9), [#10](https://github.com/vcav-io/av-tee/issues/10) | Operational hardening — env var validation, early API key check, typed echo errors | av-tee #18 |
| av-tee [#5](https://github.com/vcav-io/av-tee/issues/5), [#6](https://github.com/vcav-io/av-tee/issues/6), [#7](https://github.com/vcav-io/av-tee/issues/7) | TEE correctness — tee_type serde, schema canonicalization, mutex poisoning | av-tee #17 |
| website [#32](https://github.com/vcav-io/website/issues/32) | Lane framing — software/confidential execution environments copy | website #52 |
| website [#40](https://github.com/vcav-io/website/issues/40) | SEO Phase 3: comparison and problem-framing articles (5 essays + delegation framing pass) | website #51 |
| — | TEE receipt introspection + execution environments docs | #203 |
| [#186](https://github.com/vcav-io/agentvault/issues/186) | Provider notes with current-gen model sweep results | — |
| [#187](https://github.com/vcav-io/agentvault/issues/187) | Red team template for schema boundary violation testing | — |
| [#179](https://github.com/vcav-io/agentvault/issues/179) | Post-PR follow-ups: README v2 updates, model defaults refresh | — |
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
