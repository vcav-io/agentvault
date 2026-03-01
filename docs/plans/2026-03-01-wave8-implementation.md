# Wave 8: Testing Tooling + Demo — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Containerize the AV relay for 5-minute demos, build paraphrase stability tooling, and add Category C meta-protocol leakage tests.

**Architecture:** Serial execution — #669 (demo) → #55 (stability) → #56 (Category C). All work in `av-claude` worktree on branch `claude/wave8-testing-demo`. The relay gets a Docker image + GHCR workflow; test scripts get variant prompt support and a metadata observer endpoint.

**Tech Stack:** Rust (relay), Bash (test scripts, inline Node.js evaluation), Docker (containerization), GitHub Actions (GHCR publishing)

**Design doc:** `docs/plans/2026-03-01-wave8-testing-demo-design.md`

---

## Task 1: Create Dockerfile for AV relay (#669)

**Files:**
- Create: `docker/Dockerfile.relay`

**Step 1: Write the Dockerfile**

Follow the pattern from vcav's `docker/Dockerfile.orchestrator` but simpler — relay is pure Rust, no Node.js stage.

```dockerfile
# Stage 1: Build
FROM rust:1.88-bookworm AS builder
WORKDIR /build

# Cache dependencies by copying manifests first
COPY Cargo.toml Cargo.lock ./
COPY packages/agentvault-relay/Cargo.toml packages/agentvault-relay/Cargo.toml
RUN mkdir -p packages/agentvault-relay/src && echo "fn main() {}" > packages/agentvault-relay/src/main.rs
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN=$(cat /run/secrets/github_token 2>/dev/null || echo "") \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=url.https://${GITHUB_TOKEN}@github.com/.insteadOf \
    GIT_CONFIG_VALUE_0=https://github.com/ \
    CARGO_NET_GIT_FETCH_WITH_CLI=true \
    cargo build --release --package agentvault-relay 2>/dev/null || true

# Copy real source and build
COPY packages/agentvault-relay packages/agentvault-relay
COPY prompt_programs prompt_programs
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN=$(cat /run/secrets/github_token 2>/dev/null || echo "") \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=url.https://${GITHUB_TOKEN}@github.com/.insteadOf \
    GIT_CONFIG_VALUE_0=https://github.com/ \
    CARGO_NET_GIT_FETCH_WITH_CLI=true \
    cargo build --release --package agentvault-relay

# Stage 2: Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/agentvault-relay /usr/local/bin/agentvault-relay
COPY prompt_programs /opt/agentvault/prompt_programs

ENV VCAV_PROMPT_PROGRAM_DIR=/opt/agentvault/prompt_programs
ENV VCAV_PORT=3100
EXPOSE 3100

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD curl -sf http://localhost:3100/health || exit 1

ENTRYPOINT ["agentvault-relay"]
```

**Step 2: Verify Dockerfile builds locally**

Run: `docker build -f docker/Dockerfile.relay -t agentvault-relay:local --secret id=github_token,env=GITHUB_TOKEN .`
(from `~/Development/vcav-io/av-claude`)

Expected: successful build, image tagged `agentvault-relay:local`

**Step 3: Test the container starts**

Run: `docker run -d --name av-relay-test -p 3100:3100 -e ANTHROPIC_API_KEY=test -e VCAV_ENV=dev agentvault-relay:local`
Then: `curl -sf http://localhost:3100/health`
Expected: `{"status":"ok",...}`
Cleanup: `docker rm -f av-relay-test`

**Step 4: Commit**

```
git add docker/Dockerfile.relay
git commit -m "feat(docker): add Dockerfile for AV relay (#669)"
```

---

## Task 2: Create docker-compose for demo (#669)

**Files:**
- Create: `docker/docker-compose.demo.yml`

**Step 1: Write the compose file**

