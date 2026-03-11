# Negotiation Registry Artefacts

> Status: Draft architecture note
> Related: [agentvault-negotiation-protocol.md](agentvault-negotiation-protocol.md), [protocol-spec.md](../protocol-spec.md)

## 1. Purpose

This note sketches the registry artefacts needed to support structured bounded-computation negotiation in AgentVault.

It is intentionally lightweight. The goal is to define the shape of the artefacts and their compatibility links before governance and wire formats are frozen.

## 2. Artefact Types

The minimum negotiation registry should contain four artefact types:

- `signal_family`
- `schema`
- `policy_bundle`
- `standard_offer`

Model profiles and prompt/program artefacts already exist conceptually in the system and can be referenced directly by negotiation.

## 3. Signal Family Artefact

A `signal_family` defines the semantic class of bounded result the session is meant to produce.

Suggested fields:

- `signal_family_id`
- `version`
- `semantic_intent`
- `admitted_schema_refs`
- `admitted_program_refs`
- `bounded_parameter_kinds`

Example families:

- `overlap_signal`
- `compatibility_signal`
- `mediation_triage`
- `feasibility_signal`

### 3.1 Role

`signal_family` is the semantic anchor of negotiation.

It answers:

- what kind of bounded computation is this?
- how should the output be interpreted?
- which schemas and programs are even valid choices?

## 4. Schema Artefact

A `schema` defines one concrete bounded realization of a signal family.

Suggested fields:

- `schema_id`
- `version`
- `schema_hash`
- `signal_family_id`
- `json_schema`
- `entropy_class`
- `output_notes`

### 4.1 Role

The schema fixes:

- output structure
- output field set
- boundedness / entropy shape
- machine validation surface

Each schema should belong to exactly one signal family.

## 5. Policy Bundle Artefact

A `policy_bundle` defines execution and disclosure constraints relevant to negotiation and execution.

Suggested fields:

- `policy_bundle_id`
- `version`
- `policy_hash`
- `policy_scope`
- `constraints`
- `compatible_signal_families` (optional)

Example bundles:

- `corporate_confidentiality`
- `strict_privacy_mode`
- `relationship_sensitive_mode`

## 6. Standard Offer Artefact

A `standard_offer` is a content-addressed pre-composed agreement template.

Suggested fields:

- `offer_id`
- `version`
- `offer_hash`
- `topic_code`
- `signal_family`
- `default_schema_ref`
- `required_policy_refs`
- `acceptable_profile_refs`
- `program_ref` or derivation rule
- `default_bounded_parameters`

### 6.1 Role

A standard offer gives agents a simple default path.

Most sessions should start from a standard offer and only fall back to richer negotiation when the standard offer does not fit.

## 7. Compatibility Rules

Compatibility should be declared in the registry, not inferred ad hoc at runtime.

Minimum compatibility rules:

- a `signal_family` declares its admitted schemas
- a `signal_family` declares its admitted programs, unless programs are fully derived
- a `schema` belongs to exactly one `signal_family`
- a `standard_offer` references only compatible artefacts
- bounded parameter kinds must be admitted by the selected `signal_family`

This allows incoherent combinations to fail early, before execution contract compilation.

## 8. Governance Surface

These compatibility mappings are also a governance surface.

Adding a new schema to a signal family or a new standard offer to the registry changes what negotiations can successfully produce.

This note does not define governance policy, but the system will eventually need a clear ownership and review model for:

- who may define new signal families
- who may attach schemas/programs/policies to them
- how compatibility mappings are versioned and reviewed

## 9. Direction

The intended shape is:

- signal families define semantic classes
- schemas define concrete bounded realizations
- policy bundles define execution constraints
- standard offers define default pre-composed agreement templates

These artefacts should all be content-addressed or otherwise unambiguously versioned, so that negotiation and execution remain machine-verifiable.
