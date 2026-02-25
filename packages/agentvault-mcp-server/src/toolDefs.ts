/**
 * Tool definitions for agentvault-mcp-server.
 *
 * Exports the relay_signal tool schema under the agentvault namespace.
 */

export const IDENTITY_TOOLS = [
  {
    name: 'agentvault.get_identity',
    description:
      'Returns this agent\'s identity (agent_id) and the list of known agents ' +
      'available for relay sessions. Call this before agentvault.relay_signal ' +
      'to confirm your agent_id and discover counterparty aliases.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

export const RELAY_TOOLS = [
  {
    name: 'agentvault.relay_signal',
    description:
      'Run a AgentVault relay session for bounded agent-to-agent signals. The relay ' +
      'enforces the contract schema — neither party sees the other\'s raw input, ' +
      'only the bounded signal and a cryptographic receipt.\n\n' +
      'Available purposes: MEDIATION (bounded mediation signal: mediation_signal, ' +
      'common_ground, suggested_next_step), COMPATIBILITY (bounded compatibility ' +
      'signal: compatibility_signal, overlap_summary).\n\n' +
      'PROTOCOL:\n' +
      '- First call: provide mode, counterparty/from, purpose/expected_purpose, my_input.\n' +
      '- If action_required = CALL_AGAIN: you MUST call again with ONLY resume_token.\n' +
      '  Do NOT include mode, my_input, or any other args on resume calls.\n' +
      '- If state = COMPLETED: stop. Read output.\n' +
      '- If state = FAILED: read error_code and user_message. Follow user_message.\n' +
      '- NEVER call without resume_token after the first call.\n\n' +
      'Call agentvault.get_identity first to see your agent_id and known agents.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: {
          type: 'string',
          enum: ['INITIATE', 'RESPOND', 'CREATE', 'JOIN'],
          description: 'INITIATE: create session and send invite (recommended). RESPOND: poll inbox for invite and join (recommended). CREATE/JOIN: legacy. NOT required on resume calls.',
        },
        resume_token: {
          type: 'string',
          description: 'REQUIRED on every call after the first. Pass back EXACTLY as received. Do not include other args.',
        },
        purpose: {
          type: 'string',
          enum: ['MEDIATION', 'COMPATIBILITY'],
          description: 'Type of bounded signal session (INITIATE mode). Selects the right contract, schema, and prompt template.',
        },
        expected_purpose: {
          type: 'string',
          enum: ['MEDIATION', 'COMPATIBILITY'],
          description: 'What kind of session you expect to join (RESPOND mode, required unless expected_contract_hash provided). Verified cryptographically against the invite\'s contract hash before submitting data.',
        },
        expected_contract_hash: {
          type: 'string',
          description: 'Explicit contract hash for custom contracts (RESPOND mode). Overrides expected_purpose.',
        },
        counterparty: {
          type: 'string',
          description: 'Agent ID, name, or alias of the counterparty to send the relay invite to (INITIATE mode, required). Resolved against known agents.',
        },
        from: {
          type: 'string',
          description: 'Agent ID, name, or alias of the expected sender — only accept invites from this agent (RESPOND mode, required). Resolved against known agents.',
        },
        contract: {
          type: 'object',
          description: 'Full contract JSON for custom contracts (INITIATE and CREATE modes). Overrides purpose.',
        },
        my_input: {
          type: 'string',
          description: 'This agent\'s private context/input (all modes)',
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
