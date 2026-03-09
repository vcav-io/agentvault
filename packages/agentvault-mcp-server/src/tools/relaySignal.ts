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

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSuccess, buildError, type ToolResponse, type ErrorCode } from '../envelope.js';
import { createAndSubmit, pollUntilDone, joinAndWait } from 'agentvault-client';
import {
  submitInput as rawSubmitInput,
  getStatus as httpGetStatus,
  getOutput as httpGetOutput,
} from 'agentvault-client/http';
import type { SessionOutputResponse } from 'agentvault-client';
import {
  buildRelayContract,
  listRelayPurposes,
  computeRelayContractHash,
  withRelayContractModelProfile,
  type RelayContract,
} from 'agentvault-client/contracts';
import type { AfalTransport, AfalInviteMessage } from '../afal-transport.js';
import { PURPOSE_TO_TEMPLATE, isAcceptResult } from '../afal-transport.js';
import { RelayInboxTransport, RELAY_INBOX_PAYLOAD_TYPE } from '../relay-inbox-transport.js';
import { computeProposalId, generateNonce } from '../afal-types.js';
import type { AfalPropose, RelayInvitePayload, RelaySessionBinding } from '../afal-types.js';
import { DirectAfalTransport } from '../direct-afal-transport.js';
import { listKnownModelProfiles, resolveModelProfileRefs, type ModelProfileRef } from '../model-profiles.js';
import {
  purposeToContractOfferIds,
  resolveContractOfferToContract,
  listSupportedContractOffers,
} from '../contract-offers.js';
import type { ContractOfferProposal } from '../contract-negotiation.js';
import {
  resolveBespokeContractToContract,
} from '../bespoke-contracts.js';
import type { TopicAlignmentProposal } from '../topic-alignment.js';
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

function isRelayInvitePayload(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & RelayInvitePayload {
  return (
    typeof payload['session_id'] === 'string' &&
    typeof payload['responder_submit_token'] === 'string' &&
    typeof payload['responder_read_token'] === 'string' &&
    typeof payload['relay_url'] === 'string'
  );
}

// ── Configuration ───────────────────────────────────────────────────────

/**
 * Handle validity window across many short tool invocations.
 * NOT a single-invocation timeout. OpenClaw's agent runtime defaults to 600s —
 * a single run cannot span 30 minutes. This value is only used to reject stale
 * resume tokens that have outlived the expected multi-heartbeat session.
 */
const HANDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Bounded poll budget for phaseDiscover. Polls inbox repeatedly up to this
 * budget before returning DEFERRED. Keeps the tool call responsive while
 * covering the typical case where the counterparty invite arrives within seconds.
 */
const DISCOVER_POLL_BUDGET_MS = 30_000; // 30 seconds
const DISCOVER_POLL_INTERVAL_MS = 3_000; // 3 seconds between checks

/**
 * Bounded poll budget for phasePollRelay and phaseJoin. Polls relay status
 * repeatedly up to this budget before returning DEFERRED. Eliminates the need
 * for the LLM to repeatedly decide "call again with resume_token", saving
 * ~10-12 LLM round-trips per session.
 */
const RELAY_POLL_BUDGET_MS = 25_000; // 25 seconds (headroom within heartbeat cycle)
const RELAY_POLL_INTERVAL_MS = 2_000; // 2 seconds between checks

// Mutable copies used at runtime — overridable for tests.
let _discoverPollBudgetMs = DISCOVER_POLL_BUDGET_MS;
let _discoverPollIntervalMs = DISCOVER_POLL_INTERVAL_MS;
let _relayPollBudgetMs = RELAY_POLL_BUDGET_MS;
let _relayPollIntervalMs = RELAY_POLL_INTERVAL_MS;

/** @internal Test-only: override discover poll timing. */
export function _setDiscoverPollConfigForTesting(budgetMs: number, intervalMs: number): void {
  _discoverPollBudgetMs = budgetMs;
  _discoverPollIntervalMs = intervalMs;
}

/** @internal Test-only: override relay poll timing. */
export function _setRelayPollConfigForTesting(budgetMs: number, intervalMs: number): void {
  _relayPollBudgetMs = budgetMs;
  _relayPollIntervalMs = intervalMs;
}

/** Human-readable descriptions for relay abort reasons. */
const ABORT_DESCRIPTIONS: Record<string, string> = {
  PROVIDER_ERROR: 'The relay LLM provider returned an error (usually transient).',
  TIMEOUT: 'The relay session timed out.',
  SCHEMA_VALIDATION: 'The LLM output did not match the contract schema.',
  CONTRACT_MISMATCH: 'Contract hash mismatch (configuration error).',
  POLICY_GATE: 'Session aborted: a guardian enforcement rule with GATE classification fired.',
};

export type ResumeStrategy = 'IMMEDIATE' | 'DEFERRED';

interface LegacyProposeRetryState {
  retryKind: 'legacy';
  propose: AfalPropose;
  relay: RelayInvitePayload;
  templateId: string;
  budgetTier: string;
}

interface DirectProposeRetryState {
  retryKind: 'direct';
  proposeParams: {
    propose: AfalPropose;
    templateId: string;
    budgetTier: string;
  };
  contract: object;
  relayUrl: string;
  purposeHint?: string | null;
}

// ── Types ───────────────────────────────────────────────────────────────

export interface RelaySignalArgs {
  mode?: 'CREATE' | 'JOIN' | 'INITIATE' | 'RESPOND';
  resume_token?: string;

  // INITIATE mode
  counterparty?: string;
  purpose?: string;
  contract?: object;
  acceptable_topic_codes?: string[];
  acceptable_contracts?: Array<{
    purpose_code: string;
    schema_ref: string;
    policy_ref: string;
    program_ref: string;
    acceptable_model_profiles?: string[];
  }>;
  acceptable_model_profiles?: string[];
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

export interface DerivedField {
  field: string;
  value: string;
  rule_summary: string;
  model_value: string;
  agrees?: boolean;
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
  derived_fields?: DerivedField[];
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
  resume_strategy?: ResumeStrategy;
  user_message: string;
  output?: SessionOutputResponse;
  error_code?: string;
  display: DisplayDirective;
  interpretation_context?: InterpretationContext;
  resume_token_display?: string | null;
  aligned_topic_code?: string;
  negotiated_contract?: {
    kind: 'offer' | 'bespoke';
    contract_offer_id?: string;
    bespoke_contract?: {
      purpose_code: string;
      schema_ref: string;
      policy_ref: string;
      program_ref: string;
    };
    selected_model_profile: ModelProfileRef;
  };
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
  const sessionId = handle.sessionId ?? null;
  return {
    purpose: 'MEDIATION',
    signal_description:
      'Bounded mediation signal from private relay computation. Indicates alignment degree ' +
      "and suggested next step without revealing either party's input.",
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
        values: {
          LOW: 'Low confidence.',
          MEDIUM: 'Moderate confidence.',
          HIGH: 'High confidence.',
        },
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
        `This session is cryptographically receipted (session_id=${sessionId ?? 'n/a'}).`,
      ],
      invalid_claims: [
        '"Bob never saw your input" — the relay enforces privacy at its boundary, but cannot control what the counterparty\'s agent does with the relay output.',
        '"Alice does not know X" — the protocol limits what the relay discloses, not what agents infer.',
        '"The other party doesn\'t know about…" — overclaims beyond protocol guarantees.',
      ],
    },
    provenance: {
      session_id: sessionId,
      contract_hash: handle.contractHash ?? null,
      receipt_available: true,
    },
  };
}

