/**
 * agentvault.relay_signal — Least-trust relay session tool (AgentVault).
 *
 * v2: Uses standard /inbox transport (same as coordinate), phased FSM execution
 * with resume tokens, and guided constant-shape outputs.
 *
 * INITIATE mode: creates a relay session, submits own input, sends invite via
 * standard /inbox, returns AWAITING, polls relay on resume calls.
 * RESPOND mode: polls /inbox for relay invite from a specific sender, validates,
 * joins relay, accepts invite after successful submit, returns AWAITING.
 *
 * CREATE/JOIN modes: legacy manual token exchange (backward compat).
 */

import { createHash } from 'node:crypto';
import { buildSuccess, buildError, type ToolResponse, type ErrorCode } from '../envelope.js';
import {
  createAndSubmit,
  pollUntilDone,
  joinAndWait,
} from 'agentvault-client';
import { submitInput as rawSubmitInput } from 'agentvault-client/http';
import type { SessionOutputResponse } from 'agentvault-client';
import {
  buildRelayContract,
  listRelayPurposes,
  computeRelayContractHash,
} from 'agentvault-client/contracts';
import type { InviteTransport, InviteMessage } from '../invite-transport.js';
import {
  encodeRelayToken,
  decodeRelayToken,
  createRelayHandle,
  findExistingRelayHandle,
  computeRelayIdempotencyKey,
  pruneRelayHandles,
  type RelayHandle,
} from './relayHandles.js';

export interface NormalizedKnownAgent {
  agent_id: string;
  aliases: string[];
}

// ── Configuration ───────────────────────────────────────────────────────

/** Max time a single tool call blocks in poll loops. */
const CALL_BUDGET_MS = 30_000;
/** Overall timeout for the relay operation. */
const OVERALL_TIMEOUT_MS = 120_000;
/** Polling interval for relay status checks. */
const POLL_INTERVAL_MS = 2_000;
/** Polling interval for inbox discovery. */
const INBOX_POLL_INTERVAL_MS = 2_000;

/** Human-readable descriptions for relay abort reasons. */
const ABORT_DESCRIPTIONS: Record<string, string> = {
  PROVIDER_ERROR: 'The relay LLM provider returned an error (usually transient).',
  TIMEOUT: 'The relay session timed out.',
  SCHEMA_VALIDATION: 'The LLM output did not match the contract schema.',
  CONTRACT_MISMATCH: 'Contract hash mismatch (configuration error).',
};

/** Map relay purpose to an existing orchestrator template_id. */
const PURPOSE_TO_TEMPLATE: Record<string, string> = {
  MEDIATION: 'mediation-demo.v1.standard',
  COMPATIBILITY: 'dating.v1.d2',
};

// ── Types ───────────────────────────────────────────────────────────────

export interface RelaySignalArgs {
  mode?: 'CREATE' | 'JOIN' | 'INITIATE' | 'RESPOND';
  resume_token?: string;

  // INITIATE mode
  counterparty?: string;
  purpose?: string;
  contract?: object;
  my_input?: string;
  relay_url?: string;

  // RESPOND mode
  from?: string;
  expected_purpose?: string;
  expected_contract_hash?: string;

  // JOIN mode (legacy)
  session_id?: string;
  submit_token?: string;
  read_token?: string;
  contract_hash?: string;
}

export interface RelaySignalOutput {
  mode: 'INITIATE' | 'RESPOND';
  state: 'IN_PROGRESS' | 'AWAITING' | 'COMPLETED' | 'FAILED';
  phase: string;
  resume_token: string | null;
  session_id?: string;
  contract_hash?: string;
  from?: string;
  action_required: 'CALL_AGAIN' | 'NONE';
  next_tool: string | null;
  next_args_patch: Record<string, unknown> | null;
  next_update_seconds: number | null;
  user_message: string;
  output?: SessionOutputResponse;
  error_code?: string;
}

// Legacy data types (kept for CREATE/JOIN backward compat)
export interface RelaySignalCreateData {
  mode: 'CREATE';
  session_id: string;
  contract_hash: string;
  responder_submit_token: string;
  responder_read_token: string;
  output: SessionOutputResponse;
}

export interface RelaySignalJoinData {
  mode: 'JOIN';
  session_id: string;
  output: SessionOutputResponse;
}

type RelaySignalData = RelaySignalOutput | RelaySignalCreateData | RelaySignalJoinData;

// ── Helpers ─────────────────────────────────────────────────────────────

