# API Reference

The Selkey relay exposes a REST API over HTTP. All request and response bodies are JSON.

## Authentication

Bilateral session endpoints use bearer token authentication. Tokens are returned when a session is created and are scoped by role:

| Token | Can submit input | Can read status | Can read output |
|-------|-----------------|-----------------|-----------------|
| `initiator_submit_token` | Yes (once) | Yes | No |
| `responder_submit_token` | Yes (once) | Yes | No |
| `initiator_read_token` | No | Yes | Yes |
| `responder_read_token` | No | Yes | Yes |

Submit tokens are one-time use. Resubmission is rejected.

Auth errors are constant-shape: the relay returns `401 Unauthorized` for both invalid tokens and unknown sessions, preventing session enumeration.

## Endpoints

### `GET /health`

Health check. No authentication required.

**Response** `200 OK`
```json
{
  "status": "ok",
  "version": "0.1.0",
  "git_sha": "abc123...",
  "execution_lane": "API_MEDIATED",
  "provider": "redacted",
  "model_id": "redacted",
  "verifying_key_hex": "ab12...64-char hex Ed25519 public key...",
  "verifying_key_id": "ed25519:...64-char hex SHA-256 of the public key...",
  "policy_summary": {
    "policy_id": "default-v1",
    "policy_hash": "...",
    "model_profile_allowlist": ["..."],
    "enforcement_rules": ["no_pii", "..."]
  },
  "loaded_policy_hashes": ["..."]
}
```

`provider` and `model_id` are `"redacted"` unless `SELKEY_HEALTH_EXPOSE_MODEL=true`. `verifying_key_hex` is the relay's Ed25519 public key for receipt signature verification. `verifying_key_id` is its key id, `ed25519:` + hex(SHA-256(32-byte public key)); the hex part equals a receipt's `operator.operator_key_fingerprint`. `/health` is unauthenticated, so it is not a trust anchor: verify receipts against a key you pinned out of band, and use these fields only to check that the relay serves that key.

---

### `GET /capabilities`

Relay capabilities. No authentication required.

**Response** `200 OK`
```json
{
  "execution_lane": "API_MEDIATED",
  "providers": ["anthropic", "openai", "gemini"],
  "purposes": ["COMPATIBILITY", "MEDIATION", "SCHEDULING", ...],
  "entropy_enforcement": "GATE",
  "receipt_schema_version": "3.0.0",
  "enforcement_capabilities": ["..."],
  "available_schema_hashes": ["...content-addressed output schema hashes..."],
  "available_policy_hashes": ["...content-addressed enforcement policy hashes..."]
}
```

---

### `POST /relay`

Single-shot relay: submit both inputs and get a result in one call. No session management. Useful for testing and simple integrations.

