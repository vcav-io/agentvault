# A2A Extension Spec: `urn:agentvault:bounded-disclosure:v1`

> Status: Canonical reference for the AgentVault A2A extension
> Companion: [a2a-integration-spec.md](./a2a-integration-spec.md) (transport integration overview)

## 1. Extension URI and Versioning

**URI:** `urn:agentvault:bounded-disclosure:v1`

The URI is declared in `capabilities.extensions` of an A2A Agent Card. The
trailing `:v1` is the extension version. Future breaking changes will increment
to `:v2`; additive fields within v1 are backward compatible (consumers must
ignore unknown fields).

The `extension_version` field in the signed card payload is `"1"` (string).

## 2. Extension Parameters

The `params` object of the extension carries the `AgentVaultA2AExtensionParams`
interface:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `public_key_hex` | `string` | Yes | Ed25519 public key (hex) for signature verification |
| `supported_purposes` | `string[]` | Yes | Purpose codes this agent accepts (e.g. `"COMPATIBILITY"`, `"MEDIATION"`) |
| `relay_url` | `string` | No | Preferred relay URL for sessions with this agent |
| `afal_endpoint` | `string` | No | AFAL HTTP base endpoint (e.g. `https://agent.example.com/afal`). Omit for A2A-only agents |
| `a2a_send_message_url` | `string` | No | Explicit A2A SendMessage endpoint URL |
| `supports_precontract_negotiation` | `boolean` | No | `true` if the agent supports pre-contract offer negotiation |
| `supports_bespoke_contract_negotiation` | `boolean` | No | `true` if the agent supports bespoke (custom) contract negotiation |
| `supported_contract_offers` | `SupportedContractOffer[]` | No | List of contract offers this agent can fulfill (see section 7) |
| `card_signature` | `string` | No | Ed25519 signature (hex) over the canonical card payload (see section 3) |

JSON Schema: [`schemas/a2a-extension-params.schema.json`](../../schemas/a2a-extension-params.schema.json)

## 3. Signed Agent Cards

### 3.1 Signed Payload

When `card_signature` is present, it is an Ed25519 signature over a
JCS-canonicalized `AgentCardSignedPayload` object with domain prefix
`VCAV-AGENT-CARD-V1:`.

The signed payload contains these fields (alphabetically sorted for
deterministic canonicalization):

| Field | Type | Source |
|-------|------|--------|
| `agent_id` | `string` | `card.name` |
| `extension_uri` | `string` | Always `"urn:agentvault:bounded-disclosure:v1"` |
| `extension_version` | `string` | Always `"1"` |
| `public_key_hex` | `string` | From extension params |
| `supported_purposes` | `string[]` | From extension params |
| `relay_url` | `string` | From extension params (omitted if absent) |
| `a2a_send_message_url` | `string` | From extension params (omitted if absent) |
| `afal_endpoint` | `string` | From extension params (omitted if absent) |

Optional fields (`relay_url`, `a2a_send_message_url`, `afal_endpoint`) are
included in the signed payload only when present in the extension params.
The verifier must reconstruct the same object from the received card —
omitting absent fields, not setting them to `null` or empty string.

### 3.2 Verification

To verify a card signature:

1. Extract `card.name` as `agent_id`
2. Build the `AgentCardSignedPayload` from the extension params (excluding
   `card_signature` itself, `supports_precontract_negotiation`,
   `supports_bespoke_contract_negotiation`, and `supported_contract_offers`)
3. JCS-canonicalize the payload
4. Verify the Ed25519 signature using `VCAV-AGENT-CARD-V1:` domain prefix
   and the `public_key_hex` from the extension params

### 3.3 Unsigned Card Transition Policy

**Current behavior:** `card_signature` is optional. Agents may publish
unsigned cards.

**Lenient mode (default):** When `card_signature` is absent, the client logs
a warning and proceeds. The trust anchor falls back to the fetched A2A
document itself (HTTPS transport security only).

**Strict mode:** When `DirectAfalTransportConfig.requireSignedCards` is `true`:
- Unsigned cards are rejected with an error
- In strict mode, `a2a_send_message_url` must be explicitly present in the
  signed extension params; fallback derivation from `card.url` is forbidden

**Guarantees lost without signatures:**
- No proof that the card was issued by the holder of the Ed25519 key
- No tamper detection if the card is served through a compromised CDN or proxy
- No binding between the public key and the declared endpoints

**Deprecation timeline:** Unsigned cards are supported for backward
compatibility. A future extension version (`:v2`) may require signatures.
Implementers should begin signing cards now.

