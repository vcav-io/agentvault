# Environment Variables

Complete reference for all environment variables used by the Selkey relay and MCP server.

## Relay (`selkey-relay`)

### Required

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` | At least one provider API key. Each one that is set enables that provider; the relay refuses to start with none |
| `SELKEY_SIGNING_KEY_HEX` | 64-char hex Ed25519 signing key for receipt signing (e.g. `openssl rand -hex 32`). Outside `SELKEY_ENV=dev` the relay refuses to start without it. In dev, if unset, a random key is generated on each start and receipts won't verify across restarts. The key id logged at startup and reported by `/health` is `ed25519:` + hex(SHA-256(public key)) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `SELKEY_ENV` | unset | Set to `dev` for development mode: an ephemeral signing key if none is set, strict inline output schemas accepted, `POST /relay` open (unauthenticated) when no `SELKEY_OPERATOR_TOKEN` is set, `GET /sessions/:id/metadata` (input sizes and timings, which the relay records only in dev), and the development overrides below |
| `SELKEY_PORT` | `3100` | Port the relay listens on |
| `SELKEY_ALLOWED_HOSTS` | unset | Comma-separated extra hostnames accepted in the `Host` header (e.g. a compose service name). When the relay listens on loopback, or when this is set, requests whose `Host` is not `localhost`, `127.0.0.1`, `[::1]` or a listed name get `403`. This blocks DNS-rebinding requests from browser pages to a local relay |
| `SELKEY_ALLOW_UNAUTHENTICATED` | unset | Set to `1` to let the relay (dev or not) start on a non-loopback address without `SELKEY_OPERATOR_TOKEN` (only when access is controlled elsewhere, e.g. a container port published on loopback) |
| `SELKEY_BIND_ADDR` | `127.0.0.1` | IP address the relay listens on. Loopback by default; set `0.0.0.0` (or a specific interface) to accept remote connections, e.g. inside a container |
| `SELKEY_OPERATOR_TOKEN` | — | Operator bearer token. When set, `POST /relay` and `POST /sessions` require `Authorization: Bearer <token>`. Use at least 32 characters from a random generator (e.g. `openssl rand -hex 32`). The relay refuses to start with a token that is shorter, has few distinct characters or repeats a shorter sequence; these checks catch obvious mistakes, not weak generators |
| `SELKEY_MODEL_ID` | `claude-sonnet-4-6` | Anthropic model ID |
| `SELKEY_OPERATOR_ID` | `selkey-relay-dev` | `operator.operator_id` in receipts |
| `SELKEY_MAX_COMPLETION_TOKENS` | `4096` | Relay ceiling on completion tokens. A contract's `max_completion_tokens` can lower it for that session. An invalid value logs a warning and uses the default |
| `SELKEY_HEALTH_EXPOSE_MODEL` | `false` | `true`, `1` or `yes` makes `GET /health` report the provider and model ID instead of `"redacted"` |
| `SELKEY_DEFAULT_POLICY_HASH` | unset | Enforcement policy used when a contract has no `enforcement_policy_hash`. Must name a loaded, lockfile-verified policy. Required when more than one policy is loaded. Ignored when `SELKEY_REGISTRY_PATH` is set: the default then comes from `policies.default` in the admission config |
| `SELKEY_PROMPT_PROGRAM_DIR` | `prompt_programs` | Directory containing prompt programs, model profile lockfile, and enforcement policy lockfile |
| `SELKEY_SCHEMA_DIR` | `<prompt dir>/../schemas/output` | Directory of content-addressed output schemas (the schema registry). Set it to the repo's `schemas/output` when running from a checkout; the Docker image sets it. The relay refuses to start if the directory cannot be read or a schema in it declares a JSON Schema draft other than draft 7 (see [Output schema acceptance](#output-schema-acceptance)) |
| `SELKEY_SESSION_TTL_SECS` | `600` | Maximum session lifetime in seconds. A contract's `session_ttl_secs` can shorten it for that session. Background reaper cleans up expired sessions. A session still processing one TTL after inference started is aborted with `TIMEOUT` |
| `OPENAI_API_KEY` | — | Enables the OpenAI provider when set |
| `SELKEY_OPENAI_MODEL_ID` | `gpt-4o` | OpenAI model ID (only used if `OPENAI_API_KEY` is set) |
| `GEMINI_API_KEY` | — | Enables the Gemini provider when set |
| `SELKEY_GEMINI_MODEL_ID` | `gemini-3-flash-preview` | Gemini model ID (only used if `GEMINI_API_KEY` is set) |
| `ANTHROPIC_BASE_URL` | — | Override Anthropic API base URL (for proxies or mock servers) |
| `OPENAI_BASE_URL` | — | Override OpenAI API base URL |
| `GEMINI_BASE_URL` | — | Override Gemini API base URL |
| `SELKEY_REGISTRY_PATH` | unset | Path to a local artefact registry checkout. When set, the relay loads schemas, policies, model profiles and prompt programs through registry admission (digests checked at startup; any mismatch stops startup) instead of the lockfiles |
| `SELKEY_ADMISSION_CONFIG` | `relay-admission.toml` | Admission config file used with `SELKEY_REGISTRY_PATH`. A relative path is resolved against the working directory |
| `RUST_LOG` | — | Standard `tracing` log filter (e.g. `info`, `selkey_relay=debug`) |

### Network binding and operator access

The relay listens on `127.0.0.1` unless `SELKEY_BIND_ADDR` says otherwise. In Docker, set
`SELKEY_BIND_ADDR=0.0.0.0` inside the container and choose exposure when publishing the port
(the demo compose file publishes `127.0.0.1:3100:3100`).

The relay refuses to start on a non-loopback address unless `SELKEY_OPERATOR_TOKEN` is set. This
applies with `SELKEY_ENV=dev` too. The demo compose file sets a shared
`SELKEY_OPERATOR_TOKEN` (a published demo value, not a secret) for the relay and the demo service.
If access is controlled some other way (for example an authenticating reverse proxy), set
`SELKEY_ALLOW_UNAUTHENTICATED=1` to start without a token.

| Endpoint | `SELKEY_ENV=dev`, no token | Non-dev, no token | `SELKEY_OPERATOR_TOKEN` set |
|---|---|---|---|
| `POST /relay` (one caller supplies both inputs) | open | **disabled** (403) | token required |
| `POST /sessions` | open | open | token required |
| Session input/status/output | per-session tokens | per-session tokens | per-session tokens |
| `POST /invites` and inbox | agent registry tokens | agent registry tokens | agent registry tokens |

When the relay is reachable beyond localhost, set `SELKEY_OPERATOR_TOKEN` (and use the agent
registry for invites). The relay logs a warning at startup if it binds to a non-loopback address
without an operator token.

### Output schema acceptance

Contracts must use an output schema from the relay's schema registry, matched by content hash
(either `output_schema_hash` with a stub `output_schema: {}`, or the full registry schema inline).
The relay computes the entropy upper bound for registry schemas and rejects the contract if it
cannot.

With `SELKEY_ENV=dev`, the relay also accepts inline schemas that are not in the registry, but only
strict ones: `additionalProperties: false` and every property `required` on every object; every
string bounded by `enum` or `maxLength`; every array bounded by `maxItems`; integers bounded by
`minimum`/`maximum`; `number` (non-integer) values only through `enum`; `const` allowed (0 bits);
no `true`/`{}` subschemas, composition (`anyOf`, `oneOf`, ...), `$ref`, `patternProperties` or
`$schema`. Object keywords (`properties`, `required`, `additionalProperties`) are allowed only on
`type: "object"` nodes, and array keywords (`items`, `minItems`, `maxItems`, `uniqueItems`) only
on `type: "array"` nodes, in both cases without `enum`/`const`. For
these schemas the relay computes the entropy bound from the structure and ignores any
`x-vcav-entropy-bits-upper-bound` annotations. The per-session cap
(`SELKEY_MAX_ENTROPY_BITS_PER_SESSION`, default 64 bits) applies to inline schemas too, so a
free-text field of more than a few characters needs the operator to raise it.

Model output is validated against the output schema as JSON Schema draft 7. A schema may name
draft 7 in a root `$schema` keyword; any other `$schema` (another draft at the root, or `$schema`
anywhere below the root, such as in a `$ref` target) is rejected, because the validator would
otherwise switch drafts for that part of the schema. A registry directory containing such a schema
stops the relay at startup, and contracts using one are rejected. Every output schema is also
compiled when the contract is accepted, so a schema the validator cannot compile (for example an
invalid `pattern`) is rejected before any provider call.

Before release, integral numbers in the model output are rewritten as JSON integers (`2.0`,
`2e0` → `2`), so a value has one representation.

Enforcement policy rules also apply to inline schemas. Under the default policy
(`compatibility_safe_v1`), the digit rule (`Nd`) checks JSON numbers by their text, so it
rejects **every** numeric output value: `integer` and `number` fields are not usable with that
policy. Use string enums, or a policy without the digit rule.

### Lockfile overrides (development only)

These require `SELKEY_ENV=dev` to have any effect. Production deployments must always use lockfiles.

| Variable | Description |
|----------|-------------|
| `SELKEY_ENFORCEMENT_LOCKFILE_SKIP` | Set to `1` (with `SELKEY_ENV=dev`) to start without `relay_policies.lock` (enforcement policy lockfile validation is skipped) |

There is no override for model profile lockfile validation.

### Inbox Persistence (feature-gated)

The relay's inbox can persist invites to SQLite. This requires building with the `persistence` feature:

```bash
cargo build --features persistence
```

| Variable | Default | Description |
|----------|---------|-------------|
| `SELKEY_INBOX_DB_PATH` | — | Path to the SQLite database file for inbox persistence. Required when running with `--features persistence`. If unset, the relay falls back to in-memory storage |
| `SELKEY_INVITE_TTL_SECS` | `604800` | Invite lifetime in seconds (7 days). A value that isn't a whole number is ignored and the default used. Applies with or without persistence |

### Limits

Unset variables use the default. A set value must be a positive integer, or the relay refuses to start.

Provisioning: the two store budgets together allow `2 × SELKEY_MAX_STORE_BYTES` of estimated heap. Real resident memory can reach about 2–3 times that (allocator overhead and fragmentation, other allocators than glibc), plus transient memory for requests being parsed (up to `SELKEY_MAX_BODY_BYTES` per request, many times that once parsed). Size the container accordingly, or lower `SELKEY_MAX_STORE_BYTES`.

Contracts have fixed size limits, checked before a session or invite is created (`400` above them): 16 KiB for the whole contract as compact JSON, 256 KiB of estimated heap once parsed, 2 KiB for `metadata`, and 256 bytes for each string outside `output_schema` and `metadata` (participant ids, hashes, profile ids).

| Variable | Default | Description |
|----------|---------|-------------|
| `SELKEY_MAX_ENTROPY_BITS_PER_SESSION` | `64` | Per-session cap on the output schema's entropy upper bound. Applies to every contract, whatever its `entropy_budget_bits` or `entropy_enforcement`; a contract above it is rejected at session or invite creation |
| `SELKEY_MAX_BODY_BYTES` | `262144` | Maximum request body size (`413` above it) |
| `SELKEY_MAX_SESSIONS` | `10000` | Sessions held in memory at once (`503` when full) |
| `SELKEY_MAX_STORE_BYTES` | `268435456` | Memory budget, in bytes, for each in-memory store: the contracts and not-yet-finished inputs of held sessions, and separately the contracts of held invites (each invite holds two copies of its contract). Sizes are the estimated heap of the parsed JSON (approximate; modelled on glibc malloc, and up to about 100 times the request size for JSON made of many tiny values). A new session or input over the budget gets `503`; for invites, finished invites are removed to make room first. With the shipped contracts, the invite budget binds at about 9,000 invites. See the provisioning note below |
| `SELKEY_MAX_INVITES` | `10000` | Invites held in memory at once. Accepted, declined, canceled and expired invites are removed 1 hour after they reach that state; when the store is full, the oldest finished invite (declined, canceled or expired before accepted) is removed to make room. `503` only when every held invite is pending |
| `SELKEY_MAX_INVITES_PER_AGENT` | `1000` | Invites in any state held per sending agent. At the limit the sender's oldest finished invite is removed; `429` if all of them are pending |
| `SELKEY_MAX_PENDING_INVITES_PER_AGENT` | `100` | Pending invites per sending agent (`429` above it) |
| `SELKEY_SESSION_CREATE_RATE_PER_MIN` | `60` | `POST /sessions` plus `POST /relay` per client address per minute (`429` above it). IPv6 clients are grouped by /64. Behind a reverse proxy all clients share the proxy's address |
| `SELKEY_INVITE_CREATE_RATE_PER_MIN` | `30` | `POST /invites` per sending agent per minute (`429` above it) |

### Agent registry (inbox authentication)

| Variable | Default | Description |
|----------|---------|-------------|
| `SELKEY_AGENT_REGISTRY_PATH` | — | Path to `agents.json`: `{"agents": [{"agent_id", "inbox_token", "public_key_hex"?}]}`. Required unless `SELKEY_INBOX_AUTH=off` with `SELKEY_ENV=dev`. Each `inbox_token` must be unique and should be at least 32 characters from a random generator (e.g. `openssl rand -hex 32`); the relay refuses to start if any token is shorter, has few distinct characters or repeats a shorter sequence. `public_key_hex` is the key attached to that agent's invites |
| `SELKEY_INBOX_AUTH` | — | Set to `off` (with `SELKEY_ENV=dev`) to run without an agent registry; inbox endpoints then reject every request |

## MCP Server (`selkey-mcp`)

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELKEY_RELAY_URL` | For all relay sessions | — | Relay base URL (e.g. `http://localhost:3100`). INITIATE and RESPOND only use locally configured relays: this URL plus `SELKEY_RELAY_ALLOWLIST`. Relay URLs from a peer's Agent Card or invite are never used unless they match. Plain `http://` is accepted only for loopback hosts (`localhost`, `127.0.0.0/8`, `[::1]`); use `https://` otherwise. If `SELKEY_RELAY_VERIFYING_KEY_HEX` (64 hex chars) is set, the relay's `/health` `verifying_key_hex` must match it before any input is submitted |
| `SELKEY_RELAY_ALLOWLIST` | No | — | Comma-separated additional relay URLs this agent will use (e.g. when a counterparty's session lives on a different relay you trust). Non-loopback `http://` entries are ignored |
| `SELKEY_RELAY_INSECURE_HTTP_HOSTS` | No | — | Comma-separated host names on which plain `http://` relays are allowed besides loopback (`localhost`, `127.0.0.0/8`, `[::1]`), for example `relay` on a private compose network in the local demo |
| `SELKEY_AGENT_ID` | No | — | This agent's ID, used for contract building |
| `SELKEY_RESUME_TOKEN_SECRET` | No | — | Secret for HMAC-signing resume tokens. Recommended for production |
| `SELKEY_WORKDIR` | No | current directory | Directory under which the server keeps its state in `.selkey/` (pins, entropy ledger, IFC grants, held receipts) |
| `SELKEY_INBOX_TRANSPORT` | No | — | Set to `relay` to send and receive invites through the relay inbox. Then `SELKEY_INBOX_TOKEN`, `SELKEY_AGENT_ID` and `SELKEY_RELAY_URL` are required, and the server refuses to start without them |
| `SELKEY_INBOX_TOKEN` | With `SELKEY_INBOX_TRANSPORT=relay` | — | This agent's `inbox_token` from the relay's agent registry |
| `SELKEY_REGISTRY_PATH` | No | `selkey-registry` next to the selkey checkout | Artefact registry used for bespoke contract negotiation. Negotiation is unavailable if the directory has no `registry.json` |
| `SELKEY_ENV` | No | — | `dev` lets the agent run relay sessions without `SELKEY_RELAY_VERIFYING_KEY_HEX` (local development only) |
| `SELKEY_OPERATOR_TOKEN` | When the relay has one | — | The operator token of the relay at `SELKEY_RELAY_URL` (the relay's `SELKEY_OPERATOR_TOKEN`). Sent as `Authorization: Bearer <token>` when this agent creates a session on that relay, and never sent to other relays or logged |
| `SELKEY_RELAY_VERIFYING_KEY_HEX` | Yes, outside `SELKEY_ENV=dev` | — | Pinned relay Ed25519 verifying key (64 hex chars), obtained from the relay operator. Contracts this agent builds carry it as `relay_verifying_key_hex`, so a relay with a different key refuses the session before input is submitted. A responder accepts only contracts that carry the same value, so both parties must pin the same key. Outside `SELKEY_ENV=dev`, `relay_signal` refuses INITIATE, CREATE, RESPOND and JOIN without it. Outside development, a responder given `expected_contract_hash` also requires that hash to be a contract it builds itself with the pinned key. In development an unpinned agent still works and a pinned responder also accepts contracts without the key field, but pinning is recommended there too. Session receipts must verify against it. `selkey.verify_receipt` uses it when no `public_key_hex` argument is given, and rejects an argument that differs from it. Without this or an argument, the tool returns an error |

### Owner-side disclosure budget

Before the agent submits its own input to a relay session, it charges the session's disclosure against a local ledger at `$SELKEY_WORKDIR/.selkey/budget-ledger.json` (mode 0600 in a 0700 directory). The charge is the upper bound on bits the contract's output schema can carry, computed locally (or the contract's `entropy_budget_bits`, if larger). Charges are recorded before submission, so sessions that abort still count. If a budget would be exceeded, or the bound cannot be computed (the schema can't be resolved locally or doesn't bound its output), the input is not submitted and `relay_signal` returns `ENTROPY_BUDGET_EXCEEDED` or `ENTROPY_BOUND_UNAVAILABLE`. A ledger file that is group- or world-writable or malformed also stops submissions. `selkey.get_identity` reports `remaining_budget` (with a warning when the ledger is off). The budgets are a probing rate limit, not a secrecy guarantee: they bound how fast released bits accumulate per window, not what a counterparty can learn over many windows. Each relay session is charged once; array outputs with `uniqueItems` are counted as ordered selections.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELKEY_ENTROPY_LEDGER` | No | `enforce` | `enforce` or `off` |
| `SELKEY_ENTROPY_BUDGET_PER_COUNTERPARTY_BITS` | No | `128` | Bits one counterparty (by `agent_id`) can be charged within the window |
| `SELKEY_ENTROPY_BUDGET_GLOBAL_BITS` | No | `512` | Bits charged across all counterparties within the window. This bounds what many distinct counterparty identities can extract together |
| `SELKEY_ENTROPY_BUDGET_WINDOW_SECONDS` | No | `86400` | Rolling window length in seconds |

### AFAL Direct Transport

These enable the AFAL direct transport for INITIATE and RESPOND session modes (agent-to-agent without an orchestrator).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELKEY_AFAL_SEED_HEX` | For AFAL | — | 64-char hex Ed25519 seed for signing AFAL messages |
| `SELKEY_AFAL_HTTP_PORT` | For RESPOND | — | Port for the AFAL HTTP server (enables RESPOND mode) |
| `SELKEY_AFAL_BIND_ADDRESS` | No | `127.0.0.1` | Bind address for the AFAL HTTP server |
| `SELKEY_AFAL_TRUSTED_AGENTS` | No | — | JSON array of trusted agents: `[{"agentId":"...","publicKeyHex":"..."}]`. Seeds the agent pin store (see below) |
| `SELKEY_AFAL_ALLOWED_PURPOSES` | No | `MEDIATION` | Comma-separated list of allowed purpose codes (e.g. `MEDIATION,COMPATIBILITY`). Also the purposes RESPOND accepts when `expected_purpose` is omitted |
| `SELKEY_AFAL_PEER_DESCRIPTOR_URL` | For INITIATE | — | URL of the peer agent's descriptor (used in INITIATE mode) |
| `SELKEY_AFAL_PEER_ENDPOINT_ORIGINS` | No | — | Comma-separated origins (e.g. `https://bob.example.com:9443`) that the peer's PROPOSE, COMMIT, negotiate and A2A endpoints may use besides the origin of `SELKEY_AFAL_PEER_DESCRIPTOR_URL`. Endpoints on any other origin are refused. With `SELKEY_ENV=dev`, loopback endpoints on any port are also accepted when the descriptor URL is on loopback. A responder advertises its endpoints as `http://<SELKEY_AFAL_BIND_ADDRESS>:<SELKEY_AFAL_HTTP_PORT>`, so when that differs from the descriptor URL the initiator must list the advertised origin here |
| `SELKEY_AFAL_ADVERTISE_AFAL_ENDPOINT` | No | `true` | Set to `false` to publish an A2A-only Agent Card (no AFAL endpoint) |
| `SELKEY_AFAL_REQUIRE_SIGNED_CARDS` | No | — | No longer has an effect. An A2A agent card is used only if its `card_signature` verifies under the peer's pinned key; endpoints and relay hints are never taken from an unsigned card (discovery falls back to the signed AFAL descriptor) |
| `SELKEY_AGENT_PIN_RESEED` | No | — | Lets configured keys replace stored pins that differ from them; see [Agent identity pins](#agent-identity-pins) |
| `SELKEY_AGENT_PIN_MODE` | No | `preshared` | `preshared`: peers must be pinned in advance. `tofu`: on first contact the peer's key is recorded as pending and the call fails with `NEEDS_CONFIRMATION` until a person runs `selkey-mcp pins confirm <agent_id>` in a terminal |

### Known Agents

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELKEY_KNOWN_AGENTS` | No | — | JSON array of known agents: `[{"agent_id":"bob-agent","aliases":["Bob"],"public_key_hex":"...","a2a_send_message_url":"..."}]`. Aliases match exactly (no case folding); an alias that names more than one agent is an error. `public_key_hex` seeds the agent pin store |

### IFC

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SELKEY_IFC_MAX_GRANT_TTL_SECONDS` | No | `86400` | Longest lifetime this agent allows for IFC grants it issues (values above 86400 are ignored) |

IFC grant state lives in `$SELKEY_WORKDIR/.selkey/ifc-grants.json` and `ifc-audit.jsonl`; receipts of completed sessions (used to authorise grant issuance) in `held-receipts.json`. All are `0600` in a `0700` directory.

### Agent identity pins

The MCP server keeps one pin store at `$SELKEY_WORKDIR/.selkey/pins.json` (directory `0700`, file `0600`; the server refuses to start if the file is group- or world-writable). It is seeded from `SELKEY_AFAL_TRUSTED_AGENTS` and the `public_key_hex` entries of `SELKEY_KNOWN_AGENTS`. Stored pins take precedence: if a configured key differs from a stored pin (for example after a CLI re-pin or a rotation), the server refuses to start and shows both fingerprints. Update the configuration first if the stored pin is the correct one. `SELKEY_AGENT_PIN_RESEED=true` lets configured keys replace stored pins that themselves came from configuration; it does not undo a CLI re-pin, a signed rotation or a confirmed first contact. To replace such a pin with the configured key, name the agent explicitly (`SELKEY_AGENT_PIN_RESEED=<agent_id>[,<agent_id>...]`) and unset the variable afterwards. Pinned keys must be canonical Ed25519 points of prime order. The running server re-reads `pins.json` when it changes, so `selkey-mcp pins` commands take effect without a restart. Every PROPOSE, ADMIT, DENY, COMMIT, negotiation request and IFC signature from a peer is verified against the pinned key for its `agent_id`, never against a key in the peer's card, descriptor or message. Signatures must be 128 lowercase hex characters and are checked with strict Ed25519 (`s < L`, canonical prime-order `R` and key, cofactorless verification). A peer that presents a different key is rejected with both fingerprints (`ed25519:` + hex SHA-256 of the raw key).

Manage pins with:

```bash
selkey-mcp pins list
selkey-mcp pins add <agent_id> <public_key_hex> [--alias <alias>]
selkey-mcp pins remove <agent_id>
selkey-mcp pins confirm <agent_id>      # tofu mode: interactive terminal only
selkey-mcp pins rotate <statement.json> <new_public_key_hex>
```

A rotation statement is `{agent_id, old_fpr, new_fpr, issued_at, signature}`, signed by the currently pinned key with the AFAL signing rules and the domain prefix `VCAV-KEY-ROTATION-V1:`. A statement is refused if it was applied before or its `issued_at` is not newer than the last rotation applied for that agent.

`pins confirm` requires an interactive terminal and is not available as an MCP tool, so a model using the MCP tools cannot confirm a pin. It does not stop a model that has its own shell or terminal access; do not give such a model access to the terminal where pins are confirmed.
