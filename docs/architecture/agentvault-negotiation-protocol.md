# AgentVault Negotiation Protocol

> Status: Draft protocol sketch
> Related: [protocol-spec.md](../protocol-spec.md), [precontract-negotiation-notes.md](precontract-negotiation-notes.md), [ifc-reintegration-proposal.md](ifc-reintegration-proposal.md)

## 1. North Star

AgentVault should allow delegated agents to negotiate bespoke bounded-computation agreements without allowing freeform contract generation.

The intended middle ground is:

- most sessions use standard named offers from the registry
- advanced sessions negotiate bespoke agreements by composing admitted artefacts
- execution always happens through a rigid, verifiable contract derived from that agreement

The key distinction is between two layers:

- **agreement layer** — negotiable, structured, and expressive within bounds
- **execution layer** — content-addressed, machine-verifiable, and relay-admissible

Agents do not invent raw execution contracts. They negotiate a bounded computation agreement and deterministically compile it into an execution contract.

This split is also an evolution boundary. Negotiation semantics can change over time without changing the execution contract format, as long as compilation still produces the same relay-verifiable contract shape. The same boundary runs the other direction: execution assurance can evolve, for example from relay-asserted to TEE-attested, without changing the shape of agreement negotiation.

## 2. Negotiation Threat Model

Negotiation is not a benign coordination helper. It is an information channel and must be treated as such.

The main risk is that agents can learn about each other from:

- proposal choices
- counterproposal choices
- reject reasons
- convergence failure
- timing and number of rounds

So the system must decide what trust boundary applies during negotiation.

### 2.1 Default assumption

The safest default model is:

- negotiation messages are not treated as disclosure-free
- negotiation reveals some bounded metadata about acceptable computation shapes
- private substantive facts must not be exchanged during negotiation

This means negotiation should be understood as a tightly constrained metadata exchange, not as a private pre-session conversation.

### 2.2 Stronger future model

A stronger model may later place negotiation inside a relay- or enclave-mediated trust boundary so that proposal contents are not directly revealed agent-to-agent.

That is not assumed by this sketch.

For now, the protocol should be designed conservatively for the direct-exchange case.

There are at least two future variants:

- **trusted relay mediation**
  - the relay can observe negotiation contents and mediate convergence, but the counterparties do not see each proposal directly
- **TEE-mediated negotiation**
  - negotiation contents are hidden from both counterparties and the relay operator, subject to the enclave trust model

Both variants would materially reduce direct agent-to-agent leakage, but they also introduce stronger trust assumptions than the current sketch.

### 2.3 Design consequence

Because negotiation is itself a side channel:

- message types must be fixed and small
- reason codes must be coarse and finite
- round count must be bounded and explicit
- the protocol should minimize repeated exploratory bargaining

## 3. Agreement Object

The agreement object is the main object of negotiation. It describes what bounded computation should be run, not arbitrary runtime behavior.

### 3.1 Agreement fields

An initial agreement object should contain:

- `topic_code`
- `signal_family`
- `acceptable_schema_refs`
  - must all be compatible with the chosen `signal_family`
- `required_policy_refs`
- `acceptable_profile_refs`
- `acceptable_program_refs` or a deterministic derivation rule
- `bounded_parameters`
- `preference_order`
- `related_session_context` (optional)

### 3.2 Field intent

- `topic_code`
  - real-world coordination domain
  - examples: `salary_alignment`, `meeting_scheduling`, `project_scope`

- `signal_family`
  - semantic class of the bounded result
  - examples: `overlap_signal`, `feasibility_signal`, `mediation_triage`

- `acceptable_schema_refs`
  - one or more admitted schema identifiers or hashes compatible with the chosen signal family

- `required_policy_refs`
  - policy bundles that must apply to any acceptable agreement

- `acceptable_profile_refs`
  - acceptable reasoning/model profile artefacts

- `acceptable_program_refs`
  - admitted prompt/program artefacts, unless program choice is fully derived from the other fields

- `bounded_parameters`
  - tightly limited negotiable parameters, such as:
  - entropy tier
  - timing class
  - allowed follow-up scope

- `preference_order`
  - ranked ordering over acceptable choices, so negotiation can converge without prose

- `related_session_context`
  - optional prior receipt/session/topic references when negotiation is not starting from zero

### 3.3 Hard constraints and ranked preferences

The agreement object should distinguish between:

- hard constraints
- ranked preferences

Hard constraints define what is acceptable at all.

Ranked preferences define how to choose among mutually acceptable options.

For example, an agent may require:

- `strict_privacy_mode`
- one of `[overlap_signal_v1, overlap_signal_v2]`

And prefer:

- `balanced_reasoning` before `fast_low_compute`
- `overlap_signal_v2` before `overlap_signal_v1`

This is more precise than loose "preferred" semantics and gives convergence logic a deterministic basis.

### 3.4 Compatibility validation

The agreement layer should reject incoherent combinations early.

At minimum:

- every `acceptable_schema_ref` must be admitted for the selected `signal_family`
- every `acceptable_program_ref` must be compatible with the selected schema and policy set
- bounded parameters must be valid for the selected signal family and schema

The preferred way to enforce this is through registry-declared compatibility mappings rather than late compilation failure.

## 4. Negotiation Message Types

Negotiation should use a small typed protocol, not free-text bargaining.

The initial message set should be:

- `PROPOSE_AGREEMENT`
- `COUNTER_AGREEMENT`
- `ACCEPT_AGREEMENT`
- `REJECT_AGREEMENT`

Every negotiation envelope should also include:

- `negotiation_id`
- `round_index`
- `round_budget`

`round_budget` should be an explicit protocol parameter visible to both sides at negotiation start. A small default such as 3 rounds is likely sufficient for most flows.