## 4. Media Types

Six media types are defined for A2A message parts:

| Media Type | Direction | Content | Task State |
|------------|-----------|---------|------------|
| `application/vnd.agentvault.propose+json` | Initiator -> Responder | Signed AFAL propose envelope | n/a (request) |
| `application/vnd.agentvault.admit+json` | Responder -> Initiator | Signed AFAL admit envelope | `working` (with task_id) or `completed` (without) |
| `application/vnd.agentvault.deny+json` | Responder -> Initiator | Signed AFAL deny envelope | `failed` |
| `application/vnd.agentvault.session-tokens+json` | Initiator -> Responder (commit) / Responder -> Initiator (ack) | Signed COMMIT with relay session binding / acknowledgment | `completed` |
| `application/vnd.agentvault.contract-offer-proposal+json` | Initiator -> Responder | Pre-contract negotiation proposal | n/a (request) |
| `application/vnd.agentvault.contract-offer-selection+json` | Responder -> Initiator | Contract offer selection response | `completed` |

## 5. Task Lifecycle States and Transitions

The A2A task lifecycle tracks the bootstrap handshake through stateful
transitions. Task state is carried in the `status.state` field of A2A Task
response objects.

### 5.1 State Definitions

| State | Type | Meaning |
|-------|------|---------|
| `submitted` | `A2ATaskState` | Task received but not yet processed (standard A2A; not emitted by AgentVault) |
| `working` | `A2ATaskState` | Proposal admitted; awaiting session token delivery (COMMIT) |
| `completed` | `A2ATaskState` | Handshake finished successfully |
| `failed` | `A2ATaskState` | Proposal denied or handshake failed |

### 5.2 State Transitions

```
                     ┌─────────────┐
   PROPOSE ─────────>│   working   │──── session-tokens (COMMIT) ────>  completed
   (with task_id)    └──────┬──────┘
                            │
                         (deny)
                            │
                            v
                         failed
```

**Stateful path (task_id present):**
- PROPOSE with `configuration.task_id` -> ADMIT response has state `working`
- Session-tokens (COMMIT) using same `task_id` -> response has state `completed`
- DENY response -> state `failed`

**Stateless path (no task_id, backward compatible):**
- PROPOSE without task_id -> ADMIT response has state `completed`
- DENY response has state `completed` or `failed`

### 5.3 In-Flight Task Tracking

The HTTP server tracks in-flight tasks (state `working`) with a TTL of 10
minutes. Tasks are garbage-collected on each incoming A2A request. When a
session-tokens message arrives for a tracked task, the task is removed from
the in-flight map and the response carries state `completed`.

### 5.4 Task ID Format

Task IDs are provided by the initiator in `configuration.task_id`. The
implementation uses the convention `task-propose-{proposal_id}` for bootstrap
tasks and `task-negotiate-{negotiation_id}` for contract negotiation tasks,
but the format is not normative — any string is accepted.

## 6. Relay Preference Arbitration

Relay preference enables the responder to declare which relay it prefers or
requires for the session.

### 6.1 RelayPreference Structure

```typescript
interface RelayPreference {
  relay_url: string;
  policy: 'REQUIRED' | 'PREFERRED';
}
```

Carried in `AfalAdmit.relay_preference` (optional).

### 6.2 Policy Semantics

**REQUIRED:**
- The initiator must use the specified `relay_url`
- COMMIT must include `chosen_relay_url` matching the required URL
- Mismatch or missing `chosen_relay_url` causes COMMIT rejection

**PREFERRED:**
- The responder prefers the specified relay but will accept alternatives
- If the initiator has no explicit relay override (`config.relayUrl`), the
  responder's preferred relay is used
- If the initiator has an explicit relay URL that differs, the initiator's
  choice wins (with a warning logged)
- Missing `chosen_relay_url` in COMMIT triggers a warning but is allowed

**Absent (no relay_preference):**
- Initiator-chooses semantics (backward compatible with pre-arbitration agents)
- No `chosen_relay_url` validation on COMMIT

### 6.3 Responder Configuration

The responder declares relay preference via `AdmissionPolicy.relayPreference`:

```typescript
interface AdmissionPolicy {
  // ... other fields ...
  relayPreference?: RelayPreference;
}
```

When set, the preference is included in every ADMIT response.

### 6.4 Initiator Arbitration Logic

On receiving an ADMIT with `relay_preference`:

