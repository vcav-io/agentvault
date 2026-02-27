# OpenClaw Integration Brief – AgentVault MCP Server

## Objective

Prepare the existing AgentVault MCP server for real-world peer-to-peer testing between two OpenClaw VPS instances (Alice and Bob), with no out-of-band coordination and no protocol instructions embedded in user prompts.

The goal is to successfully complete the first real AgentVault vault session between two independent OpenClaw agents running on separate VPS hosts.

---

# 1. Architectural Decision

## Phase 1: No Native Plugin Port

We will NOT initially build a native OpenClaw plugin.

Instead, we will:

• Run the existing AgentVault MCP server as-is
• Use OpenClaw's mcporter runtime to call MCP tools
• Provide an OpenClaw Skill that teaches the agent how to use AgentVault tools

This keeps the trusted surface minimal and preserves protocol isolation.

Native plugin work can be considered later.

---

# 2. Target Topology

Two independent machines:

Alice VPS:
- OpenClaw installed
- mcporter installed
- AgentVault MCP server configured

Bob VPS:
- OpenClaw installed
- mcporter installed
- AgentVault MCP server configured

Transport mode for first test:
- AFAL direct transport (preferred for strict no-OOB constraints)

Relay mode may be added later if discovery is fully tool-mediated.

---

# 3. Required Components on Each VPS

## 3.1 OpenClaw Installation

Confirm:
- ~/.openclaw/openclaw.json exists
- OpenClaw service running
- Skills directory available at ~/.openclaw/skills

## 3.2 mcporter Installed

Confirm:
- mcporter binary available to OpenClaw runtime user
- mcporter can list MCP tools

## 3.3 AgentVault MCP Server Reachability

Each VPS must:
- Run its own MCP server instance
- Or securely reach a hosted MCP endpoint
- Use TLS if exposed publicly
- Avoid leaking credentials in logs

---

# 4. OpenClaw Skill Design

Create a skill directory:

~/.openclaw/skills/agentvault/

With at minimum:

SKILL.md

## 4.1 Purpose of Skill

The skill:
- Teaches the agent how to use AgentVault tools
- Encodes correct lifecycle usage
- Prevents protocol instructions from appearing in user prompts
- Ensures no user-side coordination steps are required

## 4.2 Skill Must Instruct Agent To

1. Use mcporter to:
   - Discover available MCP tools
   - Inspect tool schemas
   - Invoke tools strictly via structured calls

2. Begin flow with identity retrieval

3. Prefer AFAL direct transport

4. Avoid asking the human for protocol coordination

5. Persist session references via:
   ./.agentvault/last_session.json

6. Continue tool-mediated polling or state resolution until session completes

---

# 5. Security Constraints

The OpenClaw integration must preserve:

• No protocol logic in user prompt
• No OOB token exchange
• No manual copy-paste
• No model free-text negotiation outside vault
• All session state derived via tools

The skill enforces these constraints.

---

# 6. Pre-Live Test Checklist

On both VPS hosts:

[ ] OpenClaw running
[ ] Skill appears in `openclaw skills list --eligible`
[ ] mcporter can list AgentVault MCP tools
[ ] get_identity works
[ ] last_session.json is written correctly
[ ] Tool schemas validate correctly

---

# 7. First Live Session Run Plan

1. Start both OpenClaw agents
2. Provide natural-language request requiring vault coordination
3. Allow agents to:
   - Discover each other via AFAL
   - Exchange invites
   - Create session
   - Execute vault
4. Collect:
   - Guardian receipts
   - Session pointer files
   - Logs

Success criteria:
- No manual coordination
- No prompt-based protocol hints
- Session fully completed
- Receipts verifiable

---

# 8. Phase 2 (Optional): Native OpenClaw Plugin

If desired later:

A TypeScript plugin could:
- Provide native tools instead of mcporter indirection
- Expose configuration via openclaw.plugin.json
- Add UI hints

This increases integration tightness but expands trusted surface.

Not required for first peer-to-peer test.

---

# 9. Deliverables

For integration readiness:

1. OpenClaw Skill (agentvault)
2. VPS runbook
3. MCP server configuration guide
4. Live test log capture plan

---

End of Brief

