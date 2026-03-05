# Provider Notes

Model sweep results and provider-specific observations for AgentVault relay mediation.

## Key Finding: Agent-Relay Pairing Matters More Than Relay Model Tier

Relay model capability in isolation is necessary but not sufficient. A capable relay model will fail to produce meaningful mediation output if the agent model doesn't provide adequate inputs. Tier recommendations below are stated as relay model floors — the agent model pairing is the binding constraint on output quality.

## Current-Gen Sweep Results (2026-03-05)

Sweep script: `tests/live/sweep.sh` | Scenario: `01-cofounder-mediation`

| Provider | Model | Tier | Signal | Quality |
|----------|-------|------|--------|---------|
| Anthropic | `claude-haiku-4-5-20251001` | budget | PARTIAL_ALIGNMENT | PASS |
| Anthropic | `claude-sonnet-4-6` | reference | PARTIAL_ALIGNMENT | PASS |
| OpenAI | `gpt-5-nano` | budget | PARTIAL_ALIGNMENT | PASS |
| OpenAI | `gpt-5-mini` | mid | PARTIAL_ALIGNMENT | PASS |
| Gemini | `gemini-3.1-flash-lite-preview` | budget | NEEDS_FACILITATION | PASS |
| Gemini | `gemini-3-flash-preview` | mid | PARTIAL_ALIGNMENT | PASS |

**All current-gen models pass at every tier**, including budget. This is a change from the previous sweep (2026-03-04), where `gpt-5-nano` and `gpt-5-mini` returned no output (both were pre-GA at the time), and `gpt-4.1-nano` failed with degenerate output (`INSUFFICIENT_SIGNAL` / `NO_COMMON_GROUND_DETECTED`).

## Demo Defaults

The demo should use the cheapest viable model per provider. All budget-tier current-gen models now pass, so recommended defaults for minimum cost:

| Provider | Recommended Default | Tier | Rationale |
|----------|-------------------|------|-----------|
| Gemini | `gemini-3.1-flash-lite-preview` | budget | Cheapest. Signals NEEDS_FACILITATION (slightly more conservative) but valid |
| OpenAI | `gpt-5-nano` | budget | Cheapest GPT-5. Now GA and producing valid structured output |
| Anthropic | `claude-haiku-4-5-20251001` | budget | Only budget option with tool-call support |

## Provider-Specific Notes

### Anthropic

- **Conservative signaling**: In red team testing, Anthropic models produce more conservative signals (NO_MATCH/UNKNOWN) compared to OpenAI. This affects utility, not privacy — the schema is the primary privacy control.
- **Stable under adversarial pressure**: Shows drift under adaptive adversary in multi-session accumulation tests, but no privacy leaks.
- **No cheaper option**: Haiku 4.5 is both the agent and relay default — no cheaper Anthropic model supports tool calling.

### OpenAI

- **Most stable across sessions**: In red team testing, OpenAI models showed perfectly stable signal distribution across multi-session runs with no drift.
- **GPT-5 family now viable**: Previous sweep showed gpt-5-nano and gpt-5-mini failing (pre-GA). Both now produce valid structured output at budget/mid tiers.
- **GPT-4.1-nano still fails**: The previous-gen budget model produced degenerate output (`INSUFFICIENT_SIGNAL`). Current-gen gpt-5-nano does not have this problem.

### Gemini

- **Slightly more conservative at budget tier**: `gemini-3.1-flash-lite-preview` signals NEEDS_FACILITATION where mid/reference models signal PARTIAL_ALIGNMENT. This is a quality difference, not a correctness failure.
- **All Gemini models report HIGH confidence**: Both budget and mid tiers consistently return `confidence_band: HIGH`, where Anthropic and OpenAI budget models return MEDIUM.
- **Preview model IDs**: Current Gemini 3 models use `-preview` suffixes. These may change when models graduate to GA.

## Previous-Gen Comparison (2026-03-04)

For reference, the prior sweep included previous-gen models:

| Model | Tier | Result | Notes |
|-------|------|--------|-------|
| `gpt-4.1-mini` | mid | PASS | Previous default; superseded by gpt-5-nano |
| `gpt-4.1-nano` | budget | FAIL | Degenerate output (INSUFFICIENT_SIGNAL) |
| `gemini-2.5-flash` | mid | PASS | Previous default; superseded by gemini-3.1-flash-lite |
| `gemini-2.5-flash-lite` | budget | PASS | Previous-gen budget still worked |

## Limitations

- **Sweep tests relay model in isolation**: Pre-defined inputs are submitted directly via curl, bypassing the agent loop. This tests whether the relay model can produce valid structured output, not whether the full agent→relay pipeline works well.
- **Single scenario**: The sweep uses scenario 01 (cofounder mediation). Different scenarios with different schemas may produce different results.
- **Single run per model**: No statistical confidence. A model that passes once may fail on retry with different sampling.

## Running the Sweep

```bash
# All models in models.json
./tests/live/sweep.sh

# Filter by provider
./tests/live/sweep.sh --providers gemini,anthropic

# Different scenario
./tests/live/sweep.sh --scenario 04-adversarial-extraction
```

Results are saved to `tests/live/results/sweep-<timestamp>/`.
