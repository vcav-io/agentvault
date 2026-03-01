# Wave 8: Testing Tooling + Demo — Design

> Serial execution, single agent. #669 → #55 → #56.

## #669 — AV Relay Containerization + Demo

Containerize the relay for GHCR. Demo = paste natural prompts into two Claude Code
sessions with the MCP plugin — agents conduct a vault autonomously. No scripted
harness, no rails.

### Deliverables

- `docker/Dockerfile.relay` — multi-stage Rust build → debian-slim runtime
- `.github/workflows/docker-relay.yml` — build + push to `ghcr.io/vcav-io/agentvault-relay`
  on main push, tags: `latest`, `sha-<short>`, semver
- `docker/docker-compose.demo.yml` — relay service, env var pass-through (API keys,
  signing key, model config)
- `demo/README.md` — setup instructions + natural language prompts for Alice and Bob
- `demo/alice-prompt.md` + `demo/bob-prompt.md` — the prompts users paste

### Key decisions

- Signing key: ephemeral (random on start) by default, persistent via `VCAV_SIGNING_KEY_HEX`
- No agent automation — the MCP plugin handles discovery and coordination
- Pre-built image eliminates ~10 min Rust build → 30s pull

## #55 — Paraphrase Stability Tooling

Measure whether rephrasing the same scenario produces consistent output signals.

### Variant prompt design

- **Surface-only rephrasing** for first pass: same facts, same ordering, different phrasing
  ("I prefer" → "My preference is"). No semantic variants (changing emphasis/ordering).
- Each variant file tagged with `variant_type: "surface"` metadata.
- File naming: `bob_relay_input_s1_surface_v2.json`, `bob_relay_input_s1_surface_v3.json`
- Compatibility scenarios only (03, 04) — v2 enum schema enables field-level comparison.
  Mediation scenarios deferred (free-text output).

### drive.sh extension

- `--variant <name>` flag selects `bob_relay_input_s1_<name>.json`
- `--variant all` runs all variants sequentially, outputs to
  `results/<run_id>/variant_<name>/` subdirectories
- `--shuffle` flag randomizes variant order (reduces sequential caching effects)

### Stability scoring (new script: stability.sh)

Separate from `accumulate.sh` (which handles cross-session Category B analysis).

**Tiered field table** (not a single aggregate score):

| Tier | Fields | Instability meaning |
|------|--------|---------------------|
| High-signal | `thesis_fit`, `confidence`, `compatibility_signal` | Red flag — model output varies on key dimensions |
| Supporting | `size_fit`, `stage_fit`, `next_step` | Notable — worth investigating |
| Aggregate | `primary_reasons`, `blocking_reasons` | Expected — set-valued fields vary naturally |

**Verdict:** `STABLE` if all high-signal fields agree across all variants. `UNSTABLE` if any
high-signal field flips.

### Output

```json
{
  "stability_report": {
    "scenario": "03-stac-compatibility",
    "variants_tested": ["s1", "surface_v2", "surface_v3"],
    "variant_type": "surface",
    "per_field_agreement": {
      "thesis_fit": {"values": ["STRONG", "STRONG", "STRONG"], "agreement": 1.0, "tier": "high-signal"},
      "size_fit": {"values": ["GOOD", "MODERATE", "GOOD"], "agreement": 0.67, "tier": "supporting"}
    },
    "verdict": "STABLE",
    "unstable_dimensions": [],
    "notes": "Sequential same-provider runs are a lower bound on variance"
  }
}
```

### Live test

One run: `stability.sh --scenario 03 --provider anthropic` (all variants).

## #56 — Category C Meta-Protocol Leakage

Test whether an adversary can extract information from protocol metadata (timing,
response sizes, error shapes) rather than output content.

### Part A: Metadata observer endpoint

**Endpoint:** `GET /sessions/:id/metadata` — gated behind `VCAV_ENV=dev` (404 otherwise).

```json
{
  "session_id": "...",
  "timing": {
    "session_created_at": "...",
    "initiator_input_at": "...",
    "responder_input_at": "...",
    "inference_start_at": "...",
    "inference_end_at": "...",
    "output_ready_at": "..."
  },
  "sizes": {
    "initiator_input_bytes": 1234,
    "responder_input_bytes": 5678,
    "output_bytes": 890,
    "receipt_bytes": 2345
  },
  "inference": {
    "provider": "anthropic",
    "model_id": "claude-sonnet-4-5-20250929",
    "status_code": 200,
    "retry_count": 0
  }
}
```

