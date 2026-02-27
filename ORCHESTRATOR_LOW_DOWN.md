# ORCHESTRATOR_LOW_DOWN.md

## 1) Executive Summary

- The orchestrator is the **VCAV session lifecycle API server**. It manages agent registration, inbox-based invite exchange, VCAV session creation/seal/run, SSE event streaming, receipt storage, and a runtime bridge to the vault inference engine.
- It exists because **agents need a coordination hub** to discover each other (inbox), negotiate session terms (invites with contract/model/policy hashes), and drive a sealed-runtime through the create→input→seal→run→emit state machine. Without it, there is no session orchestration.
- The orchestrator is **VCAV-specific**. Its core value — session lifecycle with guardian checks, timing enforcement, sealed-runtime delegation, contract/profile/policy registries, and receipt verification — is tightly coupled to VCAV semantics. The inbox/invite subsystem is the only part that could be argued as "shared infrastructure".
- **Recommendation: keep in vcav.** The orchestrator is ~95% VCAV-specific. Moving it would drag VCAV semantics into shared infrastructure. Instead, extract the **invite transport interface** (already done in agentVault as `InviteTransport`) and let agentVault consume the orchestrator's inbox API as an external service, not a shared library.
- agentVault already has a clean relay with its own session model. The two should remain separate: agentVault relay = stateless API-mediated inference; vcav orchestrator = stateful sealed-vault lifecycle.
- The agentVault MCP server defines an `InviteTransport` interface. The vcav-mcp-server provides an `OrchestratorClient`-backed implementation. This is the correct coupling boundary.
- AFAL (Agent Federation & Admission Layer) lives entirely in vcav. It replaces the invite flow with signed Ed25519 proposals for cross-domain federation.
- IFC (Information Flow Control) lives in vcav + vault-family-core. The orchestrator touches IFC only through labeled message delivery and agent public-key lookup for grant verification.
- The pre-split demo's implicit dependency on the orchestrator is mediated through the inbox HTTP API, not direct imports. Decoupling requires only that agentVault call the orchestrator's REST endpoints (already the case).

---

## 2) Where the Orchestrator Lives and How It Runs

### Package

| Field | Value |
|-------|-------|
| Package name | `@vcav/orchestrator` |
| Directory | `vcav/packages/vcav-orchestrator/` (inside vcav repo) |
| Language | TypeScript (Node.js) |
| Version | 0.1.0 |

### Entrypoint

**`src/index.ts`** — creates an Express app, initializes stores (SQLite or in-memory), loads registries (model tiers, mitigations), starts SSE heartbeat, listens on port 3000.

```
main() → initStores() → loadModelRegistry() → loadMitigationRegistry() → createApp() → app.listen(3000)
```

### Build & Run

```bash
npm run build          # tsc
npm run dev            # tsx watch src/index.ts
npm run start:demo     # VCAV_RUNTIME_MODE=demo node dist/index.js
npm run test           # VCAV_RUNTIME_MODE=demo vitest run
```

### Docker

| File | Notes |
|------|-------|
| `docker/Dockerfile.orchestrator` | Multi-stage: Rust binary + TS orchestrator. Final image: node:20-bookworm-slim |
| `docker/docker-compose.demo.yml` | Service `orchestrator`, port 3000:3000, SQLite at `/data/db/orchestrator.db` |
| `docker/docker-compose.sealed.yml` | Service `orchestrator`, port 3300:3000, `VCAV_RUNTIME_MODE=sealed` |

### Runtime Dependencies

| Dependency | Purpose |
|------------|---------|
| SQLite (better-sqlite3) | Agent store, invite store, session store, receipt store, audit log, labeled messages |
| Filesystem | Receipt directory (`VCAV_RECEIPT_DIR`), prompt programs, model profiles |
| vault-runtime-server (Rust binary) | Sealed-mode inference (spawned or connected via URL) |
| Environment vars | See config section below |

### Key Environment Variables

| Var | Default | Notes |
|-----|---------|-------|
| `VCAV_RUNTIME_MODE` | (required) | `demo` or `sealed` |
| `VAULT_RUNTIME_URL` | null | Required for sealed mode |
| `VAULT_RUNTIME_BEARER_TOKEN` | null | Required for sealed mode |
| `API_KEYS` | `dev-api-key` | Comma-separated; must be explicit in sealed mode |
| `VCAV_STORAGE_MODE` | `memory` | `memory` or `sqlite` |
| `VCAV_DB_PATH` | `./data/db/orchestrator.db` | SQLite path |
| `VCAV_AUTH_MODE` | `dual` | `api_key`, `ed25519`, or `dual` |
| `VCAV_REGISTRATION_TOKEN` | null | Optional gate for agent registration |
| `PORT` | 3000 | |

