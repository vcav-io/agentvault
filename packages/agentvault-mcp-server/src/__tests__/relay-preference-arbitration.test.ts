/**
 * Tests for relay preference arbitration (#310).
 *
 * Covers:
 * - Same relay on both sides: proceed normally
 * - Conflicting relays with REQUIRED: initiator uses responder's relay
 * - Conflicting relays with REQUIRED: responder rejects COMMIT with wrong relay
 * - Conflicting relays with PREFERRED: initiator may override, responder logs warning
 * - Missing relay_preference (old responder): initiator-chooses
 * - COMMIT carries chosen_relay_url that matches admitted preference
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { AfalResponder } from '../afal-responder.js';
import type { AdmissionPolicy } from '../afal-responder.js';
import { signMessage, verifyMessage, DOMAIN_PREFIXES, contentHash } from '../afal-signing.js';
import { computeProposalId } from '../afal-types.js';
import type { AfalPropose, RelayInvitePayload, RelaySessionBinding } from '../afal-types.js';

// ── Test keypairs ────────────────────────────────────────────────────────────

const RESPONDER_SEED = '0202020202020202020202020202020202020202020202020202020202020202';
const RESPONDER_PUBKEY = bytesToHex(ed25519.getPublicKey(hexToBytes(RESPONDER_SEED)));

const PROPOSER_SEED = '0101010101010101010101010101010101010101010101010101010101010101';
const PROPOSER_PUBKEY = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';

const RESPONDER_RELAY = 'https://relay.responder.example.com';
const INITIATOR_RELAY = 'https://relay.initiator.example.com';

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

function makeRelay(relayUrl = 'http://relay.example.com'): RelayInvitePayload {
  return {
    session_id: 'sess-001',
    responder_submit_token: 'sub-tok',
    responder_read_token: 'read-tok',
    relay_url: relayUrl,
  };
}

function makeWrappedBody(
  proposeOverrides: Partial<Omit<AfalPropose, 'proposal_id'>> = {},
  relayUrl = 'http://relay.example.com',
): { propose: Record<string, unknown>; relay: RelayInvitePayload } {
  const relay = makeRelay(relayUrl);
  const propose = makePropose({
    relay_binding_hash: contentHash(relay),
    ...proposeOverrides,
  });
  const signed = signMessage(
    DOMAIN_PREFIXES.PROPOSE,
    propose as unknown as Record<string, unknown>,
    PROPOSER_SEED,
  );
  return { propose: signed, relay };
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
    relay_session: {
      ...makeRelay(),
      contract_hash: 'c'.repeat(64),
    } satisfies RelaySessionBinding,
    ...overrides,
  };
  return signMessage(DOMAIN_PREFIXES.COMMIT, commitMsg, PROPOSER_SEED);
}

function admitAndGetIds(responder: AfalResponder): {
  tokenId: string;
  proposalId: string;
  response: Record<string, unknown>;
} {
  const body = makeWrappedBody();
  const result = responder.handlePropose(body);
  expect(result.outcome).toBe('ADMIT');
  return {
    tokenId: result.response['admit_token_id'] as string,
    proposalId: result.response['proposal_id'] as string,
    response: result.response,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Relay Preference Arbitration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── ADMIT includes relay_preference ────────────────────────────────────

  describe('ADMIT relay_preference field', () => {
    it('includes relay_preference when policy has relayPreference', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({
          relayPreference: { relay_url: RESPONDER_RELAY, policy: 'REQUIRED' },
        }),
      });

      const body = makeWrappedBody();
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('ADMIT');
      expect(result.response['relay_preference']).toEqual({
        relay_url: RESPONDER_RELAY,
        policy: 'REQUIRED',
      });
    });

    it('omits relay_preference when policy has no relayPreference (backward compat)', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy(),
      });

      const body = makeWrappedBody();
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('ADMIT');
      expect(result.response['relay_preference']).toBeUndefined();
    });

    it('relay_preference is inside the signed envelope (tamper-proof)', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({
          relayPreference: { relay_url: RESPONDER_RELAY, policy: 'PREFERRED' },
        }),
      });

      const body = makeWrappedBody();
      const result = responder.handlePropose(body);
      expect(result.outcome).toBe('ADMIT');

      // Verify the signature covers the relay_preference field
      expect(
        verifyMessage(DOMAIN_PREFIXES.ADMIT, result.response, RESPONDER_PUBKEY),
      ).toBe(true);

      // Tampering with relay_preference should break the signature
      const tampered = { ...result.response, relay_preference: { relay_url: 'https://evil.com', policy: 'REQUIRED' } };
      expect(
        verifyMessage(DOMAIN_PREFIXES.ADMIT, tampered, RESPONDER_PUBKEY),
      ).toBe(false);
    });
  });

  // ── Responder-side COMMIT enforcement ──────────────────────────────────

  describe('Responder-side COMMIT enforcement', () => {
    it('accepts COMMIT with matching chosen_relay_url (REQUIRED)', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({
          relayPreference: { relay_url: RESPONDER_RELAY, policy: 'REQUIRED' },
        }),
      });

      const { tokenId, proposalId } = admitAndGetIds(responder);
      const commit = makeSignedCommit(tokenId, proposalId, {
        chosen_relay_url: RESPONDER_RELAY,
      });
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(true);
    });

    it('rejects COMMIT with wrong chosen_relay_url when REQUIRED', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({
          relayPreference: { relay_url: RESPONDER_RELAY, policy: 'REQUIRED' },
        }),
      });

      const { tokenId, proposalId } = admitAndGetIds(responder);
      const commit = makeSignedCommit(tokenId, proposalId, {
        chosen_relay_url: INITIATOR_RELAY,
      });
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('does not match required relay');
    });

    it('rejects COMMIT with missing chosen_relay_url when REQUIRED', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({
          relayPreference: { relay_url: RESPONDER_RELAY, policy: 'REQUIRED' },
        }),
      });

      const { tokenId, proposalId } = admitAndGetIds(responder);
      // No chosen_relay_url in commit
      const commit = makeSignedCommit(tokenId, proposalId);
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('missing chosen_relay_url');
    });

    it('allows COMMIT with different chosen_relay_url when PREFERRED (logs warning)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({
          relayPreference: { relay_url: RESPONDER_RELAY, policy: 'PREFERRED' },
        }),
      });

      const { tokenId, proposalId } = admitAndGetIds(responder);
      const commit = makeSignedCommit(tokenId, proposalId, {
        chosen_relay_url: INITIATOR_RELAY,
      });
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('differs from preferred relay'),
      );
    });

    it('allows COMMIT with missing chosen_relay_url when PREFERRED (logs warning)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({
          relayPreference: { relay_url: RESPONDER_RELAY, policy: 'PREFERRED' },
        }),
      });

      const { tokenId, proposalId } = admitAndGetIds(responder);
      const commit = makeSignedCommit(tokenId, proposalId);
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('missing chosen_relay_url'),
      );
    });

    it('accepts COMMIT without chosen_relay_url when no relay preference (backward compat)', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy(),
      });

      const { tokenId, proposalId } = admitAndGetIds(responder);
      const commit = makeSignedCommit(tokenId, proposalId);
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(true);
    });

    it('same relay on both sides proceeds normally (REQUIRED)', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({
          relayPreference: { relay_url: RESPONDER_RELAY, policy: 'REQUIRED' },
        }),
      });

      const { tokenId, proposalId } = admitAndGetIds(responder);
      const commit = makeSignedCommit(tokenId, proposalId, {
        chosen_relay_url: RESPONDER_RELAY,
      });
      const result = responder.handleCommit(commit);
      expect(result.ok).toBe(true);

      const queued = responder.drainQueue();
      expect(queued).toHaveLength(1);
    });
  });

  // ── COMMIT carries chosen_relay_url ────────────────────────────────────

  describe('COMMIT chosen_relay_url field', () => {
    it('chosen_relay_url is a signed field in the COMMIT envelope', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({
          relayPreference: { relay_url: RESPONDER_RELAY, policy: 'REQUIRED' },
        }),
      });

      const { tokenId, proposalId } = admitAndGetIds(responder);
      const commit = makeSignedCommit(tokenId, proposalId, {
        chosen_relay_url: RESPONDER_RELAY,
      });

      // The signature should verify
      expect(
        verifyMessage(DOMAIN_PREFIXES.COMMIT, commit, PROPOSER_PUBKEY),
      ).toBe(true);

      // Tampering with chosen_relay_url should break the signature
      const tampered = { ...commit, chosen_relay_url: 'https://evil.com' };
      expect(
        verifyMessage(DOMAIN_PREFIXES.COMMIT, tampered, PROPOSER_PUBKEY),
      ).toBe(false);
    });
  });

  // ── AdmittedProposal persists relay preference ─────────────────────────

  describe('AdmittedProposal persistence', () => {
    it('persists relay preference alongside the admitted proposal', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy({
          relayPreference: { relay_url: RESPONDER_RELAY, policy: 'REQUIRED' },
        }),
      });

      const { tokenId, proposalId } = admitAndGetIds(responder);
      const commit = makeSignedCommit(tokenId, proposalId, {
        chosen_relay_url: RESPONDER_RELAY,
      });
      responder.handleCommit(commit);

      const queued = responder.drainQueue();
      expect(queued).toHaveLength(1);
      expect(queued[0].admittedRelayPreference).toEqual({
        relay_url: RESPONDER_RELAY,
        policy: 'REQUIRED',
      });
    });

    it('admittedRelayPreference is undefined when policy has no relayPreference', () => {
      const responder = new AfalResponder({
        agentId: 'bob-test',
        seedHex: RESPONDER_SEED,
        policy: makePolicy(),
      });

      const { tokenId, proposalId } = admitAndGetIds(responder);
      const commit = makeSignedCommit(tokenId, proposalId);
      responder.handleCommit(commit);

      const queued = responder.drainQueue();
      expect(queued).toHaveLength(1);
      expect(queued[0].admittedRelayPreference).toBeUndefined();
    });
  });
});
