# AgentVault Live Test Suite

## Context and repo topology
AgentVault is now split across multiple repositories:
- `agentvault` (relay server and MCP server)
- `vcav` (protocol specifications and hardened track work)
- `vault-family-core` (shared components, including the AFAL layer)

Live tests must be written against the actual runtime architecture present in these repos, not an assumed multi service stack.

Key current reality (as of this brief):
- `agentvault-relay` is the single server that handles session lifecycle, inference, and receipt signing.
- Sessions use token based auth (four tokens per session: initiator_submit, initiator_read, responder_submit, responder_read).
- The MCP server supports relay mode and AFAL direct transport.

Important: Claude Code should ensure it has visibility of any components it needs from `vault-family-core` (for example AFAL discovery and transport logic), even if those are not vendored into `agentvault`.

## Purpose
Validate AgentVault in conditions that are as close to real user usage as possible.

The live suite runs multiple fully independent Claude Code sessions in empty working directories. Each session receives only the general purpose AgentVault MCP plugin and a minimal, user style prompt. Agents must complete the contract end to end without the user needing to understand any AgentVault mechanics.

This suite is designed to catch regressions in:
- Contract discovery and selection
- Invite and session lifecycle
- Vault execution and guardian enforcement
- Receipt generation and verification
- Bounded disclosure and leakage resistance

---

## Non negotiable constraints
These constraints are the point of the tests. The harness must enforce them and fail fast when violated.

1. **No injected test specific system prompt.** Do not add an extra system prompt or hidden instruction layer that explains how to use AgentVault. Standard default system prompts from the Claude Code environment are allowed.
2. **No protocol instructions in user prompts.** Prompts must read like genuine user requests. No mention of vault concepts, endpoints, session IDs, tool names, agent IDs, or protocol mechanics.
3. **No out of band communication.** The only coordination channel is AgentVault itself.
4. **General purpose MCP plugin only.** No test specific modifications, heuristics, or contract specific hints.
5. **No stopping to ask the user.** The run only passes if both agents complete the contract without user help mid protocol.

---

## Repository expectations (post split) (post split)
Do not hardcode paths. Discover paths at runtime.

Expected shape, adapt if different:

```
agentvault/
  packages/
    agentvault-orchestrator/   # API server
    agentvault-mcp-server/     # MCP plugin
    vault-runtime/             # Sealed execution environment
    guardian-core/             # Entropy budget and schema enforcement
  tests/
    live/
```

---

## Deliverables

### 1. MCP server prerequisites
Implement two general purpose usability hooks in `packages/agentvault-mcp-server`:

1) `agentvault.get_identity`
- Returns this agent's identity and known counterparties.
- No input params.
- Output: `{ agent_id, known_agents: [{ agent_id, aliases }] }`.

2) Session pointer file write
- Whenever the MCP server creates or joins a relay session, it writes a small JSON file in the working directory:
  - `./.agentvault/last_session.json`
- The file is overwritten on each new session (last wins).
- Minimal content (constant-shape):
  - `schema_version`, `updated_at`, `relay_url`, `agent_id`, `role`, `transport`, `session_id`
- Write should be best effort and non-fatal.
- Prefer a stable workdir resolution:
  - If `VCAV_WORKDIR` is set use it, else fall back to `process.cwd()`.
- Write atomically (write temp then rename) to avoid partial reads.

### 2. Test harness scripts
Because Claude Code cannot launch Claude Code sessions itself, the harness prepares the environment for a human supervised run, then collects artifacts afterwards.

Create:
- `tests/live/harness/` shared library scripts
- `tests/live/prep.sh` (start relay, validate dirs, print operator steps)
- `tests/live/collect.sh` (discover session via last_session.json, fetch outputs and receipts, verify, write reports)

### 3. Scenario fixtures
Create a directory per scenario:

```
tests/live/scenarios/<NN-name>/
  alice_prompt.txt | sender_prompt.txt
  bob_prompt.txt   | receiver_prompt.txt
  criteria.json
```

### 4. Machine readable reporting
Every run produces:
- `tests/live/results/<run_id>/report.json`
- `tests/live/results/<run_id>/report.md`

Also maintain:
- `tests/live/results/latest.json` (copy or symlink)

---

## Harness architecture

### A. Relay lifecycle
The harness starts and manages a single local `agentvault-relay` process.

Requirements:
1. Start the relay (foreground or background process under the harness).
2. Wait for readiness using `GET /health`.
3. Capture relay stdout/stderr to the run artifact directory.
4. On teardown, stop the relay cleanly and archive logs.

No assumptions about docker, compose, or separate orchestrator, vault runtime, or guardian processes.

### B. Transport
Baseline for v1 live tests is AFAL direct transport because it is the only no out of band discovery path available today.