function compatibilityContext(handle: RelayHandle): InterpretationContext {
  const sessionId = handle.sessionId ?? null;
  return {
    purpose: 'COMPATIBILITY',
    signal_description:
      'Bounded compatibility signal from private relay computation. Indicates degree of match ' +
      "between two parties' criteria across multiple dimensions without revealing what those " +
      'criteria were. Also includes a deterministic derivation of next_step from other signal dimensions.',
    signal_fields: [
      {
        field: 'compatibility_signal',
        description: 'Overall degree of match between criteria.',
        values: {
          STRONG_MATCH: 'High overlap across dimensions.',
          PARTIAL_MATCH: 'Meaningful overlap with gaps in some dimensions.',
          WEAK_MATCH: 'Limited overlap; significant gaps present.',
          NO_MATCH: 'Criteria incompatible.',
        },
      },
      {
        field: 'thesis_fit',
        description: 'Alignment on thesis or sector dimension.',
        values: {
          ALIGNED: 'Strong alignment on this dimension.',
          PARTIAL: 'Partial alignment; some gap.',
          MISALIGNED: 'Significant misalignment on this dimension.',
          UNKNOWN: 'Insufficient signal to assess.',
        },
      },
      {
        field: 'size_fit',
        description: 'Compatibility on size dimension.',
        values: {
          WITHIN_BAND: 'Size is within acceptable range.',
          TOO_LOW: 'Size is below acceptable range.',
          TOO_HIGH: 'Size is above acceptable range.',
          UNKNOWN: 'Insufficient signal to assess.',
        },
      },
      {
        field: 'stage_fit',
        description: 'Alignment on stage dimension.',
        values: {
          ALIGNED: 'Strong alignment on this dimension.',
          PARTIAL: 'Partial alignment; some gap.',
          MISALIGNED: 'Significant misalignment on this dimension.',
          UNKNOWN: 'Insufficient signal to assess.',
        },
      },
      {
        field: 'confidence',
        description: 'Relay confidence in the signal given inputs provided.',
        values: {
          LOW: 'Low confidence.',
          MEDIUM: 'Moderate confidence.',
          HIGH: 'High confidence.',
        },
      },
      {
        field: 'primary_reasons',
        description: 'Positive factors supporting the compatibility signal (up to 3).',
        values: {
          SECTOR_MATCH: 'Sector alignment detected.',
          SIZE_COMPATIBLE: 'Size within acceptable range.',
          STAGE_COMPATIBLE: 'Stage alignment detected.',
          GEOGRAPHIC_PROXIMITY: 'Geographic alignment detected.',
          EXPERIENCE_RELEVANCE: 'Relevant experience alignment.',
          TIMELINE_COMPATIBLE: 'Timeline alignment detected.',
        },
      },
      {
        field: 'blocking_reasons',
        description: 'Hard blockers that prevent compatibility (up to 2). Empty if none.',
        values: {
          SIZE_INCOMPATIBLE: 'Size is outside acceptable range.',
          SECTOR_MISMATCH: 'Sector mismatch detected.',
          STAGE_MISMATCH: 'Stage mismatch detected.',
          GEOGRAPHY_MISMATCH: 'Geographic mismatch detected.',
          TIMELINE_CONFLICT: 'Timeline conflict detected.',
          STRUCTURE_INCOMPATIBLE: 'Structural incompatibility detected.',
        },
      },
      {
        field: 'next_step',
        description: 'Model-chosen next step. See derived_fields for deterministic derivation.',
        values: {
          PROCEED: 'Proceed with engagement.',
          PROCEED_WITH_CAVEATS: 'Proceed but address identified gaps.',
          ASK_FOR_PUBLIC_INFO: 'Gather more publicly available information before deciding.',
          DO_NOT_PROCEED: 'Do not proceed with engagement.',
        },
      },
    ],
    epistemic_limits: {
      valid_claims: [
        'The protocol does not expose raw inputs to counterparties.',
        'Only a bounded signal is produced — not a summary of either input.',
        `This session is cryptographically receipted (session_id=${sessionId ?? 'n/a'}).`,
        'derived_fields.value is a deterministic function of other signal fields — it is not an opinion or recommendation.',
      ],
      invalid_claims: [
        '"Bob never saw your input" — the relay enforces privacy at its boundary, but cannot control what the counterparty\'s agent does with the relay output.',
        '"The counterparty\'s specific criteria are known" — the protocol does not expose them.',
        '"The other party doesn\'t know about…" — overclaims beyond protocol guarantees.',
        "'The vault recommends X' — derived_fields are a deterministic function of the signal, not a recommendation from the protocol or relay.",
      ],
    },
    provenance: {
      session_id: sessionId,
      contract_hash: handle.contractHash ?? null,
      receipt_available: true,
    },
  };
}

function customContext(handle: RelayHandle): InterpretationContext {
  const sessionId = handle.sessionId ?? null;
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
      session_id: sessionId,
      contract_hash: handle.contractHash ?? null,
      receipt_available: true,
    },
  };
}

