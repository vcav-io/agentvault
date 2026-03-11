# Negotiation Wire Format

> Status: Draft wire-format sketch
> Related: [agentvault-negotiation-protocol.md](agentvault-negotiation-protocol.md), [negotiation-registry-artefacts.md](negotiation-registry-artefacts.md)

## 1. Purpose

This note sketches an initial JSON wire format for structured bounded-computation negotiation in AgentVault.

It is intentionally draft and should not yet be treated as normative.

## 2. Envelope Shape

Every negotiation message should share a common envelope:

```json
{
  "version": "AV-NEGOTIATE-V1",
  "negotiation_id": "uuid",
  "message_type": "PROPOSE_AGREEMENT",
  "proposal_id": "uuid",
  "round_index": 1,
  "round_budget": 3,
  "sender": "alice",
  "created_at": "2026-03-11T16:00:00Z",
  "body": {}
}
```

Common fields:

- `version`
- `negotiation_id`
- `message_type`
- `proposal_id`
- `round_index`
- `round_budget`
- `sender`
- `created_at`
- `body`

## 3. Agreement Shape

The draft agreement object should look like:

```json
{
  "topic_code": "salary_alignment",
  "signal_family": "overlap_signal",
  "acceptable_schema_refs": [
    "schema:overlap_signal_v1",
    "schema:overlap_signal_v2"
  ],
  "required_policy_refs": [
    "policy:corporate_confidentiality"
  ],
  "acceptable_profile_refs": [
    "profile:balanced_reasoning",
    "profile:conservative_reasoning"
  ],
  "acceptable_program_refs": [
    "program:overlap_estimator_v2"
  ],
  "bounded_parameters": {
    "entropy_tier": ["E8", "E12"]
  },
  "preference_order": {
    "schema_refs": [
      "schema:overlap_signal_v2",
      "schema:overlap_signal_v1"
    ],
    "profile_refs": [
      "profile:balanced_reasoning",
      "profile:conservative_reasoning"
    ]
  }
}
```

## 4. Message Bodies

### 4.1 PROPOSE_AGREEMENT

```json
{
  "agreement": { "...": "..." }
}
```

### 4.2 COUNTER_AGREEMENT

```json
{
  "agreement": { "...": "..." },
  "reason_codes": ["INCOMPATIBLE_TERMS"]
}
```

The initial wire format should bias toward coarse agent-visible reason codes.

More specific diagnostics can be relay-visible without being counterpart-visible.

### 4.3 ACCEPT_AGREEMENT

```json
{
  "resolved_agreement": {
    "topic_code": "salary_alignment",
    "signal_family": "overlap_signal",
    "schema_ref": "schema:overlap_signal_v1",
    "policy_refs": ["policy:corporate_confidentiality"],
    "profile_ref": "profile:balanced_reasoning",
    "program_ref": "program:overlap_estimator_v2",
    "bounded_parameters": {
      "entropy_tier": "E8"
    }
  },
  "resolved_agreement_hash": "64hex"
}
```

`resolved_agreement` must contain one concrete selection for every execution-relevant dimension.

### 4.4 REJECT_AGREEMENT

```json
{
  "reason_codes": ["NO_ACCEPTABLE_AGREEMENT"]
}
```

## 5. Direction

This format is intended to stay:

- small
- typed
- deterministic
- compatible with future signing and hashing rules

The next stage would be to freeze:

- exact field requirements
- canonicalization rules
- signature rules
- the allowed reason code set
