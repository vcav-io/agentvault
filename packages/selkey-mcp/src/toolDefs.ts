/**
 * Tool definitions for selkey-mcp.
 *
 * Exports the relay_signal tool schema under the selkey namespace.
 */

import { listRelayPurposes } from 'selkey/contracts';

const RELAY_PURPOSES = listRelayPurposes();

export const IDENTITY_TOOLS = [
  {
    name: 'selkey.get_identity',
    description:
      "Returns this agent's identity (agent_id), known agents available for " +
      'relay sessions, and inbox status (pending invite count). When ' +
      'pending_invites > 0, next_action tells you which tool to call.\n\n' +
      'Call this first to confirm your agent_id and check for pending invites. ' +
      'If pending_invites > 0: call selkey.relay_signal in RESPOND mode ' +
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
    name: 'selkey.verify_receipt',
    description:
      'Verify the cryptographic signature of an Selkey session receipt. ' +
      'Supports v3 receipts (receipt_schema_version: "3.0.0", emitted by current relays, ' +
      'checked with strict Ed25519 rules), v2 receipts (receipt_schema_version: "2.x.y") ' +
      'and v1 receipts (schema_version: "1.0.0"). ' +
      'Returns valid: true only if the receipt signature is valid under the relay verifying key. ' +
      'A relay key is required: pass public_key_hex, or configure SELKEY_RELAY_VERIFYING_KEY_HEX. ' +
      'Obtain the key out of band from the relay operator (not from the receipt or the counterparty). ' +
      'Keys embedded in the receipt (e.g. tee_attestation.receipt_signing_pubkey_hex) are never trusted ' +
      'on their own; a receipt whose embedded key differs from the relay key is invalid. ' +
      'assurance_level and tee_info in the result are asserted by the relay; this tool does not ' +
      'verify TEE attestation quotes.',
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
            'Relay Ed25519 verifying key as 64 hex chars. Optional if SELKEY_RELAY_VERIFYING_KEY_HEX is set; ' +
            'must match it when both are present.',
        },
      },
      required: ['receipt'],
    },
  },
];

export const IFC_TOOLS = [
  {
    name: 'selkey.create_ifc_grant',
    description:
      'Allow a counterparty to send THIS agent post-session IFC messages. The grant is issued by this ' +
      'agent (the recipient) and is only possible for a receipt this agent holds from a completed session ' +
      'in which the audience was the counterparty. The grant is delivered to the audience when its A2A ' +
      'endpoint is known. Use selkey.revoke_ifc_grant to withdraw it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        audience: { type: 'string', description: 'Agent allowed to send messages to this agent (agent_id or alias).' },
        receipt_id: { type: 'string', description: 'receipt_id of a completed session with the audience.' },
        session_id: {
          type: 'string',
          description: 'Optional; must match the session of the receipt.',
        },
        message_classes: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['LOGISTICS', 'CONSENT', 'REFERENCE', 'ARTIFACT_TRANSFER'],
          },
          description: 'Message classes the audience may send.',
        },
        max_uses: { type: 'number', description: 'Maximum number of messages (1-100).' },
        expires_in_seconds: {
          type: 'number',
          description: 'Grant validity in seconds (at most SELKEY_IFC_MAX_GRANT_TTL_SECONDS, default 86400).',
        },
      },
      required: ['audience', 'receipt_id', 'message_classes', 'max_uses', 'expires_in_seconds'],
    },
  },
  {
    name: 'selkey.send_ifc_message',
    description:
      'Send one IFC-wrapped post-session message to a known peer over the Selkey A2A send-message path, ' +
      'under a grant that peer issued to this agent (received grants are listed by selkey.list_ifc_grants). ' +
      'Plain non-IFC messages are not allowed on this surface.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        counterparty: {
          type: 'string',
          description: 'Known agent_id or alias of the counterparty that issued the grant.',
        },
        grant_id: {
          type: 'string',
          description: 'grant_id of a grant received from the counterparty.',
        },
        grant: {
          type: 'object',
          description: 'Alternatively, the signed grant object received from the counterparty.',
        },
        message_class: {
          type: 'string',
          enum: ['LOGISTICS', 'CONSENT', 'REFERENCE', 'ARTIFACT_TRANSFER'],
          description: 'Post-session IFC message class.',
        },
        payload: { type: 'string', description: 'Bounded message payload (at most 4096 characters).' },
      },
      required: ['counterparty', 'message_class', 'payload'],
    },
  },
  {
    name: 'selkey.read_ifc_messages',
    description:
      'Read pending IFC messages that have been allowed, hidden, escalated, or blocked for this agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Optional maximum number of pending messages to read.' },
      },
      required: [],
    },
  },
  {
    name: 'selkey.revoke_ifc_grant',
    description:
      'Revoke a grant this agent issued. Takes effect immediately: further messages under it are blocked.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        grant_id: { type: 'string', description: 'grant_id of a grant this agent issued.' },
        reason: { type: 'string', description: 'Optional reason, recorded in the audit log.' },
      },
      required: ['grant_id'],
    },
  },
  {
    name: 'selkey.list_ifc_grants',
    description:
      'List IFC grants this agent issued (with state, uses and expiry) and grants it received from peers.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

export const RELAY_TOOLS = [
  {
    name: 'selkey.relay_signal',
    description:
      'Run a Selkey relay session for bounded agent-to-agent signals. The relay ' +
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
      'Call selkey.get_identity first to see your agent_id and known agents.\n\n' +
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
          enum: RELAY_PURPOSES,
          description:
            'Type of bounded signal session (INITIATE mode). Selects the right contract, schema, and prompt template.',
        },
        acceptable_purposes: {
          type: 'array',
          description:
            'Ordered purpose candidates for INITIATE mode when you do not want to force an early single-purpose guess. ' +
            'On direct AFAL transports, the counterparty can negotiate a common contract offer from this set. ' +
            'The first purpose is the initiator-preferred option.',
          items: {
            type: 'string',
            enum: RELAY_PURPOSES,
          },
        },
        expected_purpose: {
          type: 'string',
          enum: RELAY_PURPOSES,
          description:
            'What kind of session you expect to join (RESPOND mode). Optional: if omitted, the purposes allowed by local configuration (SELKEY_AFAL_ALLOWED_PURPOSES) are used. ' +
            'The invite is accepted only if its full contract hash matches a contract built locally for an accepted purpose.',
        },
        expected_contract_hash: {
          type: 'string',
          description:
            'Explicit contract hash for custom contracts (RESPOND mode). Overrides expected_purpose. Obtain it from your own records, not from the invite.',
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
        acceptable_topic_codes: {
          type: 'array',
          description:
            'Optional bounded topic codes to align on before contract negotiation (INITIATE mode). ' +
            'Use lowercase fixed codes like salary_alignment or reference_check. ' +
            'If no common topic code is available, session creation stops before the relay session is created.',
          items: {
            type: 'string',
          },
        },
        acceptable_contracts: {
          type: 'array',
          description:
            'Bounded bespoke contract candidates for pre-contract negotiation (INITIATE mode). ' +
            'Each item must provide purpose_code plus explicit schema/policy/program refs. ' +
            'Use this instead of full custom contract JSON when you want deterministic bespoke negotiation.',
          items: {
            type: 'object',
          },
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
          description:
            'Relay base URL. Defaults to SELKEY_RELAY_URL. Must be SELKEY_RELAY_URL or listed in SELKEY_RELAY_ALLOWLIST.',
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