function resolveRelayUrl(argsUrl?: string): string {
  const url = argsUrl ?? process.env['VCAV_RELAY_URL'];
  if (!url) {
    throw new Error(
      'relay_url is required (or set VCAV_RELAY_URL environment variable)',
    );
  }
  return url;
}

function mapRelayError(error: unknown): { code: ErrorCode; detail: string } {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('Relay HTTP 4')) {
      return { code: 'INVALID_INPUT', detail: msg };
    }
    if (
      msg.includes('fetch failed') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('abort') ||
      msg.includes('Relay HTTP 5')
    ) {
      return { code: 'COUNTERPARTY_UNREACHABLE', detail: msg };
    }
    if (msg.includes('relay_url')) {
      return { code: 'INVALID_INPUT', detail: msg };
    }
    return { code: 'SESSION_ERROR', detail: msg };
  }
  return { code: 'UNKNOWN_ERROR', detail: 'Unexpected error in relay_signal' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAgentAlias(hint: string, knownAgents: NormalizedKnownAgent[]): string {
  const hintLower = hint.toLowerCase();
  const match = knownAgents.find(
    (entry) =>
      entry.agent_id.toLowerCase() === hintLower ||
      entry.aliases.some((alias) => alias.toLowerCase() === hintLower),
  );
  return match ? match.agent_id : hint;
}

function hashInput(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function getResumeTokenSecret(): string | null {
  return process.env['VCAV_RESUME_TOKEN_SECRET'] ?? null;
}

// ── Response Builders ───────────────────────────────────────────────────

function awaitingResponse(
  handle: RelayHandle,
  userMessage: string,
): ToolResponse<RelaySignalOutput> {
  const token = encodeRelayToken(handle, getResumeTokenSecret());
  return buildSuccess('PENDING', {
    mode: handle.role === 'INITIATOR' ? 'INITIATE' : 'RESPOND',
    state: 'AWAITING',
    phase: handle.phase,
    resume_token: token,
    session_id: handle.sessionId,
    contract_hash: handle.contractHash,
    from: handle.role === 'RESPONDER' ? handle.counterparty : undefined,
    action_required: 'CALL_AGAIN',
    next_tool: 'agentvault.relay_signal',
    next_args_patch: { resume_token: token },
    next_update_seconds: 5,
    user_message: userMessage,
  });
}

function completedResponse(
  handle: RelayHandle,
  output: SessionOutputResponse,
): ToolResponse<RelaySignalOutput> {
  handle.phase = 'COMPLETED';
  return buildSuccess('COMPLETE', {
    mode: handle.role === 'INITIATOR' ? 'INITIATE' : 'RESPOND',
    state: 'COMPLETED',
    phase: 'COMPLETED',
    resume_token: null,
    session_id: handle.sessionId,
    contract_hash: handle.contractHash,
    from: handle.role === 'RESPONDER' ? handle.counterparty : undefined,
    action_required: 'NONE',
    next_tool: null,
    next_args_patch: null,
    next_update_seconds: null,
    user_message: 'Relay session complete. Output and receipt available.',
    output,
  });
}

function failedResponse(
  handle: RelayHandle,
  errorCode: string,
  userMessage: string,
  output?: SessionOutputResponse,
): ToolResponse<RelaySignalOutput> {
  handle.phase = 'FAILED';
  return buildSuccess('ERROR', {
    mode: handle.role === 'INITIATOR' ? 'INITIATE' : 'RESPOND',
    state: 'FAILED',
    phase: 'FAILED',
    resume_token: null,
    session_id: handle.sessionId,
    contract_hash: handle.contractHash,
    from: handle.role === 'RESPONDER' ? handle.counterparty : undefined,
    action_required: 'NONE',
    next_tool: null,
    next_args_patch: null,
    next_update_seconds: null,
    user_message: userMessage,
    error_code: errorCode,
    output,
  });
}

// ── INITIATE Phases ─────────────────────────────────────────────────────

async function phaseInvite(
  handle: RelayHandle,
  args: RelaySignalArgs,
  transport: InviteTransport,
  knownAgents: NormalizedKnownAgent[],
): Promise<ToolResponse<RelaySignalOutput>> {
  const counterparty = resolveAgentAlias(handle.counterparty, knownAgents);

  // Resolve contract
  let contract: object;
  let purposeHint: string | null = null;
  if (args.contract) {
    contract = args.contract;
  } else if (args.purpose) {
    const myId = process.env['VCAV_AGENT_ID'] ?? '';
    let built;
    try {
      built = buildRelayContract(args.purpose, [myId, counterparty]);
    } catch (e) {
      return buildError('INVALID_INPUT', (e as Error).message);
    }
    if (!built) {
      return buildError('INVALID_INPUT',
        `Unknown purpose "${args.purpose}". Available: ${listRelayPurposes().join(', ')}`);
    }
    contract = built;
    purposeHint = args.purpose;
  } else {
    return buildError('INVALID_INPUT',
      `INITIATE requires purpose (${listRelayPurposes().join(', ')}) or contract`);
  }

  const relayUrl = resolveRelayUrl(args.relay_url);
  const config = { relay_url: relayUrl };

  // 1. Create session and submit own input
  const created = await createAndSubmit(config, contract, args.my_input ?? '', 'initiator');

  // 2. Send invite via standard /inbox (not labeled messages)
  // Note: contract_hash is intentionally omitted — the relay contract hash differs
  // from any orchestrator contract hash, so the orchestrator auto-resolves from template_id.
  const templateId = purposeHint ? (PURPOSE_TO_TEMPLATE[purposeHint] ?? 'mediation-demo.v1.standard') : 'mediation-demo.v1.standard';
  await transport.sendInvite({
    to_agent_id: counterparty,
    template_id: templateId,
    budget_tier: 'SMALL',
    payload_type: 'VCAV_E_INVITE_V1',
    payload: {
      session_id: created.sessionId,
      responder_submit_token: created.responderSubmitToken,
      responder_read_token: created.responderReadToken,
      relay_url: relayUrl,
    },
  });

  // 3. Populate handle with session data
  handle.sessionId = created.sessionId;
  handle.contractHash = created.contractHash;
  handle.relayUrl = relayUrl;
  handle.tokens = {
    submit: '', // initiator doesn't need submit
    read: '', // initiator doesn't need responder read
    initiatorRead: created.initiatorReadToken,
  };
  handle.purpose = purposeHint ?? undefined;
  handle.phase = 'POLL_RELAY';

  return awaitingResponse(handle, 'Relay session created. Waiting for counterparty to join.');
}

async function phasePollRelay(
  handle: RelayHandle,
): Promise<ToolResponse<RelaySignalOutput>> {
  // Check overall timeout
  if (Date.now() > handle.timeoutDeadline) {
    return failedResponse(handle, 'RELAY_TIMEOUT', 'Relay session timed out. Call agentvault.relay_signal INITIATE to retry.');
  }

  const config = { relay_url: handle.relayUrl! };
  const output = await pollUntilDone(
    config,
    handle.sessionId!,
    handle.tokens!.initiatorRead!,
    POLL_INTERVAL_MS,
    CALL_BUDGET_MS,
  );

  if (output.state === 'COMPLETED') {
    return completedResponse(handle, output);
  }

  if (output.state === 'ABORTED' && output.abort_reason !== 'TIMEOUT') {
    // Real server-side abort
    const reason = output.abort_reason ?? 'UNKNOWN';
    const desc = ABORT_DESCRIPTIONS[reason] ?? 'The relay session was aborted.';
    return failedResponse(
      handle,
      `RELAY_${reason}`,
      `Session aborted: ${desc} Call agentvault.relay_signal INITIATE to retry.`,
      output,
    );
  }

  // Call budget expired — relay still running
  return awaitingResponse(handle, 'Waiting for counterparty to join relay session.');
}

// ── RESPOND Phases ──────────────────────────────────────────────────────

async function phaseDiscover(
  handle: RelayHandle,
  transport: InviteTransport,
): Promise<ToolResponse<RelaySignalOutput>> {
  // Check overall timeout
  if (Date.now() > handle.timeoutDeadline) {
    return failedResponse(handle, 'RELAY_TIMEOUT', 'Timed out waiting for relay invite. Ask the initiator to retry.');
  }

  const callDeadline = Date.now() + CALL_BUDGET_MS;

  while (Date.now() < callDeadline) {
    const response = await transport.checkInbox();
    const invites: InviteMessage[] = response.invites ?? [];

    // Track whether we found invites from the sender that failed contract matching.
    // If all sender invites fail contract checks, return CONTRACT_MISMATCH immediately
    // instead of polling forever (the sender won't send a different contract).
    let foundSenderInviteWithContractMismatch = false;

    // Scan newest-first to prefer the most recent matching invite
    for (let i = invites.length - 1; i >= 0; i--) {
      const invite = invites[i];
      const fromAgentId: string = invite.from_agent_id;
      const payloadType: string | undefined = invite.payload_type;

      // Filter by sender
      if (fromAgentId !== handle.counterparty) continue;
      // Filter by payload type
      if (payloadType !== 'VCAV_E_INVITE_V1') continue;
      // If handle already has a bound inviteId, only match that
      if (handle.inviteId && invite.invite_id !== handle.inviteId) continue;

      const payload = invite.payload;
      if (!payload || typeof payload !== 'object') continue;
      if (!payload['session_id'] || !payload['responder_submit_token'] || !payload['responder_read_token'] || !payload['relay_url']) continue;

      // Check expected_contract_hash if provided (direct hash comparison)
      if (handle.expectedContractHash && invite.contract_hash !== handle.expectedContractHash) {
        foundSenderInviteWithContractMismatch = true;
        continue;
      }

      // For AgentVault relay invites, validate expected_purpose matches the invite's template_id
      // rather than comparing contract hashes. The AFAL invite carries a VCAV contract
      // hash (auto-resolved from template_id) which differs from the AgentVault relay contract
      // hash. The real contract verification happens at the relay on input submission.
      if (handle.expectedPurpose) {
        const expectedTemplate = PURPOSE_TO_TEMPLATE[handle.expectedPurpose];
        const inviteTemplate = invite.template_id;
        if (expectedTemplate && inviteTemplate && inviteTemplate !== expectedTemplate) {
          foundSenderInviteWithContractMismatch = true;
          continue; // Wrong purpose — skip this invite
        }
      }

      // Compute relay contract hash for binding into the handle (used by phaseJoin
      // for expected_contract_hash verification at the relay).
      let relayContractHash: string | undefined;
      if (handle.expectedPurpose) {
        const myId = process.env['VCAV_AGENT_ID'] ?? '';
        try {
          const relayContract = buildRelayContract(handle.expectedPurpose, [handle.counterparty, myId]);
          if (relayContract) relayContractHash = computeRelayContractHash(relayContract);
        } catch {
          // Non-fatal — relay will verify on submit
        }
      }

      // Bind invite to handle (stops scanning for different invites)
      handle.inviteId = invite.invite_id;
      handle.sessionId = payload['session_id'] as string;
      handle.contractHash = relayContractHash ?? invite.contract_hash;
      handle.relayUrl = handle.relayUrl ?? payload['relay_url'] as string;
      handle.tokens = {
        submit: payload['responder_submit_token'] as string,
        read: payload['responder_read_token'] as string,
      };
      handle.phase = 'JOIN';

      return awaitingResponse(handle, 'Relay invite found. Joining session.');
    }

    // If sender sent invites but all failed contract matching, fail fast
    if (foundSenderInviteWithContractMismatch) {
      return buildError('CONTRACT_MISMATCH',
        'Invite contract does not match expected contract.');
    }

    await sleep(INBOX_POLL_INTERVAL_MS);
  }

  // Call budget expired — no invite found yet
  return awaitingResponse(handle, 'Waiting for relay invite from counterparty.');
}

async function phaseJoin(
  handle: RelayHandle,
  transport: InviteTransport,
): Promise<ToolResponse<RelaySignalOutput>> {
  // Check overall timeout
  if (Date.now() > handle.timeoutDeadline) {
    return failedResponse(handle, 'RELAY_TIMEOUT', 'Relay session timed out. Ask the initiator to retry.');
  }

  const config = { relay_url: handle.relayUrl! };

  // Submit input if not yet done (uses stored myInput from handle, not args)
  if (!handle.submitted) {
    await rawSubmitInput(
      config,
      handle.sessionId!,
      handle.tokens!.submit,
      'responder',
      handle.myInput ?? '',
      handle.contractHash,
    );
    handle.submitted = true;

    // Accept the orchestrator invite after successful submit
    try {
      await transport.acceptInvite(handle.inviteId!);
    } catch {
      // Accept failure is non-fatal — relay session proceeds regardless.
      // The invite expires naturally via TTL.
    }
  }

  // Poll relay for result
  const output = await pollUntilDone(
    config,
    handle.sessionId!,
    handle.tokens!.read,
    POLL_INTERVAL_MS,
    CALL_BUDGET_MS,
  );

  if (output.state === 'COMPLETED') {
    return completedResponse(handle, output);
  }

  if (output.state === 'ABORTED' && output.abort_reason !== 'TIMEOUT') {
    const reason = output.abort_reason ?? 'UNKNOWN';
    const desc = ABORT_DESCRIPTIONS[reason] ?? 'The relay session was aborted.';
    return failedResponse(
      handle,
      `RELAY_${reason}`,
      `Session aborted: ${desc} Waiting for the initiator to retry — call agentvault.relay_signal RESPOND again.`,
      output,
    );
  }

  // Call budget expired
  return awaitingResponse(handle, 'Waiting for relay session to complete.');
}

// ── Legacy Modes (unchanged) ────────────────────────────────────────────

async function handleCreate(
  args: RelaySignalArgs,
): Promise<ToolResponse<RelaySignalCreateData>> {
  if (!args.contract) {
    return buildError('INVALID_INPUT', 'contract is required for CREATE mode');
  }
  const relayUrl = resolveRelayUrl(args.relay_url);
  const config = { relay_url: relayUrl };

  const created = await createAndSubmit(config, args.contract, args.my_input ?? '', 'initiator');
  const output = await pollUntilDone(config, created.sessionId, created.initiatorReadToken);

  return buildSuccess('COMPLETE', {
    mode: 'CREATE' as const,
    session_id: created.sessionId,
    contract_hash: created.contractHash,
    responder_submit_token: created.responderSubmitToken,
    responder_read_token: created.responderReadToken,
    output,
  });
}

async function handleJoin(
  args: RelaySignalArgs,
): Promise<ToolResponse<RelaySignalJoinData>> {
  if (!args.session_id) return buildError('INVALID_INPUT', 'session_id is required for JOIN mode');
  if (!args.submit_token) return buildError('INVALID_INPUT', 'submit_token is required for JOIN mode');
  if (!args.read_token) return buildError('INVALID_INPUT', 'read_token is required for JOIN mode');
  if (!args.contract_hash) return buildError('INVALID_INPUT', 'contract_hash is required for JOIN mode');

  const relayUrl = resolveRelayUrl(args.relay_url);
  const config = { relay_url: relayUrl };

  const output = await joinAndWait(
    config, args.session_id, args.submit_token, args.read_token,
    args.contract_hash, args.my_input ?? '', 'responder',
  );

  return buildSuccess('COMPLETE', {
    mode: 'JOIN' as const,
    session_id: args.session_id,
    output,
  });
}

// ── Entry Point ─────────────────────────────────────────────────────────

/** Check if any args besides resume_token are provided. */
function hasExtraArgs(args: RelaySignalArgs): boolean {
  const keys = Object.keys(args).filter(k => k !== 'resume_token');
  return keys.length > 0;
}

export async function handleRelaySignal(
  args: RelaySignalArgs,
  transport?: InviteTransport,
  knownAgents: NormalizedKnownAgent[] = [],
): Promise<ToolResponse<RelaySignalData>> {
  try {
    // Prune expired handles on every call
    pruneRelayHandles();

    // ── Resume path ─────────────────────────────────────────────────
    if (args.resume_token) {
      if (hasExtraArgs(args)) {
        return buildError('INVALID_INPUT',
          'When resume_token is provided, do NOT include any other args (mode, my_input, counterparty, etc.).');
      }

      const agentId = transport?.agentId ?? process.env['VCAV_AGENT_ID'] ?? '';
      const handle = decodeRelayToken(args.resume_token, agentId, getResumeTokenSecret());
      if (!handle) {
        return buildError('INVALID_INPUT', 'Invalid or expired resume_token. Start a new relay_signal call.');
      }

      if (!transport) {
        return buildError('SESSION_ERROR', 'Resume requires InviteTransport (agent mode only)');
      }

      // Route to the correct phase
      switch (handle.phase) {
        case 'POLL_RELAY':
          return await phasePollRelay(handle);
        case 'DISCOVER':
          return await phaseDiscover(handle, transport);
        case 'JOIN':
          return await phaseJoin(handle, transport);
        case 'COMPLETED':
        case 'ABORTED':
        case 'FAILED':
          return buildError('INVALID_INPUT', `Handle is in terminal state: ${handle.phase}. Start a new call.`);
        default:
          return buildError('SESSION_ERROR', `Unexpected handle phase: ${handle.phase}`);
      }
    }

    // ── Fresh call path ─────────────────────────────────────────────
    if (!args.mode) {
      return buildError('INVALID_INPUT', 'mode is required (INITIATE, RESPOND, CREATE, or JOIN)');
    }

    switch (args.mode) {
      case 'INITIATE': {
        if (!transport) {
          return buildError('SESSION_ERROR', 'INITIATE mode requires InviteTransport (agent mode only)');
        }
        if (!args.counterparty) {
          return buildError('INVALID_INPUT', 'counterparty is required for INITIATE mode');
        }

        const counterparty = resolveAgentAlias(args.counterparty, knownAgents);
        const agentId = transport.agentId ?? process.env['VCAV_AGENT_ID'] ?? '';

        // Compute idempotency key
        const inputHash = hashInput(args.my_input ?? '');
        let contractHashForKey: string;
        if (args.contract) {
          contractHashForKey = createHash('sha256').update(JSON.stringify(args.contract)).digest('hex');
        } else if (args.purpose) {
          const built = buildRelayContract(args.purpose, [agentId, counterparty]);
          contractHashForKey = built ? computeRelayContractHash(built) : args.purpose;
        } else {
          contractHashForKey = '';
        }
        const idempotencyKey = computeRelayIdempotencyKey(agentId, [contractHashForKey, counterparty, inputHash]);

        // Check for existing handle
        const existing = findExistingRelayHandle(agentId, 'INITIATOR', idempotencyKey);
        if (existing) {
          // Reattach — route to current phase
          if (existing.phase === 'POLL_RELAY') return await phasePollRelay(existing);
          return awaitingResponse(existing, 'Reattached to existing relay session.');
        }

        // Create new handle
        const handle = createRelayHandle({
          agentId,
          role: 'INITIATOR',
          phase: 'INVITE',
          counterparty,
          idempotencyKey,
          timeoutMs: OVERALL_TIMEOUT_MS,
        });

        return await phaseInvite(handle, args, transport, knownAgents);
      }

      case 'RESPOND': {
        if (!transport) {
          return buildError('SESSION_ERROR', 'RESPOND mode requires InviteTransport (agent mode only)');
        }
        if (!args.from) {
          return buildError('INVALID_INPUT', 'from is required for RESPOND mode (agent ID of expected sender)');
        }

        const from = resolveAgentAlias(args.from, knownAgents);
        const agentId = transport.agentId ?? process.env['VCAV_AGENT_ID'] ?? '';

        // Compute idempotency key
        const inputHash = hashInput(args.my_input ?? '');
        const purposeOrHash = args.expected_purpose ?? args.expected_contract_hash ?? '';
        const idempotencyKey = computeRelayIdempotencyKey(agentId, [from, purposeOrHash, inputHash]);

        // Check for existing handle
        const existing = findExistingRelayHandle(agentId, 'RESPONDER', idempotencyKey);
        if (existing) {
          if (existing.phase === 'DISCOVER') return await phaseDiscover(existing, transport);
          if (existing.phase === 'JOIN') return await phaseJoin(existing, transport);
          return awaitingResponse(existing, 'Reattached to existing relay session.');
        }

        // Validate that we have expected_purpose or expected_contract_hash
        if (!args.expected_purpose && !args.expected_contract_hash) {
          return buildError('INVALID_INPUT',
            'RESPOND requires expected_purpose or expected_contract_hash.');
        }

        // Validate expected_purpose is a known purpose code
        if (args.expected_purpose) {
          const knownPurposes = listRelayPurposes();
          if (!knownPurposes.includes(args.expected_purpose)) {
            return buildError('INVALID_INPUT',
              `Unknown purpose "${args.expected_purpose}". Available: ${knownPurposes.join(', ')}`);
          }
        }

        // Create new handle — store args for use on resume calls
        const handle = createRelayHandle({
          agentId,
          role: 'RESPONDER',
          phase: 'DISCOVER',
          counterparty: from,
          idempotencyKey,
          timeoutMs: OVERALL_TIMEOUT_MS,
          myInput: args.my_input,
          expectedPurpose: args.expected_purpose,
          expectedContractHash: args.expected_contract_hash,
          relayUrl: args.relay_url,
        });

        return await phaseDiscover(handle, transport);
      }

      case 'CREATE':
        return await handleCreate(args);

      case 'JOIN':
        return await handleJoin(args);

      default:
        return buildError(
          'INVALID_INPUT',
          `Unknown mode "${String(args.mode)}" — must be INITIATE, RESPOND, CREATE, or JOIN`,
        );
    }
  } catch (error) {
    const { code, detail } = mapRelayError(error);
    return buildError(code, detail);
  }
}
