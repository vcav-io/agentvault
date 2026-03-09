# Demo Integrity Rules

This document defines the design constraints for the AgentVault demo UI, its
scenario corpus, its agent-facing system prompts, and the implementation
choices that shape the live experience.

The goal is simple: the demo should show AgentVault working with ordinary agent
inputs under bounded disclosure. It should not depend on hidden signaling,
special prompt engineering, or UI behavior that quietly smuggles information
outside the protocol.

## Why this exists

The demo is public-facing evidence. If it only works because the prompts,
system behavior, or UI are carefully engineered to steer the outcome, it stops
demonstrating the core claim.

The core claim is narrower:

- two agents hold private context
- the relay runs a fixed contract
- only a bounded informational signal leaves the session
- the receipt proves what governed that session

The demo must preserve that claim at every layer.

## Scope

These rules apply to:

- scenario prompts in
  [public/scenarios.js](/Users/tobykershaw/Development/vcav-io/av-codex/packages/agentvault-demo-ui/public/scenarios.js)
- agent-facing system prompts in
  [src/server.ts](/Users/tobykershaw/Development/vcav-io/av-codex/packages/agentvault-demo-ui/src/server.ts)
- UI language and controls in
  [public/app.js](/Users/tobykershaw/Development/vcav-io/av-codex/packages/agentvault-demo-ui/public/app.js),
  [public/render.js](/Users/tobykershaw/Development/vcav-io/av-codex/packages/agentvault-demo-ui/public/render.js),
  and [public/index.html](/Users/tobykershaw/Development/vcav-io/av-codex/packages/agentvault-demo-ui/public/index.html)
- runtime behavior in
  [src/agent-loop.ts](/Users/tobykershaw/Development/vcav-io/av-codex/packages/agentvault-demo-ui/src/agent-loop.ts)
  and related demo server code

## Core principles

### 1. No out-of-band communication

Demo prompts and system prompts must not create side channels between agents.

Forbidden patterns:

- telling one agent to convey a hidden fact to the other
- embedding coded phrases, acrostics, numbers, or stylistic markers meant to
  carry extra information
- asking an agent to use tone, wording, or timing as a covert signal
- agent instructions that reveal more than the bounded output is meant to carry

The only intended cross-agent channel is the protocol output permitted by the
contract and schema.

### 2. Natural language only

User-facing scenario prompts must read like plausible messages from ordinary
users to their assistants.

Forbidden patterns:

- references to contracts, schemas, receipts, policies, entropy, or protocol
  internals
- instructions that assume knowledge of the relay implementation
- test-harness phrasing designed around internal states rather than user needs

Allowed prompts should still make sense if the user never heard of AgentVault.

### 3. No coaching the system

The demo must not succeed because the prompts explain how the system should
behave.

Forbidden patterns:

- "use the vault to..."
- "coordinate privately..."
- "return an enum..."
- "produce a bounded output..."
- "do not reveal X directly; instead encode it as Y"

The system prompt may explain the tool surface to the agent, but it must not
coach the model toward a pre-arranged answer or use hidden instructions to
manufacture clean outcomes.

### 4. Symmetry between participants

Both sides should look like independent user asks, not a paired script.

That means:

- either side should be believable on its own
- the two prompts should not look like mirror-written fixtures
- one side should not exist only to tee up a predetermined outcome
- differences in viewpoint are fine; hidden choreography is not

Symmetry does not mean both prompts are identical. It means both are equally
plausible as ordinary user messages.

### 5. Realistic user context

Scenarios should involve tasks a real assistant could plausibly help with:

- mediation
- compatibility assessment
- scheduling or planning constraints
- negotiation
- bounded triage or signaling under privacy constraints

Scenarios should not be synthetic protocol puzzles or thinly disguised tests of
the harness.

## Scenario prompt rules

Each scenario prompt must satisfy all of the following:

- it is written as a normal user message
- it does not mention AgentVault or relay mechanics
- it does not prescribe the output format
- it does not instruct the agent to signal hidden content indirectly
- it contains enough realistic context to motivate a bounded mediation or
  compatibility result

Each scenario pair should also satisfy:

