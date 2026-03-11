# Demo UI Model Defaults

Current model defaults per provider for the AgentVault demo UI.

## Coordination models (UI selector)

| Provider | Default model | Tier | Notes |
|----------|--------------|------|-------|
| Gemini | `gemini-3-flash-preview` | flagship | Default coordination model shown in the selector |
| OpenAI | `gpt-5` | flagship | Default coordination model shown in the selector |
| Anthropic | `claude-sonnet-4-6` | flagship | Default coordination model shown in the selector |

## Heartbeat models (polling loops)

| Provider | Default model | Tier | Notes |
|----------|--------------|------|-------|
| Gemini | `gemini-3.1-flash-lite-preview` | budget | Same as agent (cheapest current-gen) |
| OpenAI | `gpt-4.1-nano` | budget | Cheapest OpenAI model used for heartbeat polling |
| Anthropic | `claude-haiku-4-5-20251001` | budget | Same as agent (no cheaper option with tool use) |

## Available models in UI selector

### Gemini
- `gemini-3-flash-preview` (mid)
- `gemini-3.1-flash-lite-preview` (budget, default)

### OpenAI
- `gpt-5` (flagship, default)
- `gpt-4.1-mini` (mid)

### Anthropic
- `claude-sonnet-4-6` (flagship, default)
- `claude-haiku-4-5-20251001` (budget)

## Selection heuristic

Two defaults are in play:
1. The coordination-model selector defaults to a stronger flagship model per provider for the main demo run.
2. Heartbeat polling defaults to the cheapest model with usable tool support.

## Removed models

- `gpt-4.1-nano` — removed from the coordination selector; still used for heartbeat polling, but produced degenerate mediation output as a primary coordination model
- `gpt-5-nano` — no longer used by the demo UI
- `gpt-5-mini` — no longer used by the demo UI
- `gemini-2.5-flash` — previous-gen Gemini default
- `gemini-2.5-flash-lite` — previous-gen Gemini budget option

## Last sweep

- **Date**: 2026-03-05
- **Sweep method**: Live `tests/live/sweep.sh` against all current-gen models
- **Result**: All 6 models pass, including budget tier across all providers
- **Details**: See [provider-notes.md](provider-notes.md)