### External Endpoints (Complete Route Map)

**Root router (`/`):**
| Method | Path | Handler |
|--------|------|---------|
| GET | `/health` | Health check (no auth) |
| POST | `/sessions` | Create session |
| POST | `/sessions/:id/inputs` | Submit participant input |
| POST | `/sessions/:id/seal` | Seal session |
| POST | `/sessions/:id/run` | Start vault execution |
| GET | `/sessions/:id` | Get session state |
| GET | `/sessions/:id/events` | SSE stream for session events |
| GET/POST | `/receipts/*` | Receipt CRUD |
| GET/POST | `/keyring/*` | Key ring operations |
| GET/POST | `/budgets/*` | Budget tracking |

**Inbox router (`/inbox`):**
| Method | Path | Handler |
|--------|------|---------|
| POST | `/inbox/invite` | Create invite |
| GET | `/inbox` | Get pending invites for authenticated agent |
| GET | `/inbox/events` | SSE stream for inbox events |
| GET | `/inbox/:id` | Get invite status |
| POST | `/inbox/:id/accept` | Accept invite |
| POST | `/inbox/:id/reject` | Reject invite |

**Agent router (`/agents`):**
| Method | Path | Handler |
|--------|------|---------|
| POST | `/agents/register` | Register agent (optional token gate) |
| GET | `/agents` | List agents |
| GET | `/agents/:id/public-key` | Get agent's Ed25519 public key |
| POST | `/agents/:id/messages` | Deliver labeled IFC message |
| GET | `/agents/:id/messages` | Fetch pending labeled messages (self-only) |
| POST | `/agents/:id/messages/ack` | Acknowledge delivery |
| POST | `/agents/:id/revoke` | Revoke agent |

**Registry routers:**
| Mount | Purpose |
|-------|---------|
| `/contracts` | Contract registry CRUD |
| `/profiles` | Model profile registry |
| `/policies` | Policy bundle registry |
| `/manifests` | Agent manifest publishing |
| `/artefacts` | Artefact storage |
| `/prompt-templates` | Prompt template registry |
| `/rollout` | Model tier registry / rollback |
| `/governance` | Mitigation registry |

**AFAL router (mounted at root):**
| Method | Path | Handler |
|--------|------|---------|
| GET | `/.well-known/agent-descriptor` | Serve local AFAL descriptor (no auth) |
| POST | `/afal/message` | Receive signed inter-agent message |

---

## 3) Protocol and Data Model

### Invite

| Field | Type | Notes |
|-------|------|-------|
| `invite_id` | 32 hex chars (UUID without dashes) | Primary key |
| `from_agent_id` | string | Sender |
| `to_agent_id` | string | Recipient |
| `template_id` | string | e.g., `dating.v1`, `mediation.v2` |
| `budget_tier` | enum | `TINY`, `SMALL`, `MEDIUM`, `LARGE` |
| `state` | enum | `PENDING` → `ACCEPTED`/`REJECTED`/`EXPIRED` |
| `expires_at` | ISO timestamp | Default TTL 5 min, max 1 hour |
| `contract_hash` | 64 hex chars | SHA-256 of JCS-canonical contract (optional) |
| `model_profile_hash` | 64 hex chars | Optional |
| `policy_bundle_hash` | 64 hex chars | Optional |
| `pre_agreement_hash` | string | Computed on accept (SHA-256 of agreement fields) |
| `session_id` | string | Set after accept triggers session creation |
| `payload_type` | string | `VCAV_E_INVITE_V1` — carries relay session tokens |
| `payload` | JSON object | `{session_id, responder_submit_token, responder_read_token, relay_url}` |

**Storage:** SQLite table (via `InboxStore` interface) or in-memory map.

**Lifecycle:**
```
PENDING ──accept──→ ACCEPTED ──(auto)──→ session_id linked
PENDING ──reject──→ REJECTED
PENDING ──timeout─→ EXPIRED
```

### Session (VCAV)