### 4.1 PROPOSE_AGREEMENT

Sent when one side proposes an initial agreement object.

Fields:

- `negotiation_id`
- `proposal_id`
- `round_index`
- `round_budget`
- `agreement`
- `sender`
- `created_at`

### 4.2 COUNTER_AGREEMENT

Sent when the counterparty can accept the general direction but needs different admissible choices.

Fields:

- `negotiation_id`
- `proposal_id`
- `counterproposal_id`
- `round_index`
- `round_budget`
- `agreement`
- `reason_codes`
- `sender`
- `created_at`

`reason_codes` should be structured and finite, for example:

- `INCOMPATIBLE_TERMS`
- `NO_ACCEPTABLE_AGREEMENT`
- `ROUND_BUDGET_EXHAUSTED`

Reason codes should stay as coarse as the convergence goal allows. They are useful for convergence, but they are also part of the negotiation side channel.

There is a real tradeoff:

- **coarser codes** leak less but make convergence harder
- **finer codes** help convergence but reveal more about posture and acceptable terms

The initial protocol should make this tradeoff explicit. One plausible first model is:

- agent-visible codes remain coarse
- more specific failure details are visible only to the relay or audit log

### 4.3 ACCEPT_AGREEMENT

Sent when one side accepts a fully resolved agreement object.

Fields:

- `negotiation_id`
- `proposal_id`
- `round_index`
- `round_budget`
- `resolved_agreement`
- `resolved_agreement_hash`
- `sender`
- `created_at`

Acceptance must bind a single resolved choice for each execution-relevant dimension. It must not bind only a still-ambiguous set of acceptable options.

### 4.4 REJECT_AGREEMENT

Sent when no acceptable convergence exists.

Fields:

- `negotiation_id`
- `proposal_id`
- `round_index`
- `round_budget`
- `reason_codes`
- `sender`
- `created_at`

The reject path should explain failure in structured coarse terms rather than natural language.

## 5. Compilation Rule to Execution Contract

Once both sides accept the same resolved agreement object, AgentVault compiles it deterministically into an execution contract.

The compilation rule should:

1. resolve the selected schema ref to one concrete schema artefact
2. resolve the selected policy refs to one concrete policy set
3. resolve the selected profile ref
4. resolve or derive one concrete program ref
5. resolve bounded parameters into final concrete values
6. synthesize one canonical execution contract
7. compute the resulting contract hash

The execution contract should then bind the relay-relevant artefacts, such as:

- `schema_hash`
- `policy_hash`
- `profile_hash`
- `program_hash`
- concrete bounded parameter values

This compilation must be deterministic. Two agents holding the same accepted agreement must derive the same execution contract bytes and the same contract hash.

### 5.1 Standard offers

Standard offers should be immutable, content-addressed agreement artefacts in the registry.

For example:

- `salary_overlap_offer`
- `compatibility_check_offer`
- `mediation_triage_offer`

Using a standard offer should still produce an agreement object. The difference is only that the object is largely pre-filled rather than negotiated from scratch.

Referencing a standard offer should be unambiguous and versioned, for example via an offer ref or offer hash.

## 6. Constraints on the Negotiation Process

The negotiation protocol itself must be bounded, not just the artefacts.

Initial constraints should include:

- a fixed message grammar
- no free-text semantic bargaining
- an explicit small round budget
- explicit reject and counterproposal reason codes
- no exchange of private substantive facts during negotiation
- no unregistered schemas, policies, profiles, or programs

Negotiation is for formal parameter convergence, not for moving the real coordination problem outside the vault.

## 7. Worked Examples

### 7.1 Salary alignment

Two agents want to determine whether acceptable compensation ranges overlap.

Agreement shape:

- `topic_code = salary_alignment`
- `signal_family = overlap_signal`
- `acceptable_schema_refs = [overlap_signal_v1, overlap_signal_v2]`
- `required_policy_refs = [corporate_confidentiality]`
- `acceptable_profile_refs = [balanced_reasoning, conservative_reasoning]`

If both sides converge on `overlap_signal_v1 + corporate_confidentiality + balanced_reasoning`, the system compiles a concrete execution contract and runs the vault session.

### 7.2 Ambiguous mediation / compatibility case

Two agents know they need bounded help on a sensitive coordination problem, but do not initially agree whether the right signal is compatibility assessment or mediation triage.

Agreement shape:

- `topic_code = project_scope`
- `signal_family = [compatibility_signal, mediation_triage]`
- `acceptable_schema_refs = [...]`
- `required_policy_refs = [strict_privacy_mode]`

The negotiation protocol can narrow this to one admissible signal family and one compatible schema without forcing both sides to guess a brittle top-level `purpose_code` upfront.

### 7.3 Failure at round limit

Two agents negotiate under `round_budget = 3` and fail to converge on a mutually acceptable resolved agreement.

The protocol terminates with `REJECT_AGREEMENT` and coarse structured reasons such as:

- `NO_COMMON_SCHEMA`
- `POLICY_TOO_WEAK`

The system should report the failure to the principal in a way that does not reveal more than the negotiated protocol already exposed. In the initial model, a safe default is:

- "No acceptable bounded agreement was reached."

Richer reporting can be added later, but it should be treated as another disclosure surface.

## 8. Direction

The intended direction is:

- keep standard offers as the default product path
- allow richer structured negotiation when standard offers do not fit
- treat `purpose_code` as a coarse derived label or family tag, not the deepest semantic primitive
- keep the registry as the innovation surface for new capabilities

This note is a protocol sketch, not yet a normative specification. Its role is to define the target shape of agreement negotiation before individual fields and wire formats are frozen.
