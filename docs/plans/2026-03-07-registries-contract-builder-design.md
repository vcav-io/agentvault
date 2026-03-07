# Ecosystem Registries & Contract Builder — Design

**Issues:** #164 (registries), #166 (contract builder), #167 (protocol stabilisation)
**Date:** 2026-03-07

## Goal

Build an ecosystem-facing, content-addressed artefact registry and a client-side
contract builder that enables open-ended contract engineering. Agents discover,
compose, and reference shared artefacts to construct novel contracts without relay
code changes. Relays independently decide which ecosystem artefacts they admit and
execute.

## Architecture

Two layers, cleanly separated:

1. **Ecosystem registry** — a shared, append-only, git-based repo of canonical
   artefacts indexed by content hash. The source of truth for what exists.
2. **Relay admission** — a relay-local allowlist of digests the operator trusts.
   Determines what a specific relay will load and execute.

A **contract builder** library consumes registry indexes and assembles valid
contracts from artefact references with compatibility validation.

```
agentvault-registry (git repo)     relay operator
├── schemas/                       ├── relay-admission.toml
├── policies/                      │   (allow + default per kind)
├── profiles/                      └── AV_REGISTRY_PATH → local clone
├── programs/                          ↓
└── registry.json                  relay startup: load only admitted artefacts

agentvault-client
└── contracts module
    ├── loadRegistryIndex()        ← reads index.json files
    ├── buildContract()            ← resolves refs, validates, assembles
    └── av-contract CLI            ← thin wrapper
```

---

## 1. Artefact Model

### 1.1 Artefact kinds

Four primitive types in v1. Extensible — adding a kind means adding a directory
and an entry in `registry.json`.

| Kind | Directory | Contents |
|------|-----------|----------|
| `schema` | `schemas/` | JSON Schema for output validation |
| `policy` | `policies/` | Enforcement policy (rules, entropy constraints, allowlists) |
| `profile` | `profiles/` | Model/provider configuration |
| `program` | `programs/` | Prompt template + assembly logic |

Contract templates are **not** a v1 kind. They are a composition convenience over
primitives and may be introduced as a secondary layer once the primitive model is
stable.

### 1.2 Digest rules

- **Algorithm**: SHA-256
- **Input**: JCS (RFC 8785) canonicalization of the parsed payload JSON
- **Output**: lowercase hex, 64 characters
- **Qualified form**: `sha256:<hex>` — used in index keys, allowlists, contract refs
- **Filenames**: `sha256-<hex>.json` (hyphen for filesystem safety)

The digest is computed over the **canonical form**, not the raw file bytes. The
stored file may be pretty-printed. Consumers must JCS-canonicalize before verifying.
This matches the existing `receipt_core::canonicalize_serializable` pattern used
throughout the relay and client.

### 1.3 Payload files

Pure JSON. No wrapper, no metadata envelope. The file contains exactly the artefact
payload — the same structure the relay's existing loaders expect. Metadata lives in
the index, not in the payload.

### 1.4 Version semantics

Three distinct version fields with different scopes:

| Field | Location | What it versions |
|-------|----------|-----------------|
| `registry_version` | `registry.json` | Registry manifest schema (directory layout, index conventions) |
| `version` | `index.json` root | Index schema (field names, metadata shape, alias rules) |
| `version` | per-artefact entry | Author-declared semantic version. Informational only — digests are the identity. |

---

## 2. Registry Structure

### 2.1 Directory layout

```
agentvault-registry/
├── _schemas/                        # type-validation schemas (for CI)
│   ├── schema.schema.json
│   ├── policy.schema.json
│   ├── profile.schema.json
│   └── program.schema.json
├── schemas/
│   ├── index.json
│   └── sha256-0d25ea01...json
├── policies/
│   ├── index.json
│   └── sha256-b977379e...json
├── profiles/
│   ├── index.json
│   └── sha256-0892ed75...json
├── programs/
│   ├── index.json
│   └── sha256-bc4fdec5...json
└── registry.json
```