| Field | Type | Notes |
|-------|------|-------|
| `session_id` | UUID | Primary key |
| `purpose_code` | enum | `MEDIATION`, `COMPATIBILITY`, etc. |
| `participants` | array | `[{agent_id, input_submitted, input_fingerprint, input_size_bytes}]` |
| `state` | enum | `CREATED` → `SEALED` → `RUNNING` → `GATED` → `EMITTED` (or `ABORTED`/`REJECTED`) |
| `output_schema_id` | string | e.g., `vcav_e_mediation_signal_v2` |
| `template_id` | string | Links to template registry |
| `contract_hash` | string | Bound into receipt |
| `model_profile_hash` | string | Bound into receipt |
| `policy_bundle_hash` | string | Optional |
| `agreement_hash` | string | Computed from invite terms + session_id |
| `output` | JSON | Structured output from vault runtime |
| `receipt_id` | string | Receipt reference after emission |
| `budgets` | array | Budget tier + usage records |
| `guardian_checks` | array | Guardian validation results |

**Storage:** In-memory (active sessions) + SQLite (terminal/restarted sessions).

**Session State Machine:**
```
CREATED ──(all inputs)──→ SEALED ──(run)──→ RUNNING ──(guardian gate)──→ GATED ──(emit)──→ EMITTED
                                    ↓                        ↓
                                 ABORTED                  REJECTED
```

### Agent (Registered)

| Field | Type | Notes |
|-------|------|-------|
| `agent_id` | string | `[a-z0-9][a-z0-9._-]{0,127}` |
| `public_key_hex` | 64 hex chars | Ed25519 public key |
| `display_name` | string | Optional, max 256 chars |
| `status` | enum | `active` / `revoked` |
| `registered_at` | ISO timestamp | |

**Storage:** SQLite.

### Auth Model

- **API key auth:** `Authorization: Bearer <key>` checked against `API_KEYS` env var.
- **Ed25519 auth:** Request signature verification against registered agent's public key.
- **Dual mode (default):** Accepts either method.

---

## 4) AFAL: Where It Lives and What It Is

### Definition

**AFAL = Agent Federation & Admission Layer.** A signed protocol sitting above VCAV that provides:
1. Agent identity (Ed25519-signed descriptors with capability advertisements)
2. Cross-domain discovery (WebFinger, RFC 7033)
3. Admission gating (PROPOSE/ADMIT/COMMIT replacing flat invite flow)
4. Optional plain messaging (pre-escalation dialogue without vault guarantees)

### Files Containing AFAL

**Specification & Design (vcav repo):**
- `docs/plans/2026-02-11-afal-agent-federation-admission-layer.md` — Implementation draft (462 lines)
- `docs/spec/afal-binding-spec-v1.md` — Normative specification v1.0.0

**Schema:**
- `vcav/schemas/afal_agent_descriptor.schema.json` — JSON Schema for agent descriptors

**Orchestrator Implementation (`vcav/packages/vcav-orchestrator/src/afal/`):**
- `descriptor.ts` — Descriptor validation, signing, verification
- `signing.ts` — Domain-separated signing with DOMAIN_PREFIXES
- `propose.ts` — PROPOSE message handling
- `admit.ts` — ADMIT token generation and verification
- `commit.ts` — COMMIT phase validation
- `messageHandler.ts` — Plain MESSAGE protocol
- `webfinger.ts` — WebFinger (RFC 7033) agent discovery
- `admission.ts` — Admission policy engine with trust tiers
- `replay.ts` — Replay attack protection
- `cache.ts` — Descriptor caching

**Orchestrator Routes (`src/server/afalRoutes.ts`):**
- `GET /.well-known/agent-descriptor` — Serves local descriptor (public, no auth)
- `POST /afal/message` — Receives signed inter-agent MESSAGE

**MCP Server Tools (`vcav/packages/vcav-mcp-server/src/tools/agent/`):**
- `afalPropose.ts` — `vcav.afal_propose`
- `afalCommit.ts` — `vcav.afal_commit`
- `afalSendMessage.ts` — `vcav.afal_send_message`
- `afalGetDescriptor.ts` — `vcav.afal_get_descriptor`
- `afalResolveAgent.ts` — `vcav.afal_resolve_agent`
- `afalFederatedPropose.ts` — `vcav.afal_federated_propose`
- `afalFederationStatus.ts` — `vcav.afal_federation_status`

**Tests:** Full suite in `src/afal/__tests__/` (14 test files including federation-e2e, red-team, cross-domain signing).

**agentVault References (this repo):**
- `packages/agentvault-client/src/index.ts:4` — Comment: "No imports from orchestrator, AFAL..."
- `packages/agentvault-client/src/http.ts:4` — Same boundary comment
- `packages/agentvault-mcp-server/src/tools/relaySignal.ts:411-413` — AFAL invite carries VCAV contract hash context

