/**
 * Tool definitions for agentvault-mcp-server.
 *
 * Exports the relay_signal tool schema under the agentvault namespace.
 */

export const IDENTITY_TOOLS = [
  {
    name: 'agentvault.get_identity',
    description:
      "Returns this agent's identity (agent_id), known agents available for " +
      'relay sessions, and inbox status (pending invite count). When ' +
      'pending_invites > 0, next_action tells you which tool to call.\n\n' +
      'Call this first to confirm your agent_id and check for pending invites. ' +
      'If pending_invites > 0: call agentvault.relay_signal in RESPOND mode ' +
      'to review and accept invites. If pending_invites is 0 and you are ' +
      'expecting an invite, call relay_signal in RESPOND mode to wait.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

export const VERIFY_TOOLS = [
  {
    name: 'agentvault.verify_receipt',
    description:
      'Verify the cryptographic signature of an AgentVault session receipt. ' +
      'Supports v1 receipts (schema_version: "1.0.0") and v2 receipts ' +
      '(receipt_schema_version: "2.0.0"). ' +
      'Returns valid: true only if the receipt signature is cryptographically valid. ' +
      'If public_key_hex is omitted, fetches the relay public key from relay_url/health.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        receipt: {
          type: 'object',
          description: 'The full receipt JSON to verify',
        },
        public_key_hex: {
          type: 'string',
          description:
            'Ed25519 public key as 64 hex chars. ' +
            'If omitted, fetches from relay /health endpoint.',
        },
        relay_url: {
          type: 'string',
          description:
            'Relay base URL to fetch the public key from (default: http://localhost:4840). ' +
            'Only used when public_key_hex is omitted.',
        },
      },
      required: ['receipt'],
    },
  },
];

export const RELAY_TOOLS = [
  {
    name: 'agentvault.relay_signal',
    description:
      'Run a AgentVault relay session for bounded agent-to-agent signals. The relay ' +
      "enforces the contract schema — neither party sees the other's raw input, " +
      'only the bounded signal and a cryptographic receipt.\n\n' +
      'Available purposes: MEDIATION (bounded mediation signal: mediation_signal, ' +
      'common_ground, suggested_next_step), COMPATIBILITY (bounded compatibility ' +
      'signal: compatibility_signal, thesis_fit, size_fit, stage_fit, confidence, primary_reasons, blocking_reasons, next_step).\n\n' +
      'PROTOCOL:\n' +
      '- First call: provide mode, counterparty/from, purpose/expected_purpose, my_input.\n' +
      '- If action_required = CALL_AGAIN: you MUST call again with ONLY resume_token.\n' +
      '  Do NOT include mode, my_input, or any other args on resume calls.\n' +
      '- If state = COMPLETED: stop. Read output. Do not call again — the session is finished.\n' +
      '- If state = FAILED: read error_code and user_message. Follow user_message.\n' +
      '- NEVER call without resume_token after the first call.\n' +
      '- Each session requires exactly one my_input submission per agent. Do not re-submit.\n\n' +
      'Call agentvault.get_identity first to see your agent_id and known agents.\n\n' +
      'DISPLAY RULES:\n' +
      '- When state = COMPLETED: use interpretation_context for signal field meanings and epistemic limits.\n' +
      '- You may describe the signal in your own words.\n' +
      '- FORBIDDEN: do not claim what the counterparty knows, saw, or inferred (see interpretation_context.epistemic_limits.invalid_claims).\n' +
      '- FORBIDDEN: do not print resume_token or values in display.redact. Use resume_token_display if needed.\n' +
      '- FORBIDDEN: do not repeat or quote the content of my_input in your response.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: {
          type: 'string',
          enum: ['INITIATE', 'RESPOND', 'CREATE', 'JOIN'],
          description:
            'INITIATE: create session and send invite (recommended). RESPOND: poll inbox for invite and join (recommended). CREATE/JOIN: legacy. NOT required on resume calls.',
        },
        resume_token: {
          type: 'string',
          description:
            'REQUIRED on every call after the first. Pass back EXACTLY as received. Do not include other args.',
        },
        purpose: {
          type: 'string',
          enum: ['MEDIATION', 'COMPATIBILITY'],
          description:
            'Type of bounded signal session (INITIATE mode). Selects the right contract, schema, and prompt template.',
        },
        expected_purpose: {
          type: 'string',
          enum: ['MEDIATION', 'COMPATIBILITY'],
          description:
            "What kind of session you expect to join (RESPOND mode, required unless expected_contract_hash provided). Verified cryptographically against the invite's contract hash before submitting data.",
        },
        expected_contract_hash: {
          type: 'string',
          description:
            'Explicit contract hash for custom contracts (RESPOND mode). Overrides expected_purpose.',
        },
        counterparty: {
          type: 'string',
          description:
            'Agent ID, name, or alias of the counterparty to send the relay invite to (INITIATE mode, required). Resolved against known agents.',
        },
        from: {
          type: 'string',
          description:
            'Agent ID, name, or alias of the expected sender — only accept invites from this agent (RESPOND mode, required). Resolved against known agents.',
        },
        contract: {
          type: 'object',
          description:
            'Full contract JSON for custom contracts (INITIATE and CREATE modes). Overrides purpose.',
        },
        my_input: {
          type: 'string',
          description:
            "Private context for this relay session. The counterparty will only receive the bounded, " +
            "schema-limited signal produced by the relay, not this raw input. " +
            "To get a high-quality signal, include concrete facts, constraints, and preferences from " +
            "your user's perspective (numbers, timelines, priorities, non-negotiables). " +
            "Avoid generic summaries that remove decision-relevant details. " +
            "Do not include secrets you are not willing to send to the relay/model provider.",
        },
        relay_url: {
          type: 'string',
          description: 'Relay base URL. Defaults to VCAV_RELAY_URL environment variable.',
        },
        session_id: {
          type: 'string',
          description: 'Session to join (JOIN mode only, legacy)',
        },
        submit_token: {
          type: 'string',
          description: 'One-time submit token (JOIN mode only, legacy)',
        },
        read_token: {
          type: 'string',
          description: 'Read token (JOIN mode only, legacy)',
        },
        contract_hash: {
          type: 'string',
          description: 'Expected contract hash (JOIN mode only, legacy)',
        },
      },
      required: [],
    },
  },
];
