/**
 * Relay handle store with HMAC-signed resume tokens.
 *
 * Tracks in-flight relay_signal operations so agents can resume across
 * tool calls without re-sending invites or re-creating sessions.
 *
 * Pattern follows coordinate.ts (encodeResumeToken / decodeResumeToken /
 * handles Map / sweepExpired).
 */

import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

// ── Types ──────────────────────────────────────────────────────────────────

export type RelayPhase =
  | 'INVITE'
  | 'PROPOSE_RETRY'
  | 'POLL_INVITE'
  | 'POLL_RELAY'
  | 'DISCOVER'
  | 'JOIN'
  | 'COMPLETED'
  | 'ABORTED'
  | 'FAILED';

export interface RelayHandle {
  id: string;
  agentId: string;
  role: 'INITIATOR' | 'RESPONDER';
  phase: RelayPhase;
  counterparty: string;
  purpose?: string;
  contractHash?: string;
  /** Full confirmed contract object (structured confirmation). */
  contract?: Record<string, unknown>;
  sessionId?: string;
  relayUrl?: string;
  tokens?: { submit: string; read: string; initiatorRead?: string };
  inviteId?: string;
  /** AFAL proposal ID for tracing and future receipt binding. */
  proposalId?: string;
  /** Set to true after relay input has been submitted (JOIN phase). */
  submitted?: boolean;
  /** Stored from first call for use on resume (responder only). */
  myInput?: string;
  expectedPurpose?: string;
  expectedContractHash?: string;
  alignedTopicCode?: string;
  negotiatedContract?: {
    kind: 'offer' | 'bespoke';
    contractOfferId?: string;
    bespokeContract?: {
      purpose_code: string;
      schema_ref: string;
      policy_ref: string;
      program_ref: string;
    };
    selectedModelProfile: {
      id: string;
      version: string;
      hash: string;
    };
  };
  /** Opaque retry state for PROPOSE_RETRY phase (stored by relaySignal). */
  retryState?: unknown;
  createdAt: number;
  timeoutDeadline: number;
  idempotencyKey: string;
}

