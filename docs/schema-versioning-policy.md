# Schema Versioning and Migration Policy

> Defines how output schemas evolve in the AgentVault protocol.
> Addresses [AV #54](https://github.com/vcav-io/agentvault/issues/54).

## Core Rules

### 1. Schema hashes are immutable

Every output schema is content-addressed via JCS canonicalization (RFC 8785) + SHA-256.
A given hash always maps to exactly one schema object. Any change to the schema —
however small — produces a new hash and thus a new identity.

The hash is computed by both the Rust relay (`compute_output_schema_hash` in relay.rs)
and the TypeScript client (`computeOutputSchemaHash` in relay-contracts.ts) using
identical algorithms. Cross-language parity is enforced by shared test vectors.

### 2. Contracts bind to schemas by content

Contracts carry their output schema inline as the `output_schema` field. The contract
hash (also JCS + SHA-256) captures the schema content transitively. The relay also
computes `output_schema_hash` directly from the inline schema at session time.

### 3. Receipts bind `output_schema_hash` for offline verification

Every receipt includes:
- `output_schema_id` — human-readable schema identifier (e.g., `vcav_e_mediation_signal_v2`)
- `output_schema_hash` — SHA-256 of the JCS-canonical schema content
- `contract_hash` — SHA-256 of the JCS-canonical contract (which includes the schema)

A verifier can independently hash the schema, compare against the receipt's
`output_schema_hash`, and confirm which exact schema governed the session output.

### 4. No in-place migration of existing contracts

To use a new schema version:
1. Define a new schema with a new `output_schema_id` (e.g., `vcav_e_compatibility_signal_v3`)
2. Create a new prompt template designed for the new schema
3. Create a new contract template referencing the new schema and prompt template

Existing contracts referencing the old schema remain valid and unaffected. Old and new
schemas coexist — backwards compatibility is achieved by coexistence, not mutation.

### 5. Out-of-band negotiation

Parties agree on a schema version before initiating a session. The contract's
`output_schema_id` and `output_schema_hash` (derivable from the inline schema) serve
as the enforcement mechanism. After session creation, the schema is immutable — the
relay enforces the contract as submitted.

## Standalone Schema Files

Canonical output schema JSON files live in `schemas/output/` alongside the existing
input schemas in `schemas/`. These files serve as:
- Reference documentation for schema consumers
- Source material for tooling and offline verification
- Diffable artefacts for schema review

The relay reads schemas from the contract at runtime, not from files. The files are
the canonical source of truth for what a given `output_schema_id` should contain.

## No Code Path Allows Schema Mutation After Hash Computation

`compute_output_schema_hash` is a pure function of the schema `serde_json::Value` at
the time of the call. The relay computes the hash from `contract.output_schema` at
session start and binds it into the receipt. The `Contract` struct's `output_schema`
field is `serde_json::Value` — immutable after deserialization. No code path modifies
the schema between hash computation and receipt signing.
