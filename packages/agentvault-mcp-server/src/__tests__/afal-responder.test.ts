import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { AfalResponder, NonceCache } from '../afal-responder.js';
import type { AdmissionPolicy } from '../afal-responder.js';
import { signMessage, verifyMessage, DOMAIN_PREFIXES } from '../afal-signing.js';
import { computeProposalId } from '../afal-types.js';
import type { AfalPropose, RelayInvitePayload } from '../afal-types.js';

// ── Test keypairs ────────────────────────────────────────────────────────────

const RESPONDER_SEED = '0202020202020202020202020202020202020202020202020202020202020202';
const RESPONDER_PUBKEY = bytesToHex(ed25519.getPublicKey(hexToBytes(RESPONDER_SEED)));

const PROPOSER_SEED = '0101010101010101010101010101010101010101010101010101010101010101';
const PROPOSER_PUBKEY = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<AdmissionPolicy> = {}): AdmissionPolicy {
  return {
    trustedAgents: [{ agentId: 'alice-test', publicKeyHex: PROPOSER_PUBKEY }],
    allowedPurposeCodes: ['MEDIATION'],
    allowedLaneIds: ['API_MEDIATED'],
    maxEntropyBits: 256,
    defaultTier: 'DENY',
    ...overrides,
  };
}

function makePropose(overrides: Partial<Omit<AfalPropose, 'proposal_id'>> = {}): AfalPropose {
  const fields: Omit<AfalPropose, 'proposal_id'> = {
    proposal_version: '1',
    nonce: 'a'.repeat(64),
    timestamp: new Date().toISOString(),
    from: 'alice-test',
    to: 'bob-test',
    purpose_code: 'MEDIATION',
    lane_id: 'API_MEDIATED',
    output_schema_id: 'vcav_e_mediation_signal_v2',
    output_schema_version: '1',
    requested_budget_tier: 'SMALL',
    requested_entropy_bits: 12,
    model_profile_id: 'api-claude-sonnet-v1',
    model_profile_version: '1',
    admission_tier_requested: 'DEFAULT',
    ...overrides,
  };
  return { ...fields, proposal_id: computeProposalId(fields) };
}

function makeRelay(): RelayInvitePayload {
  return {
    session_id: 'sess-001',
    responder_submit_token: 'sub-tok',
    responder_read_token: 'read-tok',
    relay_url: 'http://relay.example.com',
  };
}

