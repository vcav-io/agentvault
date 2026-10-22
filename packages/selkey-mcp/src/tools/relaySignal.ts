/**
 * selkey.relay_signal — Least-trust relay session tool (Selkey).
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
import { labelUntrustedContent, relaySignalUntrustedPaths } from '../untrusted-content.js';
import { createAndSubmit, pollUntilDone, joinAndWait } from 'selkey';
import { generateCommitmentNonce } from 'selkey/commitment';
import {
  submitInput as rawSubmitInput,
  getStatus as httpGetStatus,
  getOutput as httpGetOutput,
} from 'selkey/http';
import type { SessionOutputResponse } from 'selkey';
import {
  buildRelayContract,
  listRelayPurposes,
  computeRelayContractHash,
  withRelayContractModelProfile,
  type RelayContract,
} from 'selkey/contracts';
import type { AfalTransport, AfalInviteMessage } from '../afal-transport.js';
import { PURPOSE_TO_TEMPLATE, isAcceptResult } from '../afal-transport.js';
import { RelayInboxTransport, RELAY_INBOX_PAYLOAD_TYPE } from '../relay-inbox-transport.js';
import { computeProposalId, generateNonce } from '../afal-types.js';
import type { AfalPropose, RelayInvitePayload, RelaySessionBinding } from '../afal-types.js';
import { CommitRejectedError, DirectAfalTransport } from '../direct-afal-transport.js';
import { COMMIT_ERROR_UNKNOWN_ADMIT } from '../afal-responder.js';
import { listKnownModelProfiles, resolveModelProfileRefs, type ModelProfileRef } from '../model-profiles.js';
import {
  purposeToContractOfferIds,
  listSupportedContractOffers,
} from '../contract-offers.js';
import type { ContractOfferProposal } from '../contract-negotiation.js';
import type { TopicAlignmentProposal } from '../topic-alignment.js';
import {
  compileResolvedAgreement,
  mapResolvedAgreementToNegotiatedContract,
  resolvedAgreementFromBespoke,
  resolvedAgreementFromOffer,
  type ResolvedAgreement,
} from '../resolved-agreement.js';
import {
  assertRelayTrusted,
  checkReceiptAgainstPinnedKey,
  expectedRelayKeyVariants,
  type LocalSessionData,
  isRelayKeyPinned,
  isRelayUrlAllowed,
  normalizeRelayUrl,
  resolveLocalRelayUrl,
  RelayTrustError,
  withPinnedRelayKey,
  requireRelayKeyPin,
  assertContractCarriesRelayPin,
  relayClientConfig,
  isDevEnvironment,
} from '../relay-trust.js';
import { buildExpectedContractHashes, localAllowedPurposes } from '../responder-contracts.js';
import { chargeOwnDisclosure, EntropyLedgerError } from '../entropy-ledger.js';
import { isRetryableTransportError, relayHttpStatus } from '../transport-errors.js';
import { appendPrivateLine, ensurePrivateDir, selkeyStateDir, writePrivateJson } from '../secure-fs.js';
import { PinError, normalizeAgentId, resolveAgentHint } from '../pin-store.js';
import { recordHeldReceipt } from '../held-receipts.js';
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
  public_key_hex?: string;
  a2a_send_message_url?: string;
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
  /**
   * Set once the relay session exists and this agent's input is submitted:
   * a retry re-sends the COMMIT for this session and never creates another.
   */
  committedSession?: RelaySessionBinding;
}

// ── Types ───────────────────────────────────────────────────────────────

export interface RelaySignalArgs {
  mode?: 'CREATE' | 'JOIN' | 'INITIATE' | 'RESPOND';
  resume_token?: string;

  // INITIATE mode
  counterparty?: string;
  purpose?: string;
  acceptable_purposes?: string[];
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
  purpose_override?: {
    requested_purpose: string;
    adopted_purpose: string;
  };
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

function parseAcceptablePurposes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const knownPurposes = new Set(listRelayPurposes());
  const parsed: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !knownPurposes.has(item) || parsed.includes(item)) continue;
    parsed.push(item);
  }
  return parsed;
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
        receiptClaim(sessionId),
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
        receiptClaim(sessionId),
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
        receiptClaim(sessionId),
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

