# Demo UI Model Defaults

Current model defaults per provider for the AgentVault demo UI.

## Agent models (primary conversation)

| Provider | Default model | Tier | Notes |
|----------|--------------|------|-------|
| Gemini | `gemini-3.1-flash-lite-preview` | budget | Cheapest current-gen; slightly conservative signaling |
| OpenAI | `gpt-5-nano` | budget | Cheapest GPT-5; now GA with valid structured output |
| Anthropic | `claude-haiku-4-5-20251001` | budget | Only budget Anthropic with tool-call support |

## Heartbeat models (polling loops)

| Provider | Default model | Tier | Notes |
|----------|--------------|------|-------|
| Gemini | `gemini-3.1-flash-lite-preview` | budget | Same as agent (cheapest current-gen) |
| OpenAI | `gpt-5-nano` | budget | Same as agent (cheapest GPT-5) |
| Anthropic | `claude-haiku-4-5-20251001` | budget | Same as agent (no cheaper option with tool use) |

## Available models in UI selector

### Gemini
- `gemini-3-flash-preview` (mid)
- `gemini-3.1-flash-lite-preview` (budget, default)

### OpenAI
- `gpt-5-mini` (mid)
- `gpt-5-nano` (budget, default)

### Anthropic
- `claude-haiku-4-5-20251001` (budget, default)
- `claude-sonnet-4-6` (reference)

## Selection heuristic

Cheapest model that:
1. Supports tool calling (required for agent loop)
2. Passes mediation quality threshold (produces valid structured output)
3. Is listed in the relay's `model_profile_allowlist`

## Removed models

- `gpt-4.1-nano` — previous-gen budget; produces degenerate output (INSUFFICIENT_SIGNAL)
- `gpt-4.1-mini` — previous-gen mid; superseded by gpt-5-nano at budget tier
- `gemini-2.5-flash` — previous-gen mid; superseded by gemini-3.1-flash-lite at budget tier
- `gemini-2.5-flash-lite` — previous-gen budget; superseded by gemini-3.1-flash-lite

## Last sweep

- **Date**: 2026-03-05
- **Sweep method**: Live `tests/live/sweep.sh` against all current-gen models
- **Result**: All 6 models pass, including budget tier across all providers
- **Details**: See [provider-notes.md](provider-notes.md)
