/**
 * AfalResponder — AFAL admission logic for RESPOND mode.
 *
 * Evaluates incoming PROPOSE messages against an AdmissionPolicy, signs
 * ADMIT/DENY responses, and queues admitted proposals for checkInbox() drain.
 *
 * DENY is a fixed 6-field set: admission_version, proposal_id, outcome,
 * deny_code, expires_at, signature.
 *
 * ADMIT is a fixed 7-field set: admission_version, proposal_id, outcome,
 * admit_token_id, admission_tier, expires_at, signature.
 */

import { randomUUID } from 'node:crypto';
import type { AfalPropose, RelayInvitePayload } from './afal-types.js';
import { computeProposalId } from './afal-types.js';
import { signMessage, verifyMessage, DOMAIN_PREFIXES } from './afal-signing.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type DenyCode = 'UNTRUSTED' | 'UNSUPPORTED' | 'STALE' | 'REPLAY' | 'POLICY' | 'INTEGRITY';

export interface TrustedAgent {
  agentId: string;
  publicKeyHex: string;
}

export interface AdmissionPolicy {
  trustedAgents: TrustedAgent[];
  allowedPurposeCodes: string[];
  allowedLaneIds: string[];
  maxEntropyBits: number;
  /** In M4, LOW_TRUST behaves as DENY unless proposer is in trustedAgents. */
  defaultTier: 'DENY' | 'LOW_TRUST';
}

export interface AdmittedProposal {
  propose: AfalPropose;
  relay: RelayInvitePayload;
  admitTokenId: string;
  proposerAgentId: string;
  proposerPublicKeyHex: string;
  expiresAt: number;
}

// ── NonceCache ───────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PER_AGENT = 1000;

export class NonceCache {
  private readonly caches = new Map<string, Map<string, number>>();
  private readonly maxPerAgent: number;
  private readonly windowMs: number;

  constructor(opts?: { maxPerAgent?: number; windowMs?: number }) {
    this.maxPerAgent = opts?.maxPerAgent ?? DEFAULT_MAX_PER_AGENT;
    this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  }

  check(agentId: string, nonce: string, timestampMs: number): boolean {
    let agentCache = this.caches.get(agentId);
    if (!agentCache) {
      agentCache = new Map();
      this.caches.set(agentId, agentCache);
    }

    const cutoff = timestampMs - this.windowMs;
    for (const [n, ts] of agentCache) {
      if (ts < cutoff) agentCache.delete(n);
    }

    if (agentCache.size >= this.maxPerAgent) return false;
    if (agentCache.has(nonce)) return false;

    agentCache.set(nonce, timestampMs);
    return true;
  }

  _reset(): void {
    this.caches.clear();
  }
}

// ── AfalResponder ────────────────────────────────────────────────────────────

const ADMIT_TTL_MS = 10 * 60 * 1000;

export interface AfalResponderConfig {
  agentId: string;
  seedHex: string;
  policy: AdmissionPolicy;
}

export class AfalResponder {
  private readonly config: AfalResponderConfig;
  private readonly nonceCache: NonceCache;
  private readonly admitStore = new Map<string, AdmittedProposal>();
  private readonly queue: AdmittedProposal[] = [];

  constructor(config: AfalResponderConfig) {
    this.config = config;
    this.nonceCache = new NonceCache();
  }