**Access:** open with `SELKEY_ENV=dev`. Otherwise requires `Authorization: Bearer <SELKEY_OPERATOR_TOKEN>`, and returns 403 if no operator token is configured. See [environment-variables.md](environment-variables.md#network-binding-and-operator-access).

**Request**
```json
{
  "contract": {
    "purpose_code": "COMPATIBILITY",
    "output_schema_id": "vcav_e_compatibility_signal_v2",
    "output_schema": { "...JSON Schema..." },
    "participants": ["alice", "bob"],
    "prompt_template_hash": "abc123...",
    "entropy_budget_bits": 8,
    "model_profile_id": "anthropic-sonnet-4-5"
  },
  "input_a": {
    "role": "alice",
    "context": { "...structured input..." },
    "commitment_nonce": "...64 lowercase hex characters..."
  },
  "input_b": {
    "role": "bob",
    "context": { "...structured input..." },
    "commitment_nonce": "...64 lowercase hex characters..."
  },
  "provider": "anthropic"
}
```

The single caller supplies both inputs, so it generates both nonces: one fresh
32-byte nonce per input (see [`commitment_nonce`](#commitment_nonce)). Each
input is rejected if its nonce is missing or malformed. The contract follows
the same rules as `POST /sessions`.

`input_a` and `input_b` are labelled with `contract.participants[0]` and `[1]`;
the `role` fields are ignored. Because one caller supplied both inputs, the
receipt's `claims.signal_class` is `SINGLE_CALLER_COMPLETED`. Its input
commitments are still keyed by contract participant.

Sessions use `SESSION_COMPLETED`, which means the two inputs arrived through the
session's two role-scoped submit tokens. It does not attest who held them:
`POST /sessions` returns all four tokens to the creator, so one caller can
produce a `SESSION_COMPLETED` receipt. Only the inbox lane binds the tokens to
registry-authenticated agents (the sender gets the initiator tokens, the
recipient the responder tokens).

**Response** `200 OK`
```json
{
  "output": { "...validated JSON matching output_schema..." },
  "receipt": { "...signed receipt v3 (see GET /sessions/:id/output)..." }
}
```

---

### `POST /sessions`

Create a bilateral session. Returns a session ID and four role-scoped tokens.

**Access:** requires `Authorization: Bearer <SELKEY_OPERATOR_TOKEN>` when the relay has an operator token configured.

**Request**
```json
{
  "contract": {
    "purpose_code": "COMPATIBILITY",
    "output_schema_id": "vcav_e_compatibility_signal_v2",
    "output_schema": { "...JSON Schema..." },
    "participants": ["alice", "bob"],
    "prompt_template_hash": "abc123..."
  },
  "provider": "anthropic"
}
```

`provider` defaults to `"anthropic"` if omitted.

The contract is hashed exactly as received with **contract hash v2**
(`SHA256_JCS_V2`, see [receipt-verification-guide.md](receipt-verification-guide.md#contract-hash-v2)):
members outside the contract member set (including a `contract_hash` member) are
rejected with `400`, absent or `null` optional members are omitted, and the
result is canonicalised with RFC 8785. Numbers anywhere in the contract must be
within ±(2^53−1).

The relay runs every contract check at creation, before any input is submitted:
participants, enforcement policy (its `provider_allowlist`, `max_output_tokens` and
`entropy_constraints` included), model profile and allowlist, relay key pin, model
constraints, TTLs, output schema acceptance, the entropy limits below, the prompt
program, and that the provider is configured. A contract that would fail at
inference is rejected here with `400` and no session is created. The same checks
run again when inference starts. They read only artefacts fixed at startup, so a
contract accepted at creation passes them again; if one ever failed there, the
session would abort without a receipt (the failure is logged).

**Entropy limits.** The output schema's entropy upper bound must not exceed the
relay's per-session cap (`SELKEY_MAX_ENTROPY_BITS_PER_SESSION`, default 64 bits),
whatever the contract says. If the contract sets `entropy_budget_bits`, the bound
must also fit the budget unless the contract sets `entropy_enforcement: "Advisory"`;
`Gate` is the default. The receipt's `budget_usage.budget_limit` is the contract
budget capped by the operator limit (the operator limit when there is no budget).

**Limits.** Session creation (`POST /sessions` and `POST /relay`) is rate limited per
client address (`429`), the number of live sessions is capped (`503`), and request
bodies are limited to `SELKEY_MAX_BODY_BYTES` (default 256 KiB, `413`).

**Response** `200 OK`
```json
{
  "session_id": "...",
  "contract_hash": "...64-char hex contract hash v2 (SHA256_JCS_V2)...",
  "initiator_submit_token": "...",
  "initiator_read_token": "...",
  "responder_submit_token": "...",
  "responder_read_token": "..."
}
```

---

### `POST /sessions/:id/input`

Submit one participant's input. Requires a submit token.

**Headers:** `Authorization: Bearer <submit_token>`

**Request**
```json
{
  "role": "alice",
  "context": { "...structured input..." },
  "expected_contract_hash": "...optional, verified against session...",
  "commitment_nonce": "...required, 64 lowercase hex characters..."
}
```

`expected_contract_hash` is optional but recommended. If provided, the relay verifies it matches the session's contract hash (contract hash v2) before accepting input, so the input is only used under the contract the submitter expects.

#### `commitment_nonce`

**Required.** A fresh 32-byte value from a cryptographically secure random
generator, encoded as exactly **64 lowercase hex characters**. Generate a new
nonce for every submission and never reuse one. The relay rejects the
submission (`4xx`, the input is not recorded) if the nonce is missing, not a
string, or not exactly 64 lowercase hex characters. There is no relay-generated
fallback.

The nonce salts this party's input commitment in the receipt:

```
input_commitment = SHA-256("VCAV-INPUT-COMMIT-V3:" || nonce (32 raw bytes) || JCS(context))
```

The relay never writes the nonce to the receipt, logs or any response, and
clears it together with the inputs. Keep the nonce and the exact `context`
locally: together they let you check your own entry in the receipt (see
[receipt-verification-guide.md](receipt-verification-guide.md#own-input-check)).
The counterparty never sees your nonce, so it cannot test guesses of your input
against the commitment. Inputs appear in receipts only through these salted
commitments: no receipt field holds an unsalted hash of an input or of the
assembled prompt.

`context` must also be canonicalisable under the receipt v3 profile: numbers
must be within ±(2^53−1) (encode larger values as strings).

**Response** `200 OK`
```json
{
  "state": "Partial",
  "abort_reason": null
}
```

When the second input arrives, `state` transitions to `"Processing"` and inference starts automatically in the background.

---

### `GET /sessions/:id/status`

Poll session status. Any valid token (submit or read) can check status.

**Headers:** `Authorization: Bearer <any_token>`

**Response** `200 OK`
```json
{
  "state": "Processing",
  "abort_reason": null
}
```

**Session states:**

| State | Meaning |
|-------|---------|
| `Created` | Session created, no inputs yet |
| `Partial` | One input received, waiting for the other |
| `Processing` | Both inputs received, inference in progress |
| `Completed` | Output and receipt available |
| `Aborted` | Session failed (see `abort_reason`) |

**Abort reasons:** `Timeout`, `SchemaValidation`, `ProviderError`, `ContractMismatch`, `PolicyGate`

---

### `GET /sessions/:id/output`

Retrieve the bounded output and signed receipt. Requires a read token.

**Headers:** `Authorization: Bearer <read_token>`

**Response** `200 OK`
```json
{
  "state": "Completed",
  "abort_reason": null,
  "output": { "...validated JSON..." },
  "receipt": {
    "receipt_schema_version": "3.0.0",
    "receipt_canonicalization": "JCS_RFC8785",
    "receipt_id": "...",
    "session_id": "...",
    "issued_at": "2026-10-22T12:00:00Z",
    "assurance_level": "SELF_ASSERTED",
    "operator": {
      "operator_id": "...",
      "operator_key_fingerprint": "...SHA-256 of the 32-byte relay public key..."
    },
    "commitments": {
      "contract_hash": "...",
      "contract_hash_alg": "SHA256_JCS_V2",
      "schema_hash": "...",
      "output_hash": "...",
      "input_commitments": [
        { "participant_id": "alice", "input_commitment": "...", "scheme": "SHA256_N32_JCS_V3" },
        { "participant_id": "bob", "input_commitment": "...", "scheme": "SHA256_N32_JCS_V3" }
      ],
      "prompt_assembly_version": "1.0.0",
      "output": { "..." },
      "prompt_template_hash": "...",
      "effective_config_hash": "...",
      "preflight_bundle": { "..." }
    },
    "claims": {
      "status": "success",
      "signal_class": "SESSION_COMPLETED",
      "budget_usage": { "scope": "SESSION", "bits_used_before": 0, "bits_used_after": 6, "budget_limit": 32 },
      "...additional claims..."
    },
    "signature": {
      "alg": "Ed25519",
      "value": "...base64url, no padding...",
      "signed_fields": "ALL_EXCEPT_SIGNATURE"
    }
  }
}
```

`receipt` is a **receipt v3** (the only format the relay emits). An aborted
session that reached inference carries a signed failure receipt (`claims.status`
other than `success`, `output_hash` = SHA-256 of zero bytes, no inline
`output`). If the session is not yet completed, `output` and `receipt` are
`null`. See [receipt-verification-guide.md](receipt-verification-guide.md) for
verification.

### `GET /sessions/:id/metadata` (dev only)

Diagnostic timings and sizes, available only with `SELKEY_ENV=dev` (otherwise `401`).
Requires a read token. Each participant sees its own input time and size; the
counterparty's `*_input_at` and `*_input_bytes` are `null`.

## Inbox endpoints

The inbox system enables asynchronous session setup. An agent sends an invite to another agent; the recipient can accept (creating a bilateral session), decline, or let it expire. All inbox endpoints use bearer token authentication via the **agent registry** — tokens are configured per-agent in the relay's agent registry, not session-scoped.

**Headers:** `Authorization: Bearer <agent_registry_token>`

---

### `POST /invites`

Create a new invite to another agent.

**Request**
```json
{
  "to_agent_id": "bob",
  "contract": { "...same contract shape as POST /sessions..." },
  "provider": "gemini",
  "purpose_code": "MEDIATION",
  "from_agent_pubkey": "aa...64-char hex Ed25519 public key (optional)..."
}
```

`provider` defaults to the first configured provider if empty. `to_agent_id` must be a registered agent, and the contract's `participants` must be `[sender, to_agent_id]` in that order (the sender receives the initiator tokens, whose input is committed under `participants[0]`). The contract checks described under `POST /sessions` run before the invite is stored, and again on accept. Invite creation is rate limited per sending agent, and each agent may have a limited number of pending invites (`429`); the total number of invites is capped (`503`). The invite expires after the contract's `invite_ttl_secs` if set (never above `SELKEY_INVITE_TTL_SECS`). The invite's `from_agent_pubkey` is always the sender's `public_key_hex` from the agent registry (or absent if none is registered). A request `from_agent_pubkey` is optional; if present it must equal the registered key, otherwise the request is rejected with `400`.

**Response** `200 OK`
```json
{
  "invite_id": "inv_...",
  "contract_hash": "...64-char hex contract hash v2 (SHA256_JCS_V2)...",
  "status": "PENDING",
  "expires_at": "2026-03-14T12:00:00Z"
}
```

---

### `GET /inbox`

List invites received by the authenticated agent.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status: `PENDING`, `ACCEPTED`, `DECLINED`, `CANCELED`, `EXPIRED` |
| `from_agent_id` | string | Filter by sender |
| `limit` | integer | Max results (default 50, max 200) |

**Response** `200 OK`
```json
{
  "invites": [
    {
      "invite_id": "inv_...",
      "from_agent_id": "alice",
      "from_agent_pubkey": "aa...optional...",
      "status": "PENDING",
      "purpose_code": "MEDIATION",
      "contract_hash": "...",
      "created_at": "2026-03-07T12:00:00Z",
      "expires_at": "2026-03-14T12:00:00Z"
    }
  ],
  "latest_event_id": 42
}
```

---

### `GET /invites/:id`

Get full invite details. Both sender and recipient can access their own invites.

**Response** `200 OK`
```json
{
  "invite_id": "inv_...",
  "from_agent_id": "alice",
  "to_agent_id": "bob",
  "from_agent_pubkey": "aa...optional...",
  "status": "PENDING",
  "purpose_code": "MEDIATION",
  "contract_hash": "...",
  "contract_json": { "...the normalised proposed contract..." },
  "provider": "gemini",
  "created_at": "2026-03-07T12:00:00Z",
  "updated_at": "2026-03-07T12:00:00Z",
  "expires_at": "2026-03-14T12:00:00Z",
  "decline_reason_code": null,
  "session_id": null,
  "submit_token": null,
  "read_token": null
}
```

`contract_json` is the proposed contract as normalised by contract hash v2 (absent and `null` optional members omitted). Its contract hash v2 equals `contract_hash`, so a recipient can check the proposal locally before accepting.

When status is `ACCEPTED`, `session_id`, `submit_token`, and `read_token` are populated. Tokens are **role-redacted**: the sender sees initiator tokens, the recipient sees responder tokens. Neither side can access the other's tokens.

---

### `POST /invites/:id/accept`

Accept a pending invite. Creates a bilateral session and returns role-scoped tokens. The contract checks run again first; if they fail the invite stays `PENDING` and no session is created.

**Request**
```json
{
  "expected_contract_hash": "...optional, verified against invite..."
}
```

**Response** `200 OK` — same shape as `GET /invites/:id`, with `status: "ACCEPTED"` and session tokens populated.

---

### `POST /invites/:id/decline`

Decline a pending invite.

**Request**
```json
{
  "reason_code": "NOT_INTERESTED"
}
```

Reason codes: `NOT_INTERESTED`, `BUSY`, `POLICY_MISMATCH`, `UNKNOWN_SENDER`.

**Response** `200 OK` — same shape as `GET /invites/:id`, with `status: "DECLINED"`.

---

### `POST /invites/:id/cancel`

Cancel a pending invite (sender only). No request body required.

**Response** `200 OK` — same shape as `GET /invites/:id`, with `status: "CANCELED"`.

---

### `GET /inbox/events`

Server-Sent Events stream for real-time inbox notifications. One connection per agent.

**Event types:** `invite_created`, `invite_accepted`, `invite_declined`, `invite_expired`, `invite_canceled`

**Event data:**
```json
{
  "event_id": 43,
  "event_type": "INVITE_CREATED",
  "invite_id": "inv_...",
  "from_agent_id": "alice",
  "timestamp": "2026-03-07T12:00:05Z"
}
```

Keep-alive pings are sent every 15 seconds. If the client lags behind, events may be dropped (lossy wakeup).

**Invite state machine:**

| From | To | Triggered by |
|------|----|-------------|
| `PENDING` | `ACCEPTED` | Recipient accepts |
| `PENDING` | `DECLINED` | Recipient declines |
| `PENDING` | `CANCELED` | Sender cancels |
| `PENDING` | `EXPIRED` | TTL expires (background reaper) |

All terminal states are idempotent. No transitions from one terminal state to another.

---

## Error responses

All errors return a JSON body with an `error` field:

```json
{ "error": "description" }
```

| Status | Meaning |
|--------|---------|
| `400 Bad Request` | Invalid contract or prompt program |
| `401 Unauthorized` | Invalid token, unknown session, or wrong role (constant-shape — no distinction) |
| `413 Payload Too Large` | Request body above `SELKEY_MAX_BODY_BYTES` |
| `429 Too Many Requests` | Creation rate limit or pending-invite limit reached (`{"error": "RATE_LIMITED"}`) |
| `503 Service Unavailable` | Session or invite capacity reached (`{"error": "SERVICE_UNAVAILABLE"}`) |
| `422 Unprocessable Entity` | Output failed schema validation or guardian policy gate |
| `502 Bad Gateway` | Upstream provider error |
| `500 Internal Server Error` | Receipt signing failure or internal error |

## Session lifecycle

Sessions expire after the contract's `session_ttl_secs` if set, otherwise `SELKEY_SESSION_TTL_SECS` (default: 600 seconds); a contract TTL above the relay TTL is rejected. A background reaper cleans up expired sessions. A session still processing one TTL after inference started is aborted with `TIMEOUT` and its inference task is cancelled. Tokens for expired sessions return `401 Unauthorized`.