```yaml
services:
  relay:
    image: ghcr.io/vcav-io/agentvault-relay:latest
    ports:
      - "3100:3100"
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - VCAV_MODEL_ID=${VCAV_MODEL_ID:-claude-sonnet-4-5-20250929}
      - VCAV_OPENAI_MODEL_ID=${VCAV_OPENAI_MODEL_ID:-gpt-4o}
      - OPENAI_BASE_URL=${OPENAI_BASE_URL:-}
      - VCAV_SIGNING_KEY_HEX=${VCAV_SIGNING_KEY_HEX:-}
      - VCAV_ENV=${VCAV_ENV:-dev}
      - VCAV_INBOX_AUTH=${VCAV_INBOX_AUTH:-off}
      - VCAV_AGENT_REGISTRY_PATH=${VCAV_AGENT_REGISTRY_PATH:-}
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:3100/health"]
      interval: 10s
      timeout: 3s
      retries: 3
```

**Step 2: Test with local image**

Run: `docker compose -f docker/docker-compose.demo.yml up -d` (with `ANTHROPIC_API_KEY` set)
Then: `curl -sf http://localhost:3100/health`
Cleanup: `docker compose -f docker/docker-compose.demo.yml down`

**Step 3: Commit**

```
git add docker/docker-compose.demo.yml
git commit -m "feat(docker): add docker-compose for demo (#669)"
```

---

## Task 3: Create GHCR publishing workflow (#669)

**Files:**
- Create: `.github/workflows/docker-relay.yml`

**Step 1: Write the workflow**

Follow vcav's `docker-orchestrator.yml` pattern. Key differences: single Rust stage, different image name.

```yaml
name: Build and Push Relay Image

on:
  push:
    branches: [main]
    paths:
      - 'packages/agentvault-relay/**'
      - 'docker/Dockerfile.relay'
      - 'Cargo.lock'
      - 'prompt_programs/**'
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: vcav-io/agentvault-relay

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,prefix=sha-
            type=semver,pattern={{version}}

      - uses: docker/setup-buildx-action@v3

      - uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/Dockerfile.relay
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          platforms: linux/amd64,linux/arm64
          cache-from: type=gha
          cache-to: type=gha,mode=max
          secrets: |
            github_token=${{ secrets.GITHUB_TOKEN }}
```

**Step 2: Commit**

```
git add .github/workflows/docker-relay.yml
git commit -m "ci: add GHCR publishing workflow for relay image (#669)"
```

---

## Task 4: Create demo prompts and README (#669)

**Files:**
- Create: `demo/README.md`
- Create: `demo/alice-prompt.md`
- Create: `demo/bob-prompt.md`

**Step 1: Write Alice's prompt**

`demo/alice-prompt.md` — natural language prompt for Alice (the seller in scenario 03).
Adapt from `tests/live/scenarios/03-stac-compatibility/seller_prompt.txt` but frame it
for a user pasting into Claude Code with the AgentVault MCP plugin installed.

**Step 2: Write Bob's prompt**

`demo/bob-prompt.md` — natural language prompt for Bob (the buyer in scenario 03).
Adapt from `tests/live/scenarios/03-stac-compatibility/buyer_prompt.txt`.

**Step 3: Write the README**

`demo/README.md` covering:
1. Prerequisites: Docker, API key, Claude Code with AgentVault MCP plugin
2. Quick start: `docker compose -f docker/docker-compose.demo.yml up -d`
3. Agent setup: paste prompts into two separate Claude Code sessions
4. What happens: agents discover each other, negotiate, conduct vault, produce receipt
5. Verification: check receipt in relay output

**Step 4: Commit**

```
git add demo/
git commit -m "docs: add demo prompts and README (#669)"
```

---

## Task 5: Create relay input files for scenario 03 (#55)

**Files:**
- Create: `tests/live/scenarios/03-stac-compatibility/alice_relay_input.json`
- Create: `tests/live/scenarios/03-stac-compatibility/bob_relay_input_s1.json`

Scenario 03 currently only has prompt text files (for agent-mediated testing). For
drive.sh-based stability testing, we need relay input JSON files (plain strings).

**Step 1: Create Alice's relay input**

Extract the context from `seller_prompt.txt` as a JSON string. Same facts, formatted
as a single string that the relay receives as Alice's input.

