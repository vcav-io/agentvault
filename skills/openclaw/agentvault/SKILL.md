---
name: agentvault
description: Orchestrate bounded agent-to-agent vault sessions via AgentVault MCP tools
---

# AgentVault Skill

This skill teaches you how to run bounded agent-to-agent vault sessions using the
AgentVault MCP tools. Follow all steps in order. Never deviate from the protocol
or ask the human for coordination steps.

---

## What AgentVault Does

AgentVault runs a bounded vault session between two agents. Each agent submits
private input. The relay evaluates both inputs against a contract schema and
returns a bounded signal. Neither agent sees the other's raw input.

**AgentVault returns bounded signals, not recommendations or decisions.
Interpretation happens outside the vault.**

---

## Step 1: Discover Identity and Check Inbox (Always First)

Before any vault session, call `agentvault.get_identity` with no arguments:

```json
{}
```

This returns:
- `agent_id` — your agent identifier
- `known_agents` — list of agents you can reach, with their IDs and aliases
- `pending_invites` — number of pending invites in your inbox (when inbox transport is active)
- `next_action` — if invites are pending, tells you which tool to call next
- `inbox_hint` — human-readable description of pending invites

**If `pending_invites` > 0:** follow `next_action` — call `agentvault.relay_signal`
in RESPOND mode. Another agent has already initiated a session with you.

**If `pending_invites` is 0 or absent:** use `known_agents` to find the counterparty
identifier and initiate a session yourself (Step 2).

Do not assume a counterparty ID — always resolve it from `known_agents`.

---

## Step 2: Start a Session

There are two roles. Decide which role you are playing before calling.

### Initiator (you go first)

Use mode `INITIATE`. Required fields:
- `mode`: `"INITIATE"`
- `purpose`: `"MEDIATION"` or `"COMPATIBILITY"`
- `counterparty`: the agent ID, name, or alias from `known_agents`
- `my_input`: your private context string

```json
{
  "mode": "INITIATE",
  "purpose": "COMPATIBILITY",
  "counterparty": "bob-agent",
  "my_input": "..."
}
```

The relay sends an invite to the counterparty and waits for their response.

### Responder (you join a session already initiated by another agent)

Use mode `RESPOND`. Required fields:
- `mode`: `"RESPOND"`
- `expected_purpose`: `"MEDIATION"` or `"COMPATIBILITY"` (must match what the initiator specified)
- `from`: the agent ID, name, or alias of the initiator
- `my_input`: your private context string

```json
{
  "mode": "RESPOND",
  "expected_purpose": "COMPATIBILITY",
  "from": "alice-agent",
  "my_input": "..."
}
```

The relay polls your inbox for a matching invite and submits your input when found.

---

## Step 3: Resume Loop

After the first call, the response may include:

```json
{
  "action_required": "CALL_AGAIN",
  "resume_token": "...",
  "state": "AWAITING"
}
```

When `action_required` is `CALL_AGAIN`, call `agentvault.relay_signal` again with
**only** the `resume_token`. Do NOT include `mode`, `my_input`, `counterparty`,
`from`, `purpose`, or any other fields:

```json
{
  "resume_token": "<value from previous response>"
}
```

Repeat this loop until `state` is `COMPLETED` or `FAILED`.

Do not wait for human input between resume calls. Continue polling autonomously.

---

## Step 4: Completion

When `state` is `COMPLETED`, the response contains:
- `output` — the bounded signal fields (e.g. `compatibility_signal`, `overlap_summary`)
- `interpretation_context` — field meanings and epistemic limits
- `receipt` — cryptographic receipt

Use `interpretation_context` to understand the signal fields. Present the result
using only what `interpretation_context` defines for each field.

---

## Step 5: Failure

When `state` is `FAILED`, read:
- `error_code` — machine-readable error type
- `user_message` — human-readable description of the failure

Follow the instructions in `user_message`. Do not retry the same call unless
the user_message explicitly says to retry.

---

## Session State File

After each call, the MCP server writes `./.agentvault/last_session.json` with
`session_id`, `role`, `read_token`, `relay_url`, and `timestamp`. This persists
session references across context resets without requiring human coordination.
Do not write this file yourself — the tool handles it.

---

## Protocol Rules

These rules are mandatory. Violating them breaks the bounded-disclosure guarantee.

### Never ask the human for protocol coordination

You must not ask the human for:
- Resume tokens
- Session IDs
- Submit tokens or read tokens
- Which mode to use
- Whether to call again

All of this is determined from tool responses.

### Resume calls must have only resume_token

After the first call, every subsequent call to `agentvault.relay_signal` must
include ONLY `resume_token`. No other fields.

### Use INITIATE and RESPOND modes

The `CREATE` and `JOIN` modes are legacy. Use `INITIATE` (you start the session)
or `RESPOND` (you join a session another agent started).

### Prefer AFAL direct transport

AFAL direct transport requires no relay server and enables strict no-out-of-band
operation. It is active when `VCAV_AFAL_SEED_HEX` is set in the environment.

---

## Display Rules

These rules preserve bounded disclosure for the human you are reporting to.

### What you MAY do

- Describe the bounded signal using the field meanings in `interpretation_context`
- Report the `state` and `error_code` on failure
- Report that a vault session was initiated or completed

### What you MUST NOT do

- NEVER repeat or paraphrase the content of `my_input` in your response
- NEVER restate the counterparty's private inputs (you did not see them)
- NEVER claim what the counterparty "knows", "saw", or "inferred"
- NEVER explain "what the vault probably thought" or invent reasoning
- NEVER invent narrative about the counterparty's decision-making
- NEVER print the value of `resume_token`
- NEVER print values listed in `display.redact`

Use ONLY the field meanings and epistemic limits in `interpretation_context`
when describing outputs to the human.

---

## Quick Reference

| State | Action |
|-------|--------|
| First call (initiator) | `mode: INITIATE`, `purpose`, `counterparty`, `my_input` |
| First call (responder) | `mode: RESPOND`, `expected_purpose`, `from`, `my_input` |
| `action_required: CALL_AGAIN` | Call with `resume_token` only |
| `state: COMPLETED` | Read output using `interpretation_context` |
| `state: FAILED` | Read `user_message`, follow instructions |

Available purposes: `MEDIATION`, `COMPATIBILITY`

Tools: `agentvault.get_identity`, `agentvault.relay_signal`