function receiptClaim(sessionId: string | null): string {
  return isRelayKeyPinned()
    ? `This session's receipt verified against the pinned relay key (session_id=${sessionId ?? 'n/a'}).`
    : `This session has a relay-signed receipt, not verified: no relay key pinned (session_id=${sessionId ?? 'n/a'}).`;
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

function resolveRelayUrl(argsUrl?: string): string {
  // Only locally configured relays: never fall back to a peer-advertised relay.
  return resolveLocalRelayUrl(argsUrl);
}

/** Relay URL from this agent's own transport configuration. */
function transportLocalRelayUrl(transport: AfalTransport | undefined): string | undefined {
  if (transport instanceof RelayInboxTransport) return transport.relayUrl;
  if (transport instanceof DirectAfalTransport) return transport.localRelayUrl;
  return undefined;
}

/** Purposes this responder accepts, from the caller's expected_purpose or local config. */
function responderAcceptablePurposes(handle: RelayHandle, transport: AfalTransport): string[] {
  if (handle.expectedPurpose) return [handle.expectedPurpose];
  const purposes = new Set<string>(
    transport instanceof DirectAfalTransport && transport.respondPurposeCodes
      ? transport.respondPurposeCodes
      : localAllowedPurposes(),
  );
  if (handle.preferredPurpose) purposes.add(handle.preferredPurpose);
  return [...purposes];
}

function mapRelayError(error: unknown): { code: ErrorCode; detail: string } {
  if (error instanceof PinError) {
    const code: ErrorCode =
      error.code === 'NEEDS_CONFIRMATION'
        ? 'NEEDS_CONFIRMATION'
        : error.code === 'AMBIGUOUS_ALIAS'
          ? 'INVALID_INPUT'
          : 'PEER_IDENTITY_MISMATCH';
    return { code, detail: error.message };
  }
  if (error instanceof EntropyLedgerError) {
    return { code: error.code, detail: error.message };
  }
  if (error instanceof RelayTrustError) {
    return {
      code: error.message.startsWith('relay_url') ? 'INVALID_INPUT' : 'PRECONDITION_FAILED',
      detail: error.message,
    };
  }
  if (error instanceof Error) {
    const msg = error.message;
    const relayStatus = relayHttpStatus(error);
    if (relayStatus !== undefined && relayStatus >= 400 && relayStatus < 500) {
      return { code: 'INVALID_INPUT', detail: msg };
    }
    // Classified by error type and status code, never by message text.
    if (isRetryableTransportError(error)) {
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
    const finalPath = path.join(selkeyStateDir(), 'last_session.json');
    const record = {
      session_id: sessionId,
      role,
      read_token: readToken,
      relay_url: relayUrl,
      timestamp: new Date().toISOString(),
    };
    writePrivateJson(finalPath, record);
  } catch (err) {
    // Non-fatal — log but do not fail the relay operation
    console.error(
      `writeLastSessionFile: failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve an agent_id or alias to an agent_id (exact NFC match, no case
 * folding). Aliases come from known agents and from the transport's pin
 * store. An alias naming more than one agent throws AMBIGUOUS_ALIAS.
 */
function resolveAgentAlias(
  hint: string,
  knownAgents: NormalizedKnownAgent[],
  transport?: AfalTransport,
): string {
  const pinned = transport instanceof DirectAfalTransport ? transport.pinStore.listPins() : [];
  return resolveAgentHint(hint, [...knownAgents, ...pinned]) ?? normalizeAgentId(hint);
}

/**
 * Charge this agent's disclosure for a session against the owner-side budget
 * ledger before its input is submitted (fail closed). The counterparty is
 * taken from the local contract's participants, falling back to the
 * locally resolved counterparty id.
 */
function chargeSessionDisclosure(params: {
  key: string;
  contract: unknown;
  selfId: string | undefined;
  fallbackCounterparty?: string;
  purpose?: string;
}): void {
  const participants =
    params.contract && typeof params.contract === 'object'
      ? (params.contract as Record<string, unknown>)['participants']
      : undefined;
  let counterparty: string | undefined;
  if (Array.isArray(participants) && params.selfId && participants.includes(params.selfId)) {
    const others = participants.filter((p): p is string => typeof p === 'string' && p !== params.selfId);
    if (others.length === 1) counterparty = others[0];
  }
  counterparty = counterparty ?? params.fallbackCounterparty;
  chargeOwnDisclosure({
    key: params.key,
    contract: params.contract,
    counterparty,
    purpose: params.purpose,
  });
}

function hashInput(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Charge key for one relay session this agent submits input to. Sessions
 * not yet created get a fresh key per creation attempt, so every new
 * session is charged.
 */
function newSessionChargeKey(handle: RelayHandle): string {
  return `${handle.id}:new:${randomUUID()}`;
}

function getResumeTokenSecret(): string | null {
  return process.env['SELKEY_RESUME_TOKEN_SECRET'] ?? null;
}

// ── Session State Files ─────────────────────────────────────────────────

function resolveWorkdir(): string {
  const dir = process.env['SELKEY_WORKDIR'] ?? process.cwd();
  if (!process.env['SELKEY_WORKDIR']) {
    console.warn(
      `[SELKEY WARNING] SELKEY_WORKDIR not set — writing session state to ${dir}. ` +
        'The heartbeat agent may not find these files. Set SELKEY_WORKDIR to your workspace directory.',
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
  // Parent directory 0700; file 0600 via an O_EXCL temp file + rename.
  writePrivateJson(filePath, data);
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
    const sessionsDir = path.join(workdir, '.selkey', 'sessions');
    const indexPath = path.join(workdir, '.selkey', 'active_sessions.json');
    ensurePrivateDir(path.join(workdir, '.selkey'));

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
    const sessionsDir = path.join(workdir, '.selkey', 'sessions');
    const indexPath = path.join(workdir, '.selkey', 'active_sessions.json');
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
  return mapResolvedAgreementToNegotiatedContract(handle.resolvedAgreement);
}

function mapAlignedTopicCode(handle: RelayHandle): string | undefined {
  return handle.alignedTopicCode;
}

function mapPurposeOverride(
  handle: RelayHandle,
): RelaySignalOutput['purpose_override'] | undefined {
  if (!handle.purposeOverride) return undefined;
  return {
    requested_purpose: handle.purposeOverride.requestedPurpose,
    adopted_purpose: handle.purposeOverride.adoptedPurpose,
  };
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
    next_tool: 'selkey.relay_signal',
    next_args_patch: { resume_token: token },
    next_update_seconds: seconds,
    resume_strategy: strategy,
    user_message: userMessage,
    aligned_topic_code: mapAlignedTopicCode(handle),
    purpose_override: mapPurposeOverride(handle),
    negotiated_contract: mapNegotiatedContract(handle),
    display: {
      forbidden: ['PRINT_RESUME_TOKEN', 'CLAIM_COUNTERPARTY_KNOWLEDGE'],
      redact: ['resume_token'],
    },
  });
}

/**
 * Commitment nonce for one submission.
 *
 * A retry of the same submission (same session and exactly the same
 * context) reuses its nonce: after an ambiguous failure the first attempt
 * may already have reached the relay, which accepts one submission per
 * party, so the receipt commits under that nonce. Any other submission gets a
 * fresh nonce, stored with the matching context.
 */
function submissionNonce(handle: RelayHandle, sessionId: string, context: unknown): string {
  const prior = handle.inputCommitment;
  if (
    prior &&
    prior.sessionId === sessionId &&
    JSON.stringify(prior.context) === JSON.stringify(context)
  ) {
    return prior.nonce;
  }
  const nonce = generateCommitmentNonce();
  handle.inputCommitment = { sessionId, context, nonce };
  return nonce;
}

/** What this agent holds locally for checking the session receipt. */
function localSessionData(handle: RelayHandle): LocalSessionData {
  const sub = handle.inputCommitment;
  return {
    ownInput: sub
      ? { participantId: handle.agentId, context: sub.context, commitmentNonce: sub.nonce }
      : undefined,
    contract: handle.contract,
    // Completion is only reached after this agent submitted its input.
    submittedInput: true,
  };
}

/**
 * Remember the receipt of a session this agent completed, with the
 * counterparty from the local handle. IFC grants can only be issued for a
 * held receipt.
 */
function recordCompletedReceipt(
  handle: RelayHandle,
  localSessionId: string | undefined,
  output: SessionOutputResponse,
  verified: boolean,
): void {
  // Only the v3 receipt the session check covered; the session id comes from
  // this agent's own handle, never from the receipt.
  const receipt = output.receipt as Record<string, unknown> | null | undefined;
  if (!receipt || typeof receipt !== 'object' || typeof receipt['receipt_id'] !== 'string' || !localSessionId) {
    return;
  }
  try {
    recordHeldReceipt({
      agent_id: handle.agentId,
      receipt_id: receipt['receipt_id'],
      session_id: localSessionId,
      counterparty: handle.counterparty,
      role: handle.role,
      receipt_verified: verified,
      recorded_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      `recordCompletedReceipt: failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function completedResponse(
  handle: RelayHandle,
  output: SessionOutputResponse,
): ToolResponse<RelaySignalOutput> {
  const receiptCheck = checkReceiptAgainstPinnedKey(output, localSessionData(handle));
  if (receiptCheck.status === 'FAILED') {
    // Do not present output whose receipt fails the pinned-key check.
    return failedResponse(handle, 'RECEIPT_VERIFICATION_FAILED', receiptCheck.detail);
  }
  handle.phase = 'COMPLETED';
  const localSessionId = handle.sessionId;
  const effectiveSessionId = getEffectiveCompletedSessionId(handle, output);
  if (effectiveSessionId) {
    handle.sessionId = effectiveSessionId;
  }
  removeSessionStateFile(handle);
  recordCompletedReceipt(handle, localSessionId, output, receiptCheck.status === 'VERIFIED');
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
    purpose_override: mapPurposeOverride(handle),
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
    purpose_override: mapPurposeOverride(handle),
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

function tryAdoptPreferredPurpose(
  handle: RelayHandle,
  advertisedPurpose: string | undefined,
): ToolResponse<RelaySignalOutput> | null {
  if (!handle.preferredPurpose || !advertisedPurpose || advertisedPurpose === handle.preferredPurpose) {
    return null;
  }

  const knownPurposes = listRelayPurposes();
  if (!knownPurposes.includes(advertisedPurpose)) {
    return failedResponse(
      handle,
      'PURPOSE_MISMATCH',
      `Counterparty proposed unsupported purpose "${advertisedPurpose}".`,
    );
  }

  handle.purposeOverride = {
    requestedPurpose: handle.preferredPurpose,
    adoptedPurpose: advertisedPurpose,
  };
  handle.purpose = advertisedPurpose;
  return null;
}

/**
 * Pick the relay for a direct-AFAL session from the responder's ADMIT
 * relay_preference:
 * - REQUIRED: the responder's relay (it must still be locally trusted; the
 *   caller's assertRelayTrusted fails closed otherwise).
 * - PREFERRED: the responder's relay only when this agent has no relay of its
 *   own configured and the preferred relay is locally allowlisted; otherwise
 *   keep the locally resolved relay.
 * - Absent: the locally resolved relay.
 */
function arbitrateDirectSessionRelay(
  transport: AfalTransport,
  proposalId: string,
  localRelayUrl: string,
): string {
  const pref = transport.admittedRelayPreference?.(proposalId);
  if (!pref) return localRelayUrl;
  if (normalizeRelayUrl(pref.relay_url) === normalizeRelayUrl(localRelayUrl)) return localRelayUrl;
  if (pref.policy === 'REQUIRED') return pref.relay_url;
  const ownConfigured = transportLocalRelayUrl(transport);
  if (!ownConfigured && isRelayUrlAllowed(pref.relay_url)) return pref.relay_url;
  return localRelayUrl;
}

/**
 * Create the relay session and submit this agent's input (charged once per
 * session). Returns the binding to COMMIT; does not contact the peer.
 */
async function createDirectSession(params: {
  handle: RelayHandle;
  transport: AfalTransport;
  relayUrl: string;
  contract: object;
  myInput: string;
  proposalId: string;
  purposeHint?: string | null;
}): Promise<RelaySessionBinding> {
  // Arbitrate the relay BEFORE creating the session, so the session (and the
  // initiator's input) lives on the relay named in the COMMIT. The arbitrated
  // relay must still pass the local trust check below.
  params.relayUrl = arbitrateDirectSessionRelay(params.transport, params.proposalId, params.relayUrl);
  await assertRelayTrusted(params.relayUrl, [transportLocalRelayUrl(params.transport)]);
  chargeSessionDisclosure({
    key: newSessionChargeKey(params.handle),
    contract: params.contract,
    selfId: params.transport.agentId,
    fallbackCounterparty: params.handle.counterparty,
    purpose: params.purposeHint ?? undefined,
  });
  const config = relayClientConfig(params.relayUrl);
  const nonce = generateCommitmentNonce();
  const created = await createAndSubmit(config, params.contract, params.myInput, 'initiator', nonce);
  params.handle.inputCommitment = {
    sessionId: created.sessionId,
    context: params.myInput,
    nonce,
  };
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
  return relaySession;
}

/**
 * Create the session, then COMMIT it. A COMMIT that fails because the peer
 * was unreachable leaves the handle in PROPOSE_RETRY with the existing
 * session, so the retry re-sends the COMMIT only.
 */
async function createAndCommitDirectSession(
  params: Parameters<typeof createDirectSession>[0],
  retryBase: Omit<DirectProposeRetryState, 'committedSession'>,
): Promise<'COMMITTED' | 'COMMIT_PENDING'> {
  const relaySession = await createDirectSession(params);
  try {
    if (params.transport.commitAdmit) {
      await params.transport.commitAdmit(params.proposalId, relaySession);
    }
  } catch (err) {
    if (isRetryableTransportError(err)) {
      params.handle.retryState = { ...retryBase, committedSession: relaySession } satisfies DirectProposeRetryState;
      params.handle.phase = 'PROPOSE_RETRY';
      return 'COMMIT_PENDING';
    }
    throw err;
  }
  return 'COMMITTED';
}

// ── INITIATE Phases ─────────────────────────────────────────────────────

async function phaseInvite(
  handle: RelayHandle,
  args: RelaySignalArgs,
  transport: AfalTransport,
  knownAgents: NormalizedKnownAgent[],
  relayProfileId?: string,
): Promise<ToolResponse<RelaySignalOutput>> {
  const counterparty = resolveAgentAlias(handle.counterparty, knownAgents, transport);
  const acceptablePurposes = parseAcceptablePurposes(args.acceptable_purposes);
  if (args.purpose && acceptablePurposes.length) {
    return buildError(
      'INVALID_INPUT',
      'Provide either purpose or acceptable_purposes, not both.',
    );
  }
  if (acceptablePurposes.length > 0 && args.contract) {
    return buildError(
      'INVALID_INPUT',
      'acceptable_purposes cannot be combined with explicit contract JSON',
    );
  }

  // Resolve contract — use transport.agentId consistently as the identity source
  const agentId = transport.agentId;
  let contract: object | null = null;
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
  } else if (acceptablePurposes.length === 1) {
    const selectedPurpose = acceptablePurposes[0];
    let built;
    try {
      built = buildRelayContract(selectedPurpose, [agentId, counterparty], relayProfileId);
    } catch (e) {
      return buildError('INVALID_INPUT', (e as Error).message);
    }
    if (!built) {
      return buildError(
        'INVALID_INPUT',
        `Unknown purpose "${selectedPurpose}". Available: ${listRelayPurposes().join(', ')}`,
      );
    }
    contract = built;
    relayContract = built;
    purposeHint = selectedPurpose;
  } else if (acceptablePurposes.length > 1) {
    // Defer concrete contract binding until pre-contract negotiation selects an offer.
  } else {
    return buildError(
      'INVALID_INPUT',
      `INITIATE requires purpose (${listRelayPurposes().join(', ')}), acceptable_purposes, or contract`,
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
    if (!contract) {
      return buildError(
        'SESSION_ERROR',
        'acceptable_purposes with more than one purpose requires direct bilateral transport and pre-contract negotiation.',
      );
    }
    // Bind the contract to the pinned relay key (if configured), as on
    // every other INITIATE path.
    try {
      contract = withPinnedRelayKey(contract);
    } catch (e) {
      return buildError('INVALID_INPUT', (e as Error).message);
    }
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
  if (acceptablePurposes.length > 1 && !(transport instanceof DirectAfalTransport)) {
    return buildError(
      'SESSION_ERROR',
      'acceptable_purposes requires direct bilateral transport when more than one purpose is supplied.',
    );
  }
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

  let resolvedAgreement: ResolvedAgreement | null = null;
  if (transport instanceof DirectAfalTransport && !args.contract) {
    const negotiationCandidates: ContractOfferProposal['acceptable_offers'] = [];
    const preferredProfile = preferredModelProfileRef(relayContract);
    const defaultNegotiationProfiles = args.acceptable_model_profiles?.length
      ? resolveModelProfileRefs(args.acceptable_model_profiles)
      : preferredProfile
        ? [preferredProfile]
        : undefined;

    const negotiationPurposes = acceptablePurposes.length > 0
      ? acceptablePurposes
      : purposeHint
        ? [purposeHint]
        : [];

    if (negotiationPurposes.length > 1 && !peerDiscovery?.supportsPrecontractNegotiation) {
      return buildError(
        'SESSION_ERROR',
        'Counterparty does not advertise support for multi-purpose pre-contract negotiation.',
      );
    }

    if (negotiationPurposes.length && peerDiscovery?.supportsPrecontractNegotiation && peerDiscovery.supportedContractOffers?.length) {
      const offerIds = negotiationPurposes.flatMap((purpose) => purposeToContractOfferIds(purpose));
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
          resolvedAgreement = resolvedAgreementFromOffer({
            contractOfferId: selection.selected_contract_offer_id,
            selectedModelProfile: selection.selected_model_profile,
            topicCode: handle.alignedTopicCode,
          });
          contract = await compileResolvedAgreement({
            agreement: resolvedAgreement,
            participants: [agentId, counterparty],
          });
        } else if (selection.selected_bespoke_contract) {
          resolvedAgreement = resolvedAgreementFromBespoke({
            contract: selection.selected_bespoke_contract,
            selectedModelProfile: selection.selected_model_profile,
            topicCode: handle.alignedTopicCode,
          });
          contract = await compileResolvedAgreement({
            agreement: resolvedAgreement,
            participants: [agentId, counterparty],
          });
        }
        if (resolvedAgreement && contract) {
          handle.resolvedAgreement = resolvedAgreement;
          relayContract = contract as RelayContract;
          purposeHint = relayContract.purpose_code;
        }
      }
    } else if (acceptablePurposes.length > 1) {
      return buildError(
        'SESSION_ERROR',
        'No negotiated contract offers were available for the supplied acceptable_purposes.',
      );
    }
  }

  if (!contract) {
    return buildError(
      'SESSION_ERROR',
      'No concrete contract could be resolved from the supplied acceptable_purposes.',
    );
  }

  // Bind the contract to the pinned relay key (if configured) so the relay
  // refuses the session when its signing key differs.
  try {
    contract = withPinnedRelayKey(contract);
  } catch (e) {
    return buildError('INVALID_INPUT', (e as Error).message);
  }

  const relayUrl = resolveRelayUrl(args.relay_url);
  // 1. Build AfalPropose from purpose and contract template.
  const templateId = purposeHint
    ? (PURPOSE_TO_TEMPLATE[purposeHint] ?? 'mediation-demo.v1.standard')
    : 'mediation-demo.v1.standard';
  const preferredProfile =
    resolvedAgreement?.selected_model_profile ??
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
    ...(!resolvedAgreement && negotiatedProfiles
      ? { acceptable_model_profiles: negotiatedProfiles }
      : {}),
  };

  const proposalId = computeProposalId(proposeFields);
  const propose: AfalPropose = { ...proposeFields, proposal_id: proposalId };
  handle.purpose = purposeHint ?? undefined;
  handle.myInput = args.my_input;
  handle.proposalId = proposalId;

  if (!(transport instanceof DirectAfalTransport)) {
    await assertRelayTrusted(relayUrl, [transportLocalRelayUrl(transport)]);
    chargeSessionDisclosure({
      key: newSessionChargeKey(handle),
      contract,
      selfId: agentId,
      fallbackCounterparty: counterparty,
      purpose: purposeHint ?? undefined,
    });
    const config = relayClientConfig(relayUrl);
    const myContext = args.my_input ?? '';
    const nonce = generateCommitmentNonce();
    const created = await createAndSubmit(config, contract, myContext, 'initiator', nonce);
    handle.inputCommitment = { sessionId: created.sessionId, context: myContext, nonce };
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
  const retryBase = {
    retryKind: 'direct' as const,
    proposeParams,
    contract,
    relayUrl,
    purposeHint,
  };
  let response: Awaited<ReturnType<AfalTransport['sendPropose']>>;
  try {
    response = await transport.sendPropose(proposeParams);
  } catch (err) {
    if (isRetryableTransportError(err)) {
      handle.retryState = retryBase satisfies DirectProposeRetryState;
      handle.phase = 'PROPOSE_RETRY';
      return awaitingResponse(
        handle,
        'Counterparty not yet reachable (they may not have started yet). Will keep trying.',
        { strategy: 'DEFERRED', seconds: 60 },
      );
    }
    throw err; // non-retryable — let outer catch handle
  }
  const selectedProfile = response?.selectedModelProfile ?? preferredProfile;
  const committed = await createAndCommitDirectSession(
    {
      handle,
      transport,
      relayUrl,
      contract: bindSelectedProfile(contract, selectedProfile),
      myInput: args.my_input ?? '',
      proposalId,
      purposeHint,
    },
    retryBase,
  );
  if (committed === 'COMMIT_PENDING') {
    return awaitingResponse(
      handle,
      'Relay session created; the counterparty did not receive the session tokens yet. Will keep trying.',
      { strategy: 'DEFERRED', seconds: 60 },
    );
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
      'Timed out waiting for invite acceptance. Call selkey.relay_signal INITIATE to retry.',
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

    writeLastSessionFile(handle.sessionId!, 'INITIATOR', detail.read_token, handle.relayUrl!);

    // Commit phase before submit so retries route to POLL_RELAY (not back here)
    handle.phase = 'POLL_RELAY';

    // Submit initiator input (only to a locally configured relay)
    try {
      await assertRelayTrusted(handle.relayUrl, [transport.relayUrl]);
    } catch (err) {
      return failedResponse(
        handle,
        'RELAY_NOT_TRUSTED',
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      chargeSessionDisclosure({
        key: `${handle.id}:${handle.sessionId ?? `invite:${handle.inviteId ?? ''}`}`,
        contract: handle.contract,
        selfId: transport.agentId,
        fallbackCounterparty: handle.counterparty,
        purpose: handle.purpose,
      });
    } catch (err) {
      if (err instanceof EntropyLedgerError) {
        return failedResponse(handle, err.code, err.message);
      }
      throw err;
    }
    const config = relayClientConfig(handle.relayUrl);
    const myContext = handle.myInput ?? '';
    try {
      await rawSubmitInput(
        config,
        handle.sessionId,
        handle.tokens.submit,
        'initiator',
        myContext,
        submissionNonce(handle, handle.sessionId, myContext),
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
      'Relay session timed out. Call selkey.relay_signal INITIATE to retry.',
    );
  }

  if (!handle.relayUrl || !handle.sessionId || !handle.tokens?.initiatorRead) {
    return failedResponse(handle, 'SESSION_ERROR', 'Missing session data in POLL_RELAY phase.');
  }

  const config = relayClientConfig(handle.relayUrl);
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
        `Session aborted: ${desc} Call selkey.relay_signal INITIATE to retry.`,
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
          respondHandle.preferredPurpose = handle.purpose;
          respondHandle.myInput = handle.myInput;
          respondHandle.contractHash = handle.contractHash;
          // Collision yields should adopt the live counterparty invite when it is
          // locally supported, not enforce the abandoned local session as a hard
          // contract requirement.
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
      'Counterparty never became reachable within the timeout. Ask them to start their agent, then call selkey.relay_signal INITIATE again.',
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

    if (params.committedSession) {
      // The session exists and holds this agent's input: only re-send COMMIT.
      if (transport.commitAdmit) {
        try {
          await transport.commitAdmit(params.proposeParams.propose.proposal_id, params.committedSession);
        } catch (err) {
          // The first COMMIT may have reached the responder and only its
          // response was lost: the responder then no longer holds the
          // admission and says so with a structured code. Continue to poll
          // the relay; the session completes if the responder submitted.
          if (!(err instanceof CommitRejectedError && err.code === COMMIT_ERROR_UNKNOWN_ADMIT)) throw err;
          console.error(
            `relay_signal: re-sent COMMIT for proposal ${params.proposeParams.propose.proposal_id} found no ` +
              'admission at the responder; treating the first COMMIT as delivered',
          );
        }
      }
      handle.phase = 'POLL_RELAY';
      handle.retryState = undefined;
      return awaitingResponse(
        handle,
        'Counterparty admitted the invite. Waiting for relay session to complete.',
        { strategy: 'IMMEDIATE', seconds: 5 },
      );
    }

    let response: Awaited<ReturnType<AfalTransport['sendPropose']>>;
    try {
      response = await transport.sendPropose(params.proposeParams);
    } catch (err) {
      if (isRetryableTransportError(err)) {
        return awaitingResponse(handle, 'Counterparty still not reachable. Will keep trying.', {
          strategy: 'DEFERRED',
          seconds: 60,
        });
      }
      throw err;
    }
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
    const committed = await createAndCommitDirectSession(
      {
        handle,
        transport,
        relayUrl: params.relayUrl,
        contract: finalContract,
        myInput: handle.myInput ?? '',
        proposalId: params.proposeParams.propose.proposal_id,
        purposeHint: params.purposeHint,
      },
      params,
    );
    if (committed === 'COMMIT_PENDING') {
      return awaitingResponse(
        handle,
        'Relay session created; the counterparty did not receive the session tokens yet. Will keep trying.',
        { strategy: 'DEFERRED', seconds: 60 },
      );
    }
  } catch (err) {
    // Only re-sends of an existing invite or COMMIT are retried here; a
    // failure while creating a new session is not.
    if (
      isRetryableTransportError(err) &&
      (params.retryKind === 'legacy' || params.committedSession !== undefined)
    ) {
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

  const localRelayUrl = transportLocalRelayUrl(transport);

  while (true) {
    // Check overall timeout
    if (Date.now() > handle.timeoutDeadline) {
      return failedResponse(
        handle,
        'RELAY_TIMEOUT',
        'Timed out waiting for relay invite. Ask the initiator to retry.',
      );
    }

    // The responder only accepts a contract that hashes to one it would build
    // itself from local configuration (or to an explicitly supplied hash).
    // Rebuilt each poll so configuration changes take effect.
    // Maps each accepted hash to the locally built contract (undefined for an
    // explicitly supplied hash, whose contract is not known locally).
    // Outside development an explicit hash must also be one of the locally
    // built contracts bound to the pinned relay key.
    let expectedContractHashes: Map<string, RelayContract | undefined>;
    if (handle.expectedContractHash && isDevEnvironment()) {
      expectedContractHashes = new Map([[handle.expectedContractHash, undefined]]);
    } else {
      const built = await buildExpectedContractHashes({
        purposes: responderAcceptablePurposes(handle, transport),
        participants: [handle.counterparty, handle.agentId],
        relayKeys: expectedRelayKeyVariants(),
      });
      if (handle.expectedContractHash) {
        const local = built.get(handle.expectedContractHash);
        expectedContractHashes = local ? new Map([[handle.expectedContractHash, local]]) : new Map();
      } else {
        expectedContractHashes = built;
      }
    }

    // Sleep between polls (not before the first check)
    if (!isFirstCheck) {
      await new Promise(resolve => setTimeout(resolve, _discoverPollIntervalMs));
    }
    isFirstCheck = false;

    const response = await transport.peekInbox();
    const invites: AfalInviteMessage[] = response.invites ?? [];

    // Track whether we found invites from the sender that failed validation.
    // If all sender invites fail, return a first-class terminal error instead
    // of polling forever (the sender won't send a different contract).
    let senderInviteFailure:
      | { kind: 'contract' }
      | { kind: 'purpose'; expected: string; actual: string }
      | { kind: 'relay'; relayUrl: string }
      | null = null;

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

      const advertisedPurpose =
        invite.afalPropose?.purpose_code ??
        (invite.template_id
          ? Object.entries(PURPOSE_TO_TEMPLATE).find(
              // PURPOSE_TO_TEMPLATE is currently 1:1. If that changes, replace
              // this reverse lookup with an explicit template->purpose map.
              ([, templateId]) => templateId === invite.template_id,
            )?.[0]
          : undefined);

      // Check expected_contract_hash if provided (direct hash comparison)
      if (handle.expectedContractHash && invite.contract_hash !== handle.expectedContractHash) {
        senderInviteFailure = { kind: 'contract' };
        continue;
      }

      // AFAL-enriched path: validate purpose_code from parsed AfalPropose
      if (
        invite.afalPropose?.purpose_code &&
        handle.expectedPurpose &&
        !handle.expectedContractHash
      ) {
        if (invite.afalPropose.purpose_code !== handle.expectedPurpose) {
          senderInviteFailure = {
            kind: 'purpose',
            expected: handle.expectedPurpose,
            actual: invite.afalPropose.purpose_code,
          };
          continue;
        }
      } else if (handle.expectedPurpose && !handle.expectedContractHash) {
        // Legacy path: validate expected_purpose via template_id
        const expectedTemplate = PURPOSE_TO_TEMPLATE[handle.expectedPurpose];
        const inviteTemplate = invite.template_id;
        if (expectedTemplate && inviteTemplate && inviteTemplate !== expectedTemplate) {
          senderInviteFailure = {
            kind: 'purpose',
            expected: handle.expectedPurpose,
            actual: advertisedPurpose ?? 'UNKNOWN',
          };
          continue;
        }
      } else if (
        handle.preferredPurpose &&
        advertisedPurpose &&
        advertisedPurpose !== handle.preferredPurpose
      ) {
        const adoptionResult = tryAdoptPreferredPurpose(handle, advertisedPurpose);
        if (adoptionResult) return adoptionResult;
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
          senderInviteFailure = { kind: 'contract' };
          continue;
        }

        // Validate: contract_json must hash to the advertised contract_hash
        const computedHash = computeRelayContractHash(detail.contract_json);
        if (computedHash !== detail.contract_hash) {
          console.error(
            `phaseDiscover: invite ${invite.invite_id} contract_json hash mismatch: ` +
              `computed=${computedHash} advertised=${detail.contract_hash}`,
          );
          senderInviteFailure = { kind: 'contract' };
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
          senderInviteFailure = { kind: 'contract' };
          continue;
        }

        // Validate: purpose compatibility (if caller supplied expected_purpose)
        if (handle.expectedPurpose) {
          const contractPurpose = detail.contract_json.purpose_code;
          if (typeof contractPurpose === 'string' && contractPurpose !== handle.expectedPurpose) {
            senderInviteFailure = {
              kind: 'purpose',
              expected: handle.expectedPurpose,
              actual: contractPurpose,
            };
            continue;
          }
        } else if (handle.preferredPurpose) {
          const contractPurpose = detail.contract_json.purpose_code;
          if (typeof contractPurpose === 'string' && contractPurpose !== handle.preferredPurpose) {
            const adoptionResult = tryAdoptPreferredPurpose(handle, contractPurpose);
            if (adoptionResult) return adoptionResult;
          }
        }

        // Validate: the full contract must be one this responder would build
        if (!expectedContractHashes.has(computedHash)) {
          console.error(
            `phaseDiscover: invite ${invite.invite_id} contract ${computedHash} is not a locally expected contract`,
          );
          senderInviteFailure = { kind: 'contract' };
          continue;
        }

        // Bind confirmed contract to handle
        handle.inviteId = invite.invite_id;
        handle.contractHash = detail.contract_hash;
        // Same hash, but prefer the locally built contract over the copy the
        // invite carried.
        handle.contract =
          (expectedContractHashes.get(computedHash) as Record<string, unknown> | undefined) ??
          detail.contract_json;
        handle.proposalId = invite.afalPropose?.proposal_id;
        handle.relayUrl = handle.relayUrl ?? transport.relayUrl;
      } else {
        // Legacy path: extract session tokens from invite payload.
        // (payload was validated by the filter above — this guard is defensive)
        const payload = invite.payload;
        if (!payload || typeof payload !== 'object' || !isRelayInvitePayload(payload)) continue;

        // The contract hash bound to the session must be one this responder
        // would build itself.
        if (!invite.contract_hash || !expectedContractHashes.has(invite.contract_hash)) {
          senderInviteFailure = { kind: 'contract' };
          continue;
        }

        // The session relay must be locally configured, and must match an
        // explicitly requested relay_url.
        if (
          !isRelayUrlAllowed(payload.relay_url, [localRelayUrl]) ||
          (handle.relayUrl &&
            normalizeRelayUrl(handle.relayUrl) !== normalizeRelayUrl(payload.relay_url))
        ) {
          senderInviteFailure = { kind: 'relay', relayUrl: payload.relay_url };
          continue;
        }

        handle.inviteId = invite.invite_id;
        handle.contractHash = invite.contract_hash;
        // The contract charged and checked locally is the one this responder
        // built itself for that hash; the invite carries only the hash.
        const localContract = expectedContractHashes.get(invite.contract_hash);
        if (localContract) handle.contract = localContract as unknown as Record<string, unknown>;
        handle.proposalId = invite.afalPropose?.proposal_id;
        handle.sessionId = payload.session_id;
        handle.relayUrl = payload.relay_url;
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
    if (senderInviteFailure?.kind === 'purpose') {
      return failedResponse(
        handle,
        'PURPOSE_MISMATCH',
        `Counterparty proposed ${senderInviteFailure.actual}, but this response expected ${senderInviteFailure.expected}.`,
      );
    }
    if (senderInviteFailure?.kind === 'contract') {
      return failedResponse(
        handle,
        'CONTRACT_MISMATCH',
        'Invite contract does not match expected contract.',
      );
    }
    if (senderInviteFailure?.kind === 'relay') {
      return failedResponse(
        handle,
        'RELAY_NOT_TRUSTED',
        `Invite names relay "${senderInviteFailure.relayUrl}", which is not a locally configured relay. ` +
          'Set SELKEY_RELAY_URL or add it to SELKEY_RELAY_ALLOWLIST.',
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

  const config = relayClientConfig(handle.relayUrl);

  // Submit input if not yet done (uses stored myInput from handle, not args)
  if (!handle.submitted) {
    // Only submit to a locally configured relay (and, if pinned, the expected key).
    try {
      await assertRelayTrusted(handle.relayUrl, [transportLocalRelayUrl(transport)]);
    } catch (err) {
      return failedResponse(
        handle,
        'RELAY_NOT_TRUSTED',
        err instanceof Error ? err.message : String(err),
      );
    }

    // Charge the owner-side disclosure budget before accepting or submitting.
    try {
      chargeSessionDisclosure({
        key: `${handle.id}:${handle.sessionId ?? `invite:${handle.inviteId ?? ''}`}`,
        contract: handle.contract,
        selfId: transport.agentId,
        fallbackCounterparty: handle.counterparty,
        purpose: handle.purpose,
      });
    } catch (err) {
      if (err instanceof EntropyLedgerError) {
        return failedResponse(handle, err.code, err.message);
      }
      throw err;
    }

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

    const myContext = handle.myInput ?? '';
    try {
      await rawSubmitInput(
        config,
        handle.sessionId!,
        handle.tokens!.submit,
        'responder',
        myContext,
        submissionNonce(handle, handle.sessionId!, myContext),
        handle.contractHash,
      );
    } catch (submitErr) {
      const msg = submitErr instanceof Error ? submitErr.message : String(submitErr);
      // A relay 401 means the session is stale (already submitted or aborted).
      // Fail gracefully so the FSM can retry with a fresh invite. Decided by
      // the relay client's status code, never by message text.
      if (relayHttpStatus(submitErr) === 401) {
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
        `Session aborted: ${desc} Waiting for the initiator to retry — call selkey.relay_signal RESPOND again.`,
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

// ── Legacy Modes ────────────────────────────────────────────────────────

function ownInputFromContract(
  contract: unknown,
  index: number,
  context: unknown,
  commitmentNonce: string,
): LocalSessionData['ownInput'] {
  const participants =
    contract && typeof contract === 'object'
      ? (contract as Record<string, unknown>)['participants']
      : undefined;
  const participantId = Array.isArray(participants) ? participants[index] : undefined;
  return typeof participantId === 'string'
    ? { participantId, context, commitmentNonce }
    : undefined;
}

/** This agent's participant id from local configuration (never from a receipt). */
function localParticipantId(contract: unknown, index: number): string | undefined {
  const participants =
    contract && typeof contract === 'object'
      ? (contract as Record<string, unknown>)['participants']
      : undefined;
  if (Array.isArray(participants) && typeof participants[index] === 'string') {
    return participants[index] as string;
  }
  const configured = process.env['SELKEY_AGENT_ID']?.trim();
  return configured ? configured : undefined;
}

async function handleCreate(args: RelaySignalArgs): Promise<ToolResponse<RelaySignalCreateData>> {
  if (!args.contract) {
    return buildError('INVALID_INPUT', 'contract is required for CREATE mode');
  }
  requireRelayKeyPin('start a relay session');
  const relayUrl = resolveRelayUrl(args.relay_url);
  await assertRelayTrusted(relayUrl);
  // Bind the relay key before charging, so a pin mismatch never leaves a charge.
  const contract = withPinnedRelayKey(args.contract);
  chargeSessionDisclosure({
    key: `create:${randomUUID()}`,
    contract,
    selfId: localParticipantId(contract, 0),
  });
  const config = relayClientConfig(relayUrl);

  const myContext = args.my_input ?? '';
  const nonce = generateCommitmentNonce();
  const created = await createAndSubmit(config, contract, myContext, 'initiator', nonce);
  const output = await pollUntilDone(config, created.sessionId, created.initiatorReadToken);

  const receiptCheck = checkReceiptAgainstPinnedKey(output, {
    ownInput: ownInputFromContract(contract, 0, myContext, nonce),
    contract,
    submittedInput: true,
  });
  if (receiptCheck.status === 'FAILED') {
    return buildError('VERIFICATION_FAILED', receiptCheck.detail);
  }

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

  if (args.contract !== undefined && computeRelayContractHash(args.contract) !== args.contract_hash) {
    return buildError(
      'CONTRACT_MISMATCH',
      'contract does not hash to contract_hash; input was not submitted',
    );
  }
  assertContractCarriesRelayPin(args.contract);
  const relayUrl = resolveRelayUrl(args.relay_url);
  await assertRelayTrusted(relayUrl);
  // The disclosure bound comes from the caller's contract; without it the
  // session cannot be charged, so JOIN refuses (when the ledger is enforced).
  chargeSessionDisclosure({
    key: `join:${args.session_id}`,
    contract: args.contract,
    selfId: localParticipantId(args.contract, 1),
  });
  const config = relayClientConfig(relayUrl);

  const myContext = args.my_input ?? '';
  const nonce = generateCommitmentNonce();
  const output = await joinAndWait(
    config,
    args.session_id,
    args.submit_token,
    args.read_token,
    args.contract_hash,
    myContext,
    'responder',
    nonce,
  );

  // The responder's participant id comes from the caller's contract (second
  // participant) or SELKEY_AGENT_ID; it is never taken from the receipt.
  const participantId = localParticipantId(args.contract, 1);
  const receiptCheck = checkReceiptAgainstPinnedKey(output, {
    ownInput: participantId
      ? { participantId, context: myContext, commitmentNonce: nonce }
      : undefined,
    contract: args.contract,
    submittedInput: true,
  });
  if (receiptCheck.status === 'FAILED') {
    return buildError('VERIFICATION_FAILED', receiptCheck.detail);
  }

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
  const response = await handleRelaySignalUnlabelled(args, transport, knownAgents, relayProfileId);
  return labelUntrustedContent(response, relaySignalUntrustedPaths(response));
}

async function handleRelaySignalUnlabelled(
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
      const fallbackArgs = hasExtraArgs(args)
        ? { ...args, resume_token: undefined }
        : null;
      // Budget models often include mode/counterparty alongside resume_token.
      // Instead of rejecting, strip extra args and proceed — the resume_token
      // carries all the state needed.
      if (hasExtraArgs(args)) {
        const extra = Object.keys(args).filter((k) => k !== 'resume_token');
        console.info(`relay_signal resume: ignoring extra args [${extra.join(', ')}] alongside resume_token`);
        args = { resume_token: resumeToken } as typeof args;
      }

      const agentId = transport?.agentId ?? process.env['SELKEY_AGENT_ID'] ?? '';
      const handle = decodeRelayToken(resumeToken, agentId, getResumeTokenSecret());
      if (!handle) {
        if (fallbackArgs) {
          console.info(
            'relay_signal resume: resume_token invalid/expired; falling back to fresh call args.',
          );
          // Fall through to the fresh-call path below with the caller's
          // non-resume arguments restored.
          args = fallbackArgs;
        } else {
          return buildError(
            'INVALID_INPUT',
            'Invalid or expired resume_token. Start a new relay_signal call.',
          );
        }
      } else {
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
        requireRelayKeyPin('start a relay session');
        if (!args.counterparty) {
          return buildError('INVALID_INPUT', 'counterparty is required for INITIATE mode');
        }

        const counterparty = resolveAgentAlias(args.counterparty, knownAgents, transport);
        const agentId = transport.agentId ?? process.env['SELKEY_AGENT_ID'] ?? '';

        // Compute contract hash early — needed for both collision path and idempotency key
        let contractHashForKey: string;
        const acceptablePurposes = parseAcceptablePurposes(args.acceptable_purposes);
        if (args.contract) {
          contractHashForKey = createHash('sha256')
            .update(JSON.stringify(args.contract))
            .digest('hex');
        } else if (args.purpose) {
          const built = buildRelayContract(args.purpose, [agentId, counterparty], relayProfileId);
          contractHashForKey = built ? computeRelayContractHash(built) : args.purpose;
        } else if (acceptablePurposes.length > 0) {
          contractHashForKey = createHash('sha256')
            .update(JSON.stringify({ acceptable_purposes: acceptablePurposes }))
            .digest('hex');
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
          if (args.purpose) {
            respondHandle.preferredPurpose = args.purpose;
          }
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
        requireRelayKeyPin('respond to a relay session');

        if (!args.from) {
          const knownNames = knownAgents.map(a => a.agent_id).join(', ');
          return buildError(
            'INVALID_INPUT',
            `from is required for RESPOND mode — set it to the agent_id of the sender. ` +
            `Your known agents: ${knownNames || 'none'}`,
          );
        }

        const from = resolveAgentAlias(args.from, knownAgents, transport);
        const agentId = transport.agentId ?? process.env['SELKEY_AGENT_ID'] ?? '';

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

        // Without expected_purpose or expected_contract_hash, the responder
        // accepts only contracts built from its locally configured purposes.

        // An explicit relay_url must be a locally configured relay.
        if (args.relay_url && !isRelayUrlAllowed(args.relay_url, [transportLocalRelayUrl(transport)])) {
          return buildError(
            'INVALID_INPUT',
            `relay_url "${args.relay_url}" is not a locally configured relay. ` +
              'Set SELKEY_RELAY_URL or add it to SELKEY_RELAY_ALLOWLIST.',
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
      const entry = `[${new Date().toISOString()}] error_code=${code} detail=${detail} raw=${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;
      appendPrivateLine(path.join(selkeyStateDir(), 'relay-debug.log'), entry);
    } catch (logErr) {
      console.error(
        `handleRelaySignal: failed to write diagnostic log: ${logErr instanceof Error ? logErr.message : String(logErr)}`,
      );
    }
    return buildError(code, detail);
  }
}
