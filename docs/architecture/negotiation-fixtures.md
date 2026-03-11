# Negotiation Fixtures

> Status: Draft fixture note
> Related: [agentvault-negotiation-protocol.md](agentvault-negotiation-protocol.md), [negotiation-wire-format.md](negotiation-wire-format.md)

## 1. Purpose

This note records three lightweight negotiation fixtures that can later become protocol vectors or tests.

## 2. Fixture A: Convergent Salary Alignment

### Initial proposal

- `topic_code = salary_alignment`
- `signal_family = overlap_signal`
- `acceptable_schema_refs = [overlap_signal_v1, overlap_signal_v2]`
- `required_policy_refs = [corporate_confidentiality]`
- `acceptable_profile_refs = [balanced_reasoning, conservative_reasoning]`
- `round_budget = 3`

### Counterproposal

Counterparty narrows to:

- `acceptable_schema_refs = [overlap_signal_v1]`
- `acceptable_profile_refs = [balanced_reasoning]`

### Acceptance

Resolved agreement:

- `schema_ref = overlap_signal_v1`
- `policy_refs = [corporate_confidentiality]`
- `profile_ref = balanced_reasoning`
- `program_ref = overlap_estimator_v2`

Expected result:

- agreement accepted within round budget
- deterministic execution contract compiled

## 3. Fixture B: Incompatible Terms

### Initial proposal

- `topic_code = project_scope`
- `signal_family = mediation_triage`
- `required_policy_refs = [strict_privacy_mode]`
- `round_budget = 3`

### Counterparty response

Counterparty can only accept:

- `signal_family = compatibility_signal`
- `required_policy_refs = [corporate_confidentiality]`

### Expected result

- no resolved agreement
- protocol terminates with `REJECT_AGREEMENT`
- agent-visible reason codes remain coarse, for example:
  - `INCOMPATIBLE_TERMS`

## 4. Fixture C: Round Budget Exhausted

### Initial proposal

- `topic_code = relationship_future`
- `signal_family = compatibility_signal`
- `acceptable_schema_refs = [compatibility_signal_v1, compatibility_signal_v2]`
- `round_budget = 3`

### Negotiation path

1. proposal sent
2. counterproposal sent
3. second counterproposal still does not converge on one resolved agreement

### Expected result

- negotiation halts when `round_index == round_budget`
- protocol terminates with `REJECT_AGREEMENT`
- principal-visible outcome can safely be:
  - "No acceptable bounded agreement was reached."

## 5. Direction

These fixtures are intentionally simple.

Their role is to pressure-test:

- agreement object shape
- resolved acceptance semantics
- coarse reject behavior
- explicit round-budget behavior

Once the wire format and registry artefacts stabilize, these can become concrete JSON test vectors.