### AFAL Invite Flow (Sequence Diagram)

```
Agent A                          Orchestrator                       Agent B
   │                                  │                                │
   │  1. POST /agents/register        │                                │
   │  (agent_id, public_key_hex)      │                                │
   │─────────────────────────────────→│                                │
   │                                  │                                │
   │  2. POST /inbox/invite           │                                │
   │  {to: agentB, template_id,      │                                │
   │   budget_tier, contract_hash}    │                                │
   │─────────────────────────────────→│  3. SSE: INVITE_RECEIVED       │
   │                                  │───────────────────────────────→│
   │                                  │                                │
   │                                  │  4. GET /inbox                 │
   │                                  │←───────────────────────────────│
   │                                  │  (authoritative state)         │
   │                                  │───────────────────────────────→│
   │                                  │                                │
   │                                  │  5. POST /inbox/:id/accept     │
   │                                  │←───────────────────────────────│
   │                                  │                                │
   │  6. SSE: INVITE_RESOLVED         │  6. SSE: INVITE_RESOLVED       │
   │←─────────────────────────────────│───────────────────────────────→│
   │  (no outcome in SSE!)            │  (no outcome in SSE!)          │
   │                                  │                                │
   │  7. GET /inbox/:id               │  7. GET /inbox/:id             │
   │  (authoritative: outcome,        │  (authoritative: outcome,      │
   │   session_id, pre_agreement_hash)│   session_id)                  │
   │─────────────────────────────────→│←───────────────────────────────│
   │                                  │                                │
   │  8. SSE: HANDOFF_CREATED         │  8. SSE: HANDOFF_CREATED       │
   │  (50-150ms delay for timing      │  (timing normalization)        │
   │   normalization)                 │                                │
   │←─────────────────────────────────│───────────────────────────────→│
```

**Key design:**
- SSE events are **wake-ups only** — they tell the client "something changed" but do NOT include the outcome (accept/reject).
- The **authoritative state** is always obtained via `GET /inbox/:id`. This prevents SSE message ordering from leaking accept/reject decisions.
- `INVITE_RESOLVED` is sent to **both** sender and recipient with identical structure regardless of outcome.
- `HANDOFF_CREATED` is emitted with a **50-150ms random delay** after accept to prevent timing correlation.

### AFAL Federation (PROPOSE/ADMIT/COMMIT)

This is the next-gen protocol **replacing** the inbox invite flow for cross-domain scenarios:

```
Agent A                    A's Gateway              B's Gateway              Agent B
   │                          │                         │                      │
   │  vcav.afal_resolve_agent │                         │                      │
   │  (acct:bob@example.com) │                         │                      │
   │─────────────────────────→│  WebFinger lookup       │                      │
   │                          │────────────────────────→│                      │
   │                          │  agent-descriptor URL   │                      │
   │                          │←────────────────────────│                      │
   │                          │  GET /.well-known/      │                      │
   │                          │  agent-descriptor       │                      │
   │                          │────────────────────────→│                      │
   │                          │  Descriptor + Ed25519   │                      │
   │                          │←────────────────────────│                      │
   │                          │                         │                      │
   │  vcav.afal_propose       │                         │                      │
   │  (signed PROPOSE msg)    │  POST /afal/propose     │                      │
   │─────────────────────────→│────────────────────────→│  evaluate admission  │
   │                          │                         │  policy (trust tier)  │
   │                          │  ADMIT token (or DENY)  │                      │
   │                          │←────────────────────────│                      │
   │                          │                         │                      │
   │  vcav.afal_commit        │                         │                      │
   │  (signed COMMIT +        │  POST /afal/commit      │                      │
   │   admit_token)           │────────────────────────→│  verify + establish  │
   │─────────────────────────→│                         │  session             │
   │                          │                         │                      │
```

### Transport vs Vault Semantics

| Piece | Classification | Notes |
|-------|---------------|-------|
| Inbox (invite CRUD + SSE) | **Transport** | Agent rendezvous, no confidentiality guarantees |
| AFAL descriptor/signing/replay | **Transport** | Identity + integrity, no vault semantics |
| AFAL admission policy engine | **Vault-adjacent** | Trust tiers map to VCAV budget tiers |
| Session create/seal/run/emit | **Vault semantics** | Core VCAV state machine |
| Contract/profile/policy registries | **Vault semantics** | VCAV-specific governance |
| Labeled message delivery | **Vault semantics (IFC)** | Carries IFC envelopes |