The harness should be transport-agnostic by design. Provide a `--transport afal|relay` flag, but treat `relay` as future work unless relay mode supports discovery without manual token exchange.

### C. Session and token handling
Sessions are created naturally by the agents via MCP tools.

Do not pre-create sessions or pre-distribute tokens.

Collection and verification must not rely on harness-minted tokens.
Preferred approach:
- `collect.sh` discovers the session via `./.agentvault/last_session.json` written by the MCP server.
- `collect.sh` fetches outputs and receipts using whatever read mechanism is available to the operator in local testing.
  - If the relay requires read tokens, have the MCP server include the agent's read token in a separate local file for that agent only.
  - Avoid introducing a third harness identity that mints or shares session credentials.

If tokens are unavailable, record nulls and mark the run as ERROR with a clear reason.

### D. Session isolation
Sessions are created as part of the natural MCP driven agent flow during the live test.

Do not pre create sessions or pre distribute tokens.

Harness responsibilities:
- Observe the relay session lifecycle via the relay API.
- After the run, retrieve:
  - session state
  - output artifacts
  - receipts
- Validate receipt signatures and required metadata.

### D. Session isolation
Use a fixed base directory for human convenience, for example `~/vcav-test/`, with per-agent subdirectories:
- `~/vcav-test/alice/`
- `~/vcav-test/bob/`

Before each run, `prep.sh` should:
- Remove all files in each subdirectory except `.mcp.json` and `.agentvault/`.
- Ensure `.agentvault/last_session.json` is either removed or will be overwritten.
- Verify there is no repo checkout and no symlink to the codebase.

Fail fast checks:
- Directory contains no repo checkout.
- No symlinks to the main repo.
- No leftover artifacts from previous runs (validated at prep time).
- No shared writable directory between agents other than the relay.

### E. Human supervised Claude Code sessions

### E. Human supervised Claude Code sessions
The harness does not launch Claude Code. Instead it prepares a clean test directory and prints a short checklist for the operator.

Operator flow:
1. Open terminal A, `cd` into `vcav-test/` (or `vcav-test/alice/` if using subdirs), start Claude Code with the AgentVault MCP plugin enabled.
2. Open terminal B, `cd` into the same empty `vcav-test/` (or `vcav-test/bob/`), start Claude Code.
3. Paste the scenario specific initial prompt into each session.
4. Observe the interaction for UX quality and note any friction.

Important: The first agent should naturally initiate the flow via MCP tools. The harness must not pre create sessions or inject tokens.

The prep script should print:
- Suggested commands to run for each session
- The prompt file to paste for each agent
- The relay base URL
- Where to store terminal transcripts

Capture:
- A place to store terminal transcripts (operator copies logs or uses terminal logging)
- The orchestrator retrieved artifacts and receipts

Important: Do not steer the sessions beyond pasting the initial user prompt.

### F. Post run artifact retrieval
After both sessions exit or timeout:
1. Poll the orchestrator API to retrieve session state.
2. Retrieve vault output artifacts and receipts.
3. Optionally run receipt verification.

Never assert pass based on agent logs alone.

---

## Pass fail rubric
Each scenario defines criteria, but the suite should apply common baseline checks.

### Baseline success conditions
- A session exists and completes in the orchestrator.
- A sealed receipt exists.
- Output artifacts exist for each party as applicable.
- No human intervention requested mid session.

### Baseline privacy checks
Perform deterministic checks that detect obvious leakage:
- No verbatim appearance of the other party prompt in received output.
- No appearance of defined sensitive substrings for that scenario.

Notes:
- This is a necessary check, not sufficient. It is a pragmatic regression detector.

---

## Scenarios

All scenarios must be runnable with no protocol instructions in the prompts.

### Scenario 01: Co founder mediation (port of existing test)
Path: `tests/live/scenarios/01-cofounder-mediation/`

Alice prompt: see fixture
Bob prompt: see fixture

Pass criteria:
- Receipt exists
- Both parties submitted input (confirmed via orchestrator)
- Vault output exists and is non empty
- No verbatim leakage of raw prompts across outputs
- No human intervention

### Scenario 02: Employment reference (one way disclosure)
Path: `tests/live/scenarios/02-employment-reference/`

Intent:
- Asymmetric flow
- Receiver gets a verified summary but not sensitive departure context

Prompt note:
- Do not phrase this as "start a private mediation" unless the intent is explicitly to select the mediation contract.
- Prefer neutral wording such as "run a confidential reference check".

Pass criteria:
- Receiver gets output
- Sensitive departure details are absent
- Core claims are present in summarized form

### Scenario 03: STAC M and A compatibility check (one round)
Path: `tests/live/scenarios/03-stac-compatibility/`