**Step 2: Create Bob's relay input**

Extract from `buyer_prompt.txt` similarly.

**Step 3: Verify drive.sh can run scenario 03**

Run: `./tests/live/drive.sh --scenario 03 --no-relay --provider anthropic`
(with a running relay). Confirm session completes and output contains v2 enum fields.

**Step 4: Commit**

```
git add tests/live/scenarios/03-stac-compatibility/
git commit -m "feat: add relay input files for scenario 03 (#55)"
```

---

## Task 6: Create surface-rephrased variant prompts (#55)

**Files:**
- Create: `tests/live/scenarios/03-stac-compatibility/bob_relay_input_s1_surface_v2.json`
- Create: `tests/live/scenarios/03-stac-compatibility/bob_relay_input_s1_surface_v3.json`

**Step 1: Write variant v2**

Same facts as `bob_relay_input_s1.json`, surface-rephrased: swap phrasing patterns
("We're looking for" → "Our interest is in", "I need to know" → "I'd like to
understand"), keep all facts, numbers, and ordering identical.

**Step 2: Write variant v3**

Different surface rephrasing from v2. Use passive constructions, formal register
("We are a strategic acquirer" → "Our division serves as a strategic acquirer").

**Step 3: Commit**

```
git add tests/live/scenarios/03-stac-compatibility/bob_relay_input_s1_surface_v2.json
git add tests/live/scenarios/03-stac-compatibility/bob_relay_input_s1_surface_v3.json
git commit -m "feat: add surface-rephrased variant prompts for scenario 03 (#55)"
```

---

## Task 7: Extend drive.sh with --variant flag (#55)

**Files:**
- Modify: `tests/live/drive.sh`

**Step 1: Add --variant argument parsing**

In the argument parsing section (lines 28-52), add:
```bash
VARIANT=""
```
and in the while loop:
```bash
--variant)
    VARIANT="$2"
    shift 2
    ;;
```

**Step 2: Add variant input selection logic**

After the existing Bob input selection (line ~262), add logic:
- If `VARIANT` is set and not "all", use `bob_relay_input_s1_${VARIANT}.json`
- If `VARIANT` is "all", loop over all `bob_relay_input_s1_*.json` files
  (excluding the base `bob_relay_input_s1.json`), run each as a separate session,
  output to `results/<run_id>/variant_<name>/`

**Step 3: Add --shuffle flag**

Add `SHUFFLE=false` to argument parsing. When `--shuffle` and `--variant all` are
combined, randomize the order of variant files before iterating.

**Step 4: Test the flag manually**

Run: `./tests/live/drive.sh --scenario 03 --variant surface_v2 --no-relay`
(dry-run check that correct file is selected)

**Step 5: Commit**

```
git add tests/live/drive.sh
git commit -m "feat: add --variant and --shuffle flags to drive.sh (#55)"
```

---

## Task 8: Write stability.sh evaluator (#55)

**Files:**
- Create: `tests/live/stability.sh`

**Step 1: Write the stability script**

Bash script with inline Node.js evaluator (following accumulate.sh pattern).

Arguments:
- `--scenario <name>` — which scenario to evaluate
- `--provider <name>` — which provider to use (anthropic/openai)
- `--relay-url <url>` — relay URL (default http://localhost:3100)

Flow:
1. Run `drive.sh --variant all --scenario <name> --provider <provider>` to execute
   all variants
2. Collect output JSON from each variant's result directory
3. Extract v2 enum fields from each output
4. Compare field values across variants using tiered field table:
   - High-signal: `thesis_fit`, `confidence`, `compatibility_signal`
   - Supporting: `size_fit`, `stage_fit`, `next_step`
   - Aggregate: `primary_reasons`, `blocking_reasons`
5. Compute per-field agreement rate (mode count / total variants)
6. Verdict: STABLE if all high-signal fields agree, UNSTABLE otherwise
7. Write `stability_report.json` and `stability_report.md`

**Step 2: Make executable**

Run: `chmod +x tests/live/stability.sh`

**Step 3: Commit**

```
git add tests/live/stability.sh
git commit -m "feat: add stability.sh paraphrase evaluator (#55)"
```

---

## Task 9: Live run — paraphrase stability test (#55)

**Step 1: Start relay**

Ensure relay is running at localhost:3100 with `ANTHROPIC_API_KEY` set.

**Step 2: Run stability test**

Run: `./tests/live/stability.sh --scenario 03 --provider anthropic`

**Step 3: Review results**

Check `results/<run_id>/stability_report.json` — verify:
- All 3 variants produced valid outputs
- High-signal fields have agreement data
- Verdict is either STABLE or UNSTABLE with clear rationale

**Step 4: Commit results** (if useful as test vectors)

```
git add tests/live/results/
git commit -m "test: paraphrase stability run for scenario 03 (#55)"
```

---

## Task 10: Add SessionMetadata to types and Session struct (#56)

**Files:**
- Modify: `packages/agentvault-relay/src/types.rs` (after line 130)
- Modify: `packages/agentvault-relay/src/session.rs` (Session struct, line 59)

**Step 1: Write the test**

In `packages/agentvault-relay/src/types.rs` (or in a test module), add a test that
`SessionMetadata` serializes correctly:

```rust
#[test]
fn test_session_metadata_serializes() {
    let meta = SessionMetadata {
        session_id: "test-123".to_string(),
        timing: SessionTiming {
            session_created_at: Some(Utc::now()),
            initiator_input_at: None,
            responder_input_at: None,
            inference_start_at: None,
            inference_end_at: None,
            output_ready_at: None,
        },
        sizes: SessionSizes {
            initiator_input_bytes: None,
            responder_input_bytes: None,
            output_bytes: None,
            receipt_bytes: None,
        },
        inference: None,
    };
    let json = serde_json::to_string(&meta).unwrap();
    assert!(json.contains("test-123"));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p agentvault-relay test_session_metadata_serializes`
Expected: FAIL — struct not defined

**Step 3: Write the structs**

In `types.rs` after line 130:

```rust
// ============================================================================
// Session metadata (dev-only diagnostic endpoint)
// ============================================================================

/// Timing data for session phases. Only populated when VCAV_ENV=dev.
/// inference_start_at = immediately before provider.call()
/// inference_end_at = full response received (non-streaming)
#[derive(Debug, Clone, Serialize)]
pub struct SessionTiming {
    pub session_created_at: Option<DateTime<Utc>>,
    pub initiator_input_at: Option<DateTime<Utc>>,
    pub responder_input_at: Option<DateTime<Utc>>,
    pub inference_start_at: Option<DateTime<Utc>>,
    pub inference_end_at: Option<DateTime<Utc>>,
    pub output_ready_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSizes {
    pub initiator_input_bytes: Option<usize>,
    pub responder_input_bytes: Option<usize>,
    pub output_bytes: Option<usize>,
    pub receipt_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InferenceMetadata {
    pub provider: String,
    pub model_id: String,
    pub status_code: u16,
    pub retry_count: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMetadata {
    pub session_id: String,
    pub timing: SessionTiming,
    pub sizes: SessionSizes,
    pub inference: Option<InferenceMetadata>,
}
```

Add `metadata: Option<SessionMetadata>` to `Session` struct in `session.rs` (after line 74).
Initialize as `None` in `SessionStore::create()` (line ~136).

**Step 4: Run test to verify it passes**

Run: `cargo test -p agentvault-relay test_session_metadata_serializes`
Expected: PASS

**Step 5: Commit**

```
git add packages/agentvault-relay/src/types.rs packages/agentvault-relay/src/session.rs
git commit -m "feat: add SessionMetadata types for dev diagnostic endpoint (#56)"
```

---

## Task 11: Capture timing and size data in relay handlers (#56)

**Files:**
- Modify: `packages/agentvault-relay/src/lib.rs` (submit_input_handler, spawn_inference)
- Modify: `packages/agentvault-relay/src/relay.rs` (relay_core timing)
- Modify: `packages/agentvault-relay/src/main.rs` (pass is_dev to AppState)

**Step 1: Add is_dev flag to AppState**

In `lib.rs` AppState struct (line 41), add:
```rust
pub is_dev: bool,
```
Set it in `main.rs` from the existing `is_dev` variable (line 160).

**Step 2: Capture input byte sizes in submit_input_handler**

In `submit_input_handler` (lib.rs ~line 204), after deserializing the input:
```rust
if state.is_dev {
    let input_bytes = serde_json::to_string(&body.context).map(|s| s.len()).unwrap_or(0);
    // Store in session metadata based on role
}
```

**Step 3: Capture inference timing in relay_core**

In `relay.rs`, `relay_core()`:
- Return inference timing from the function (add to `RelayResult` or return separately)
- Capture `inference_start` immediately before the provider match (line ~236)
- Capture `inference_end` immediately after (line ~261)

**Step 4: Wire timing into session metadata in spawn_inference**

In `spawn_inference()` (lib.rs ~line 265), after `relay_core()` returns:
- Create `SessionMetadata` with timing data
- Store in session via `with_session()`

**Step 5: Run full test suite**

Run: `cargo test -p agentvault-relay`
Expected: all existing tests pass

**Step 6: Commit**

```
git add packages/agentvault-relay/src/lib.rs packages/agentvault-relay/src/relay.rs packages/agentvault-relay/src/main.rs
git commit -m "feat: capture session metadata timing and sizes (#56)"
```

---

## Task 12: Add /sessions/:id/metadata endpoint (#56)

**Files:**
- Modify: `packages/agentvault-relay/src/lib.rs` (router + handler)

**Step 1: Write the test**

Add integration test in `tests/integration.rs` or unit test in `lib.rs`:
```rust
#[tokio::test]
async fn test_metadata_endpoint_returns_404_in_prod() {
    // Create app with is_dev=false
    // POST /sessions, GET /sessions/:id/metadata
    // Assert 404
}

#[tokio::test]
async fn test_metadata_endpoint_returns_data_in_dev() {
    // Create app with is_dev=true
    // POST /sessions, submit both inputs, wait for completion
    // GET /sessions/:id/metadata with read token
    // Assert 200 with timing data
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p agentvault-relay test_metadata_endpoint`
Expected: FAIL — endpoint not registered

**Step 3: Write the handler**

Follow `session_output_handler` pattern (lib.rs lines 343-375):

```rust
async fn session_metadata_handler(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !state.is_dev {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "not found"}))).into_response();
    }

    let token = match extract_bearer_token(&headers) {
        Some(t) => t,
        None => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "missing token"}))).into_response(),
    };

    let metadata = state.session_store.with_session(&session_id, |session| {
        let role = session.validate_token(&token);
        match role {
            Some(TokenRole::InitiatorRead | TokenRole::ResponderRead) => {
                Ok(session.metadata.clone())
            }
            _ => Err(()),
        }
    }).await;

    match metadata {
        Some(Ok(Some(meta))) => Json(meta).into_response(),
        Some(Ok(None)) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "metadata not available"}))).into_response(),
        Some(Err(())) => (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "invalid token"}))).into_response(),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "session not found"}))).into_response(),
    }
}
```

**Step 4: Register the route**

In `build_router()` (lib.rs ~line 389), add:
```rust
.route("/sessions/:id/metadata", get(session_metadata_handler))
```

**Step 5: Run tests to verify they pass**

Run: `cargo test -p agentvault-relay test_metadata_endpoint`
Expected: PASS

**Step 6: Run full suite**

Run: `cargo test -p agentvault-relay`
Expected: all tests pass

**Step 7: Commit**

```
git add packages/agentvault-relay/src/lib.rs
git commit -m "feat: add /sessions/:id/metadata dev diagnostic endpoint (#56)"
```

---

## Task 13: Write drive-catc.sh Category C test driver (#56)

**Files:**
- Create: `tests/live/drive-catc.sh`

**Step 1: Write the script**

Bash script. Arguments:
- `--scenario <name>` (default: 03)
- `--provider <name>` (default: anthropic)
- `--relay-url <url>` (default: http://localhost:3100)

Three test phases:

**Phase 1 — Timing side-channel:**
1. Create short Alice input (2-3 sentences)
2. Create long Alice input (same facts + 10x padding context)
3. Run two sessions via drive.sh with the two different Alice inputs
4. GET `/sessions/:id/metadata` for each
5. Compare `inference_end_at - inference_start_at`
6. Ratio < 1.3x → PASS, 1.3-2.0x → ADVISORY, > 2.0x → FAIL

**Phase 2 — Size constancy:**
1. Use two different Bob inputs (existing s1 + surface_v2)
2. Run two sessions
3. GET `/sessions/:id/metadata` for each
4. Compare `output_bytes`
5. Delta < 64 bytes → PASS, else FAIL

**Phase 3 — Error shape:**
1. Submit 3 malformed inputs (missing `context`, empty string, invalid JSON)
2. Capture error response bodies
3. Compare structure (strip field names, compare shape)
4. All same structure → PASS, else FAIL

Output: `results/<run_id>/category_c_report.json` + `.md`

**Step 2: Make executable**

Run: `chmod +x tests/live/drive-catc.sh`

**Step 3: Commit**

```
git add tests/live/drive-catc.sh
git commit -m "feat: add drive-catc.sh Category C test driver (#56)"
```

---

## Task 14: Live run — Category C tests (#56)

**Step 1: Ensure relay is running with VCAV_ENV=dev**

The relay must be started with `VCAV_ENV=dev` for the metadata endpoint to be active.

**Step 2: Run Category C tests**

Run: `./tests/live/drive-catc.sh --scenario 03 --provider anthropic`

**Step 3: Review results**

Check `results/<run_id>/category_c_report.json`:
- Timing test: ratio should be < 1.3x (PASS)
- Size test: delta should be < 64 bytes (PASS)
- Error shape: structures should match (PASS)

**Step 4: Commit results**

```
git add tests/live/results/
git commit -m "test: Category C meta-protocol leakage run (#56)"
```

---

## Task 15: Run full test suite and create PR

**Step 1: Run Rust tests**

Run: `cargo test --manifest-path ~/Development/vcav-io/av-claude/Cargo.toml --workspace`
Expected: all tests pass

**Step 2: Run clippy**

Run: `cargo clippy --manifest-path ~/Development/vcav-io/av-claude/Cargo.toml --workspace -- -D warnings`
Expected: no warnings

**Step 3: Run fmt check**

Run: `cargo fmt --manifest-path ~/Development/vcav-io/av-claude/Cargo.toml --all -- --check`
Expected: no formatting issues

**Step 4: Run TS tests**

Run: `cd ~/Development/vcav-io/av-claude/packages/agentvault-client && npm test`
Expected: all tests pass

**Step 5: Push and create PR**

```
git push -u origin claude/wave8-testing-demo
gh pr create --title "feat: Wave 8 — testing tooling + demo containerization" \
  --body "## Summary
- Containerize AV relay for GHCR + 5-minute demo (#669)
- Paraphrase stability tooling with surface-variant prompts (#55)
- Category C meta-protocol leakage tests with metadata endpoint (#56)

## Test plan
- [ ] Docker image builds and starts successfully
- [ ] drive.sh --variant flag selects correct input files
- [ ] stability.sh produces valid stability report
- [ ] /sessions/:id/metadata returns timing data in dev mode
- [ ] /sessions/:id/metadata returns 404 in production mode
- [ ] drive-catc.sh produces valid Category C report
- [ ] All existing Rust and TS tests pass"
```

---

## Verification Summary

After all tasks:
```bash
# Rust
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check

# TypeScript
cd packages/agentvault-client && npm test

# Docker
docker build -f docker/Dockerfile.relay -t agentvault-relay:test .

# Live tests (requires API key + running relay)
./tests/live/stability.sh --scenario 03 --provider anthropic
./tests/live/drive-catc.sh --scenario 03 --provider anthropic
```