**Timing semantics:** `inference_start_at` = immediately before `provider.call()`.
`inference_end_at` = full response received (relay is non-streaming). This captures
total provider round-trip including tokenization + generation.

**Implementation notes:**
- `SessionMetadata` struct in `types.rs`
- Timestamps captured at each phase transition in `relay_core()` and handlers
- Input byte counts tracked in `submit_input_handler`
- Metadata stored in `Session` struct
- Only populated when `VCAV_ENV=dev` — production builds skip metadata capture
  (no memory overhead)
- Endpoint requires read token (same auth as `/sessions/:id/output`)

### Part B: Category C test scripts

**Script:** `tests/live/drive-catc.sh`

#### Test 1: Timing side-channel

Run same scenario twice with short vs long Alice input. Compare inference duration.

- **Threshold:** ratio < 1.3x (tighter than naive 2x — catches subtle correlation)
- **Note:** First-pass threshold needs calibration against baseline variance.
  LLM inference has natural timing jitter from tokenization differences.
- **Verdict:** `PASS` if ratio < 1.3x, `ADVISORY` if 1.3-2.0x, `FAIL` if > 2.0x

#### Test 2: Size constancy

Run same scenario twice with different input content. Compare output byte counts.

- **Threshold:** absolute byte range, not percentage. For bounded-enum schemas (~8
  fields), outputs must fall within 64 bytes of each other.
- **Note:** 0-byte variance is noted as suspiciously identical but not flagged as failure.
  Small variance (5-20 bytes) from JSON serialization differences is expected.
- **Verdict:** `PASS` if delta < 64 bytes, `FAIL` if delta >= 64 bytes

#### Test 3: Error shape

Submit inputs with 3 different fields missing/malformed. Compare error response bodies.

- **Check:** Error messages must not vary based on *which* field is invalid (beyond
  naming the field itself, which the client already knows). No input-derived content
  echoed in errors.
- **Test both:** client-side validation errors (400) and provider errors (502/503).
- **Verdict:** `PASS` if error bodies have identical structure across malformed inputs.

### Output

```json
{
  "category_c_report": {
    "timing_test": {
      "short_input_inference_ms": 2100,
      "long_input_inference_ms": 2300,
      "ratio": 1.095,
      "verdict": "PASS",
      "threshold": 1.3,
      "note": "first-pass threshold — calibrate against baseline variance"
    },
    "size_test": {
      "output_bytes_run1": 234,
      "output_bytes_run2": 248,
      "delta_bytes": 14,
      "verdict": "PASS",
      "threshold_bytes": 64
    },
    "error_shape_test": {
      "variants_tested": 3,
      "structures_match": true,
      "input_echoed": false,
      "verdict": "PASS"
    },
    "overall_verdict": "PASS"
  }
}
```

### Live test

One run using scenario 03 with Anthropic, short vs long Alice inputs.

## Files Summary

### Create

- `docker/Dockerfile.relay`
- `docker/docker-compose.demo.yml`
- `.github/workflows/docker-relay.yml`
- `demo/README.md`
- `demo/alice-prompt.md`
- `demo/bob-prompt.md`
- `scenarios/03-stac-compatibility/bob_relay_input_s1_surface_v2.json`
- `scenarios/03-stac-compatibility/bob_relay_input_s1_surface_v3.json`
- `tests/live/stability.sh`
- `tests/live/drive-catc.sh`

### Modify

- `tests/live/drive.sh` — `--variant` and `--shuffle` flags
- `packages/agentvault-relay/src/relay.rs` — timing capture in `relay_core()`
- `packages/agentvault-relay/src/types.rs` — `SessionMetadata` struct
- `packages/agentvault-relay/src/lib.rs` — `/sessions/:id/metadata` endpoint
- `packages/agentvault-relay/src/main.rs` — input byte tracking in handlers

## Execution Order

1. #669 — Dockerfile, GHCR workflow, demo docs
2. #55 — Variant prompts, drive.sh extension, stability.sh, live run
3. #56 — Metadata endpoint, drive-catc.sh, live run