function getReceiptSessionId(receipt: unknown): string | undefined {
  if (!receipt || typeof receipt !== 'object') return undefined;
  const sessionId = (receipt as Record<string, unknown>)['session_id'];
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

function getEffectiveCompletedSessionId(
  handle: RelayHandle,
  output: SessionOutputResponse,
): string | undefined {
  return getReceiptSessionId(output.receipt_v2) ?? getReceiptSessionId(output.receipt) ?? handle.sessionId;
}

/** Pure function: deterministic derivation of next_step from COMPAT v2 signal fields.
 *  Returns null if the compatibility_signal is unknown/missing (no derivation possible). */
export function deriveCompatNextStep(output: Record<string, unknown>): DerivedField | null {
  const blockingReasons = (output['blocking_reasons'] as string[] | undefined) ?? [];
  const signal = output['compatibility_signal'] as string | undefined;
  const confidence = output['confidence'] as string | undefined;
  const thesis = output['thesis_fit'] as string | undefined;
  const size = output['size_fit'] as string | undefined;
  const stage = output['stage_fit'] as string | undefined;
  const primaryReasons = (output['primary_reasons'] as string[] | undefined) ?? [];
  const modelValue = output['next_step'] as string | undefined;

  let derivedValue: string;
  let ruleSummary: string;

  // Rule 1: blocking reasons present
  if (blockingReasons.length > 0) {
    derivedValue = 'DO_NOT_PROCEED';
    ruleSummary = 'Blocking reasons present.';
  }
  // Rule 2: NO_MATCH signal
  else if (signal === 'NO_MATCH') {
    derivedValue = 'DO_NOT_PROCEED';
    ruleSummary = 'compatibility_signal is NO_MATCH.';
  }
  // Rule 3: STRONG_MATCH
  else if (signal === 'STRONG_MATCH') {
    if (
      confidence === 'HIGH' &&
      thesis === 'ALIGNED' &&
      size === 'WITHIN_BAND' &&
      stage === 'ALIGNED' &&
      primaryReasons.length >= 2
    ) {
      derivedValue = 'PROCEED';
      ruleSummary =
        'STRONG_MATCH with HIGH confidence, all dimensions ALIGNED, and at least 2 primary reasons.';
    } else {
      derivedValue = 'PROCEED_WITH_CAVEATS';
      ruleSummary = 'STRONG_MATCH but not all conditions met for full PROCEED.';
    }
  }
  // Rule 4: PARTIAL_MATCH
  else if (signal === 'PARTIAL_MATCH') {
    const weakDims = [thesis, size, stage].filter(
      (v) => v === 'MISALIGNED' || v === 'UNKNOWN',
    ).length;
    if (weakDims >= 2) {
      derivedValue = 'ASK_FOR_PUBLIC_INFO';
      ruleSummary = 'PARTIAL_MATCH with 2 or more weak dimensions (MISALIGNED or UNKNOWN).';
    } else {
      derivedValue = 'PROCEED_WITH_CAVEATS';
      ruleSummary = 'PARTIAL_MATCH with fewer than 2 weak dimensions.';
    }
  }
  // Rule 5: WEAK_MATCH
  else if (signal === 'WEAK_MATCH') {
    if (confidence === 'LOW') {
      derivedValue = 'ASK_FOR_PUBLIC_INFO';
      ruleSummary = 'WEAK_MATCH with LOW confidence.';
    } else {
      derivedValue = 'DO_NOT_PROCEED';
      ruleSummary = 'WEAK_MATCH with confidence above LOW.';
    }
  }
  // Fallback: unknown or missing signal
  else {
    return null;
  }

  const result: DerivedField = {
    field: 'next_step',
    value: derivedValue,
    rule_summary: ruleSummary,
    model_value: modelValue ?? '',
  };

  if (modelValue !== undefined) {
    result.agrees = derivedValue === modelValue;
  }

  return result;
}

function buildInterpretationContext(
  handle: RelayHandle,
  output?: Record<string, unknown>,
): InterpretationContext {
  switch (handle.purpose) {
    case 'MEDIATION':
      return mediationContext(handle);
    case 'COMPATIBILITY': {
      const ctx = compatibilityContext(handle);
      if (output !== undefined) {
        const derived = deriveCompatNextStep(output);
        if (derived !== null) {
          ctx.derived_fields = [derived];
        }
      }
      return ctx;
    }
    default:
      return customContext(handle);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function resolveRelayUrl(argsUrl?: string, discoveredUrl?: string): string {
  const url = argsUrl ?? process.env['AV_RELAY_URL'] ?? discoveredUrl;
  if (!url) {
    throw new Error(
      'relay_url is required (or set AV_RELAY_URL environment variable, or discover a peer Agent Card relay_url in direct AFAL mode)',
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
      let guidance = '';
      if (msg.includes('deny_code=UNTRUSTED')) {
        guidance =
          ' The counterparty does not recognize this agent as trusted. ' +
          'Check that the counterparty has your agent_id and public key in their trusted agents configuration, ' +
          'and that no stale AFAL server from a previous session is running on the same port.';
      } else if (msg.includes('deny_code=POLICY')) {
        guidance = ' The counterparty\'s policy does not allow this purpose or configuration.';
      } else if (msg.includes('deny_code=STALE')) {
        guidance = ' The proposal timestamp was rejected as too old. Check clock synchronization.';
      } else if (msg.includes('deny_code=INTEGRITY')) {
        guidance = ' The proposal failed integrity verification (possible tampering or version mismatch).';
      }
      return {
        code: 'SESSION_ERROR',
        detail: `Counterparty explicitly denied the proposal.${guidance} ${msg}`,
      };
    }
    if (msg.includes('relay_url')) {
      return { code: 'INVALID_INPUT', detail: msg };
    }
    return { code: 'SESSION_ERROR', detail: msg };
  }
  return { code: 'UNKNOWN_ERROR', detail: 'Unexpected error in relay_signal' };
}

function writeLastSessionFile(
  sessionId: string,
  role: 'INITIATOR' | 'RESPONDER',
  readToken: string,
  relayUrl: string,
): void {
  try {
    const workdir = process.env['AV_WORKDIR'] ?? process.cwd();
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
    fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
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
  return process.env['AV_RESUME_TOKEN_SECRET'] ?? null;
}

// ── Session State Files ─────────────────────────────────────────────────

function resolveWorkdir(): string {
  const dir = process.env['AV_WORKDIR'] ?? process.cwd();
  if (!process.env['AV_WORKDIR']) {
    console.warn(
      `[AV WARNING] AV_WORKDIR not set — writing session state to ${dir}. ` +
        'The heartbeat agent may not find these files. Set AV_WORKDIR to your workspace directory.',
    );
  }
  return dir;
}

export interface SessionStateEntry {
  handle_id: string;
  resume_strategy: ResumeStrategy;
  due_at: string;
  updated_at: string;
}

interface SessionStateFile {
  handle_id: string;
  resume_token: string;
  phase: string;
  role: 'INITIATOR' | 'RESPONDER';
  counterparty: string;
  purpose?: string;
  session_id?: string;
  /** Full confirmed contract (structured confirmation). */
  contract_json?: Record<string, unknown>;
  contract_hash?: string;
  resume_strategy: ResumeStrategy;
  next_update_seconds: number;
  due_at: string;
  expires_at: string;
  updated_at: string;
  attempt_count: number;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

function rebuildSessionIndex(sessionsDir: string, indexPath: string): void {
  const entries: SessionStateEntry[] = [];
  try {
    const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(sessionsDir, file), 'utf8');
        const state: SessionStateFile = JSON.parse(raw);
        // Clean up expired sessions during rebuild
        if (state.expires_at && new Date(state.expires_at).getTime() < Date.now()) {
          try {
            fs.unlinkSync(path.join(sessionsDir, file));
          } catch (unlinkErr) {
            if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.warn(
                `rebuildSessionIndex: failed to remove expired file ${file}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`,
              );
            }
          }
          continue;
        }
        entries.push({
          handle_id: state.handle_id,
          resume_strategy: state.resume_strategy,
          due_at: state.due_at,
          updated_at: state.updated_at,
        });
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(
            `rebuildSessionIndex: skipping unreadable session file ${file}: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
          );
        }
      }
    }
  } catch (dirErr) {
    if ((dirErr as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `rebuildSessionIndex: failed to read sessions directory ${sessionsDir}: ${dirErr instanceof Error ? dirErr.message : String(dirErr)}`,
      );
    }
  }

  // Sort: IMMEDIATE before DEFERRED, within IMMEDIATE oldest updated_at first,
  // within DEFERRED earliest due_at first, tie-break by handle_id
  entries.sort((a, b) => {
    const stratOrder = (s: ResumeStrategy) => (s === 'IMMEDIATE' ? 0 : 1);
    const stratCmp = stratOrder(a.resume_strategy) - stratOrder(b.resume_strategy);
    if (stratCmp !== 0) return stratCmp;
    if (a.resume_strategy === 'IMMEDIATE') {
      const timeCmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
      if (timeCmp !== 0) return timeCmp;
    } else {
      const timeCmp = new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
      if (timeCmp !== 0) return timeCmp;
    }
    return a.handle_id.localeCompare(b.handle_id);
  });

  atomicWriteJson(indexPath, entries);
}

function writeSessionStateFile(
  handle: RelayHandle,
  resumeToken: string,
  strategy: ResumeStrategy,
  nextUpdateSeconds: number,
): void {
  try {
    const workdir = resolveWorkdir();
    const sessionsDir = path.join(workdir, '.agentvault', 'sessions');
    const indexPath = path.join(workdir, '.agentvault', 'active_sessions.json');

    const now = new Date();
    const dueAt = new Date(now.getTime() + nextUpdateSeconds * 1000);

    // Read existing file to preserve expires_at and track attempt_count
    let existingExpiresAt: string | undefined;
    let existingAttemptCount = 0;
    let existingPhase: string | undefined;
    const filePath = path.join(sessionsDir, `${handle.id}.json`);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const existing: SessionStateFile = JSON.parse(raw);
      existingExpiresAt = existing.expires_at;
      existingAttemptCount = existing.attempt_count ?? 0;
      existingPhase = existing.phase;
    } catch {
      // First write — no existing file
    }

    // Reset attempt_count on phase change, otherwise increment
    const attemptCount =
      existingPhase && existingPhase !== handle.phase ? 0 : existingAttemptCount + 1;

    const state: SessionStateFile = {
      handle_id: handle.id,
      resume_token: resumeToken,
      phase: handle.phase,
      role: handle.role,
      counterparty: handle.counterparty,
      purpose: handle.purpose,
      session_id: handle.sessionId,
      contract_json: handle.contract,
      contract_hash: handle.contractHash,
      resume_strategy: strategy,
      next_update_seconds: nextUpdateSeconds,
      due_at: dueAt.toISOString(),
      expires_at: existingExpiresAt ?? new Date(handle.createdAt + HANDLE_TTL_MS).toISOString(),
      updated_at: now.toISOString(),
      attempt_count: attemptCount,
    };

    atomicWriteJson(filePath, state);
    rebuildSessionIndex(sessionsDir, indexPath);
  } catch (err) {
    // Non-fatal — log but do not fail the relay operation
    console.error(
      `writeSessionStateFile: failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function removeSessionStateFile(handle: RelayHandle): void {
  try {
    const workdir = resolveWorkdir();
    const sessionsDir = path.join(workdir, '.agentvault', 'sessions');
    const indexPath = path.join(workdir, '.agentvault', 'active_sessions.json');
    const filePath = path.join(sessionsDir, `${handle.id}.json`);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `removeSessionStateFile: failed to delete ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    rebuildSessionIndex(sessionsDir, indexPath);
  } catch (err) {
    console.error(
      `removeSessionStateFile: failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Response Builders ───────────────────────────────────────────────────

function mapNegotiatedContract(
  handle: RelayHandle,
): RelaySignalOutput['negotiated_contract'] | undefined {
  if (!handle.negotiatedContract) return undefined;
  return {
    kind: handle.negotiatedContract.kind,
    ...(handle.negotiatedContract.contractOfferId
      ? { contract_offer_id: handle.negotiatedContract.contractOfferId }
      : {}),
    ...(handle.negotiatedContract.bespokeContract
      ? { bespoke_contract: handle.negotiatedContract.bespokeContract }
      : {}),
    selected_model_profile: handle.negotiatedContract.selectedModelProfile,
  };
}

function mapAlignedTopicCode(handle: RelayHandle): string | undefined {
  return handle.alignedTopicCode;
}

function awaitingResponse(
  handle: RelayHandle,
  userMessage: string,
  opts?: { strategy?: ResumeStrategy; seconds?: number },
): ToolResponse<RelaySignalOutput> {
  const strategy = opts?.strategy ?? 'IMMEDIATE';
  const seconds = opts?.seconds ?? 5;
  const token = encodeRelayToken(handle, getResumeTokenSecret());
  const resumeTokenDisplay = token.length > 16 ? `${token.slice(0, 12)}…${token.slice(-4)}` : token;

  writeSessionStateFile(handle, token, strategy, seconds);

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
    next_update_seconds: seconds,
    resume_strategy: strategy,
    user_message: userMessage,
    aligned_topic_code: mapAlignedTopicCode(handle),
    negotiated_contract: mapNegotiatedContract(handle),
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
  const effectiveSessionId = getEffectiveCompletedSessionId(handle, output);
  if (effectiveSessionId) {
    handle.sessionId = effectiveSessionId;
  }
  removeSessionStateFile(handle);
  return buildSuccess('COMPLETE', {
    mode: handle.role === 'INITIATOR' ? 'INITIATE' : 'RESPOND',
    state: 'COMPLETED',
    phase: 'COMPLETED',
    resume_token: null,
    resume_token_display: null,
    session_id: effectiveSessionId,
    contract_hash: handle.contractHash,
    from: handle.role === 'RESPONDER' ? handle.counterparty : undefined,
    action_required: 'NONE',
    next_tool: null,
    next_args_patch: null,
    next_update_seconds: null,
    user_message: 'Relay session complete.',
    aligned_topic_code: mapAlignedTopicCode(handle),
    negotiated_contract: mapNegotiatedContract(handle),
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
    interpretation_context: buildInterpretationContext(
      handle,
      output.output as Record<string, unknown> | undefined,
    ),
  });
}

function failedResponse(
  handle: RelayHandle,
  errorCode: string,
  userMessage: string,
  output?: SessionOutputResponse,
): ToolResponse<RelaySignalOutput> {
  handle.phase = 'FAILED';
  removeSessionStateFile(handle);
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
    aligned_topic_code: mapAlignedTopicCode(handle),
    negotiated_contract: mapNegotiatedContract(handle),
    output,
    display: {
      forbidden: ['PRINT_RESUME_TOKEN'],
      redact: ['resume_token'],
    },
  });
}

function preferredModelProfileRef(contract: RelayContract | undefined): ModelProfileRef | undefined {
  if (!contract?.model_profile_id || !contract.model_profile_hash) return undefined;
  // Relay contracts currently bind profile id/hash but not version. Until the
  // contract schema grows a version field, direct AFAL negotiations must treat
  // the bundled templates as v1 profiles.
  return {
    id: contract.model_profile_id,
    version: '1',
    hash: contract.model_profile_hash,
  };
}

function bindSelectedProfile(
  contract: object,
  selectedProfile: ModelProfileRef | undefined,
): object {
  if (!selectedProfile) return contract;
  return withRelayContractModelProfile(contract as RelayContract, {
    id: selectedProfile.id,
    hash: selectedProfile.hash,
    version: selectedProfile.version,
  });
}

async function createCommittedDirectSession(params: {
  handle: RelayHandle;
  transport: AfalTransport;
  relayUrl: string;
  contract: object;
  myInput: string;
  proposalId: string;
  purposeHint?: string | null;
}): Promise<void> {
  const config = { relay_url: params.relayUrl };
  const created = await createAndSubmit(config, params.contract, params.myInput, 'initiator');
  const relaySession: RelaySessionBinding = {
    session_id: created.sessionId,
    responder_submit_token: created.responderSubmitToken,
    responder_read_token: created.responderReadToken,
    relay_url: params.relayUrl,
    contract_hash: created.contractHash,
  };

  params.handle.sessionId = created.sessionId;
  params.handle.contractHash = created.contractHash;
  params.handle.relayUrl = params.relayUrl;
  params.handle.tokens = {
    submit: '',
    read: '',
    initiatorRead: created.initiatorReadToken,
  };
  params.handle.purpose = params.purposeHint ?? undefined;
  params.handle.proposalId = params.proposalId;

  writeLastSessionFile(created.sessionId, 'INITIATOR', created.initiatorReadToken, params.relayUrl);

  if (params.transport.commitAdmit) {
    await params.transport.commitAdmit(params.proposalId, relaySession);
  }
}

// ── INITIATE Phases ─────────────────────────────────────────────────────

async function phaseInvite(
  handle: RelayHandle,
  args: RelaySignalArgs,
  transport: AfalTransport,
  knownAgents: NormalizedKnownAgent[],
  relayProfileId?: string,
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
      built = buildRelayContract(args.purpose, [agentId, counterparty], relayProfileId);
    } catch (e) {
      return buildError('INVALID_INPUT', (e as Error).message);
    }
    if (!built) {
      return buildError(
        'INVALID_INPUT',
        `Unknown purpose "${args.purpose}". Available: ${listRelayPurposes().join(', ')}`,
      );
    }
    contract = built;
    relayContract = built;
    purposeHint = args.purpose;
  } else {
    return buildError(
      'INVALID_INPUT',
      `INITIATE requires purpose (${listRelayPurposes().join(', ')}) or contract`,
    );
  }

  const negotiatedProfiles = args.acceptable_model_profiles?.length
    ? resolveModelProfileRefs(args.acceptable_model_profiles)
    : undefined;
  if (negotiatedProfiles && !(transport instanceof DirectAfalTransport)) {
    return buildError(
      'INVALID_INPUT',
      'acceptable_model_profiles is currently supported only for direct AFAL transport',
    );
  }
  if (negotiatedProfiles && args.contract) {
    return buildError(
      'INVALID_INPUT',
      'acceptable_model_profiles is only supported with purpose-based direct AFAL contracts',
    );
  }

  // ── Relay inbox path ──────────────────────────────────────────────────
  // When using RelayInboxTransport, create an invite via the relay's inbox
  // instead of creating a session eagerly. The relay creates the session
  // when the responder accepts the invite.
  if (transport instanceof RelayInboxTransport) {
    const resp = await transport.createRelayInvite({
      to_agent_id: counterparty,
      contract,
      purpose_code: purposeHint ?? 'CUSTOM',
    });

    handle.inviteId = resp.invite_id;
    handle.contractHash = resp.contract_hash;
    handle.contract = contract as Record<string, unknown>;
    handle.relayUrl = transport.relayUrl;
    handle.purpose = purposeHint ?? undefined;
    handle.myInput = args.my_input;
    handle.phase = 'POLL_INVITE';
    return awaitingResponse(handle, 'Invite created. Waiting for counterparty to accept.', {
      strategy: 'DEFERRED',
      seconds: 120,
    });
  }

  const peerDiscovery =
    transport instanceof DirectAfalTransport
      ? await transport.discoverPeerAgentCard(counterparty)
      : null;
  if (
    purposeHint &&
    peerDiscovery?.supportedPurposes.length &&
    !peerDiscovery.supportedPurposes.includes(purposeHint)
  ) {
    return buildError(
      'INVALID_INPUT',
      `Counterparty Agent Card does not advertise support for purpose "${purposeHint}". ` +
        `Advertised purposes: ${peerDiscovery.supportedPurposes.join(', ')}`,
    );
  }

  if (args.acceptable_topic_codes?.length) {
    if (!(transport instanceof DirectAfalTransport)) {
      return buildError(
        'SESSION_ERROR',
        'Bounded topic alignment requires direct bilateral transport.',
      );
    }
    if (!peerDiscovery?.supportsTopicAlignment || !peerDiscovery.supportedTopicCodes?.length) {
      return buildError(
        'SESSION_ERROR',
        'Counterparty does not advertise support for bounded topic alignment.',
      );
    }
    const acceptableTopicCodes = args.acceptable_topic_codes.filter(
      (code): code is string => typeof code === 'string' && /^[a-z0-9_]+$/.test(code),
    );
    if (!acceptableTopicCodes.length) {
      return buildError(
        'INVALID_INPUT',
        'acceptable_topic_codes must contain at least one lowercase topic code.',
      );
    }
    const alignmentProposal: TopicAlignmentProposal = {
      alignment_id: randomUUID(),
      acceptable_topic_codes: acceptableTopicCodes,
      expected_counterparty: counterparty,
    };
    const alignment = await transport.alignTopic(alignmentProposal);
    if (alignment?.state === 'REJECTED') {
      return buildError('SESSION_ERROR', 'Counterparty rejected bounded topic alignment.');
    }
    if (alignment?.state === 'NOT_ALIGNED') {
      return buildError('SESSION_ERROR', 'No common bounded topic code was available.');
    }
    if (alignment?.state === 'ALIGNED' && alignment.selected_topic_code) {
      handle.alignedTopicCode = alignment.selected_topic_code;
    }
  }

  let negotiatedSelection: RelayHandle['negotiatedContract'] | null = null;
  if (transport instanceof DirectAfalTransport && !args.contract) {
    const negotiationCandidates: ContractOfferProposal['acceptable_offers'] = [];
    const defaultNegotiationProfiles = args.acceptable_model_profiles?.length
      ? resolveModelProfileRefs(args.acceptable_model_profiles)
      : preferredModelProfileRef(relayContract)
        ? [preferredModelProfileRef(relayContract) as ModelProfileRef]
        : undefined;

    if (purposeHint && peerDiscovery?.supportsPrecontractNegotiation && peerDiscovery.supportedContractOffers?.length) {
      const offerIds = purposeToContractOfferIds(purposeHint);
      const localSupportedOffers = listSupportedContractOffers();
      const allowedOfferIds = new Set(
        peerDiscovery.supportedContractOffers.map((offer) => offer.contract_offer_id),
      );
      const acceptableOffers = localSupportedOffers
        .filter(
          (offer) =>
            offerIds.includes(offer.contract_offer_id) && allowedOfferIds.has(offer.contract_offer_id),
        )
        .map((offer) => ({
          kind: 'offer' as const,
          contract_offer_id: offer.contract_offer_id,
          acceptable_model_profiles: (
            defaultNegotiationProfiles?.length
              ? defaultNegotiationProfiles
              : offer.supported_model_profiles
          ).filter((profile) =>
            offer.supported_model_profiles.some(
              (candidate) =>
                candidate.id === profile.id &&
                candidate.version === profile.version &&
                candidate.hash === profile.hash,
            ),
          ),
        }))
        .filter((offer) => offer.acceptable_model_profiles.length > 0);
      negotiationCandidates.push(...acceptableOffers);
    }

    if (args.acceptable_contracts?.length) {
      if (!peerDiscovery?.supportsBespokeContractNegotiation) {
        return buildError(
          'SESSION_ERROR',
          'Counterparty does not advertise support for bespoke pre-contract negotiation.',
        );
      }
      const localProfiles = listKnownModelProfiles();
      for (const candidate of args.acceptable_contracts) {
        const acceptableProfiles = candidate.acceptable_model_profiles?.length
          ? resolveModelProfileRefs(candidate.acceptable_model_profiles)
          : defaultNegotiationProfiles?.length
            ? defaultNegotiationProfiles
            : localProfiles;
        if (acceptableProfiles.length === 0) continue;
        negotiationCandidates.push({
          kind: 'bespoke',
          purpose_code: candidate.purpose_code,
          schema_ref: candidate.schema_ref,
          policy_ref: candidate.policy_ref,
          program_ref: candidate.program_ref,
          acceptable_model_profiles: acceptableProfiles,
        });
      }
    }

    if (negotiationCandidates.length) {
      const negotiationProposal: ContractOfferProposal = {
        negotiation_id: randomUUID(),
        acceptable_offers: negotiationCandidates,
        expected_counterparty: counterparty,
      };
      const selection = await transport.negotiateContractOffer(negotiationProposal);
      if (selection?.state === 'REJECTED') {
        return buildError('SESSION_ERROR', 'Counterparty rejected pre-contract negotiation.');
      }
      if (selection?.state === 'NO_COMMON_CONTRACT') {
        return buildError(
          'SESSION_ERROR',
          'No common bounded contract and model profile combination was available.',
        );
      }
      if (selection?.state === 'AGREED' && selection.selected_model_profile) {
        if (selection.selected_contract_offer_id) {
          negotiatedSelection = {
            kind: 'offer',
            contractOfferId: selection.selected_contract_offer_id,
            selectedModelProfile: selection.selected_model_profile,
          };
          contract = resolveContractOfferToContract({
            contractOfferId: selection.selected_contract_offer_id,
            participants: [agentId, counterparty],
            selectedModelProfile: selection.selected_model_profile,
          });
        } else if (selection.selected_bespoke_contract) {
          negotiatedSelection = {
            kind: 'bespoke',
            bespokeContract: {
              purpose_code: selection.selected_bespoke_contract.purpose_code,
              schema_ref: selection.selected_bespoke_contract.schema_ref,
              policy_ref: selection.selected_bespoke_contract.policy_ref,
              program_ref: selection.selected_bespoke_contract.program_ref,
            },
            selectedModelProfile: selection.selected_model_profile,
          };
          contract = await resolveBespokeContractToContract({
            contract: selection.selected_bespoke_contract,
            participants: [agentId, counterparty],
            selectedModelProfile: selection.selected_model_profile,
          });
        }
        if (negotiatedSelection && contract) {
          handle.negotiatedContract = negotiatedSelection;
          relayContract = contract as RelayContract;
          purposeHint = relayContract.purpose_code;
        }
      }
    }
  }

  const relayUrl = resolveRelayUrl(args.relay_url, peerDiscovery?.relayUrl);
  // 1. Build AfalPropose from purpose and contract template.
  const templateId = purposeHint
    ? (PURPOSE_TO_TEMPLATE[purposeHint] ?? 'mediation-demo.v1.standard')
    : 'mediation-demo.v1.standard';
  const preferredProfile =
    negotiatedSelection?.selectedModelProfile ??
    negotiatedProfiles?.[0] ??
    preferredModelProfileRef(relayContract);

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
    model_profile_id: preferredProfile?.id ?? relayContract?.model_profile_id ?? 'api-claude-sonnet-v1',
    model_profile_version: preferredProfile?.version ?? '1',
    admission_tier_requested: 'DEFAULT',
    ...(preferredProfile?.hash ? { model_profile_hash: preferredProfile.hash } : {}),
    ...(!negotiatedSelection && negotiatedProfiles
      ? { acceptable_model_profiles: negotiatedProfiles }
      : {}),
  };

  const proposalId = computeProposalId(proposeFields);
  const propose: AfalPropose = { ...proposeFields, proposal_id: proposalId };
  handle.purpose = purposeHint ?? undefined;
  handle.myInput = args.my_input;
  handle.proposalId = proposalId;

  if (!(transport instanceof DirectAfalTransport)) {
    const config = { relay_url: relayUrl };
    const created = await createAndSubmit(config, contract, args.my_input ?? '', 'initiator');
    const relay: RelayInvitePayload = {
      session_id: created.sessionId,
      responder_submit_token: created.responderSubmitToken,
      responder_read_token: created.responderReadToken,
      relay_url: relayUrl,
    };

    handle.sessionId = created.sessionId;
    handle.contractHash = created.contractHash;
    handle.relayUrl = relayUrl;
    handle.tokens = {
      submit: '',
      read: '',
      initiatorRead: created.initiatorReadToken,
    };

    writeLastSessionFile(created.sessionId, 'INITIATOR', created.initiatorReadToken, relayUrl);

    const proposeParams = { propose, relay, templateId, budgetTier: 'SMALL' as const };
    try {
      await transport.sendPropose(proposeParams);
    } catch (err) {
      if (isRetryableTransportError(err)) {
        handle.retryState = {
          retryKind: 'legacy',
          ...proposeParams,
        } satisfies LegacyProposeRetryState;
        handle.phase = 'PROPOSE_RETRY';
        return awaitingResponse(
          handle,
          'Counterparty not yet reachable (they may not have started yet). Will keep trying.',
          { strategy: 'DEFERRED', seconds: 60 },
        );
      }
      throw err;
    }

    handle.phase = 'POLL_RELAY';
    return awaitingResponse(handle, 'Relay session created. Waiting for counterparty to join.', {
      strategy: 'IMMEDIATE',
      seconds: 5,
    });
  }

  // 4. Send via AFAL transport — if peer is unreachable, transition to PROPOSE_RETRY
  //    so the FSM retries across tool calls (up to the overall timeout).
  const proposeParams = { propose, templateId, budgetTier: 'SMALL' as const };
  try {
    const response = await transport.sendPropose(proposeParams);
    const selectedProfile = response?.selectedModelProfile ?? preferredProfile;
    const finalContract = bindSelectedProfile(contract, selectedProfile);
    await createCommittedDirectSession({
      handle,
      transport,
      relayUrl,
      contract: finalContract,
      myInput: args.my_input ?? '',
      proposalId,
      purposeHint,
    });
  } catch (err) {
    if (isRetryableTransportError(err)) {
      handle.retryState = {
        retryKind: 'direct',
        proposeParams,
        contract,
        relayUrl,
        purposeHint,
      } satisfies DirectProposeRetryState;
      handle.phase = 'PROPOSE_RETRY';
      return awaitingResponse(
        handle,
        'Counterparty not yet reachable (they may not have started yet). Will keep trying.',
        { strategy: 'DEFERRED', seconds: 60 },
      );
    }
    throw err; // non-retryable — let outer catch handle
  }

  handle.phase = 'POLL_RELAY';
  return awaitingResponse(handle, 'Counterparty admitted the invite. Waiting for relay session to complete.', {
    strategy: 'IMMEDIATE',
    seconds: 5,
  });
}

/**
 * POLL_INVITE phase (relay inbox INITIATE only).
 *
 * Single-check: queries invite status once and returns immediately.
 * Heartbeat-safe — no blocking loops.
 */
async function phasePollInvite(
  handle: RelayHandle,
  transport: AfalTransport,
): Promise<ToolResponse<RelaySignalOutput>> {
  if (Date.now() > handle.timeoutDeadline) {
    return failedResponse(
      handle,
      'RELAY_TIMEOUT',
      'Timed out waiting for invite acceptance. Call agentvault.relay_signal INITIATE to retry.',
    );
  }

  if (!(transport instanceof RelayInboxTransport)) {
    return failedResponse(
      handle,
      'SESSION_ERROR',
      'POLL_INVITE phase requires RelayInboxTransport.',
    );
  }

  if (!handle.inviteId) {
    return failedResponse(handle, 'SESSION_ERROR', 'Missing inviteId in POLL_INVITE phase.');
  }
  if (!handle.relayUrl) {
    return failedResponse(handle, 'SESSION_ERROR', 'Missing relayUrl in POLL_INVITE phase.');
  }

  const detail = await transport.getInviteDetail(handle.inviteId);

  if (detail.status === 'ACCEPTED') {
    // Validate required session fields before using them
    if (!detail.session_id || !detail.submit_token || !detail.read_token) {
      return failedResponse(
        handle,
        'SESSION_ERROR',
        'Invite accepted but relay returned incomplete session data (missing session_id, submit_token, or read_token).',
      );
    }

    // Extract initiator session tokens
    handle.sessionId = detail.session_id;
    handle.tokens = {
      submit: detail.submit_token,
      read: '', // initiator doesn't use responder read token
      initiatorRead: detail.read_token,
    };

    writeLastSessionFile(handle.sessionId, 'INITIATOR', detail.read_token, handle.relayUrl);

    // Commit phase before submit so retries route to POLL_RELAY (not back here)
    handle.phase = 'POLL_RELAY';

    // Submit initiator input
    const config = { relay_url: handle.relayUrl };
    try {
      await rawSubmitInput(
        config,
        handle.sessionId,
        handle.tokens.submit,
        'initiator',
        handle.myInput ?? '',
        handle.contractHash,
      );
    } catch (submitErr) {
      console.error(
        `phasePollInvite: input submit failed after invite accepted: ${submitErr instanceof Error ? submitErr.message : String(submitErr)}`,
      );
      return awaitingResponse(
        handle,
        'Invite accepted but input submission failed (transient). Will retry on next check.',
        { strategy: 'IMMEDIATE', seconds: 5 },
      );
    }

    return awaitingResponse(
      handle,
      'Counterparty accepted. Input submitted. Waiting for relay session to complete.',
      { strategy: 'IMMEDIATE', seconds: 5 },
    );
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

  // Still PENDING — return immediately, let heartbeat check again later
  return awaitingResponse(handle, 'Waiting for counterparty to accept invite.', {
    strategy: 'DEFERRED',
    seconds: 120,
  });
}

/**
 * POLL_RELAY phase — bounded polling loop.
 * Polls relay status repeatedly for up to RELAY_POLL_BUDGET_MS, returning
 * immediately on completion or abort. This eliminates repeated LLM round-trips
 * for mechanical "call again with resume_token" decisions.
 */
async function phasePollRelay(
  handle: RelayHandle,
  transport?: AfalTransport,
): Promise<ToolResponse<RelaySignalOutput>> {
  if (Date.now() > handle.timeoutDeadline) {
    return failedResponse(
      handle,
      'RELAY_TIMEOUT',
      'Relay session timed out. Call agentvault.relay_signal INITIATE to retry.',
    );
  }

  if (!handle.relayUrl || !handle.sessionId || !handle.tokens?.initiatorRead) {
    return failedResponse(handle, 'SESSION_ERROR', 'Missing session data in POLL_RELAY phase.');
  }

  const config = { relay_url: handle.relayUrl };
  const pollDeadline = Math.min(Date.now() + _relayPollBudgetMs, handle.timeoutDeadline);
  let isFirstCheck = true;

  while (true) {
    // Sleep between polls (not before the first check)
    if (!isFirstCheck) {
      if (Date.now() + _relayPollIntervalMs > pollDeadline) break;
      await new Promise(resolve => setTimeout(resolve, _relayPollIntervalMs));
    }
    isFirstCheck = false;

    let status;
    try {
      status = await httpGetStatus(config, handle.sessionId, handle.tokens.initiatorRead);
    } catch (err) {
      console.warn(
        `phasePollRelay: transient status check failed for session ${handle.sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      if (Date.now() >= pollDeadline) break;
      continue; // transient — retry within budget
    }

    if (status.state === 'COMPLETED') {
      try {
        const output = await httpGetOutput(config, handle.sessionId, handle.tokens.initiatorRead);
        return completedResponse(handle, output);
      } catch (fetchErr) {
        console.error(
          `phasePollRelay: session ${handle.sessionId} COMPLETED but output fetch failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
        );
        // Transient fetch failure — continue polling within budget
      }
    }

    if (status.state === 'ABORTED') {
      const reason = status.abort_reason ?? 'UNKNOWN';
      const desc = ABORT_DESCRIPTIONS[reason] ?? 'The relay session was aborted.';
      return failedResponse(
        handle,
        `RELAY_${reason}`,
        `Session aborted: ${desc} Call agentvault.relay_signal INITIATE to retry.`,
        { state: 'ABORTED', abort_reason: status.abort_reason },
      );
    }

    // ── Dual-initiate collision detection ───────────────────────────
    // If both agents initiated simultaneously, each has their own session
    // but neither will join the other's. Detect this by peeking the inbox
    // for an incoming invite from the same counterparty. The agent with
    // the higher lexicographic agent_id yields and switches to RESPOND.
    if (transport && handle.counterparty && handle.agentId > handle.counterparty) {
      try {
        const inbox = await transport.peekInbox();
        const hasCounterpartyInvite = inbox.invites.some(
          (inv) => inv.from_agent_id === handle.counterparty,
        );
        if (hasCounterpartyInvite) {
          console.info(
            `phasePollRelay: dual-initiate detected for ${handle.agentId} ↔ ${handle.counterparty}. ` +
            `Yielding (${handle.agentId} > ${handle.counterparty}).`,
          );
          // Transition to RESPOND: create a new handle and route to DISCOVER
          const yieldIdempotencyKey = computeRelayIdempotencyKey(handle.agentId, [
            handle.counterparty,
            handle.purpose ?? '',
            'dual-initiate-yield',
          ]);
          const respondHandle = createRelayHandle({
            agentId: handle.agentId,
            role: 'RESPONDER',
            phase: 'DISCOVER',
            counterparty: handle.counterparty,
            idempotencyKey: yieldIdempotencyKey,
            timeoutMs: HANDLE_TTL_MS,
          });
          respondHandle.expectedPurpose = handle.purpose;
          respondHandle.myInput = handle.myInput;
          respondHandle.contractHash = handle.contractHash;
          respondHandle.expectedContractHash = handle.expectedContractHash ?? handle.contractHash;
          // Mark old handle as abandoned
          handle.phase = 'FAILED';
          return await phaseDiscover(respondHandle, transport);
        }
      } catch (peekErr) {
        // Non-fatal — continue polling normally
        console.warn(
          `phasePollRelay: inbox peek failed during collision check: ${peekErr instanceof Error ? peekErr.message : String(peekErr)}`,
        );
      }
    }

    // Budget exhausted?
    if (Date.now() >= pollDeadline) break;
  }

  // Budget exhausted — return DEFERRED for heartbeat retry
  return awaitingResponse(handle, 'Relay processing. Waiting for session to complete.', {
    strategy: 'DEFERRED',
    seconds: 30,
  });
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

  const params = handle.retryState as LegacyProposeRetryState | DirectProposeRetryState;

  try {
    if (params.retryKind === 'legacy') {
      await transport.sendPropose(params);
      handle.phase = 'POLL_RELAY';
      handle.retryState = undefined;
      return awaitingResponse(
        handle,
        'Invite delivered. Waiting for counterparty to join relay session.',
        { strategy: 'IMMEDIATE', seconds: 5 },
      );
    }

    const response = await transport.sendPropose(params.proposeParams);
    const preferredProfile =
      params.proposeParams.propose.acceptable_model_profiles?.[0] ??
      (params.proposeParams.propose.model_profile_hash
        ? {
            id: params.proposeParams.propose.model_profile_id,
            version: params.proposeParams.propose.model_profile_version,
            hash: params.proposeParams.propose.model_profile_hash,
          }
        : undefined);
    const selectedProfile = response?.selectedModelProfile ?? preferredProfile;
    const finalContract = bindSelectedProfile(params.contract, selectedProfile);
    await createCommittedDirectSession({
      handle,
      transport,
      relayUrl: params.relayUrl,
      contract: finalContract,
      myInput: handle.myInput ?? '',
      proposalId: params.proposeParams.propose.proposal_id,
      purposeHint: params.purposeHint,
    });
  } catch (err) {
    if (isRetryableTransportError(err)) {
      return awaitingResponse(handle, 'Counterparty still not reachable. Will keep trying.', {
        strategy: 'DEFERRED',
        seconds: 60,
      });
    }
    // Non-retryable error (e.g. DENY response) — fail
    const detail = err instanceof Error ? err.message : String(err);
    return failedResponse(handle, 'SESSION_ERROR', detail);
  }

  handle.phase = 'POLL_RELAY';
  handle.retryState = undefined;
  return awaitingResponse(
    handle,
    'Counterparty admitted the invite. Waiting for relay session to complete.',
    { strategy: 'IMMEDIATE', seconds: 5 },
  );
}

// ── RESPOND Phases ──────────────────────────────────────────────────────

/**
 * DISCOVER phase (relay inbox RESPOND only).
 *
 * Bounded poll: checks inbox repeatedly for up to DISCOVER_POLL_BUDGET_MS
 * before returning DEFERRED. Covers the typical case where the counterparty
 * invite arrives within seconds (Claude Code reactive sessions), while
 * remaining compatible with OpenClaw heartbeat-driven retries.
 */
async function phaseDiscover(
  handle: RelayHandle,
  transport: AfalTransport,
): Promise<ToolResponse<RelaySignalOutput>> {
  const pollDeadline = Math.min(
    Date.now() + _discoverPollBudgetMs,
    handle.timeoutDeadline,
  );
  let isFirstCheck = true;

  while (true) {
    // Check overall timeout
    if (Date.now() > handle.timeoutDeadline) {
      return failedResponse(
        handle,
        'RELAY_TIMEOUT',
        'Timed out waiting for relay invite. Ask the initiator to retry.',
      );
    }

    // Sleep between polls (not before the first check)
    if (!isFirstCheck) {
      await new Promise(resolve => setTimeout(resolve, _discoverPollIntervalMs));
    }
    isFirstCheck = false;

    const response = await transport.peekInbox();
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
      // Relay inbox invites require RelayInboxTransport to accept
      if (isRelayInbox && !(transport instanceof RelayInboxTransport)) continue;
      // If handle already has a bound inviteId, only match that
      if (handle.inviteId && invite.invite_id !== handle.inviteId) continue;

      // For legacy invites, require session tokens in payload.
      // For relay inbox invites, tokens come from acceptInvite later.
      if (!isRelayInbox) {
        const payload = invite.payload;
        if (!payload || typeof payload !== 'object') continue;
        if (
          !payload['session_id'] ||
          !payload['responder_submit_token'] ||
          !payload['responder_read_token'] ||
          !payload['relay_url']
        )
          continue;
      }

      // Check expected_contract_hash if provided (direct hash comparison)
      if (handle.expectedContractHash && invite.contract_hash !== handle.expectedContractHash) {
        foundSenderInviteWithContractMismatch = true;
        continue;
      }

      // AFAL-enriched path: validate purpose_code from parsed AfalPropose
      if (
        invite.afalPropose?.purpose_code &&
        handle.expectedPurpose &&
        !handle.expectedContractHash
      ) {
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

      // ── Structured confirmation: fetch full contract from invite detail ──
      // For relay inbox invites, fetch the invite detail to get the full
      // proposed contract (contract_json). The responder confirms or rejects
      // this exact contract rather than rebuilding one locally from purpose.
      if (isRelayInbox && transport instanceof RelayInboxTransport) {
        let detail;
        try {
          detail = await transport.getInviteDetail(invite.invite_id);
        } catch (err) {
          console.error(
            `phaseDiscover: failed to fetch invite detail for ${invite.invite_id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }

        // Validate: contract_json must be present
        if (!detail.contract_json || typeof detail.contract_json !== 'object') {
          console.error(
            `phaseDiscover: invite ${invite.invite_id} missing contract_json — cannot confirm`,
          );
          foundSenderInviteWithContractMismatch = true;
          continue;
        }

        // Validate: contract_json must hash to the advertised contract_hash
        const computedHash = computeRelayContractHash(detail.contract_json);
        if (computedHash !== detail.contract_hash) {
          console.error(
            `phaseDiscover: invite ${invite.invite_id} contract_json hash mismatch: ` +
              `computed=${computedHash} advertised=${detail.contract_hash}`,
          );
          foundSenderInviteWithContractMismatch = true;
          continue;
        }

        // Validate: participant list must be exactly [initiator, responder]
        // Exact shape check — rejects duplicates, wrong ordering, extra entries.
        const participants: unknown[] = Array.isArray(detail.contract_json.participants)
          ? detail.contract_json.participants
          : [];
        const expectedParticipants = [handle.counterparty, handle.agentId];
        if (
          participants.length !== 2 ||
          participants[0] !== expectedParticipants[0] ||
          participants[1] !== expectedParticipants[1]
        ) {
          console.error(
            `phaseDiscover: invite ${invite.invite_id} participant mismatch: ` +
              `expected=[${expectedParticipants}] got=[${participants}]`,
          );
          foundSenderInviteWithContractMismatch = true;
          continue;
        }

        // Validate: purpose compatibility (if caller supplied expected_purpose)
        if (handle.expectedPurpose) {
          const contractPurpose = detail.contract_json.purpose_code;
          if (typeof contractPurpose === 'string' && contractPurpose !== handle.expectedPurpose) {
            foundSenderInviteWithContractMismatch = true;
            continue;
          }
        }

        // Bind confirmed contract to handle
        handle.inviteId = invite.invite_id;
        handle.contractHash = detail.contract_hash;
        handle.contract = detail.contract_json;
        handle.proposalId = invite.afalPropose?.proposal_id;
        handle.relayUrl = handle.relayUrl ?? transport.relayUrl;
      } else {
        // Legacy path: extract session tokens from invite payload.
        // (payload was validated by the filter above — this guard is defensive)
        handle.inviteId = invite.invite_id;
        handle.contractHash = invite.contract_hash;
        handle.proposalId = invite.afalPropose?.proposal_id;

        const payload = invite.payload;
        if (!payload || typeof payload !== 'object' || !isRelayInvitePayload(payload)) continue;
        handle.sessionId = payload.session_id;
        handle.relayUrl = handle.relayUrl ?? payload.relay_url;
        handle.tokens = {
          submit: payload.responder_submit_token,
          read: payload.responder_read_token,
        };
      }

      handle.phase = 'JOIN';
      return awaitingResponse(handle, 'Relay invite found. Joining session.', {
        strategy: 'IMMEDIATE',
        seconds: 0,
      });
    }

    // If sender sent invites but all failed contract matching, fail fast.
    // Transition handle to FAILED to prevent stale handle leak.
    if (foundSenderInviteWithContractMismatch) {
      return failedResponse(
        handle,
        'CONTRACT_MISMATCH',
        'Invite contract does not match expected contract.',
      );
    }

    // No invite found yet — check if we should keep polling
    if (Date.now() + _discoverPollIntervalMs > pollDeadline) {
      break;
    }
  }

  // Poll budget exhausted — return DEFERRED for heartbeat or agent retry
  return awaitingResponse(handle, 'No invite yet. Waiting for relay invite from counterparty.', {
    strategy: 'DEFERRED',
    seconds: 30,
  });
}

async function phaseJoin(
  handle: RelayHandle,
  transport: AfalTransport,
): Promise<ToolResponse<RelaySignalOutput>> {
  // Check overall timeout
  if (Date.now() > handle.timeoutDeadline) {
    return failedResponse(
      handle,
      'RELAY_TIMEOUT',
      'Relay session timed out. Ask the initiator to retry.',
    );
  }

  if (!handle.relayUrl) {
    return failedResponse(handle, 'SESSION_ERROR', 'Missing relayUrl in JOIN phase.');
  }
  if (!handle.inviteId) {
    return failedResponse(handle, 'SESSION_ERROR', 'Missing inviteId in JOIN phase.');
  }

  const config = { relay_url: handle.relayUrl };

  // Submit input if not yet done (uses stored myInput from handle, not args)
  if (!handle.submitted) {
    // For relay inbox: accept invite FIRST to get session tokens.
    // For legacy transports: tokens are already in handle from phaseDiscover.
    if (!handle.sessionId || !handle.tokens) {
      // No session tokens yet — must be relay inbox path. Accept to get them.
      const result = await transport.acceptInvite(
        handle.inviteId,
        handle.expectedContractHash ?? handle.contractHash,
      );
      if (isAcceptResult(result)) {
        handle.sessionId = result.session_id;
        handle.tokens = {
          submit: result.submit_token,
          read: result.read_token,
        };
      } else {
        return failedResponse(
          handle,
          'SESSION_ERROR',
          'acceptInvite did not return session tokens.',
        );
      }
    }

    try {
      await rawSubmitInput(
        config,
        handle.sessionId!,
        handle.tokens!.submit,
        'responder',
        handle.myInput ?? '',
        handle.contractHash,
      );
    } catch (submitErr) {
      const msg = submitErr instanceof Error ? submitErr.message : String(submitErr);
      // 401/UNAUTHORIZED means the session is stale (already submitted or aborted).
      // Fail gracefully so the FSM can retry with a fresh invite.
      // Match the RelayHttpError format ("Relay HTTP 401: ...") to avoid false positives
      // from unrelated strings that happen to contain "401" (e.g., "returned 4013 bytes").
      const is401 = msg.includes('Relay HTTP 401') || msg.includes('401 Unauthorized') || msg.includes('Unauthorized');
      if (is401) {
        return failedResponse(
          handle,
          'SESSION_ERROR',
          `Submit rejected (session may be stale): ${msg}. Will look for a new invite.`,
        );
      }
      throw submitErr;
    }
    handle.submitted = true;

    writeLastSessionFile(handle.sessionId!, 'RESPONDER', handle.tokens!.read, handle.relayUrl);

    // Accept the orchestrator invite after successful submit (legacy transports only).
    // For relay inbox, accept was already called above.
    if (handle.tokens && !(transport instanceof RelayInboxTransport)) {
      try {
        await transport.acceptInvite(handle.inviteId);
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

  // Guard against corrupted resume token missing session data
  if (!handle.sessionId || !handle.tokens?.read) {
    return failedResponse(handle, 'SESSION_ERROR', 'Missing session data for JOIN poll phase.');
  }

  // Bounded polling loop — poll relay status until completion, abort, or budget exhausted.
  const pollDeadline = Math.min(Date.now() + _relayPollBudgetMs, handle.timeoutDeadline);
  let isFirstJoinCheck = true;

  while (true) {
    // Sleep between polls (not before the first check)
    if (!isFirstJoinCheck) {
      if (Date.now() + _relayPollIntervalMs > pollDeadline) break;
      await new Promise(resolve => setTimeout(resolve, _relayPollIntervalMs));
    }
    isFirstJoinCheck = false;

    let status;
    try {
      status = await httpGetStatus(config, handle.sessionId, handle.tokens.read);
    } catch (err) {
      console.warn(
        `phaseJoin: transient status check failed for session ${handle.sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      if (Date.now() >= pollDeadline) break;
      continue; // transient — retry within budget
    }

    if (status.state === 'COMPLETED') {
      try {
        const output = await httpGetOutput(config, handle.sessionId, handle.tokens.read);
        return completedResponse(handle, output);
      } catch (fetchErr) {
        console.error(
          `phaseJoin: session ${handle.sessionId} COMPLETED but output fetch failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
        );
        // Transient fetch failure — continue polling within budget
      }
    }

    if (status.state === 'ABORTED') {
      const reason = status.abort_reason ?? 'UNKNOWN';
      const desc = ABORT_DESCRIPTIONS[reason] ?? 'The relay session was aborted.';
      return failedResponse(
        handle,
        `RELAY_${reason}`,
        `Session aborted: ${desc} Waiting for the initiator to retry — call agentvault.relay_signal RESPOND again.`,
        { state: 'ABORTED', abort_reason: status.abort_reason },
      );
    }

    // Budget exhausted?
    if (Date.now() >= pollDeadline) break;
  }

  // Budget exhausted — return DEFERRED for heartbeat retry
  return awaitingResponse(handle, 'Waiting for relay session to complete.', {
    strategy: 'DEFERRED',
    seconds: 30,
  });
}

// ── Legacy Modes (unchanged) ────────────────────────────────────────────

async function handleCreate(args: RelaySignalArgs): Promise<ToolResponse<RelaySignalCreateData>> {
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

async function handleJoin(args: RelaySignalArgs): Promise<ToolResponse<RelaySignalJoinData>> {
  if (!args.session_id) return buildError('INVALID_INPUT', 'session_id is required for JOIN mode');
  if (!args.submit_token)
    return buildError('INVALID_INPUT', 'submit_token is required for JOIN mode');
  if (!args.read_token) return buildError('INVALID_INPUT', 'read_token is required for JOIN mode');
  if (!args.contract_hash)
    return buildError('INVALID_INPUT', 'contract_hash is required for JOIN mode');

  const relayUrl = resolveRelayUrl(args.relay_url);
  const config = { relay_url: relayUrl };

  const output = await joinAndWait(
    config,
    args.session_id,
    args.submit_token,
    args.read_token,
    args.contract_hash,
    args.my_input ?? '',
    'responder',
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
  const keys = Object.keys(args).filter((k) => k !== 'resume_token');
  return keys.length > 0;
}

export async function handleRelaySignal(
  args: RelaySignalArgs,
  transport?: AfalTransport,
  knownAgents: NormalizedKnownAgent[] = [],
  relayProfileId?: string,
): Promise<ToolResponse<RelaySignalData>> {
  try {
    // Prune expired handles on every call
    pruneRelayHandles();

    // ── Resume path ─────────────────────────────────────────────────
    if (args.resume_token) {
      const resumeToken: string = args.resume_token;
      // Budget models often include mode/counterparty alongside resume_token.
      // Instead of rejecting, strip extra args and proceed — the resume_token
      // carries all the state needed.
      if (hasExtraArgs(args)) {
        const extra = Object.keys(args).filter((k) => k !== 'resume_token');
        console.info(`relay_signal resume: ignoring extra args [${extra.join(', ')}] alongside resume_token`);
        args = { resume_token: resumeToken } as typeof args;
      }

      const agentId = transport?.agentId ?? process.env['AV_AGENT_ID'] ?? '';
      const handle = decodeRelayToken(resumeToken, agentId, getResumeTokenSecret());
      if (!handle) {
        return buildError(
          'INVALID_INPUT',
          'Invalid or expired resume_token. Start a new relay_signal call.',
        );
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
          return await phasePollRelay(handle, transport);
        case 'DISCOVER':
          return await phaseDiscover(handle, transport);
        case 'JOIN':
          return await phaseJoin(handle, transport);
        case 'COMPLETED':
          // Session already finished — return success instead of error so
          // the LLM doesn't waste a round-trip processing an error.
          return buildSuccess('COMPLETE', {
            mode: handle.role === 'INITIATOR' ? 'INITIATE' : 'RESPOND',
            state: 'COMPLETED',
            phase: 'COMPLETED',
            resume_token: null,
            resume_token_display: null,
            session_id: handle.sessionId,
            action_required: 'NONE',
            next_tool: null,
            next_args_patch: null,
            next_update_seconds: null,
            user_message: 'Session already complete. No further action needed.',
            display: {
              forbidden: ['PRINT_RESUME_TOKEN'],
              redact: ['resume_token'],
            },
          });
        case 'ABORTED':
        case 'FAILED':
          return buildError(
            'INVALID_INPUT',
            `Handle is in terminal state: ${handle.phase}. Start a new call.`,
          );
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
          return buildError(
            'SESSION_ERROR',
            'INITIATE mode requires AfalTransport (agent mode only)',
          );
        }
        if (!args.counterparty) {
          return buildError('INVALID_INPUT', 'counterparty is required for INITIATE mode');
        }

        const counterparty = resolveAgentAlias(args.counterparty, knownAgents);
        const agentId = transport.agentId ?? process.env['AV_AGENT_ID'] ?? '';

        // Compute contract hash early — needed for both collision path and idempotency key
        let contractHashForKey: string;
        if (args.contract) {
          contractHashForKey = createHash('sha256')
            .update(JSON.stringify(args.contract))
            .digest('hex');
        } else if (args.purpose) {
          const built = buildRelayContract(args.purpose, [agentId, counterparty], relayProfileId);
          contractHashForKey = built ? computeRelayContractHash(built) : args.purpose;
        } else {
          contractHashForKey = '';
        }

        // ── Pre-INITIATE collision detection ─────────────────────────
        // If the counterparty already sent us an invite, join their session
        // instead of creating a redundant one. The agent with the later
        // INITIATE call becomes the de-facto RESPONDER.
        const pendingInbox = await transport.peekInbox();
        const existingInvite = pendingInbox.invites.find(
          (inv) => inv.from_agent_id === counterparty,
        );
        if (existingInvite) {
          console.info(
            `relay_signal INITIATE: ${agentId} found existing invite from ${counterparty} — ` +
              `redirecting to RESPOND (auto-collision-resolve).`,
          );
          const respondIdempotencyKey = computeRelayIdempotencyKey(agentId, [
            counterparty,
            hashInput(args.my_input ?? ''),
            'auto-respond',
          ]);
          const respondHandle = createRelayHandle({
            agentId,
            role: 'RESPONDER',
            phase: 'DISCOVER',
            counterparty,
            idempotencyKey: respondIdempotencyKey,
            timeoutMs: HANDLE_TTL_MS,
          });
          respondHandle.expectedPurpose = args.purpose;
          respondHandle.myInput = args.my_input;
          // Do not bind collision redirects to a locally precomputed contract hash.
          // On the direct AFAL path, pre-session negotiation can legitimately pick a
          // different final contract/model profile than the caller's default build.
          return await phaseDiscover(respondHandle, transport);
        }

        // Compute idempotency key
        const inputHash = hashInput(args.my_input ?? '');
        const idempotencyKey = computeRelayIdempotencyKey(agentId, [
          contractHashForKey,
          counterparty,
          inputHash,
        ]);

        // Check for existing handle
        const existing = findExistingRelayHandle(agentId, 'INITIATOR', idempotencyKey);
        if (existing) {
          // Reattach — route to current phase
          if (existing.phase === 'PROPOSE_RETRY')
            return await phaseRetryPropose(existing, transport);
          if (existing.phase === 'POLL_INVITE') return await phasePollInvite(existing, transport);
          if (existing.phase === 'POLL_RELAY') return await phasePollRelay(existing, transport);
          return awaitingResponse(existing, 'Reattached to existing relay session.');
        }

        // Create new handle
        const handle = createRelayHandle({
          agentId,
          role: 'INITIATOR',
          phase: 'INVITE',
          counterparty,
          idempotencyKey,
          timeoutMs: HANDLE_TTL_MS,
        });

        return await phaseInvite(handle, args, transport, knownAgents, relayProfileId);
      }

      case 'RESPOND': {
        if (!transport) {
          return buildError(
            'SESSION_ERROR',
            'RESPOND mode requires AfalTransport (agent mode only)',
          );
        }

        // Auto-infer missing params from inbox when there's exactly one
        // pending invite. Saves 1-2 LLM round-trips discovering required
        // parameters (from, expected_purpose).
        if (!args.from || (!args.expected_purpose && !args.expected_contract_hash)) {
          try {
            const inbox = await transport.peekInbox();
            if (inbox.invites.length === 1) {
              const invite = inbox.invites[0];
              if (!args.from && invite.from_agent_id) {
                args.from = invite.from_agent_id;
              }
              if (!args.expected_purpose && !args.expected_contract_hash && invite.afalPropose?.purpose_code) {
                args.expected_purpose = invite.afalPropose.purpose_code;
              }
            }
          } catch {
            // Non-fatal — fall through to manual validation below
          }
        }

        if (!args.from) {
          const knownNames = knownAgents.map(a => a.agent_id).join(', ');
          return buildError(
            'INVALID_INPUT',
            `from is required for RESPOND mode — set it to the agent_id of the sender. ` +
            `Your known agents: ${knownNames || 'none'}`,
          );
        }

        const from = resolveAgentAlias(args.from, knownAgents);
        const agentId = transport.agentId ?? process.env['AV_AGENT_ID'] ?? '';

        // Compute idempotency key
        const inputHash = hashInput(args.my_input ?? '');
        const purposeOrHash = args.expected_purpose ?? args.expected_contract_hash ?? '';
        const idempotencyKey = computeRelayIdempotencyKey(agentId, [
          from,
          purposeOrHash,
          inputHash,
        ]);

        // Check for existing handle
        const existing = findExistingRelayHandle(agentId, 'RESPONDER', idempotencyKey);
        if (existing) {
          if (existing.phase === 'DISCOVER') return await phaseDiscover(existing, transport);
          if (existing.phase === 'JOIN') return await phaseJoin(existing, transport);
          return awaitingResponse(existing, 'Reattached to existing relay session.');
        }

        // Validate that we have expected_purpose or expected_contract_hash
        if (!args.expected_purpose && !args.expected_contract_hash) {
          return buildError(
            'INVALID_INPUT',
            'RESPOND requires expected_purpose or expected_contract_hash.',
          );
        }

        // Validate expected_purpose is a known purpose code
        if (args.expected_purpose) {
          const knownPurposes = listRelayPurposes();
          if (!knownPurposes.includes(args.expected_purpose)) {
            return buildError(
              'INVALID_INPUT',
              `Unknown purpose "${args.expected_purpose}". Available: ${knownPurposes.join(', ')}`,
            );
          }
        }

        // Create new handle — store args for use on resume calls
        const handle = createRelayHandle({
          agentId,
          role: 'RESPONDER',
          phase: 'DISCOVER',
          counterparty: from,
          idempotencyKey,
          timeoutMs: HANDLE_TTL_MS,
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
      const workdir = process.env['AV_WORKDIR'] ?? process.cwd();
      const debugDir = path.join(workdir, '.agentvault');
      fs.mkdirSync(debugDir, { recursive: true });
      const entry = `[${new Date().toISOString()}] error_code=${code} detail=${detail} raw=${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
      fs.appendFileSync(path.join(debugDir, 'relay-debug.log'), entry, 'utf8');
    } catch (logErr) {
      console.error(
        `handleRelaySignal: failed to write diagnostic log: ${logErr instanceof Error ? logErr.message : String(logErr)}`,
      );
    }
    return buildError(code, detail);
  }
}