### 2.2 Top-level manifest

```json
{
  "registry_version": "1.0.0",
  "kinds": ["schema", "policy", "profile", "program"],
  "indexes": {
    "schema": "schemas/index.json",
    "policy": "policies/index.json",
    "profile": "profiles/index.json",
    "program": "programs/index.json"
  }
}
```

### 2.3 Per-kind index

```json
{
  "version": "1.0.0",
  "kind": "schema",
  "artefacts": {
    "sha256:0d25ea011d60a301...": {
      "id": "vcav_e_mediation_signal_v2",
      "version": "2.0.0",
      "description": "Mediation signal with enum-bounded output",
      "status": "active",
      "added": "2026-03-07",
      "compatibility": {
        "safety_class": "SAFE"
      }
    }
  },
  "aliases": {
    "vcav_e_mediation_signal_v2": "sha256:0d25ea011d60a301..."
  },
  "channels": {
    "vcav_e_mediation_signal@latest": "sha256:0d25ea011d60a301..."
  }
}
```

**Artefact entries:**
- Digest is the canonical key. Human IDs are aliases.
- `status`: `"active"` | `"deprecated"` | `"experimental"`
- `compatibility`: extensible object. `safety_class` (`"SAFE"` | `"RICH"`) present
  on schemas and policies. Future fields: `min_registry_version`,
  `max_entropy_bits`, `requires_profile_capability`, etc.

**Aliases** (immutable):
- Once created, an alias always points to the same digest.
- New versions get new aliases (e.g., `_v2` → `_v3`).
- An alias name is unique within a kind's index.
- Multiple aliases may point to the same digest.

**Channels** (mutable):
- Explicitly mutable pointers like `name@latest` or `name@recommended`.
- The `@` separator signals instability — channels may be retargeted.
- Contracts store the resolved digest, not the channel name.

**Append-only**: artefact entries are never removed. Status changes to
`"deprecated"` signal that an artefact should not be used in new contracts.

### 2.4 Per-kind validation

Type-validation schemas live in `_schemas/`. These are derived from the existing
Rust struct definitions (`RelayEnforcementPolicy`, `PromptProgram`, `ModelProfile`,
plus JSON Schema meta-schema for output schemas).

Registry CI runs three checks per artefact:
1. **Digest verification**: `SHA-256(JCS(parse(file))) == filename digest`
2. **Type validation**: payload validates against `_schemas/<kind>.schema.json`
3. **Index consistency**: every file has an index entry; every entry has a file;
   aliases and channels resolve to existing entries

### 2.5 Submission workflow

External submission is via pull request:
1. Contributor adds a payload file with the correct `sha256-<hex>.json` filename
2. Contributor adds an entry to the kind's `index.json` with metadata
3. CI validates digest, type schema, and index consistency
4. Maintainer reviews and merges

---

## 3. Relay Integration & Admission

### 3.1 Registry path

New env var: `AV_REGISTRY_PATH` — points to a local clone of the registry repo.
Optional. If unset, the relay falls back to its existing local directory loading
(full backward compat; no breaking change).

### 3.2 Admission allowlist

Relay-local `relay-admission.toml`:

```toml
[registry]
path = "./agentvault-registry"

[schemas]
allow = [
  "sha256:0d25ea011d60a301...",
  "sha256:7f3a..."
]

[policies]
allow = ["sha256:b977379e..."]
default = "sha256:b977379e..."

[profiles]
allow = ["sha256:0892ed75..."]
default = "sha256:0892ed75..."

[programs]
allow = ["sha256:bc4fdec5..."]
```

**Precedence**: `AV_REGISTRY_PATH` env var overrides `[registry].path` in TOML.

**Semantics:**
- `allow`: only these digests are loaded. Everything else in the registry is ignored.
- `default`: used when a contract omits the reference for that type. Required for
  policies. Optional for profiles. Not applicable to schemas or programs — those are
  structurally required in contracts and cannot be defaulted.
- If a contract references a digest not in `allow` → session rejected.
- Empty `allow` for a type → no artefacts of that type admitted.

