/**
 * AfalResponder — AFAL admission logic for RESPOND mode.
 *
 * Evaluates incoming PROPOSE messages against an AdmissionPolicy, signs
 * ADMIT/DENY responses, and queues committed proposals for checkInbox() drain.
 *
 * DENY is a fixed 6-field set: admission_version, proposal_id, outcome,
 * deny_code, expires_at, signature.
 *
 * ADMIT is a fixed 7-field set: admission_version, proposal_id, outcome,
 * admit_token_id, admission_tier, expires_at, signature.
 */

import { randomBytes } from 'node:crypto';
import type { AfalPropose, RelayPreference, RelaySessionBinding } from './afal-types.js';
import { computeProposalId } from './afal-types.js';
import { signMessage, verifyMessage, DOMAIN_PREFIXES, contentHash } from './afal-signing.js';
import type { ModelProfileRef } from './model-profiles.js';

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
  relayPreference?: RelayPreference;
}

export interface AdmittedProposal {
  propose: AfalPropose;
  relay?: RelaySessionBinding;
  admitTokenId: string;
  proposerAgentId: string;
  proposerPublicKeyHex: string;
  expiresAt: number;
  selectedModelProfile?: ModelProfileRef;
  admittedRelayPreference?: RelayPreference;
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
const EMPTY_PROPOSAL_ID = '0'.repeat(64);

export interface AfalResponderConfig {
  agentId: string;
  seedHex: string;
  policy: AdmissionPolicy;
  supportedModelProfiles?: ModelProfileRef[];
}

export class AfalResponder {
  private readonly config: AfalResponderConfig;
  private readonly nonceCache: NonceCache;
  private readonly admitStore = new Map<string, AdmittedProposal>();
  private queue: AdmittedProposal[] = [];

  constructor(config: AfalResponderConfig) {
    this.config = config;
    this.nonceCache = new NonceCache();
  }