---

## 5) IFC: Where It Lives and How It Interacts

### Overview

IFC = Information Flow Control, based on DIFC (Decentralized IFC) principles from FIDES (Microsoft Research, arxiv.org/abs/2505.23643). The system adds security labels to data and enforces flow policies.

### Where IFC Is Implemented

#### vault-family-core (shared library, git dependency)

| Crate | Purpose | Files |
|-------|---------|-------|
| `ifc-engine` | Label algebra, policy evaluation, deterministic hashing, WASM runtime | Rust crate |
| `message-envelope` | Ed25519-signed labeled message protocol | Rust crate |
| `receipt-core` | IFC field integration in signed receipts | Rust crate |

#### vcav repo — TypeScript Types (`vcav/packages/agent-sdk/src/types.ts`)

```typescript
interface IfcLabel {
  confidentiality: string[] | null;        // Set of principals who may see data
  integrity: 'TRUSTED' | 'UNTRUSTED';     // Integrity level
  type_tag: IfcTypeTag;                    // Information capacity bound
}

type IfcTypeTag =
  | { kind: 'Bot' }       // No information
  | { kind: 'Bool' }      // 1 bit
  | { kind: 'Enum'; value: number }  // log2(N) bits
  | { kind: 'String' }    // Unbounded
  | { kind: 'Top' };      // Maximum
```

#### vcav repo — WASM Runtime Integration (`vcav/packages/vault-runtime/src/session.rs`)

- Feature-gated behind `#[cfg(feature = "ifc")]`
- Maps VCAV Purpose codes to IFC Purpose enum
- Computes compartment_id from confidentiality set for budget partitioning
- Charges budget to appropriate label compartment

#### vcav repo — MCP Server Tools (`vcav/packages/vcav-mcp-server/src/tools/agent/ifc*.ts`)

| Tool | Purpose | Enforcer |
|------|---------|----------|
| `ifc_label_data` | Attach security label to data | WASM runtime |
| `ifc_send_labeled_message` | Send labeled message via AFAL | WASM runtime + policy engine |
| `ifc_check_labeled_inbox` | Check for incoming labeled messages | WASM runtime |
| `ifc_check_send_policy` | Pre-check send policy | WASM runtime |
| `ifc_inspect_variable` | Inspect hidden variable (FIDES HIDE semantics) | WASM runtime |
| `ifc_create_grant` | Create signed IFC capability grant | WASM runtime + Ed25519 |
| `ifc_verify_grant` | Verify grant signature and issuer | WASM runtime + orchestrator key lookup |

#### vcav repo — Integration Tests

- `vcav/harnesses/e2e-tests/tests/ifc_grant_lifecycle.rs` — 7 checks
- `vcav/harnesses/e2e-tests/tests/ifc_receipt_verifier.rs`
- 46 total cross-crate IFC tests (20 Rust + 26 TypeScript)

### How the Orchestrator Touches IFC

**Directly:**

1. **Labeled message delivery** — `POST /agents/:id/messages` (`agentRoutes.ts:231-331`)
   - Accepts `application/vcav-labeled-message+json` content type
   - Stores envelope in SQLite with dedupe (SHA-256 envelope_id)
   - Rate-limited: 100 messages per recipient inbox, 50 per sender-recipient pair
   - 24-hour TTL with lazy expiration

2. **Agent public-key lookup** — `GET /agents/:id/public-key` (`agentRoutes.ts:157-181`)
   - Used by `ifc_verify_grant` to resolve issuer identity for grant signature verification

3. **Message fetch/ack** — `GET /agents/:id/messages` + `POST /agents/:id/messages/ack`
   - Self-only enforcement; agents can only read their own mailbox

**Indirectly (does NOT enforce):**

- IFC WASM runtime runs **in the agent's MCP server process**, not in the orchestrator
- Policy decisions (Block/Escalate/Allow) are **agent-local**
- The orchestrator is a **dumb pipe** for labeled messages — it stores and routes but does not inspect labels or enforce policies
- Budget compartmentalization happens in the vault runtime (Rust), not the orchestrator

### IFC Architecture: What Gets Labeled