**Extensibility**: the TOML structure supports future additions like `deny` lists,
`required_defaults`, and cross-type combination rules without schema changes.

### 3.3 Startup behaviour (fail-closed)

1. Parse `relay-admission.toml`
2. For each admitted digest, load payload from `<registry_path>/<kind>/sha256-<hex>.json`
3. Verify digest: `SHA-256(JCS(parse(file))) == expected`
4. Validate payload against relay's **bundled** type-validation schemas
5. Build in-memory registries (`SchemaRegistry`, `PolicyRegistry`, etc.)
6. Expose admitted digests via `/capabilities` endpoint

**Fail-closed rules:**
- Admitted digest missing from registry path → **startup error**
- Digest verification fails → **startup error**
- Type validation fails → **startup error**
- `default` digest not in `allow` list → **startup error**
- No partial loading. Relay does not start with an incomplete artefact set.

**Type-validation schemas are relay-bundled**, not loaded from the registry's
`_schemas/` directory. The relay does not trust the registry to define its own
validation rules.

### 3.4 Migration from lockfiles

When `AV_REGISTRY_PATH` is unset, the existing `relay_policies.lock`,
`model_profiles.lock`, and per-directory loading work unchanged. When the registry
path is set, `relay-admission.toml` replaces lockfiles entirely — they are ignored.

### 3.5 Relay code changes

- New `admission.rs` module: TOML parsing, selective loading, digest verification
- Existing loaders (`schema_registry.rs`, `enforcement_policy.rs`,
  `prompt_program.rs`) gain an optional `allowed_digests` filter parameter
- `main.rs` startup branches on `AV_REGISTRY_PATH` presence
- `/capabilities` response unchanged (already serves digest lists)

---

## 4. Contract Builder

### 4.1 Location

New module in `agentvault-client`: `src/contract-builder.ts`, exported as
`agentvault-client/contracts`.

### 4.2 Core API

```typescript
import { buildContract, loadRegistryIndex } from 'agentvault-client/contracts';

const registry = await loadRegistryIndex('/path/to/agentvault-registry');

const contract = buildContract(registry, {
  schema: 'vcav_e_mediation_signal_v2',      // alias, channel, or digest
  policy: 'compatibility_safe_v1',
  profile: 'api-claude-sonnet-v1',
  program: 'mediation_system_v1',
  purpose_code: 'MEDIATION',
  participants: ['alice', 'bob'],
  entropy_budget_bits: 12,
  entropy_enforcement: 'Advisory',
});
```

### 4.3 Resolution and assembly

`buildContract` performs these steps:

1. **Resolve** each reference (alias, channel, or digest) against the registry
   index for the appropriate kind. Error if not found.

2. **Validate compatibility** (metadata-level, not payload-level):
   - All artefacts must have `status: "active"` or `"experimental"`.
     Deprecated artefacts → error by default; `allowDeprecated: true` downgrades
     to warning.
   - Schema + policy `safety_class` must be compatible: a `SAFE` policy cannot
     pair with a `RICH` schema. A `RICH` policy with a `SAFE` schema is fine.
   - If either lacks a `safety_class` → warning (unknown compatibility).

3. **Assemble** the `Contract` object with digests in all hash fields:
   - `output_schema_hash` ← schema digest
   - `enforcement_policy_hash` ← policy digest
   - `prompt_template_hash` ← program digest
   - `model_profile_id` ← profile's human ID (compatibility compromise; relays
     currently resolve by ID, not digest. Future: `model_profile_hash`)
   - `output_schema` ← `{}` (legacy compatibility stub for relays expecting an
     inline schema field; ignored when `output_schema_hash` is present and the
     relay supports registry resolution)

4. **Compute** `contract_hash` = `SHA-256(JCS(contract))` over the canonical
   contract **excluding** the `contract_hash` field itself.

5. **Return** a frozen contract object.

### 4.4 Registry index reader

`loadRegistryIndex` reads `registry.json` then each kind's `index.json`. Returns:

