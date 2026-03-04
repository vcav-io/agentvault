# Run the Relay from Source

This guide covers building and running the AgentVault relay from source — for contributors, operators, and anyone who wants to inspect or modify the relay itself.

For a quick demo using Docker, see [Getting Started](getting-started.md).

## Prerequisites

- Rust 1.88.0+ (see `rust-toolchain.toml`)
- An Anthropic API key (or OpenAI API key)
- The [vault-family-core](https://github.com/vcav-io/vault-family-core) dependency resolves automatically via Cargo git dependency

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `AV_PORT` | No | `3100` | Port the relay listens on |
| `AV_MODEL_ID` | No | `claude-sonnet-4-6` | Anthropic model to use |
| `AV_SIGNING_KEY_HEX` | No | ephemeral | 64-char hex Ed25519 signing key. If unset, generates a random key on each start (receipts won't verify across restarts) |
| `AV_PROMPT_PROGRAM_DIR` | No | `prompt_programs` | Directory containing prompt programs and lockfiles. The default is relative to CWD — when running from the repo root, set to `packages/agentvault-relay/prompt_programs` |
| `AV_SESSION_TTL_SECS` | No | `600` | Session expiry in seconds |
| `AV_ENV` | No | — | Set to `dev` for local development (enables dev-only overrides) |
| `AV_INBOX_AUTH` | No | — | Set to `off` (with `AV_ENV=dev`) to skip agent registry requirement |
| `OPENAI_API_KEY` | No | — | Enables the OpenAI provider |
| `AV_OPENAI_MODEL_ID` | No | `gpt-4o` | OpenAI model to use |
| `ANTHROPIC_BASE_URL` | No | — | Override Anthropic API base URL (for proxies) |
| `OPENAI_BASE_URL` | No | — | Override OpenAI API base URL (for proxies) |

See [Environment Variables](environment-variables.md) for the complete reference.

## Build and start

```bash
# Build
cargo build --workspace

# Configure environment
cp .env.example .env
# Edit .env and set your ANTHROPIC_API_KEY

# Source and start
set -a && source .env && set +a
cargo run -p agentvault-relay
```

The `.env.example` includes dev-mode defaults (`AV_ENV=dev`, `AV_INBOX_AUTH=off`) that let you start the relay without an agent registry. For production, see the [OpenClaw VPS Runbook](guides/openclaw-vps-runbook.md).

The relay starts on port 3100 by default. Verify with:

```bash
curl http://localhost:3100/health
```

Response:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "git_sha": "...",
  "execution_lane": "API_MEDIATED"
}
```

## Run a bilateral session

A bilateral session has four steps: create, submit inputs, poll, retrieve output.

### 1. Create a session

The `output_schema` field takes the full JSON Schema object (see `schemas/output/` for available schemas). Prompt programs are content-addressed — the filename without `.json` is the hash you pass as `prompt_template_hash`.

```bash
SCHEMA=$(cat schemas/output/vcav_e_compatibility_signal_v2.schema.json)

curl -s -X POST http://localhost:3100/sessions \
  -H "Content-Type: application/json" \
  -d "{
    \"contract\": {
      \"purpose_code\": \"COMPATIBILITY\",
      \"output_schema_id\": \"vcav_e_compatibility_signal_v2\",
      \"output_schema\": $SCHEMA,
      \"participants\": [\"alice\", \"bob\"],
      \"prompt_template_hash\": \"57a4a7ef5b187a226b9c0e9cbcbdece326b115093176a80edafd72e85a94bc06\"
    },
    \"provider\": \"anthropic\"
  }"
```

Save the response fields into shell variables for the next steps:

```bash
SESSION_ID="..."
CONTRACT_HASH="..."
INITIATOR_SUBMIT_TOKEN="..."
INITIATOR_READ_TOKEN="..."
RESPONDER_SUBMIT_TOKEN="..."
RESPONDER_READ_TOKEN="..."
```

### 2. Submit inputs (both parties)

Each party submits their input using their submit token:

```bash
# Initiator
curl -s -X POST http://localhost:3100/sessions/$SESSION_ID/input \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INITIATOR_SUBMIT_TOKEN" \
  -d '{
    "role": "alice",
    "context": { "profile": "Early-stage SaaS startup, Series A, B2B fintech, 15 employees" },
    "expected_contract_hash": "'$CONTRACT_HASH'"
  }'

# Responder
curl -s -X POST http://localhost:3100/sessions/$SESSION_ID/input \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RESPONDER_SUBMIT_TOKEN" \
  -d '{
    "role": "bob",
    "context": { "profile": "VC fund focused on B2B fintech, Series A-B, check sizes $2-10M" }
  }'
```

When both inputs are received, inference starts automatically.

### 3. Poll for completion

```bash
curl -s http://localhost:3100/sessions/$SESSION_ID/status \
  -H "Authorization: Bearer $INITIATOR_READ_TOKEN"
```

States: `Created` → `Partial` → `Processing` → `Completed` (or `Aborted`).

### 4. Retrieve output and receipt

```bash
curl -s http://localhost:3100/sessions/$SESSION_ID/output \
  -H "Authorization: Bearer $INITIATOR_READ_TOKEN"
```

Response:
```json
{
  "state": "Completed",
  "abort_reason": null,
  "output": { "...bounded signal..." },
  "receipt": { "...full receipt..." },
  "receipt_signature": "...hex Ed25519 signature..."
}
```

The receipt contains: `contract_hash`, `guardian_policy_hash`, `prompt_template_hash`, `model_profile_hash`, `runtime_hash`, the output, and entropy accounting. See the [API Reference](api-reference.md) for full details.