- both prompts remain credible if read independently
- the scenario does not depend on the users knowing the same script
- the pair tests a real bounded-disclosure use case, not only a canary

## System prompt rules

System prompts are allowed to define:

- role and tone
- the available tools
- when to use `agentvault.get_identity` and `agentvault.relay_signal`
- that the agent should help the user achieve their goal through the available
  workflow

System prompts are not allowed to:

- invent additional hidden channels
- tell the model to steer toward a specific schema value regardless of context
- instruct the model to encode extra information in wording, timing, or retry
  patterns
- blur the distinction between the bounded signal and the agent's own decision

The system prompt should help the agent use the demo correctly, but should not
rig the result.

## UI and interaction rules

The demo UI must not imply guarantees or causal structure that the protocol
does not actually provide.

### 1. The UI must present protocol events honestly

If a panel is labeled like a timeline or protocol session, it must not append
raw tool calls in a way that makes the protocol look like it moved backward.

Implication:

- stateful milestone views need suppression or grouping for repeated tool calls
- raw tool chatter belongs in an event log, not in a normative-looking session
  timeline

### 2. The UI must distinguish bounded output from agent narration

Agent chat messages are explanations or assistant behavior. They are not the
protocol output itself.

Implication:

- a bounded signal or receipt should be visually distinct from chat bubbles
- UI copy must not imply that agent prose is the output guaranteed by the
  contract

### 3. The UI must not overstate completion

A run should only be presented as complete when the protocol reached a terminal
state that matches the user's expectation:

- success with bounded output and receipt, or
- explicit failure/abort with a terminal error state

The UI should not mark a run complete merely because both local agent loops
stopped producing messages.

### 4. The UI must not hide trust assumptions

The software-lane demo must remain explicit that:

- the relay sees plaintext inputs
- the counterparty does not see the other side's raw context
- the bounded output and receipt are the architectural point

### 5. The UI should prefer understandable recovery over silent retries

Retries are valid, but invisible retries can make the demo feel arbitrary.

Implication:

- retried invite/respond paths should be visible and comprehensible
- recovered flows should not leave behind a misleading trail that appears like a
  protocol contradiction

## Implementation rules

The implementation should preserve the same integrity bar.

### 1. No hidden state channels between agents

The demo runtime must not pass information from one agent to the other except
through the protocol or plainly visible user interaction.

That includes:

- shared mutable state used as an implicit coordination channel
- injecting one side's private prompt into the other's runtime context
- summarizing private data into debug or status surfaces that are then visible
  cross-panel

### 2. Test helpers must not become production behavior

Synthetic values, canaries, retry helpers, and diagnostic state are valid for
testing, but the live demo path should not rely on them to function.

### 3. Failures should fail clearly

If the relay aborts, the UI and agent loop should surface that as an abort or
error state, not quietly drift into a pseudo-complete state.

### 4. Default paths must be valid

The first-run path matters. Default models, default scenarios, and default UI
choices should work on a fresh setup with a valid provider key.

### 5. Review demo changes as protocol changes

Changes to demo prompts, system prompts, event rendering, or retry behavior
should be reviewed with the same skepticism as protocol code, because they can
change what the public believes the system proves.

## Review checklist

Use this checklist for any demo change:

- Does this introduce any hidden cross-agent signaling path?
- Would the scenario still look natural to an ordinary user?
- Does any prompt mention implementation details or protocol terms?
- Are both participant prompts independently plausible?
- Does the UI distinguish raw events, assistant narration, and bounded output?
- Does the UI claim completion only when the session is truly terminal?
- Does the default first-run path succeed on a normal local setup?
- Would a skeptical reader conclude the demo is working because of the
  protocol, not because of prompt choreography?

## Non-goals

These rules do not require:

- eliminating all assistant personality from the demo
- forbidding retries or recovery logic
- making both participants behaviorally identical
- banning adversarial scenarios entirely

They do require that the demo remain honest about where behavior comes from and
what the protocol actually constrains.

## Design standard

If there is any doubt, choose the interpretation that makes the demo more
boring, more literal, and more defensible.

The demo should win credibility by showing ordinary prompts flowing through a
bounded protocol, not by looking clever.