```typescript
interface RegistryIndex {
  resolve(kind: ArtefactKind, ref: string): ResolvedArtefact;
  listByKind(kind: ArtefactKind): ArtefactEntry[];
  checkCompatibility(schema: string, policy: string): CompatibilityResult;
}
```

Reads indexes only, not payloads. Payloads are the relay's concern.

### 4.5 SAFE/RICH compatibility

Registry metadata + builder validation logic. Not a separate enforcement mechanism.

- `SAFE`: enum-only output, no free text, deterministic policy gate, strict
  entropy bounds.
- `RICH`: may include bounded free text, must declare explicit entropy upper bound,
  must include deterministic reject patterns, must clearly declare reduced privacy
  guarantees.

Builder check: `policy.safety_class >= schema.safety_class` (RICH > SAFE).
Mismatch → error with actionable message.

### 4.6 Replacing hardcoded templates

The current `TEMPLATES` map in `relay-contracts.ts` becomes a thin backward-compat
wrapper that internally delegates to `buildContract` with preset references.
Deprecated in docs. New code uses `buildContract` directly.

### 4.7 CLI wrapper

`av-contract build` command:

```bash
av-contract build \
  --registry ./agentvault-registry \
  --schema vcav_e_mediation_signal_v2 \
  --policy compatibility_safe_v1 \
  --profile api-claude-sonnet-v1 \
  --program mediation_system_v1 \
  --purpose MEDIATION \
  --participants alice,bob
```

Outputs contract JSON to stdout.

---

## 5. Phasing

### Phase 0: Freeze registry contract

This design document. Defines artefact model, digest rules, index schema,
admission model, and builder API.

### Phase 1: Registry repo + CI

- Create `vcav-io/agentvault-registry`
- Directory structure, type-validation schemas in `_schemas/`
- Seed with artefacts extracted from relay's current directories
- Per-kind `index.json` files with aliases, channels, compatibility metadata
- CI: digest verification, type validation, index consistency
- Contributing guide for PR-based submission

**Exit criteria**: CI green, all existing artefacts content-addressed and indexed.

### Phase 2a: Relay integration (parallel with 2b)

- `admission.rs` module parsing `relay-admission.toml`
- Registry-aware startup path gated on `AV_REGISTRY_PATH`
- Selective loading with fail-closed validation
- Existing lockfile path preserved when unset
- Tests: admission filtering, missing artefact, digest mismatch, default resolution

### Phase 2b: Contract builder (parallel with 2a)

- `agentvault-client/contracts` module
- `loadRegistryIndex`, `buildContract`, `RegistryIndex` interface
- Compatibility validation (safety_class, status, existence)
- Replace `TEMPLATES` (old API preserved, deprecated)
- CLI wrapper
- Tests: resolution, compatibility, deprecated handling, hash computation

### Phase 3: Close meta-issues

- Close #164, #166, #167
- Update STATUS.md, README, protocol docs

**Issue mapping:**
- Phase 1 → new issue on `agentvault-registry` repo
- Phase 2a → #164
- Phase 2b → #166
- Phase 3 → closes #167

---

## Design decisions log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Registry scope | Ecosystem-facing (option C) | Enables open-ended contract engineering by external agents |
| Registry storage | Separate git repo | Clean separation from implementation; external contributors don't need relay codebase |
| Artefact manifest | Two-file (payload + index) | Payloads stay pristine; relay loads them without unwrapping |
| Relay consumption | Direct reference (option B) | Simplest change; relay already loads from directories |
| Admission model | Single TOML file | One coherent operator policy; extensible to richer semantics |
| Contract builder | Client-side TS library | Deterministic, local; relay is not involved in contract construction |
| v1 artefact kinds | Four primitives only | Contract templates are composition, not foundation |
| Alias model | Immutable aliases + mutable channels | Clear stability guarantees; `@` separator signals mutability |
| Digest filenames | Algorithm-qualified | Hash agility for future |
| Profile reference | By ID (compat compromise) | Relays resolve by ID today; migrate to digest later |