  handlePropose(body: unknown): { outcome: 'ADMIT' | 'DENY'; response: Record<string, unknown> } {
    const now = Date.now();

    // 1. Detect body shape: wrapped {propose, relay?}
    if (!isWrappedBody(body)) {
      return this.deny('', 'UNSUPPORTED', now);
    }

    const wrapped = body as {
      propose: Record<string, unknown>;
      relay?: Record<string, unknown>;
    };

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

    // 6b. If a relay payload is attached, it must be explicitly bound.
    const relayBindingHash = wrapped.propose['relay_binding_hash'];
    const relay = wrapped.relay ? parseRelay(wrapped.relay) : null;
    if (wrapped.relay !== undefined) {
      if (!relay) {
        return this.deny(proposalId, 'UNSUPPORTED', now);
      }
      if (typeof relayBindingHash !== 'string' || !relayBindingHash) {
        return this.deny(proposalId, 'INTEGRITY', now);
      }
      const expectedRelayHash = contentHash(relay);
      if (relayBindingHash !== expectedRelayHash) {
        return this.deny(proposalId, 'INTEGRITY', now);
      }
    } else if (relayBindingHash !== undefined) {
      if (typeof relayBindingHash !== 'string' || !relayBindingHash) {
        return this.deny(proposalId, 'INTEGRITY', now);
      }
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

    const selectedModelProfile = selectModelProfile(
      propose,
      this.config.supportedModelProfiles ?? [],
    );
    if (propose.acceptable_model_profiles?.length && !selectedModelProfile) {
      return this.deny(proposalId, 'UNSUPPORTED', now);
    }

    // All checks passed — ADMIT
    const admitTokenId = randomBytes(32).toString('hex');
    const expiresAt = now + ADMIT_TTL_MS;
    const expiresAtIso = new Date(expiresAt).toISOString();

    const relayPreference = this.config.policy.relayPreference;

    const admitUnsigned: Record<string, unknown> = {
      admission_version: '1',
      proposal_id: proposalId,
      outcome: 'ADMIT',
      admit_token_id: admitTokenId,
      admission_tier: propose.admission_tier_requested,
      expires_at: expiresAtIso,
      ...(selectedModelProfile ? { selected_model_profile: selectedModelProfile } : {}),
      ...(relayPreference ? { relay_preference: relayPreference } : {}),
    };

    const signedAdmit = signMessage(DOMAIN_PREFIXES.ADMIT, admitUnsigned, this.config.seedHex);

    const admitted: AdmittedProposal = {
      propose,
      admitTokenId,
      proposerAgentId: propose.from,
      proposerPublicKeyHex: trustedAgent.publicKeyHex,
      expiresAt,
      selectedModelProfile: selectedModelProfile ?? undefined,
      admittedRelayPreference: relayPreference,
    };

    this.admitStore.set(admitTokenId, admitted);

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

    // Enforce relay preference from the ADMIT
    const chosenRelayUrl = commit['chosen_relay_url'];
    if (admitted.admittedRelayPreference) {
      const { relay_url: preferredUrl, policy: prefPolicy } = admitted.admittedRelayPreference;
      if (typeof chosenRelayUrl !== 'string' || !chosenRelayUrl) {
        if (prefPolicy === 'REQUIRED') {
          return { ok: false, error: 'COMMIT missing chosen_relay_url; responder relay preference is REQUIRED' };
        }
        console.warn(
          `AfalResponder: COMMIT missing chosen_relay_url but relay preference is PREFERRED (preferred=${preferredUrl})`,
        );
      } else if (chosenRelayUrl !== preferredUrl) {
        if (prefPolicy === 'REQUIRED') {
          return {
            ok: false,
            error: `COMMIT chosen_relay_url "${chosenRelayUrl}" does not match required relay "${preferredUrl}"`,
          };
        }
        console.warn(
          `AfalResponder: COMMIT chosen_relay_url "${chosenRelayUrl}" differs from preferred relay "${preferredUrl}" (PREFERRED policy — allowing)`,
        );
      }
    }

    const relaySession = parseRelaySession(commit['relay_session']);
    if (!relaySession) {
      return { ok: false, error: 'COMMIT missing relay_session binding' };
    }

    const finalizedPropose = admitted.selectedModelProfile
      ? {
          ...admitted.propose,
          model_profile_id: admitted.selectedModelProfile.id,
          model_profile_version: admitted.selectedModelProfile.version,
          model_profile_hash: admitted.selectedModelProfile.hash,
        }
      : admitted.propose;

    this.admitStore.delete(admitTokenId);
    this.queue.push({
      ...admitted,
      propose: finalizedPropose,
      relay: relaySession,
    });
    return { ok: true };
  }

  drainQueue(): AdmittedProposal[] {
    this.gcExpired();
    const items = [...this.queue];
    this.queue.length = 0;
    return items;
  }

  peekQueue(): AdmittedProposal[] {
    this.gcExpired();
    return [...this.queue];
  }

  /** Remove a specific proposal from the queue by proposal_id. */
  removeFromQueue(proposalId: string): boolean {
    const idx = this.queue.findIndex((item) => item.propose.proposal_id === proposalId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  private deny(
    proposalId: string,
    denyCode: DenyCode,
    nowMs: number,
  ): { outcome: 'DENY'; response: Record<string, unknown> } {
    const normalizedProposalId =
      /^[0-9a-f]{64}$/.test(proposalId) ? proposalId : EMPTY_PROPOSAL_ID;
    console.error(
      `AfalResponder DENY: code=${denyCode}, proposal=${normalizedProposalId}, agentId=${this.config.agentId}` +
        (denyCode === 'INTEGRITY'
          ? ` (proposal_id mismatch: claimed=${normalizedProposalId.slice(0, 16)}…)`
          : ''),
    );
    const expiresAtIso = new Date(nowMs + ADMIT_TTL_MS).toISOString();
    const denyUnsigned: Record<string, unknown> = {
      admission_version: '1',
      proposal_id: normalizedProposalId,
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
    this.queue = this.queue.filter((item) => item.expiresAt > now);
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
): body is { propose: Record<string, unknown>; relay?: Record<string, unknown> } {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    b['propose'] != null &&
    typeof b['propose'] === 'object' &&
    !Array.isArray(b['propose']) &&
    (b['relay'] === undefined ||
      (b['relay'] != null && typeof b['relay'] === 'object' && !Array.isArray(b['relay'])))
  );
}

function parseRelay(raw: Record<string, unknown>): Omit<RelaySessionBinding, 'contract_hash'> | null {
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

function parseRelaySession(raw: unknown): RelaySessionBinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const relay = parseRelay(value);
  if (!relay) return null;
  if (typeof value['contract_hash'] !== 'string' || !value['contract_hash']) return null;
  return { ...relay, contract_hash: value['contract_hash'] };
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
  const acceptableModelProfiles = parseModelProfileRefs(raw['acceptable_model_profiles']);
  if (raw['acceptable_model_profiles'] !== undefined && acceptableModelProfiles === null) return null;

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
    ...(acceptableModelProfiles !== null && {
      acceptable_model_profiles: acceptableModelProfiles,
    }),
    ...(typeof raw['prev_receipt_hash'] === 'string' && {
      prev_receipt_hash: raw['prev_receipt_hash'],
    }),
    ...(typeof raw['relay_binding_hash'] === 'string' && {
      relay_binding_hash: raw['relay_binding_hash'],
    }),
    ...(typeof raw['signature'] === 'string' && { signature: raw['signature'] }),
  };
}

function parseModelProfileRefs(raw: unknown): ModelProfileRef[] | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const parsed: ModelProfileRef[] = [];
  for (const item of raw) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>)['id'] !== 'string' ||
      typeof (item as Record<string, unknown>)['version'] !== 'string' ||
      typeof (item as Record<string, unknown>)['hash'] !== 'string'
    ) {
      return null;
    }
    parsed.push({
      id: (item as Record<string, unknown>)['id'] as string,
      version: (item as Record<string, unknown>)['version'] as string,
      hash: (item as Record<string, unknown>)['hash'] as string,
    });
  }
  return parsed;
}

function selectModelProfile(
  propose: AfalPropose,
  supportedProfiles: ModelProfileRef[],
): ModelProfileRef | null {
  const acceptable = propose.acceptable_model_profiles ?? [];
  if (acceptable.length === 0) {
    if (!propose.model_profile_hash) return null;
    return {
      id: propose.model_profile_id,
      version: propose.model_profile_version,
      hash: propose.model_profile_hash,
    };
  }

  if (supportedProfiles.length === 0) {
    return acceptable[0] ?? null;
  }

  for (const supported of supportedProfiles) {
    const match = acceptable.find(
      (candidate) =>
        candidate.id === supported.id &&
        candidate.version === supported.version &&
        candidate.hash === supported.hash,
    );
    if (match) return match;
  }

  return null;
}
