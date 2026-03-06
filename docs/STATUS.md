> **Note:** This file tracks internal development status and is intended for contributors. It may reference plans, experiments, or in-progress work that has not yet shipped.

# AgentVault Status

**Last Updated:** 2026-03-06

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
| agentvault | [#164](https://github.com/vcav-io/agentvault/issues/164) | Formal registries for schemas, policies, profiles, programs | L | Umbrella; #181 is concrete starting point |
| agentvault | [#181](https://github.com/vcav-io/agentvault/issues/181) | Output schema registry: content-addressed store | L | |
| agentvault | [#182](https://github.com/vcav-io/agentvault/issues/182) | Multi-policy selection in contracts | M | |
| agentvault | [#205](https://github.com/vcav-io/agentvault/issues/205) | Update README to reflect TEE lane | S | Blocked on av-tee Phase 2 |
| website | [#41](https://github.com/vcav-io/website/issues/41) | SEO Phase 4: technical authority content | L | Phases 1-3 complete; unblocked |

### Tier 2 — Important, medium-term

| Repo | Issue | Description | Size |
|------|-------|-------------|------|
| agentvault | [#154](https://github.com/vcav-io/agentvault/issues/154) | PKI / key pinning for relay verifying keys | M |
| agentvault | [#167](https://github.com/vcav-io/agentvault/issues/167) | Protocol stabilisation (meta) | L |
| av-tee | [#11](https://github.com/vcav-io/av-tee/issues/11) | Document transcript_binding field | S |
| av-tee | [#16](https://github.com/vcav-io/av-tee/issues/16) | TypeScript tee-verifier | M |
| VFC | [#15](https://github.com/vcav-io/vault-family-core/issues/15) | AFAL Agent Discovery: DNS-like resolution | L |

### Tier 3 — Backlog

| Repo | Issue | Description | Size |
|------|-------|-------------|------|
| av-tee | [#13](https://github.com/vcav-io/av-tee/issues/13) | Implement SEV-SNP CvmRuntime (real hardware) | L |
| av-tee | [#15](https://github.com/vcav-io/av-tee/issues/15) | Live transparency log for enclave measurements | L |
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
| av-tee [#14](https://github.com/vcav-io/av-tee/issues/14) | Quote verification in tee-verifier — `QuoteVerifier` trait, simulated + SNP parse-only, receipt-bound cross-checks, `is_valid()` returns true | av-tee #19, #20 |
| av-tee [#8](https://github.com/vcav-io/av-tee/issues/8), [#9](https://github.com/vcav-io/av-tee/issues/9), [#10](https://github.com/vcav-io/av-tee/issues/10) | Operational hardening — env var validation, early API key check, typed echo errors | av-tee #18 |
| av-tee [#5](https://github.com/vcav-io/av-tee/issues/5), [#6](https://github.com/vcav-io/av-tee/issues/6), [#7](https://github.com/vcav-io/av-tee/issues/7) | TEE correctness — tee_type serde, schema canonicalization, mutex poisoning | av-tee #17 |
| website [#32](https://github.com/vcav-io/website/issues/32) | Lane framing — software/confidential execution environments copy | website #52 |
| website [#40](https://github.com/vcav-io/website/issues/40) | SEO Phase 3: comparison and problem-framing articles (5 essays + delegation framing pass) | website #51 |
## Completed Feature Archive

Detailed descriptions of all completed features and older completed items are in
[archive/2026-03-01-status-archive.md](archive/2026-03-01-status-archive.md).