| Entity | Labeled? | Notes |
|--------|----------|-------|
| Messages (Tier 1) | **Yes** | `(C, I, τ)` label attached to every inter-agent message |
| Vault session inputs | **Indirectly** | Compartment ID derived from confidentiality set |
| Vault session outputs | **Yes** | Output labeled with intersection of participants' confidentiality sets |
| Tools (MCP) | **No** | Tools are the enforcement mechanism, not the labeled entity |
| Sessions | **Indirectly** | Session inherits compartment from inputs' labels |
| Lanes | **No** | Lane selection (SEALED_LOCAL, SOFTWARE_LOCAL, API_MEDIATED) is separate from IFC |

### Where Enforcement Should Live (Clean Split)

| Component | Responsibility | Repo |
|-----------|---------------|------|
| Label algebra + join + hash | Shared primitive | vault-family-core (`ifc-engine`) |
| Policy evaluation (8-rule engine) | Agent-local | vault-family-core (`ifc-engine`) |
| Message envelope signing | Shared primitive | vault-family-core (`message-envelope`) |
| Labeled message routing | Orchestrator (dumb pipe) | vcav |
| Budget compartmentalization | Vault runtime | vcav |
| WASM runtime (stateful) | Agent-side MCP server | vcav |
| Grant lifecycle (sign/verify) | Agent-side + orchestrator key lookup | vcav |

**IFC enforcement is already cleanly split.** The shared primitives (labels, policy engine, envelopes) are in vault-family-core. The orchestrator's role is limited to message routing and key lookup — it does not need to understand IFC semantics.

---

## 6) Dependency and Coupling Audit

### Orchestrator's VCAV-Specific Dependencies

| Dependency | Import Source | Classification |
|------------|--------------|----------------|
| `@vcav/agent-sdk` | `file:../agent-sdk` | **C) VCAV-only.** Contains IFC types, Purpose codes, IfcLabel, CapabilityGrant. Orchestrator uses it for type definitions. |
| `sessionRegistry` | `./sessions/registry.js` | **C) VCAV-only.** Full VCAV session state machine (CREATED→SEALED→RUNNING→GATED→EMITTED). |
| `inboxRegistry` | `./inbox/registry.js` | **B) Shared candidate.** The invite/inbox pattern is generic enough to extract, but the invite carries VCAV-specific fields (contract_hash, model_profile_hash, policy_bundle_hash). |
| `resolveRuntime` / `spawner` | `./runtime/spawner.js` | **C) VCAV-only.** Manages vault-runtime-server binary lifecycle. |
| `createRuntimeSession` / `client` | `./runtime/client.js` | **C) VCAV-only.** HTTP client for vault-runtime-server. |
| `contractRegistry` | `./contracts/registry.js` | **C) VCAV-only.** VCAV contract governance. |
| `modelProfileRegistry` | `./profiles/registry.js` | **C) VCAV-only.** Model profile binding specific to VCAV. |
| `policyBundleRegistry` | `./policies/registry.js` | **C) VCAV-only.** Policy bundles are VCAV governance. |
| `promptTemplateRegistry` | `./promptTemplates/registry.js` | **C) VCAV-only.** Prompt program management. |
| `modelRegistry` (rollout) | `./rollout/modelRegistry.js` | **C) VCAV-only.** Model tier validation, promotion, rollback. |
| `mitigationRegistry` | `./governance/mitigationRegistry.js` | **C) VCAV-only.** Governance mitigations. |
| `computeAgreementHash` | `./crypto/agreementHash.js` | **C) VCAV-only.** Agreement hash links invite→session→contract. |
| `buildPreflightBundle` | `./preflight/bundle.js` | **C) VCAV-only.** Preflight verification for sealed mode. |
| `constantTrace` | `./trace/constantTrace.js` | **C) VCAV-only.** Constant-shape timing for sealed mode. |
| `eventProxy` | `./runtime/eventProxy.js` | **C) VCAV-only.** Proxies vault runtime SSE events. |
| `schemaRegistry` | `./schemaRegistry.js` | **C) VCAV-only.** Output schema resolution. |
| AFAL modules (`./afal/*`) | Internal | **B) Shared candidate → vault-family-core** long-term. AFAL is designed to be protocol-level, but current implementation is tightly integrated with the orchestrator. |
| Auth middleware | `./server/middleware/auth.js` | **A) Pure plumbing.** API key + Ed25519 dual auth. |
| SSE infrastructure | `./server/sse.js`, `./server/inboxSse.js` | **A) Pure plumbing.** Generic SSE fan-out. |
| `responsePadMiddleware` | `./server/middleware/responsePad.js` | **A) Pure plumbing.** Constant-shape response padding. |
| `headerStripMiddleware` | `./server/middleware/headerStrip.js` | **A) Pure plumbing.** Strips X-Powered-By etc. |
| `@noble/curves`, `@noble/hashes` | npm | **A) Pure plumbing.** Crypto primitives. |
| `better-sqlite3` | npm | **A) Pure plumbing.** Storage. |
| `express`, `cors`, `pino`, `uuid` | npm | **A) Pure plumbing.** |