  handlePropose(body: unknown): { outcome: 'ADMIT' | 'DENY'; response: Record<string, unknown> } {
    const now = Date.now();

    // 1. Detect body shape: wrapped {propose, relay} vs flat M3
    if (!isWrappedBody(body)) {
      return this.deny('', 'UNSUPPORTED', now);
    }

    const wrapped = body as { propose: Record<string, unknown>; relay: Record<string, unknown> };

    // 2. Validate relay tokens (4 required string fields)
    const relay = parseRelay(wrapped.relay);
    if (!relay) {
      return this.deny('', 'UNSUPPORTED', now);
    }

    // 3. Parse propose fields, verify proposal_id integrity
    const propose = parsePropose(wrapped.propose);
    if (!propose) {
      return this.deny('', 'UNSUPPORTED', now);
    }

    const proposalId = propose.proposal_id;
    const { proposal_id: claimed, ...hashable } = propose;
    const expected = computeProposalId(hashable);
    if (claimed !== expected) {
      return this.deny(proposalId, 'INTEGRITY', now);
    }

    // 4. Check propose.to matches our agentId
    if (propose.to !== this.config.agentId) {
      return this.deny(proposalId, 'UNTRUSTED', now);
    }

    // 5. Look up proposer in trustedAgents
    //    In M4, LOW_TRUST behaves as DENY unless proposer is in trustedAgents
    //    (no descriptor-fetch path yet).
    const trustedAgent = this.config.policy.trustedAgents.find((a) => a.agentId === propose.from);
    if (!trustedAgent) {
      return this.deny(proposalId, 'UNTRUSTED', now);
    }

    // 6. Verify Ed25519 signature
    if (!verifyMessage(DOMAIN_PREFIXES.PROPOSE, wrapped.propose, trustedAgent.publicKeyHex)) {
      return this.deny(proposalId, 'UNTRUSTED', now);
    }

    // 7. Check timestamp staleness (> 10 min)
    const proposedMs = Date.parse(propose.timestamp);
    if (Number.isNaN(proposedMs) || Math.abs(now - proposedMs) > ADMIT_TTL_MS) {
      return this.deny(proposalId, 'STALE', now);
    }

    // 8. Check purpose_code (pure — before nonce side effect)
    if (!this.config.policy.allowedPurposeCodes.includes(propose.purpose_code)) {
      return this.deny(proposalId, 'POLICY', now);
    }

    // 9. Check lane_id (pure — before nonce side effect)
    if (!this.config.policy.allowedLaneIds.includes(propose.lane_id)) {
      return this.deny(proposalId, 'POLICY', now);
    }

    // 10. Check requested_entropy_bits (pure — before nonce side effect)
    if (propose.requested_entropy_bits > this.config.policy.maxEntropyBits) {
      return this.deny(proposalId, 'POLICY', now);
    }

    // 11. Check nonce uniqueness (side effect — must be last before ADMIT)
    if (!this.nonceCache.check(propose.from, propose.nonce, proposedMs)) {
      return this.deny(proposalId, 'REPLAY', now);
    }

    // All checks passed — ADMIT
    const admitTokenId = randomUUID();
    const expiresAt = now + ADMIT_TTL_MS;
    const expiresAtIso = new Date(expiresAt).toISOString();

    const admitUnsigned: Record<string, unknown> = {
      admission_version: '1',
      proposal_id: proposalId,
      outcome: 'ADMIT',
      admit_token_id: admitTokenId,
      admission_tier: propose.admission_tier_requested,
      expires_at: expiresAtIso,
    };

    const signedAdmit = signMessage(DOMAIN_PREFIXES.ADMIT, admitUnsigned, this.config.seedHex);

    const admitted: AdmittedProposal = {
      propose,
      relay,
      admitTokenId,
      proposerAgentId: propose.from,
      proposerPublicKeyHex: trustedAgent.publicKeyHex,
      expiresAt,
    };

    this.admitStore.set(admitTokenId, admitted);
    this.queue.push(admitted);

    return { outcome: 'ADMIT', response: signedAdmit };
  }

  handleCommit(body: unknown): { ok: boolean; error?: string } {
    this.gcExpired();

    if (!body || typeof body !== 'object') {
      return { ok: false, error: 'Invalid COMMIT body' };
    }

    const commit = body as Record<string, unknown>;
    const admitTokenId = commit['admit_token_id'];
    const from = commit['from'];
    const proposalId = commit['proposal_id'];

    if (
      typeof admitTokenId !== 'string' ||
      typeof from !== 'string' ||
      typeof proposalId !== 'string'
    ) {
      return { ok: false, error: 'Missing required COMMIT fields' };
    }

    const admitted = this.admitStore.get(admitTokenId);
    if (!admitted) {
      return { ok: false, error: 'Unknown or expired admit_token_id' };
    }

    if (from !== admitted.proposerAgentId) {
      return { ok: false, error: 'COMMIT sender does not match proposer' };
    }

    if (proposalId !== admitted.propose.proposal_id) {
      return { ok: false, error: 'COMMIT proposal_id does not match ADMIT' };
    }

    if (!verifyMessage(DOMAIN_PREFIXES.COMMIT, commit, admitted.proposerPublicKeyHex)) {
      return { ok: false, error: 'COMMIT signature verification failed' };
    }

    this.admitStore.delete(admitTokenId);
    return { ok: true };
  }

