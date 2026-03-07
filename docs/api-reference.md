# API Reference

The AgentVault relay exposes a REST API over HTTP. All request and response bodies are JSON.

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
  "policy_summary": {
    "policy_id": "default-v1",
    "policy_hash": "...",
    "model_profile_allowlist": ["..."],
    "enforcement_rules": ["no_pii", "..."]
  },
  "loaded_policy_hashes": ["..."]
}
```

`provider` and `model_id` are `"redacted"` unless `AV_HEALTH_EXPOSE_MODEL=true`. `verifying_key_hex` is the relay's Ed25519 public key for receipt signature verification.

---

### `GET /capabilities`

Relay capabilities. No authentication required.

**Response** `200 OK`
```json
{
  "execution_lane": "API_MEDIATED",
  "providers": ["anthropic", "openai", "gemini"],
  "purposes": ["COMPATIBILITY", "MEDIATION", "SCHEDULING", ...],
  "entropy_enforcement": "ADVISORY",
  "receipt_schema_version": "2.1.0",
  "enforcement_capabilities": ["..."],
  "available_schema_hashes": ["...content-addressed output schema hashes..."],
  "available_policy_hashes": ["...content-addressed enforcement policy hashes..."]
}
```

---

### `POST /relay`

Single-shot relay: submit both inputs and get a result in one call. No session management. Useful for testing and simple integrations.

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
    "context": { "...structured input..." }
  },
  "input_b": {
    "role": "bob",
    "context": { "...structured input..." }
  },
  "provider": "anthropic"
}
```

**Response** `200 OK`
```json
{
  "output": { "...validated JSON matching output_schema..." },
  "receipt": { "...signed receipt..." },
  "receipt_signature": "...128-char hex Ed25519 signature..."
}
```

---

### `POST /sessions`

Create a bilateral session. Returns a session ID and four role-scoped tokens.

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

**Response** `200 OK`
```json
{
  "session_id": "...",
  "contract_hash": "...64-char hex SHA-256 of JCS-canonicalized contract...",
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
  "expected_contract_hash": "...optional, verified against session..."
}
```

`expected_contract_hash` is optional but recommended. If provided, the relay verifies it matches the session's contract hash before accepting input. This prevents a contract substitution attack where a malicious session creator advertises one contract hash while using a different (more permissive) contract.

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
    "schema_version": "2.1.0",
    "session_id": "...",
    "purpose_code": "COMPATIBILITY",
    "participant_ids": ["alice", "bob"],
    "contract_hash": "...",
    "guardian_policy_hash": "...",
    "prompt_template_hash": "...",
    "model_profile_hash": "...",
    "runtime_hash": "...",
    "output": { "..." },
    "output_entropy_bits": 4.2,
    "...additional fields..."
  },
  "receipt_signature": "...128-char hex Ed25519 signature..."
}
```

If the session is not yet completed, `output`, `receipt`, and `receipt_signature` are `null`.

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

`provider` defaults to the first configured provider if empty. `from_agent_pubkey` is optional; if omitted, the relay uses the public key from the agent registry entry (if any).

**Response** `200 OK`
```json
{
  "invite_id": "inv_...",
  "contract_hash": "...64-char hex SHA-256...",
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

When status is `ACCEPTED`, `session_id`, `submit_token`, and `read_token` are populated. Tokens are **role-redacted**: the sender sees initiator tokens, the recipient sees responder tokens. Neither side can access the other's tokens.

---

### `POST /invites/:id/accept`

Accept a pending invite. Creates a bilateral session and returns role-scoped tokens.

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
| `422 Unprocessable Entity` | Output failed schema validation or guardian policy gate |
| `502 Bad Gateway` | Upstream provider error |
| `500 Internal Server Error` | Receipt signing failure or internal error |

## Session lifecycle

Sessions expire after `AV_SESSION_TTL_SECS` (default: 600 seconds). A background reaper cleans up expired sessions. Tokens for expired sessions return `401 Unauthorized`.
