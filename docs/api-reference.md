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
  "execution_lane": "API_MEDIATED"
}
```

---

### `GET /capabilities`

Relay capabilities. No authentication required.

**Response** `200 OK`
```json
{
  "execution_lane": "API_MEDIATED",
  "providers": ["anthropic", "openai"],
  "purposes": ["COMPATIBILITY", "MEDIATION", "SCHEDULING", ...],
  "entropy_enforcement": "ADVISORY",
  "receipt_schema_version": "2.0.0"
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
    "schema_version": "2.0.0",
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

Sessions expire after `VCAV_SESSION_TTL_SECS` (default: 600 seconds). A background reaper cleans up expired sessions. Tokens for expired sessions return `401 Unauthorized`.
