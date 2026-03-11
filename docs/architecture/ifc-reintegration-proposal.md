# IFC Reintegration Proposal

> Status: Draft architecture note
> Related: [protocol-spec.md](../protocol-spec.md), [a2a-integration-spec.md](a2a-integration-spec.md), [precontract-negotiation-notes.md](precontract-negotiation-notes.md), `vfc/packages/ifc-engine`, `vfc/packages/message-envelope`

## 1. Role of IFC in the Modern Stack

This note proposes how to reintegrate IFC into the current AgentVault architecture without blurring its role with AFAL or vault execution.

The intended layering is:

- **A2A** — optional transport and interoperability carrier
- **AFAL** — admission and session formation
- **Vault contract** — bounded computation
- **IFC** — bounded communication and context-flow control outside sessions

The key correction is that IFC should no longer be treated as an old experimental subsystem or an optional wrapper around a few messages. It should be the default policy membrane for out-of-vault agent communication.

That gives the system two complementary controls:

- **bounded computation** inside a vault session
- **bounded communication** outside a vault session

This restores a clean architecture. Without IFC, AgentVault risks having a highly disciplined in-vault path and a comparatively ungoverned out-of-vault path.

### 1.1 Distinct responsibilities

AFAL and IFC should remain separate:

- **AFAL asks:** should these agents open a bounded session, and under what agreement?
- **IFC asks:** may this concrete message flow between these agents outside a session, and if so under what constraints?

The vault contract then governs the actual execution once a session exists.

### 1.2 IFC as a membrane, not message decoration

An IFC envelope is not just a safer message wrapper. It is a signed, policy-evaluable claim about permissible information flow.

That claim binds:

- sender and recipient
- message payload
- IFC label
- policy hash
- label receipt
- optional grant context

The receiver does not merely "read metadata." The receiver evaluates the flow mechanically and obtains one of a small number of outcomes.

### 1.3 Where IFC applies

IFC should sit laterally to vault sessions rather than strictly before or after them.

Valid paths include:

- `IFC message`
- `IFC -> Escalate -> AFAL -> Vault`
- `Vault -> receipt/grant -> IFC follow-up`

This means IFC can govern:

- pre-session low-risk coordination
- inter-session follow-up
- post-session acknowledgements, logistics, and controlled artifact transfer

It should not be used as a replacement for bounded vault computation.

### 1.4 Non-IFC messages

If IFC is the default membrane, the architecture needs an explicit rule for plain out-of-vault messages that are not IFC-wrapped.

The long-term target should be:

- production: blocked by default unless sent via an explicitly non-sensitive channel policy
- development: optional bypass for iteration

The important thing is to make this policy explicit. Otherwise "default membrane" degrades into "membrane for only the flows we remembered to wrap."

## 2. Modern IFC Envelope and Policy Model

The existing IFC machinery in `vfc` remains strong in concept:

- signed message envelopes
- label algebra over confidentiality, integrity, and boundedness
- label receipts and policy hashes
- capability grants
- HIDE semantics

What needs updating is the semantic surface. The old IFC policy model still reflects earlier purpose buckets such as `MEDIATION` and `NEGOTIATION`. Current AgentVault has moved toward more explicit contract fields and richer session semantics, so IFC should do the same.

### 2.1 Envelope model

Keep the existing cryptographic envelope model, but modernize the policy inputs around it.

Recommended message fields:

- `message_id`
- `sender`
- `recipient`
- `payload`
- `label`
- `ifc_policy_hash`
- `label_receipt`
- `message_class`
- `topic_code`
- `session_relation`
- `related_session_id` (optional)
- `related_receipt_id` (optional)
- `grant_id` (optional)

### 2.2 Message classification

`message_class` should be functional, not contextual. Context belongs in `session_relation`.

Recommended initial `message_class` values:

- `LOGISTICS`
- `CONSENT`
- `REFERENCE`
- `ARTIFACT_TRANSFER`
- `CLARIFICATION`
- `ESCALATION_TRIGGER`

Recommended initial `session_relation` values:

- `PRE_SESSION`
- `POST_SESSION`
- `STANDALONE`

This separation makes policy evaluation cleaner than using relational labels like `FOLLOW_UP` or `SESSION_ADJACENT` inside `message_class`.

### 2.3 Policy inputs

The IFC policy engine should evaluate at least:

- label confidentiality / integrity / boundedness
- `message_class`
- `topic_code`
- `session_relation`
- current context label
- grant scope and expiry, if a grant is present
- operator-selected policy bundle

Policy outputs remain:

- `Allow`
- `Hide`
- `Escalate`
- `Block`

Interpretation:

- **Allow** — deliver into active agent context
- **Hide** — quarantine as a hidden variable; do not deliver into active reasoning context
- **Escalate** — this message should be converted into session formation
- **Block** — reject outright

