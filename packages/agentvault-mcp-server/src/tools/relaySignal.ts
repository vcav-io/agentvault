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
import * as fs from 'node:fs';
import * as path from 'node:path';
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
import type { AfalTransport, AfalInviteMessage } from '../afal-transport.js';
import { PURPOSE_TO_TEMPLATE, isAcceptResult } from '../afal-transport.js';
import { RelayInboxTransport, RELAY_INBOX_PAYLOAD_TYPE } from '../relay-inbox-transport.js';
import { computeProposalId, generateNonce } from '../afal-types.js';
import type { AfalPropose, RelayInvitePayload } from '../afal-types.js';
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

export interface DisplayDirective {
  forbidden: string[];
  redact: string[];
}

export interface SignalFieldSemantic {
  field: string;
  description: string;
  values?: Record<string, string>;
}

export interface EpistemicLimits {
  valid_claims: string[];
  invalid_claims: string[];
}

export interface InterpretationContext {
  purpose: string;
  signal_description: string;
  signal_fields: SignalFieldSemantic[];
  epistemic_limits: EpistemicLimits;
  provenance: {
    session_id: string | null;
    contract_hash: string | null;
    receipt_available: boolean;
  };
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
  display: DisplayDirective;
  interpretation_context?: InterpretationContext;
  resume_token_display?: string | null;
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

// ── Interpretation Context ───────────────────────────────────────────────

function mediationContext(handle: RelayHandle): InterpretationContext {
  return {
    purpose: 'MEDIATION',
    signal_description:
      'Bounded mediation signal from private relay computation. Indicates alignment degree ' +
      'and suggested next step without revealing either party\'s input.',
    signal_fields: [
      {
        field: 'mediation_signal',
        description: 'Overall alignment assessment.',
        values: {
          ALIGNMENT_POSSIBLE: 'Sufficient common ground to proceed.',
          PARTIAL_ALIGNMENT: 'Some overlap; gaps remain.',
          FUNDAMENTAL_DISAGREEMENT: 'Positions incompatible on core points.',
          NEEDS_FACILITATION: 'Complexity requires structured process.',
          INSUFFICIENT_SIGNAL: 'Not enough information to assess.',
        },
      },
      {
        field: 'common_ground_code',
        description: 'Category of shared ground detected.',
        values: {
          GOAL_ALIGNMENT: 'Shared end-goals.',
          RESOURCE_ALIGNMENT: 'Agreement on resource use.',
          RELATIONSHIP_CONTINUITY: 'Both value the ongoing relationship.',
          VALUE_ALIGNMENT: 'Shared underlying values.',
          OPERATIONAL_ALIGNMENT: 'Agreement on how to work together.',
          NO_COMMON_GROUND_DETECTED: 'No shared ground identified.',
        },
      },
      {
        field: 'confidence_band',
        description: 'Relay confidence in the signal given inputs provided.',
        values: { LOW: 'Low confidence.', MEDIUM: 'Moderate confidence.', HIGH: 'High confidence.' },
      },
      {
        field: 'next_step_signal',
        description: 'Recommended next step.',
        values: {
          DIRECT_DIALOGUE: 'Parties can speak directly.',
          STRUCTURED_NEGOTIATION: 'Formal negotiation recommended.',
          THIRD_PARTY_FACILITATION: 'External facilitator would help.',
          COOLING_PERIOD: 'Pause before engaging.',
          SEEK_CLARIFICATION: 'More information needed.',
        },
      },
    ],
    epistemic_limits: {
      valid_claims: [
        'The protocol does not expose raw inputs to counterparties.',
        'Only a bounded signal is produced — not a summary of either input.',
        `This session is cryptographically receipted (session_id=${handle.sessionId ?? 'n/a'}).`,
      ],
      invalid_claims: [
        '"Bob never saw your input" — the relay enforces privacy at its boundary, but cannot control what the counterparty\'s agent does with the relay output.',
        '"Alice does not know X" — the protocol limits what the relay discloses, not what agents infer.',
        '"The other party doesn\'t know about…" — overclaims beyond protocol guarantees.',
      ],
    },
    provenance: {
      session_id: handle.sessionId ?? null,
      contract_hash: handle.contractHash ?? null,
      receipt_available: true,
    },
  };
}

function compatibilityContext(handle: RelayHandle): InterpretationContext {
  return {
    purpose: 'COMPATIBILITY',
    signal_description:
      'Bounded compatibility signal indicating degree of match between two parties\' private criteria, ' +
      'without revealing what those criteria were.',
    signal_fields: [
      {
        field: 'compatibility_signal',
        description: 'Degree of match between criteria.',
        values: {
          STRONG_MATCH: 'High overlap.',
          PARTIAL_MATCH: 'Meaningful overlap with gaps.',
          WEAK_MATCH: 'Limited overlap.',
          NO_MATCH: 'Criteria incompatible.',
        },
      },
      {
        field: 'overlap_summary',
        description: 'Relay-generated summary of what the overlap consists of (not extracted from either input).',
      },
    ],
    epistemic_limits: {
      valid_claims: [
        'The protocol does not expose raw inputs to counterparties.',
        'The overlap_summary was generated by the relay, not extracted from either party\'s input.',
        `This session is cryptographically receipted (session_id=${handle.sessionId ?? 'n/a'}).`,
      ],
      invalid_claims: [
        '"Bob never saw your input" — the relay enforces privacy at its boundary, but cannot control what the counterparty\'s agent does with the relay output.',
        '"The counterparty\'s specific criteria are known" — the protocol does not expose them.',
        '"The other party doesn\'t know about…" — overclaims beyond protocol guarantees.',
      ],
    },
    provenance: {
      session_id: handle.sessionId ?? null,
      contract_hash: handle.contractHash ?? null,
      receipt_available: true,
    },
  };
}

function customContext(handle: RelayHandle): InterpretationContext {
  return {
    purpose: handle.purpose ?? 'CUSTOM',
    signal_description: 'Bounded signal from a custom relay contract.',
    signal_fields: [],
    epistemic_limits: {
      valid_claims: [
        'The protocol does not expose raw inputs to counterparties.',
        'Only a bounded signal is produced — not a summary of either input.',
      ],
      invalid_claims: [
        '"Bob never saw your input" — the relay enforces privacy at its boundary, but cannot control what the counterparty\'s agent does with the relay output.',
        '"The other party doesn\'t know about…" — overclaims beyond protocol guarantees.',
      ],
    },
    provenance: {
      session_id: handle.sessionId ?? null,
      contract_hash: handle.contractHash ?? null,
      receipt_available: true,
    },
  };
}

function buildInterpretationContext(handle: RelayHandle): InterpretationContext {
  switch (handle.purpose) {
    case 'MEDIATION': return mediationContext(handle);
    case 'COMPATIBILITY': return compatibilityContext(handle);
    default: return customContext(handle);
  }
}

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
      return {
        code: 'COUNTERPARTY_UNREACHABLE',
        detail: `Counterparty not reachable (they may not have started yet). ${msg}`,
      };
    }
    if (msg.includes('Proposal denied')) {
      return { code: 'SESSION_ERROR', detail: `Counterparty explicitly denied the proposal. ${msg}` };
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

function writeLastSessionFile(
  sessionId: string,
  role: 'INITIATOR' | 'RESPONDER',
  readToken: string,
  relayUrl: string,
): void {
  try {
    const workdir = process.env['VCAV_WORKDIR'] ?? process.cwd();
    const dir = path.join(workdir, '.agentvault');
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, 'last_session.json');
    const tmpPath = `${finalPath}.tmp`;
    const record = {
      session_id: sessionId,
      role,
      read_token: readToken,
      relay_url: relayUrl,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    // Non-fatal — log but do not fail the relay operation
    console.error(
      `writeLastSessionFile: failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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

/** Check whether an error from sendPropose is a network-level failure worth retrying.
 *  Must stay aligned with mapRelayError's transient-error detection. */
function isRetryableTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes('fetch failed') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('abort') ||
    msg.includes('Relay HTTP 5')
  );
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
  const resumeTokenDisplay = token.length > 16
    ? `${token.slice(0, 12)}…${token.slice(-4)}`
    : token;
  return buildSuccess('PENDING', {
    mode: handle.role === 'INITIATOR' ? 'INITIATE' : 'RESPOND',
    state: 'AWAITING',
    phase: handle.phase,
    resume_token: token,
    resume_token_display: resumeTokenDisplay,
    session_id: handle.sessionId,
    contract_hash: handle.contractHash,
    from: handle.role === 'RESPONDER' ? handle.counterparty : undefined,
    action_required: 'CALL_AGAIN',
    next_tool: 'agentvault.relay_signal',
    next_args_patch: { resume_token: token },
    next_update_seconds: 5,
    user_message: userMessage,
    display: {
      forbidden: ['PRINT_RESUME_TOKEN', 'CLAIM_COUNTERPARTY_KNOWLEDGE'],
      redact: ['resume_token'],
    },
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
    resume_token_display: null,
    session_id: handle.sessionId,
    contract_hash: handle.contractHash,
    from: handle.role === 'RESPONDER' ? handle.counterparty : undefined,
    action_required: 'NONE',
    next_tool: null,
    next_args_patch: null,
    next_update_seconds: null,
    user_message: 'Relay session complete.',
    output,
    display: {
      forbidden: [
        'CLAIM_COUNTERPARTY_KNOWLEDGE',
        'PRINT_RESUME_TOKEN',
        'QUOTE_MY_INPUT',
        'QUOTE_COUNTERPARTY_INPUT',
        'INCLUDE_CREDENTIALS',
      ],
      redact: ['resume_token', 'my_input'],
    },
    interpretation_context: buildInterpretationContext(handle),
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
    resume_token_display: null,
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
    display: {
      forbidden: ['PRINT_RESUME_TOKEN'],
      redact: ['resume_token'],
    },
  });
}

// ── INITIATE Phases ─────────────────────────────────────────────────────

async function phaseInvite(
  handle: RelayHandle,
  args: RelaySignalArgs,
  transport: AfalTransport,
  knownAgents: NormalizedKnownAgent[],
): Promise<ToolResponse<RelaySignalOutput>> {
  const counterparty = resolveAgentAlias(handle.counterparty, knownAgents);

  // Resolve contract — use transport.agentId consistently as the identity source
  const agentId = transport.agentId;
  let contract: object;
  let purposeHint: string | null = null;
  let relayContract: ReturnType<typeof buildRelayContract> | undefined;
  if (args.contract) {
    contract = args.contract;
  } else if (args.purpose) {
    let built;
    try {
      built = buildRelayContract(args.purpose, [agentId, counterparty]);
    } catch (e) {
      return buildError('INVALID_INPUT', (e as Error).message);
    }
    if (!built) {
      return buildError('INVALID_INPUT',
        `Unknown purpose "${args.purpose}". Available: ${listRelayPurposes().join(', ')}`);
    }
    contract = built;
    relayContract = built;
    purposeHint = args.purpose;
  } else {
    return buildError('INVALID_INPUT',
      `INITIATE requires purpose (${listRelayPurposes().join(', ')}) or contract`);
  }

  // ── Relay inbox path ──────────────────────────────────────────────────
  // When using RelayInboxTransport, create an invite via the relay's inbox
  // instead of creating a session eagerly. The relay creates the session
  // when the responder accepts the invite.
  if (transport instanceof RelayInboxTransport) {
    const resp = await transport.createRelayInvite({
      to_agent_id: counterparty,
      contract,
      provider: 'anthropic',
      purpose_code: purposeHint ?? 'CUSTOM',
    });

    handle.inviteId = resp.invite_id;
    handle.contractHash = resp.contract_hash;
    handle.relayUrl = transport.relayUrl;
    handle.purpose = purposeHint ?? undefined;
    handle.myInput = args.my_input;
    handle.phase = 'POLL_INVITE';
    return awaitingResponse(handle, 'Invite created. Waiting for counterparty to accept.');
  }

  const relayUrl = resolveRelayUrl(args.relay_url);
  const config = { relay_url: relayUrl };

  // 1. Create session and submit own input
  const created = await createAndSubmit(config, contract, args.my_input ?? '', 'initiator');

  // 2. Build AfalPropose from purpose and contract template (reuses `relayContract` from above)
  const templateId = purposeHint ? (PURPOSE_TO_TEMPLATE[purposeHint] ?? 'mediation-demo.v1.standard') : 'mediation-demo.v1.standard';

  const proposeFields: Omit<AfalPropose, 'proposal_id'> = {
    proposal_version: '1',
    nonce: generateNonce(),
    timestamp: new Date().toISOString(),
    from: agentId,
    to: counterparty,
    purpose_code: purposeHint ?? 'CUSTOM',
    lane_id: 'API_MEDIATED',
    output_schema_id: relayContract?.output_schema_id ?? 'custom',
    output_schema_version: '1',
    requested_budget_tier: relayContract?.metadata?.['budget_tier'] ?? 'SMALL',
    requested_entropy_bits: relayContract?.entropy_budget_bits ?? 12,
    model_profile_id: relayContract?.model_profile_id ?? 'api-claude-sonnet-v1',
    model_profile_version: '1',
    admission_tier_requested: 'DEFAULT',
  };

  const proposalId = computeProposalId(proposeFields);
  const propose: AfalPropose = { ...proposeFields, proposal_id: proposalId };

  const relay: RelayInvitePayload = {
    session_id: created.sessionId,
    responder_submit_token: created.responderSubmitToken,
    responder_read_token: created.responderReadToken,
    relay_url: relayUrl,
  };

  // 3. Populate handle with session data (before sendPropose so PROPOSE_RETRY has state)
  handle.sessionId = created.sessionId;
  handle.contractHash = created.contractHash;
  handle.relayUrl = relayUrl;
  handle.tokens = {
    submit: '', // initiator doesn't need submit
    read: '', // initiator doesn't need responder read
    initiatorRead: created.initiatorReadToken,
  };
  handle.purpose = purposeHint ?? undefined;
  handle.proposalId = proposalId;

  writeLastSessionFile(created.sessionId, 'INITIATOR', created.initiatorReadToken, relayUrl);

  // 4. Send via AFAL transport — if peer is unreachable, transition to PROPOSE_RETRY
  //    so the FSM retries across tool calls (up to the overall timeout).
  const proposeParams = { propose, relay, templateId, budgetTier: 'SMALL' as const };
  try {
    await transport.sendPropose(proposeParams);
  } catch (err) {
    if (isRetryableTransportError(err)) {
      handle.retryState = proposeParams;
      handle.phase = 'PROPOSE_RETRY';
      return awaitingResponse(
        handle,
        'Counterparty not yet reachable (they may not have started yet). Will keep trying.',
      );
    }
    throw err; // non-retryable — let outer catch handle
  }

  handle.phase = 'POLL_RELAY';
  return awaitingResponse(handle, 'Relay session created. Waiting for counterparty to join.');
}

/**
 * POLL_INVITE phase (relay inbox INITIATE only).
 *
 * Polls GET /invites/:id until the invite is ACCEPTED.
 * When accepted, extracts session tokens, submits initiator input,
 * and transitions to POLL_RELAY.
 */
async function phasePollInvite(
  handle: RelayHandle,
  transport: AfalTransport,
): Promise<ToolResponse<RelaySignalOutput>> {
  if (Date.now() > handle.timeoutDeadline) {
    return failedResponse(handle, 'RELAY_TIMEOUT', 'Timed out waiting for invite acceptance. Call agentvault.relay_signal INITIATE to retry.');
  }

  if (!(transport instanceof RelayInboxTransport)) {
    return failedResponse(handle, 'SESSION_ERROR', 'POLL_INVITE phase requires RelayInboxTransport.');
  }

  const callDeadline = Date.now() + CALL_BUDGET_MS;

  while (Date.now() < callDeadline) {
    const detail = await transport.getInviteDetail(handle.inviteId!);

    if (detail.status === 'ACCEPTED') {
      // Extract initiator session tokens
      handle.sessionId = detail.session_id;
      handle.tokens = {
        submit: detail.submit_token!,
        read: '', // initiator doesn't use responder read token
        initiatorRead: detail.read_token!,
      };

      writeLastSessionFile(handle.sessionId!, 'INITIATOR', detail.read_token!, handle.relayUrl!);

      // Submit initiator input
      const config = { relay_url: handle.relayUrl! };
      await rawSubmitInput(
        config,
        handle.sessionId!,
        handle.tokens.submit,
        'initiator',
        handle.myInput ?? '',
        handle.contractHash,
      );

      handle.phase = 'POLL_RELAY';
      return awaitingResponse(handle, 'Counterparty accepted. Input submitted. Waiting for relay session to complete.');
    }

    if (detail.status === 'DECLINED') {
      return failedResponse(handle, 'INVITE_DECLINED', 'Counterparty declined the invite.');
    }
    if (detail.status === 'EXPIRED') {
      return failedResponse(handle, 'INVITE_EXPIRED', 'Invite expired before counterparty accepted.');
    }
    if (detail.status === 'CANCELED') {
      return failedResponse(handle, 'INVITE_CANCELED', 'Invite was canceled.');
    }

    // Still PENDING — wait and retry
    await sleep(POLL_INTERVAL_MS);
  }

  // Call budget expired — invite still pending
  return awaitingResponse(handle, 'Waiting for counterparty to accept invite.');
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

async function phaseRetryPropose(
  handle: RelayHandle,
  transport: AfalTransport,
): Promise<ToolResponse<RelaySignalOutput>> {
  if (Date.now() > handle.timeoutDeadline) {
    return failedResponse(
      handle,
      'COUNTERPARTY_UNREACHABLE',
      'Counterparty never became reachable within the timeout. Ask them to start their agent, then call agentvault.relay_signal INITIATE again.',
    );
  }

  const params = handle.retryState as {
    propose: AfalPropose;
    relay: RelayInvitePayload;
    templateId: string;
    budgetTier: string;
  };

  try {
    await transport.sendPropose(params);
  } catch (err) {
    if (isRetryableTransportError(err)) {
      return awaitingResponse(
        handle,
        'Counterparty still not reachable. Will keep trying.',
      );
    }
    // Non-retryable error (e.g. DENY response) — fail
    const detail = err instanceof Error ? err.message : String(err);
    return failedResponse(handle, 'SESSION_ERROR', detail);
  }

  // PROPOSE succeeded — advance to relay polling
  handle.phase = 'POLL_RELAY';
  handle.retryState = undefined;
  return awaitingResponse(handle, 'Invite delivered. Waiting for counterparty to join relay session.');
}

// ── RESPOND Phases ──────────────────────────────────────────────────────

async function phaseDiscover(
  handle: RelayHandle,
  transport: AfalTransport,
): Promise<ToolResponse<RelaySignalOutput>> {
  // Check overall timeout
  if (Date.now() > handle.timeoutDeadline) {
    return failedResponse(handle, 'RELAY_TIMEOUT', 'Timed out waiting for relay invite. Ask the initiator to retry.');
  }

  const callDeadline = Date.now() + CALL_BUDGET_MS;

  while (Date.now() < callDeadline) {
    const response = await transport.checkInbox();
    const invites: AfalInviteMessage[] = response.invites ?? [];

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
      // Filter by payload type — accept both legacy and relay inbox invites
      const isRelayInbox = payloadType === RELAY_INBOX_PAYLOAD_TYPE;
      if (payloadType !== 'VCAV_E_INVITE_V1' && !isRelayInbox) continue;
      // If handle already has a bound inviteId, only match that
      if (handle.inviteId && invite.invite_id !== handle.inviteId) continue;

      // For legacy invites, require session tokens in payload.
      // For relay inbox invites, tokens come from acceptInvite later.
      if (!isRelayInbox) {
        const payload = invite.payload;
        if (!payload || typeof payload !== 'object') continue;
        if (!payload['session_id'] || !payload['responder_submit_token'] || !payload['responder_read_token'] || !payload['relay_url']) continue;
      }

      // Check expected_contract_hash if provided (direct hash comparison)
      if (handle.expectedContractHash && invite.contract_hash !== handle.expectedContractHash) {
        foundSenderInviteWithContractMismatch = true;
        continue;
      }

      // AFAL-enriched path: validate purpose_code from parsed AfalPropose
      if (invite.afalPropose?.purpose_code && handle.expectedPurpose && !handle.expectedContractHash) {
        if (invite.afalPropose.purpose_code !== handle.expectedPurpose) {
          foundSenderInviteWithContractMismatch = true;
          continue;
        }
      } else if (handle.expectedPurpose && !handle.expectedContractHash) {
        // Legacy path: validate expected_purpose via template_id
        const expectedTemplate = PURPOSE_TO_TEMPLATE[handle.expectedPurpose];
        const inviteTemplate = invite.template_id;
        if (expectedTemplate && inviteTemplate && inviteTemplate !== expectedTemplate) {
          foundSenderInviteWithContractMismatch = true;
          continue;
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
        } catch (err) {
          // Non-fatal — relay will verify on submit, but log for diagnostics
          console.error(
            `phaseDiscover: failed to compute relay contract hash for purpose=${handle.expectedPurpose}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Bind invite to handle (stops scanning for different invites)
      handle.inviteId = invite.invite_id;
      handle.contractHash = relayContractHash ?? invite.contract_hash;
      handle.proposalId = invite.afalPropose?.proposal_id;

      if (isRelayInbox) {
        // Relay inbox: tokens come from acceptInvite in phaseJoin.
        // Set relayUrl from transport if available.
        if (transport instanceof RelayInboxTransport) {
          handle.relayUrl = handle.relayUrl ?? transport.relayUrl;
        }
      } else {
        // Legacy: extract session tokens from invite payload.
        const payload = invite.payload!;
        handle.sessionId = payload['session_id'] as string;
        handle.relayUrl = handle.relayUrl ?? payload['relay_url'] as string;
        handle.tokens = {
          submit: payload['responder_submit_token'] as string,
          read: payload['responder_read_token'] as string,
        };
      }

      handle.phase = 'JOIN';
      return awaitingResponse(handle, 'Relay invite found. Joining session.');
    }

    // If sender sent invites but all failed contract matching, fail fast.
    // Transition handle to FAILED to prevent stale handle leak.
    if (foundSenderInviteWithContractMismatch) {
      handle.phase = 'FAILED';
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
  transport: AfalTransport,
): Promise<ToolResponse<RelaySignalOutput>> {
  // Check overall timeout
  if (Date.now() > handle.timeoutDeadline) {
    return failedResponse(handle, 'RELAY_TIMEOUT', 'Relay session timed out. Ask the initiator to retry.');
  }

  const config = { relay_url: handle.relayUrl! };

  // Submit input if not yet done (uses stored myInput from handle, not args)
  if (!handle.submitted) {
    // For relay inbox: accept invite FIRST to get session tokens.
    // For legacy transports: tokens are already in handle from phaseDiscover.
    if (!handle.sessionId || !handle.tokens) {
      // No session tokens yet — must be relay inbox path. Accept to get them.
      const result = await transport.acceptInvite(handle.inviteId!);
      if (isAcceptResult(result)) {
        handle.sessionId = result.session_id;
        handle.tokens = {
          submit: result.submit_token,
          read: result.read_token,
        };
      } else {
        return failedResponse(handle, 'SESSION_ERROR', 'acceptInvite did not return session tokens.');
      }
    }

    await rawSubmitInput(
      config,
      handle.sessionId!,
      handle.tokens!.submit,
      'responder',
      handle.myInput ?? '',
      handle.contractHash,
    );
    handle.submitted = true;

    writeLastSessionFile(handle.sessionId!, 'RESPONDER', handle.tokens!.read, handle.relayUrl!);

    // Accept the orchestrator invite after successful submit (legacy transports only).
    // For relay inbox, accept was already called above.
    if (handle.tokens && transport instanceof RelayInboxTransport === false) {
      try {
        await transport.acceptInvite(handle.inviteId!);
      } catch (err) {
        // Accept failure is non-fatal — relay session proceeds regardless.
        // But log for operator diagnostics (auth errors, connectivity).
        console.error(
          `phaseJoin: acceptInvite failed for invite=${handle.inviteId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
  transport?: AfalTransport,
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
        return buildError('SESSION_ERROR', 'Resume requires AfalTransport (agent mode only)');
      }

      // Route to the correct phase
      switch (handle.phase) {
        case 'PROPOSE_RETRY':
          return await phaseRetryPropose(handle, transport);
        case 'POLL_INVITE':
          return await phasePollInvite(handle, transport);
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
          return buildError('SESSION_ERROR', 'INITIATE mode requires AfalTransport (agent mode only)');
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
          if (existing.phase === 'PROPOSE_RETRY') return await phaseRetryPropose(existing, transport);
          if (existing.phase === 'POLL_INVITE') return await phasePollInvite(existing, transport);
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
          return buildError('SESSION_ERROR', 'RESPOND mode requires AfalTransport (agent mode only)');
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
    // Diagnostic file log for debugging live test failures
    try {
      const workdir = process.env['VCAV_WORKDIR'] ?? process.cwd();
      const debugDir = path.join(workdir, '.agentvault');
      fs.mkdirSync(debugDir, { recursive: true });
      const entry = `[${new Date().toISOString()}] error_code=${code} detail=${detail} raw=${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
      fs.appendFileSync(path.join(debugDir, 'relay-debug.log'), entry, 'utf8');
    } catch (logErr) {
      console.error(`handleRelaySignal: failed to write diagnostic log: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
    }
    return buildError(code, detail);
  }
}