1. If policy is `REQUIRED`: use `relay_preference.relay_url` unconditionally
2. If policy is `PREFERRED`:
   - If initiator has no explicit relay config, or initiator's relay matches: use responder's relay
   - If initiator has an explicit different relay: use initiator's relay (override)
3. If `relay_preference` is absent: initiator chooses freely

## 7. Pre-Contract Negotiation

Agents that advertise `supports_precontract_negotiation: true` accept contract
offer proposals before the PROPOSE/ADMIT handshake.

### 7.1 Contract Offer Proposal

```typescript
interface ContractOfferProposal {
  negotiation_id: string;
  acceptable_offers: NegotiableContract[];
  expected_counterparty?: string;
}

type NegotiableContract = NegotiableContractOffer | NegotiableBespokeContract;

interface NegotiableContractOffer {
  kind: 'offer';
  contract_offer_id: string;
  acceptable_model_profiles: ModelProfileRef[];
}

interface NegotiableBespokeContract {
  kind: 'bespoke';
  purpose_code: string;
  schema_ref: string;
  policy_ref: string;
  program_ref: string;
  acceptable_model_profiles: ModelProfileRef[];
}
```

### 7.2 Contract Offer Selection

```typescript
type ContractOfferSelectionState = 'AGREED' | 'NO_COMMON_CONTRACT' | 'REJECTED';

interface ContractOfferSelection {
  negotiation_id: string;
  state: ContractOfferSelectionState;
  selected_contract_offer_id?: string;           // present when state=AGREED and kind=offer
  selected_bespoke_contract?: NegotiableBespokeContract;  // present when state=AGREED and kind=bespoke
  selected_model_profile?: ModelProfileRef;       // present when state=AGREED
}
```

### 7.3 Supported Contract Offers (Card Params)

```typescript
interface SupportedContractOffer {
  contract_offer_id: string;
  supported_model_profiles: ModelProfileRef[];
}
```

### 7.4 Model Profile References

```typescript
interface ModelProfileRef {
  id: string;
  version: string;
  hash: string;
}
```

## 8. Backward Compatibility

### 8.1 Unsigned Cards

Agents that do not include `card_signature` are accepted in lenient mode
(the default). See section 3.3 for the transition policy.

### 8.2 Missing relay_preference

When `AfalAdmit.relay_preference` is absent, the initiator uses its own
relay configuration (initiator-chooses). This is the pre-arbitration default
and matches the behavior of agents that predate relay preference support.

### 8.3 Missing task_id

When `configuration.task_id` is absent in a SendMessage request, the server
falls back to stateless single-shot semantics: ADMIT responses carry state
`completed` instead of `working`, and no in-flight task tracking occurs.
This is backward compatible with clients that predate task lifecycle support.

### 8.4 Missing Pre-Contract Negotiation Fields

Agents that do not advertise `supports_precontract_negotiation` or
`supported_contract_offers` simply skip pre-contract negotiation. The
initiator proceeds directly to PROPOSE/ADMIT.

### 8.5 A2A Send Message URL Derivation

When `a2a_send_message_url` is not present in the extension params and strict
mode is disabled, the client derives the endpoint from `card.url` by appending
`/a2a/send-message`. In strict mode, this fallback is forbidden — the URL must
be explicitly present in the signed params.

## 9. Domain Prefixes

All Ed25519 signatures use domain-separated signing with a prefix string
prepended to the JCS-canonicalized message before signing:

| Domain Prefix | Usage |
|---------------|-------|
| `VCAV-AGENT-CARD-V1:` | Agent card signature |
| `VCAV-DESCRIPTOR-V1:` | Agent descriptor signature |
| `VCAV-PROPOSE-V1:` | AFAL propose message |
| `VCAV-ADMIT-V1:` | AFAL admit message |
| `VCAV-DENY-V1:` | AFAL deny message |
| `VCAV-COMMIT-V1:` | AFAL commit message |

## 10. HTTP Server Routes

The AFAL HTTP server exposes the following routes:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/agent-card.json` | A2A Agent Card |
| `GET` | `/afal/descriptor` | Agent descriptor (AFAL legacy) |
| `POST` | `/afal/propose` | Direct AFAL propose |
| `POST` | `/afal/commit` | Direct AFAL commit |
| `POST` | `/afal/negotiate` | Contract offer negotiation (direct) |
| `POST` | `/a2a/send-message` | A2A-native message endpoint (propose, session-tokens, contract-offer-proposal) |

Guards: 64 KB body limit, `Content-Type: application/json` enforcement on POST,
16 max concurrent requests (503 if exceeded), loopback binding by default.