function makeWrappedBody(
  proposeOverrides: Partial<Omit<AfalPropose, 'proposal_id'>> = {},
  relayOverrides: Partial<RelayInvitePayload> = {},
): { propose: Record<string, unknown>; relay: RelayInvitePayload } {
  const propose = makePropose(proposeOverrides);
  const signed = signMessage(
    DOMAIN_PREFIXES.PROPOSE,
    propose as unknown as Record<string, unknown>,
    PROPOSER_SEED,
  );
  return { propose: signed, relay: { ...makeRelay(), ...relayOverrides } };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AfalResponder', () => {
  let responder: AfalResponder;

  beforeEach(() => {
    responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: RESPONDER_SEED,
      policy: makePolicy(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── handlePropose — happy path ──────────────────────────────────────────

  describe('handlePropose — happy path', () => {
    it('returns ADMIT for valid wrapped body', () => {
      const body = makeWrappedBody();
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('ADMIT');
    });

    it('ADMIT has fixed 7-field set', () => {
      const body = makeWrappedBody();
      const result = responder.handlePropose(body);
      const keys = Object.keys(result.response).sort();
      expect(keys).toEqual([
        'admission_tier', 'admission_version', 'admit_token_id',
        'expires_at', 'outcome', 'proposal_id', 'signature',
      ]);
    });

    it('ADMIT is signed by responder', () => {
      const body = makeWrappedBody();
      const result = responder.handlePropose(body);
      expect(verifyMessage(DOMAIN_PREFIXES.ADMIT, result.response, RESPONDER_PUBKEY)).toBe(true);
    });

    it('enqueues admitted proposal to drain queue', () => {
      const body = makeWrappedBody();
      responder.handlePropose(body);
      const queued = responder.drainQueue();
      expect(queued).toHaveLength(1);
      expect(queued[0].proposerAgentId).toBe('alice-test');
      expect(queued[0].relay.session_id).toBe('sess-001');
    });

    it('stores admit token for COMMIT verification', () => {
      const body = makeWrappedBody();
      responder.handlePropose(body);
      expect(responder._getAdmitStoreSize()).toBe(1);
    });
  });

  // ── handlePropose — DENY cases ──────────────────────────────────────────

  describe('handlePropose — DENY', () => {
    it('DENYs flat M3 body (UNSUPPORTED)', () => {
      const propose = makePropose();
      const signed = signMessage(DOMAIN_PREFIXES.PROPOSE, propose as unknown as Record<string, unknown>, PROPOSER_SEED);
      const result = responder.handlePropose(signed);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('UNSUPPORTED');
    });

    it('DENY has fixed 6-field set', () => {
      const result = responder.handlePropose({ not: 'wrapped' });
      const keys = Object.keys(result.response).sort();
      expect(keys).toEqual([
        'admission_version', 'deny_code', 'expires_at',
        'outcome', 'proposal_id', 'signature',
      ]);
    });

    it('DENY is signed by responder', () => {
      const result = responder.handlePropose(null);
      expect(verifyMessage(DOMAIN_PREFIXES.DENY, result.response, RESPONDER_PUBKEY)).toBe(true);
    });

    it('DENYs missing relay fields (UNSUPPORTED)', () => {
      const body = makeWrappedBody();
      (body.relay as unknown as Record<string, unknown>)['session_id'] = '';
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('UNSUPPORTED');
    });

    it('DENYs invalid propose fields (UNSUPPORTED)', () => {
      const body = makeWrappedBody();
      delete (body.propose as Record<string, unknown>)['from'];
      // Re-sign is needed but the signature will be wrong, however parse fails first
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('DENY');
    });

    it('DENYs tampered proposal_id (INTEGRITY)', () => {
      const body = makeWrappedBody();
      (body.propose as Record<string, unknown>)['proposal_id'] = 'f'.repeat(64);
      // Re-sign with tampered id
      const resigned = signMessage(DOMAIN_PREFIXES.PROPOSE, body.propose, PROPOSER_SEED);
      body.propose = resigned;
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('INTEGRITY');
    });

    it('DENYs wrong recipient (UNTRUSTED)', () => {
      const body = makeWrappedBody({ to: 'wrong-agent' });
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('UNTRUSTED');
    });

    it('DENYs unknown proposer (UNTRUSTED)', () => {
      const body = makeWrappedBody({ from: 'unknown-agent' });
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('UNTRUSTED');
    });

    it('DENYs unknown proposer even with LOW_TRUST defaultTier (UNTRUSTED)', () => {
      const r = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({ defaultTier: 'LOW_TRUST' }),
      });
      const body = makeWrappedBody({ from: 'unknown-agent' });
      const result = r.handlePropose(body);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('UNTRUSTED');
    });

    it('DENYs invalid signature (UNTRUSTED)', () => {
      const body = makeWrappedBody();
      (body.propose as Record<string, unknown>)['signature'] = 'f'.repeat(128);
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('UNTRUSTED');
    });

    it('DENYs stale timestamp (STALE)', () => {
      const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const body = makeWrappedBody({ timestamp: staleTime });
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('STALE');
    });

    it('DENYs replay nonce (REPLAY)', () => {
      const body1 = makeWrappedBody();
      const result1 = responder.handlePropose(body1);
      expect(result1.outcome).toBe('ADMIT');

      // Same nonce, different timestamp to avoid staleness
      const body2 = makeWrappedBody({ nonce: 'a'.repeat(64) });
      const result2 = responder.handlePropose(body2);
      expect(result2.outcome).toBe('DENY');
      expect(result2.response['deny_code']).toBe('REPLAY');
    });

    it('DENYs disallowed purpose_code (POLICY)', () => {
      const body = makeWrappedBody({ purpose_code: 'FORBIDDEN' });
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('POLICY');
    });

    it('DENYs disallowed lane_id (POLICY)', () => {
      const body = makeWrappedBody({ lane_id: 'DIRECT_CONNECT' });
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('POLICY');
    });

    it('DENYs excess entropy bits (POLICY)', () => {
      const body = makeWrappedBody({ requested_entropy_bits: 512 });
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('DENY');
      expect(result.response['deny_code']).toBe('POLICY');
    });
  });

  // ── handleCommit ────────────────────────────────────────────────────────

  describe('handleCommit', () => {
    function admitAndGetIds(): { tokenId: string; proposalId: string } {
      const body = makeWrappedBody();
      const result = responder.handlePropose(body);
      return {
        tokenId: result.response['admit_token_id'] as string,
        proposalId: result.response['proposal_id'] as string,
      };
    }

    function makeSignedCommit(
      admitTokenId: string,
      proposalId: string,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      const commitMsg: Record<string, unknown> = {
        commit_version: '1',
        proposal_id: proposalId,
        from: 'alice-test',
        admit_token_id: admitTokenId,
        ...overrides,
      };
      return signMessage(DOMAIN_PREFIXES.COMMIT, commitMsg, PROPOSER_SEED);
    }

    it('accepts valid COMMIT', () => {
      const { tokenId, proposalId } = admitAndGetIds();
      const commit = makeSignedCommit(tokenId, proposalId);
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(true);
    });

    it('removes admit token after successful COMMIT', () => {
      const { tokenId, proposalId } = admitAndGetIds();
      const commit = makeSignedCommit(tokenId, proposalId);
      responder.handleCommit(commit);
      expect(responder._getAdmitStoreSize()).toBe(0);
    });

    it('rejects unknown admit_token_id', () => {
      const { proposalId } = admitAndGetIds();
      const commit = makeSignedCommit('unknown-token', proposalId);
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Unknown or expired');
    });

    it('rejects wrong sender', () => {
      const { tokenId, proposalId } = admitAndGetIds();
      const evilSeed = '0303030303030303030303030303030303030303030303030303030303030303';
      const commitMsg: Record<string, unknown> = {
        commit_version: '1',
        proposal_id: proposalId,
        from: 'evil-agent',
        admit_token_id: tokenId,
      };
      const signed = signMessage(DOMAIN_PREFIXES.COMMIT, commitMsg, evilSeed);
      const result = responder.handleCommit(signed);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('does not match proposer');
    });

    it('rejects mismatched proposal_id', () => {
      const { tokenId } = admitAndGetIds();
      const commit = makeSignedCommit(tokenId, 'f'.repeat(64));
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('does not match ADMIT');
    });

    it('rejects invalid signature', () => {
      const { tokenId, proposalId } = admitAndGetIds();
      const commit = makeSignedCommit(tokenId, proposalId);
      commit['signature'] = '0'.repeat(128);
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('signature verification failed');
    });

    it('rejects null body', () => {
      const result = responder.handleCommit(null);
      expect(result.ok).toBe(false);
    });
  });

  // ── drainQueue ──────────────────────────────────────────────────────────

  describe('drainQueue', () => {
    it('returns and clears the queue', () => {
      responder.handlePropose(makeWrappedBody({ nonce: 'a'.repeat(64) }));
      responder.handlePropose(makeWrappedBody({ nonce: 'b'.repeat(64) }));
      const items = responder.drainQueue();
      expect(items).toHaveLength(2);
      expect(responder.drainQueue()).toHaveLength(0);
    });

    it('GC removes expired admits', () => {
      const body = makeWrappedBody();
      responder.handlePropose(body);
      expect(responder._getAdmitStoreSize()).toBe(1);

      // Fast-forward past expiry
      vi.useFakeTimers();
      vi.advanceTimersByTime(11 * 60 * 1000);
      responder.drainQueue();
      expect(responder._getAdmitStoreSize()).toBe(0);
      vi.useRealTimers();
    });
  });
});