  drainQueue(): AdmittedProposal[] {
    this.gcExpired();
    const items = [...this.queue];
    this.queue.length = 0;
    return items;
  }

  private deny(
    proposalId: string,
    denyCode: DenyCode,
    nowMs: number,
  ): { outcome: 'DENY'; response: Record<string, unknown> } {
    console.error(
      `AfalResponder DENY: code=${denyCode}, proposal=${proposalId}, agentId=${this.config.agentId}` +
        (denyCode === 'INTEGRITY'
          ? ` (proposal_id mismatch: claimed=${proposalId.slice(0, 16)}…)`
          : ''),
    );
    const expiresAtIso = new Date(nowMs + ADMIT_TTL_MS).toISOString();
    const denyUnsigned: Record<string, unknown> = {
      admission_version: '1',
      proposal_id: proposalId,
      outcome: 'DENY',
      deny_code: denyCode,
      expires_at: expiresAtIso,
    };
    return {
      outcome: 'DENY',
      response: signMessage(DOMAIN_PREFIXES.DENY, denyUnsigned, this.config.seedHex),
    };
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [tokenId, admitted] of this.admitStore) {
      if (admitted.expiresAt <= now) {
        this.admitStore.delete(tokenId);
      }
    }
  }

  _resetForTesting(): void {
    this.admitStore.clear();
    this.queue.length = 0;
    this.nonceCache._reset();
  }

  _getAdmitStoreSize(): number {
    return this.admitStore.size;
  }
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

function isWrappedBody(
  body: unknown,
): body is { propose: Record<string, unknown>; relay: Record<string, unknown> } {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    b['propose'] != null &&
    typeof b['propose'] === 'object' &&
    !Array.isArray(b['propose']) &&
    b['relay'] != null &&
    typeof b['relay'] === 'object' &&
    !Array.isArray(b['relay'])
  );
}

function parseRelay(raw: Record<string, unknown>): RelayInvitePayload | null {
  const { session_id, responder_submit_token, responder_read_token, relay_url } = raw as Record<
    string,
    string
  >;
  if (
    typeof session_id !== 'string' ||
    !session_id ||
    typeof responder_submit_token !== 'string' ||
    !responder_submit_token ||
    typeof responder_read_token !== 'string' ||
    !responder_read_token ||
    typeof relay_url !== 'string' ||
    !relay_url
  ) {
    return null;
  }
  return { session_id, responder_submit_token, responder_read_token, relay_url };
}

const REQUIRED_PROPOSE_STRINGS = [
  'proposal_version',
  'proposal_id',
  'nonce',
  'timestamp',
  'from',
  'to',
  'purpose_code',
  'lane_id',
  'output_schema_id',
  'output_schema_version',
  'requested_budget_tier',
  'model_profile_id',
  'model_profile_version',
  'admission_tier_requested',
] as const;

function parsePropose(raw: Record<string, unknown>): AfalPropose | null {
  for (const field of REQUIRED_PROPOSE_STRINGS) {
    if (typeof raw[field] !== 'string' || !raw[field]) return null;
  }
  if (typeof raw['requested_entropy_bits'] !== 'number') return null;

  return {
    proposal_version: raw['proposal_version'] as string,
    proposal_id: raw['proposal_id'] as string,
    nonce: raw['nonce'] as string,
    timestamp: raw['timestamp'] as string,
    from: raw['from'] as string,
    to: raw['to'] as string,
    purpose_code: raw['purpose_code'] as string,
    lane_id: raw['lane_id'] as string,
    output_schema_id: raw['output_schema_id'] as string,
    output_schema_version: raw['output_schema_version'] as string,
    requested_budget_tier: raw['requested_budget_tier'] as string,
    requested_entropy_bits: raw['requested_entropy_bits'] as number,
    model_profile_id: raw['model_profile_id'] as string,
    model_profile_version: raw['model_profile_version'] as string,
    admission_tier_requested: raw['admission_tier_requested'] as string,
    ...(typeof raw['descriptor_hash'] === 'string' && { descriptor_hash: raw['descriptor_hash'] }),
    ...(typeof raw['model_profile_hash'] === 'string' && {
      model_profile_hash: raw['model_profile_hash'],
    }),
    ...(typeof raw['prev_receipt_hash'] === 'string' && {
      prev_receipt_hash: raw['prev_receipt_hash'],
    }),
    ...(typeof raw['signature'] === 'string' && { signature: raw['signature'] }),
  };
}