interface RelayTokenPayload {
  h: string; // handle ID
  a: string; // agentId
  t: number; // issuedAt (epoch ms)
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_HANDLES_PER_AGENT = 100;
const PRUNE_GRACE_MS = 10 * 60 * 1000; // 10 minutes past timeout

// ── Handle Store ───────────────────────────────────────────────────────────

const handles = new Map<string, RelayHandle>();

const TERMINAL_PHASES: ReadonlySet<RelayPhase> = new Set(['COMPLETED', 'ABORTED', 'FAILED']);

function isExpiredWithGrace(handle: RelayHandle): boolean {
  return Date.now() > handle.timeoutDeadline + PRUNE_GRACE_MS;
}

function isTerminal(handle: RelayHandle): boolean {
  return TERMINAL_PHASES.has(handle.phase);
}

// ── Resume Token ───────────────────────────────────────────────────────────

/**
 * Encode a relay handle into a signed resume token.
 * Format: base64url(JSON).hmac_signature (if secret provided)
 */
export function encodeRelayToken(handle: RelayHandle, secret: string | null): string {
  const payload: RelayTokenPayload = {
    h: handle.id,
    a: handle.agentId,
    t: Date.now(),
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  if (!secret) return b64;
  const sig = createHmac('sha256', secret).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

/**
 * Decode and verify a relay resume token.
 * Returns the RelayHandle if valid, null otherwise.
 */
export function decodeRelayToken(
  token: string,
  agentId: string,
  secret: string | null,
): RelayHandle | null {
  let b64: string;

  if (secret) {
    const dotIndex = token.lastIndexOf('.');
    if (dotIndex === -1) {
      console.error('Relay token decode: missing signature separator');
      return null;
    }
    b64 = token.slice(0, dotIndex);
    const sig = token.slice(dotIndex + 1);
    const expected = createHmac('sha256', secret).update(b64).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      console.error('Relay token decode: HMAC signature mismatch');
      return null;
    }
  } else {
    b64 = token;
  }

  let parsed: RelayTokenPayload;
  try {
    const json = Buffer.from(b64, 'base64url').toString('utf-8');
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object') {
      console.error('Relay token decode: payload is not an object');
      return null;
    }
    if (!obj.h || !obj.a || typeof obj.t !== 'number') {
      console.error('Relay token decode: missing required fields');
      return null;
    }
    parsed = obj as RelayTokenPayload;
  } catch (err) {
    console.error(
      `Relay token decode: parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (parsed.a !== agentId) {
    console.error('Relay token decode: agentId mismatch');
    return null;
  }

  const handle = handles.get(parsed.h);
  if (!handle) {
    console.error('Relay token decode: handle not found');
    return null;
  }

  if (isExpiredWithGrace(handle)) {
    console.error('Relay token decode: handle expired');
    return null;
  }

  return handle;
}

// ── Idempotency Key ────────────────────────────────────────────────────────

/**
 * Compute a deterministic idempotency key from the agentId and caller-supplied parts.
 *
 * INITIATE: parts = [contractHash, counterparty, sha256(myInput)]
 * RESPOND:  parts = [from, expectedPurpose ?? expectedContractHash, sha256(myInput)]
 */
export function computeRelayIdempotencyKey(agentId: string, parts: string[]): string {
  return createHash('sha256')
    .update(agentId + parts.join('|'))
    .digest('hex');
}

// ── Find Existing Handle ───────────────────────────────────────────────────

/**
 * Search for a non-terminal handle matching agentId + role + idempotencyKey.
 */
export function findExistingRelayHandle(
  agentId: string,
  role: string,
  idempotencyKey: string,
): RelayHandle | null {
  for (const handle of handles.values()) {
    if (
      handle.agentId === agentId &&
      handle.role === role &&
      handle.idempotencyKey === idempotencyKey &&
      !isTerminal(handle)
    ) {
      return handle;
    }
  }
  return null;
}

// ── Create Handle ──────────────────────────────────────────────────────────

type CreateRelayHandleParams = Omit<RelayHandle, 'id' | 'createdAt' | 'timeoutDeadline'> & {
  timeoutMs: number;
};

/**
 * Create and store a new relay handle.
 * Prunes expired handles first if the per-agent limit is reached.
 * Throws if still at the limit after pruning.
 */
export function createRelayHandle(params: CreateRelayHandleParams): RelayHandle {
  const agentHandleCount = countActiveHandlesForAgent(params.agentId);

  if (agentHandleCount >= MAX_HANDLES_PER_AGENT) {
    pruneRelayHandles();
    const countAfterPrune = countActiveHandlesForAgent(params.agentId);
    if (countAfterPrune >= MAX_HANDLES_PER_AGENT) {
      throw new Error(
        `Handle limit reached: agent ${params.agentId} has ${countAfterPrune} active handles (max ${MAX_HANDLES_PER_AGENT})`,
      );
    }
  }

  const now = Date.now();
  const { timeoutMs, ...rest } = params;
  const handle: RelayHandle = {
    ...rest,
    id: randomUUID(),
    createdAt: now,
    timeoutDeadline: now + timeoutMs,
  };

  handles.set(handle.id, handle);
  return handle;
}

function countActiveHandlesForAgent(agentId: string): number {
  let count = 0;
  for (const handle of handles.values()) {
    if (handle.agentId === agentId && !isTerminal(handle) && !isExpiredWithGrace(handle)) {
      count++;
    }
  }
  return count;
}

// ── Prune ──────────────────────────────────────────────────────────────────

/**
 * Remove handles that are expired past the grace period.
 */
export function pruneRelayHandles(): void {
  for (const [id, handle] of handles) {
    if (isExpiredWithGrace(handle)) {
      handles.delete(id);
    }
  }
}

// ── Testing ────────────────────────────────────────────────────────────────

export function _resetHandlesForTesting(): void {
  handles.clear();
}