### 2.4 HIDE semantics

HIDE is worth preserving. It is one of the strongest ideas in the original IFC design because it gives a third path between permissive delivery and simple rejection.

However, the design constraint needs to be explicit:

**HIDE must not become silent semantic smuggling.**

Hidden material must remain quarantined strongly enough that it cannot influence active reasoning except through:

- explicit bounded inspection, or
- explicit escalation into a more appropriate protocol path

In practice, HIDE should remain mostly an internal control primitive, not a user-facing concept that leaks into most product surfaces.

### 2.5 Escalation as a proto-agreement seed

`Escalate` should not be a vague recommendation. It should return a structured seed that AFAL can consume.

Recommended shape:

- `recommended_topic_code`
- `recommended_signal_family`
- `recommended_policy_constraints`
- `reason_code`
- `source_message_id`
- `grant_context`

This keeps the system from falling back into prose at the exact moment a message becomes too sensitive for out-of-vault handling.

### 2.6 Grants

Capability grants should become the main authorization primitive for non-session flows.

Conceptually:

- **contracts** authorize bounded computation
- **grants** authorize bounded communication

A grant should be narrowly scoped and short-lived. Recommended fields:

- issuer
- audience
- allowed `topic_code` or topic family
- allowed `message_class` set
- label ceiling
- optional related session or receipt provenance
- expiry
- use count

Bias strongly toward provenance-bound grants tied to an existing session or receipt. Avoid broad standing authority, which would recreate ambient trust through accumulated permissions.

## 3. First Implementation Slice

The first reintegration slice should be deliberately narrow. The goal is to prove the membrane concept in a place where IFC is obviously useful, not to revive the entire historical IFC surface at once.

### 3.1 Scope

Implement IFC as the default path for:

- post-session follow-up
- scheduling / logistics tied to an existing session or receipt
- grant issuance and grant consumption for those flows

Include an escalation stub in the API shape, but do not require a full end-to-end `Escalate -> AFAL -> Vault` path in the first slice.

### 3.2 Why start here

This is the easiest place for IFC to be clearly valuable:

- there is already provenance from the prior session
- the topic context is already bounded
- the communication need is real but smaller than reopening a vault
- grants can be minted naturally from a completed session or receipt

This avoids speculative "general safe agent chat" and keeps the first slice grounded.

### 3.3 Initial flow

Recommended first flow:

1. Two agents complete a vault session and receive a receipt.
2. One side mints a narrow capability grant for approved follow-up or logistics.
3. Subsequent out-of-vault messages are sent as IFC envelopes referencing the related receipt or session.
4. The receiver evaluates each message and gets `Allow`, `Hide`, `Escalate`, or `Block`.
5. If `Escalate` occurs, the system returns a structured escalation seed that can later feed AFAL session formation.

### 3.4 Candidate use cases

Good first-slice use cases:

- "I acknowledge receipt of the bounded result."
- "Here are three candidate times for the follow-up."
- "I consent to the next bounded step."
- "Here is a pointer to the artifact we agreed to exchange."

Bad first-slice use cases:

- substantive compatibility or mediation reasoning
- open-ended bargaining
- any communication that is effectively trying to continue the vault session in prose

Those should either block or escalate.

### 3.5 Minimal product and protocol requirements

The first slice should add:

- an architecture note defining IFC's modern role
- a minimal message envelope profile for post-session and logistics messages
- grant issuance and verification for those messages
- a clear policy for plain non-IFC messages in the selected surfaces
- logging / receipts sufficient to debug `Allow` / `Hide` / `Escalate` / `Block`

It should not yet add:

- broad pre-session IFC chat
- free-form negotiation inside IFC
- a full replacement for AFAL or vault session semantics

## 4. Open Design Questions

The following questions remain, but they do not block the first slice:

- Should some very low-risk channels auto-wrap plain messages into a lowest-tier IFC envelope, or should all production flows require explicit IFC wrapping?
- What exact `topic_code` ontology should IFC use when no active session exists?
- Should grants be minted only by completed receipts, or also by explicit user/operator action?
- How much of HIDE should be surfaced in developer tooling versus kept entirely internal?
- When escalation is wired end-to-end, should AFAL treat the escalation seed as a proposal hint or as a more formal proto-agreement object?

## 5. Recommendation

Reintegrate IFC as the default out-of-vault communication membrane, but do so through a narrow, session-adjacent first slice.

The architectural target is:

- **AFAL** for session admission
- **Vault contracts** for bounded computation
- **IFC** for bounded communication and context-flow control outside sessions
- **A2A** as an optional carrier for either AFAL or IFC payloads

This restores IFC as a structurally necessary part of the system rather than a dormant historical subsystem.
