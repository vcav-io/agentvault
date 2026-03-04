# Demo UI Model Defaults

Current model defaults per provider for the AgentVault demo UI.

## Agent models (primary conversation)

| Provider | Default model | Tier | Notes |
|----------|--------------|------|-------|
| Gemini | `gemini-2.5-flash` | mid | Good tool-use support, cost-effective |
| OpenAI | `gpt-4.1-mini` | mid | Strong tool-calling, mid-price |
| Anthropic | `claude-haiku-4-5-20251001` | budget | Fast, cheap, adequate for demo |

## Heartbeat models (polling loops)

| Provider | Default model | Tier | Notes |
|----------|--------------|------|-------|
| Gemini | `gemini-2.5-flash-lite` | budget | Cheapest Gemini with tool use |
| OpenAI | `gpt-4.1-nano` | budget | Cheapest OpenAI with tool-calling support |
| Anthropic | `claude-haiku-4-5-20251001` | budget | Same as agent (no cheaper option with tool use) |

## Available models in UI selector

### Gemini
- `gemini-2.5-flash` (mid, default)
- `gemini-2.5-flash-lite` (budget)

### OpenAI
- `gpt-4.1-mini` (mid, default)
- `gpt-4.1-nano` (budget)

### Anthropic
- `claude-haiku-4-5-20251001` (budget, default)
- `claude-sonnet-4-6` (reference)

## Selection heuristic

Cheapest model that:
1. Supports tool calling (required for agent loop)
2. Passes mediation quality threshold (produces valid structured output)
3. Is listed in the relay's `model_profile_allowlist`

## Removed models

- `gpt-5-mini` — does not exist (removed in PR #180)
- `gemini-3-flash-preview` — unverified, removed defensively

## Last sweep

- **Date**: 2026-03-04
- **Sweep method**: Manual audit of provider docs
- **Follow-up**: Run `tests/live/sweep.sh` for live validation (see issue #179)