### Summary

| Classification | Count | Examples |
|----------------|-------|---------|
| **A) Pure plumbing** | 8 | Auth, SSE, crypto, storage, middleware |
| **B) Shared candidate** | 2 | Inbox/invite pattern, AFAL (long-term) |
| **C) VCAV-only** | 15 | Sessions, runtime, contracts, profiles, policies, governance, receipts, budgets, entropy, timing |

### Module Boundary Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    vault-family-core                          │
│  ┌──────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │ receipt-core  │  │ vault-family-    │  │ ifc-engine    │  │
│  │ (receipts,    │  │ types            │  │ (labels,      │  │
│  │  signing)     │  │ (Purpose, Budget │  │  policy,      │  │
│  │              │  │  Tier, PairId)   │  │  grants)      │  │
│  └──────────────┘  └─────────────────┘  └───────────────┘  │
│  ┌──────────────────────────┐                                │
│  │ message-envelope          │                                │
│  │ (Ed25519 signed messages) │                                │
│  └──────────────────────────┘                                │
└─────────────────────────────────────────────────────────────┘
        ↑                    ↑                      ↑
        │                    │                      │
┌───────┴────────┐  ┌───────┴──────────────────────┴──────────┐
│  agentVault    │  │              vcav                         │
│  (this repo)   │  │                                          │
│ ┌────────────┐ │  │ ┌──────────────────────────────────────┐ │
│ │ relay      │ │  │ │         orchestrator                  │ │
│ │ (Rust)     │ │  │ │  ┌──────┐ ┌────────┐ ┌──────────┐  │ │
│ │ - /relay   │ │  │ │  │inbox │ │sessions│ │registries│  │ │
│ │ - /sessions│ │  │ │  │invite│ │lifecycle│ │contracts │  │ │
│ │            │←┼──┼─┼──│SSE   │ │seal/run│ │profiles  │  │ │
│ └────────────┘ │  │ │  └──────┘ └────────┘ │policies  │  │ │
│ ┌────────────┐ │  │ │  ┌──────┐ ┌────────┐ │prompts   │  │ │
│ │ client     │ │  │ │  │AFAL  │ │runtime │ │rollout   │  │ │
│ │ (TS)       │ │  │ │  │descrp│ │spawner │ │governance│  │ │
│ └────────────┘ │  │ │  │admit │ │client  │ └──────────┘  │ │
│ ┌────────────┐ │  │ │  └──────┘ └────────┘               │ │
│ │ mcp-server │ │  │ │  ┌──────┐ ┌────────┐               │ │
│ │ (TS)       │ │  │ │  │agents│ │IFC msg │               │ │
│ │ - relay    │ │  │ │  │regstr│ │routing │               │ │
│ │   _signal  │ │  │ │  └──────┘ └────────┘               │ │
│ └────────────┘ │  │ └──────────────────────────────────────┘ │
│                │  │                                          │
│ InviteTransport│  │ ┌──────────────────────────────────────┐ │
│ interface ─────┼──┼→│  vcav-mcp-server                     │ │
│ (defined here, │  │ │  (provides OrchestratorClient-backed │ │
│  implemented   │  │ │   InviteTransport implementation)    │ │
│  by vcav)      │  │ └──────────────────────────────────────┘ │
└────────────────┘  └──────────────────────────────────────────┘
```

The arrow from agentVault relay to orchestrator inbox represents the **runtime dependency**: the agentVault MCP server's INITIATE/RESPOND modes call the orchestrator's inbox API via HTTP to exchange relay session tokens. This is mediated through the `InviteTransport` interface — agentVault defines it, vcav-mcp-server implements it.

---

## 7) Refactor Plan to Align with the Split (Minimal First)

### Current State

agentVault **does not import** the orchestrator. The coupling is:
1. **Runtime HTTP dependency:** agentVault's MCP server INITIATE/RESPOND modes call the orchestrator's `/inbox/*` endpoints via HTTP (mediated by `InviteTransport`).
2. **Shared vault-family-core:** Both repos depend on `receipt-core` and `vault-family-types` from vault-family-core (git dep).
3. **Invite payload convention:** agentVault's `relaySignal.ts:411-413` knows that AFAL invites carry VCAV contract hashes (a comment, not a hard import).

### What's Already Clean

- agentVault relay has **zero imports** from orchestrator, AFAL, vault-runtime, or autopilot (explicitly stated in code comments at `packages/agentvault-client/src/index.ts:4`).
- The `InviteTransport` interface is already defined in agentVault and implemented in vcav-mcp-server. This is the correct dependency direction.
- agentVault's MCP server runs standalone (CREATE/JOIN modes) without the orchestrator. INITIATE/RESPOND need an `InviteTransport` injection.

### Minimal Changes Required

#### Step 1: Remove agentVault's implicit knowledge of VCAV contract hashes

**File:** `packages/agentvault-mcp-server/src/tools/relaySignal.ts:411-413`

```typescript
// Current (VCAV-aware comment):
// The AFAL invite carries a VCAV contract hash (auto-resolved from template_id)
// which differs from the AgentVault relay contract hash

// Change to:
// When InviteTransport provides a contract_hash on the invite, use expected_purpose
// matching (template_id) rather than exact hash comparison, since the transport
// may resolve a different contract hash than the relay's built-in templates.
```

This is a **comment-only change** — the code already handles the mismatch correctly.

#### Step 2: Formalize the InviteTransport contract

The `InviteTransport` interface in `packages/agentvault-mcp-server/src/invite-transport.ts` is already clean. No changes needed. Document it as the official agentVault ↔ orchestrator integration point.

#### Step 3: No file moves needed

The orchestrator **stays in vcav**. It is ~95% VCAV-specific. The only "shared" pieces (inbox pattern, AFAL) are not worth extracting today:
- Inbox is deeply integrated with VCAV contract/profile/policy resolution
- AFAL is specified as a protocol but implemented as orchestrator modules

#### Step 4: Demo configuration

For agentVault demos that need invite exchange (INITIATE/RESPOND):

| Option | Trade-off |
|--------|-----------|
| **A) Run vcav orchestrator as external service** | Clean separation, requires docker-compose with both services |
| **B) Standalone mode (CREATE/JOIN only)** | No orchestrator dependency, manual token exchange |
| **C) Lightweight stub transport** | New: implement a simple file/HTTP-based InviteTransport for demos | **(Recommended)**

Recommended: option C. Create a `StubInviteTransport` in the agentVault MCP server that uses a simple file-based or in-memory inbox (no orchestrator dependency). This is strictly for demos and tests.

```
packages/agentvault-mcp-server/src/stub-transport.ts  (new file)
```

#### Step 5: Docker image paths (if orchestrator were moved)

Not applicable — orchestrator stays in vcav. agentVault's demo compose files should reference the vcav orchestrator image if INITIATE/RESPOND demos are needed:

```yaml
# In agentVault demo compose (if needed):
services:
  orchestrator:
    image: ghcr.io/vcav-io/vcav-orchestrator:latest  # vcav's published image
    ports: ["3000:3000"]
```

### What Gets Extracted into vault-family-core

**Nothing new today.** The existing vault-family-core dependencies are sufficient:
- `receipt-core` — receipt building and signing
- `vault-family-types` — Purpose, BudgetTier, PairId
- `ifc-engine` — label algebra and policy (already there)

**Future consideration (not blocking):** If AFAL is adopted by other vault-family members, extract `afal-core` (descriptor schema, signing primitives, replay guard) into vault-family-core. Today it's premature — AFAL is only used by vcav.

### Risk List

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Breaking INITIATE/RESPOND demos** | Medium | The InviteTransport interface already handles this. Standalone mode (CREATE/JOIN) works without orchestrator. Add stub transport for full demo without vcav. |
| **vault-family-core version drift** | Low | Both repos pin to specific git revisions. Coordinate version bumps via PRs to both repos. |
| **AFAL spec divergence** | Low | AFAL spec lives in vcav but is protocol-level. If other vault-family members need it, extract to vault-family-core at that point. |
| **Labeled message routing** | None | Already HTTP-only; agentVault doesn't use IFC labeled messages directly. |
| **Contract hash mismatch in invites** | Low | Already handled in `relaySignal.ts` — uses `template_id` matching instead of exact hash comparison. |

### Summary

The split is **already clean enough**. agentVault has zero source-level imports from the orchestrator. The runtime coupling (HTTP calls for INITIATE/RESPOND) is mediated through a well-defined interface. The only actionable item is creating a `StubInviteTransport` for standalone agentVault demos, which is a small addition to the MCP server package.