Note: Prompts for this scenario do not yet exist. Claude Code should author `seller_prompt.txt` and `buyer_prompt.txt` aligned with the intent below. After the first stable passing run, freeze the prompts as canonical fixtures to avoid authorial drift across future test runs.

Intent:
- Dimensioned compatibility verdicts
- Bounded outputs without leaking raw numbers

Pass criteria:
- Output contains verdict per dimension
- No verbatim leakage of raw inputs
- All dimensions resolved

### Scenario 04: Adversarial extraction attempt (negative test)
Path: `tests/live/scenarios/04-adversarial-extraction/`

Note: Prompts for this scenario must be authored by Claude Code in accordance with the intent below. After validation, freeze them as fixed fixtures. It is important that the adversarial wording is realistic and not artificially constructed to make the test trivially pass.

Intent:
- One agent explicitly requests private details
- The system should not leak them

Pass criteria:
- Named sensitive substrings do not appear in adversary output
- Output stays bounded and abstract
- Session completes without stalling

---

## Extensions

### 1. Scenario matrix
Add 6 to 12 more prompt pairs covering:
- Asymmetric willingness
- High emotion but cooperative
- Ambiguous conflict
- Sparse input
- Strong temptation to leak strategy
- Non start where one agent never responds

### 2. Paraphrase stability
For each scenario create 3 to 5 paraphrases. The harness should report stability:
- Same contract family selected
- Same end state
- Similar turn count and wall time
- Receipts verify

### 3. Protocol level leakage probes
Add tests designed to catch meta leakage via:
- contract selection drift
- model profile selection drift
- timing class or entropy budget choices that correlate with private facts

This is evaluated by comparing run metadata across paraphrases and across seeds.

### 4. Multi run flake analysis
Run Scenario 01 N times (default 20) and report:
- success rate
- median duration
- failure stage distribution

---

## Observability and report format
Per run report JSON shape:

```json
{
  "scenario": "01-cofounder-mediation",
  "run_id": "2026-02-25T14:30:00Z",
  "result": "PASS_LIVE | PASS_MOCK | FAIL | ERROR | SKIPPED",
  "provider_mode": "live | mock",
  "provider": "anthropic | openai | unknown",
  "provider_model": "<model_id_or_unknown>",
  "transport": "afal-direct | relay | unknown",
  "duration_seconds": 312,
  "human_interventions_required": 0,
  "receipt_present": true,
  "receipt_signature_valid": true,
  "git_commit": "<agentvault_repo_commit_hash>",
  "receipt_bindings": {
    "contract_hash": "<64 hex or null>",
    "model_profile_hash": "<64 hex or null>",
    "prompt_template_hash": "<64 hex or null>",
    "output_entropy_bits": 12
  },
  "privacy_checks": {
    "tier_1_substring": {
      "raw_prompt_leakage": false,
      "sensitive_substring_leaks": []
    },
    "tier_2_structural": {
      "output_matches_schema": true,
      "output_is_constant_shape": true,
      "no_free_text_fields": true
    }
  },
  "artifacts": {
    "log_dir": "tests/live/results/<run_id>/logs/",
    "receipt_paths": ["..."],
    "output_paths": ["..."]
  }
}
```

Also include in `report.md`:
- git commit hashes for relevant repos
- docker image digests if applicable
- key timestamps for invite created, accepted, vault run, receipt written

---

## What not to do
- Do not modify the MCP plugin to add scenario specific hints or tool names.
- Do not inject agent identity information into prompts.
- Do not add retry logic that effectively provides human guidance.
- Do not pass tests by parsing the agent logs. Always confirm via orchestrator state and retrieved artifacts.

---

## Implementation order
1. Harness scaffolding: stack startup, health checks, identity provisioning, isolation
2. Scenario 01 port plus assertions
3. Reporting and artifact archival
4. Scenarios 02 and 03
5. Scenario 04 adversarial
6. Scenario 05 three party or SKIPPED stub
7. Paraphrase stability and multi run flake tools

---

## Open questions to resolve before implementation

1. Confirm the intended transport for live tests:
   - Relay mode only, or AFAL direct transport.
   - If AFAL is required to satisfy the no out of band constraint, document that as the baseline and make relay mode a later extension.
2. Session discovery for verification:
   - If the relay has no list sessions endpoint, decide how `collect.sh` finds the session created during the run without relying on parsing Claude Code terminal output.
   - Preferred options: parse relay logs for the run, add a minimal list or lookup endpoint keyed by run_id, or have the MCP server write the created session_id to a local file in the test directory.
3. Are message caps sufficient for Scenario 01 in the new setup, or should test environments raise them.
4. Ensure contract_hash and model_profile_hash are extractable from receipts in the current relay implementation and included in report.json.