// ── NonceCache unit tests ────────────────────────────────────────────────────

describe('NonceCache', () => {
  it('accepts first nonce', () => {
    const cache = new NonceCache();
    expect(cache.check('agent-1', 'nonce-1', Date.now())).toBe(true);
  });

  it('rejects duplicate nonce for same agent', () => {
    const cache = new NonceCache();
    const now = Date.now();
    cache.check('agent-1', 'nonce-1', now);
    expect(cache.check('agent-1', 'nonce-1', now + 1000)).toBe(false);
  });

  it('allows same nonce for different agents', () => {
    const cache = new NonceCache();
    const now = Date.now();
    cache.check('agent-1', 'nonce-1', now);
    expect(cache.check('agent-2', 'nonce-1', now)).toBe(true);
  });

  it('evicts old nonces on check', () => {
    const cache = new NonceCache({ windowMs: 5000 });
    cache.check('agent-1', 'nonce-1', 1000);
    // 10 seconds later — nonce-1 should be evicted
    expect(cache.check('agent-1', 'nonce-1', 11000)).toBe(true);
  });

  it('rejects when max per agent reached', () => {
    const cache = new NonceCache({ maxPerAgent: 2 });
    const now = Date.now();
    cache.check('agent-1', 'n1', now);
    cache.check('agent-1', 'n2', now);
    expect(cache.check('agent-1', 'n3', now)).toBe(false);
  });
});
