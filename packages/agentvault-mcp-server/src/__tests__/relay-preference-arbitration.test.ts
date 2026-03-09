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
import { DirectAfalTransport } from '../direct-afal-transport.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { signMessage, verifyMessage, DOMAIN_PREFIXES, contentHash } from '../afal-signing.js';
import { computeProposalId, generateNonce } from '../afal-types.js';
import type { AfalPropose, RelayInvitePayload, RelayPreference, RelaySessionBinding } from '../afal-types.js';

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

// ── E2E Initiator-side tests ──────────────────────────────────────────────────
//
// These exercise the full flow through DirectAfalTransport.commitAdmit(),
// verifying that the initiator correctly applies relay preference arbitration.

function makeDescriptor(
  agentId: string,
  pubkeyHex: string,
  seedHex: string,
): AgentDescriptor {
  const unsigned: Omit<AgentDescriptor, 'signature'> = {
    descriptor_version: '1',
    agent_id: agentId,
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: '2099-12-31T23:59:59Z',
    identity_key: { algorithm: 'ed25519', public_key_hex: pubkeyHex },
    envelope_key: { algorithm: 'ed25519', public_key_hex: pubkeyHex },
    endpoints: { propose: '', commit: '' },
    capabilities: { supported_body_formats: ['wrapped_v1'], supports_commit: true },
    policy_commitments: {},
  };
  return signMessage(
    DOMAIN_PREFIXES.DESCRIPTOR,
    unsigned as Record<string, unknown>,
    seedHex,
  ) as unknown as AgentDescriptor;
}

function makeFullPropose(localDescriptor: AgentDescriptor): AfalPropose {
  const fields: Omit<AfalPropose, 'proposal_id'> = {
    proposal_version: '1',
    nonce: generateNonce(),
    timestamp: new Date().toISOString(),
    from: 'alice-test',
    to: 'bob-test',
    descriptor_hash: contentHash(localDescriptor),
    purpose_code: 'MEDIATION',
    lane_id: 'API_MEDIATED',
    output_schema_id: 'vcav_e_mediation_signal_v2',
    output_schema_version: '1',
    model_profile_id: 'api-claude-sonnet-v1',
    model_profile_version: '1',
    model_profile_hash: '',
    requested_entropy_bits: 12,
    requested_budget_tier: 'SMALL',
    admission_tier_requested: 'DEFAULT',
  };
  return { ...fields, proposal_id: computeProposalId(fields) };
}

describe('Relay Preference Arbitration — Initiator E2E', () => {
  let transportA: DirectAfalTransport;
  let transportB: DirectAfalTransport;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (transportB) await transportB.stop();
  });

  async function startResponder(
    relayPreference?: RelayPreference,
  ): Promise<string> {
    const bobDescriptor = makeDescriptor('bob-test', RESPONDER_PUBKEY, RESPONDER_SEED);

    transportB = new DirectAfalTransport({
      agentId: 'bob-test',
      seedHex: RESPONDER_SEED,
      localDescriptor: bobDescriptor,
      respondMode: {
        httpPort: 0,
        bindAddress: '127.0.0.1',
        policy: {
          trustedAgents: [{ agentId: 'alice-test', publicKeyHex: PROPOSER_PUBKEY }],
          allowedPurposeCodes: ['MEDIATION'],
          allowedLaneIds: ['API_MEDIATED'],
          maxEntropyBits: 256,
          defaultTier: 'DENY',
          ...(relayPreference ? { relayPreference } : {}),
        },
      },
    });

    await transportB.start();
    const server = transportB as unknown as { httpServer: { port: number } };
    return `http://127.0.0.1:${server.httpServer.port}/afal/descriptor`;
  }

  async function proposeAndCommit(
    peerUrl: string,
    initiatorRelayUrl?: string,
    sessionRelayUrl = 'http://relay.example.com',
  ): Promise<{ proposalId: string }> {
    const aliceDescriptor = makeDescriptor('alice-test', PROPOSER_PUBKEY, PROPOSER_SEED);

    transportA = new DirectAfalTransport({
      agentId: 'alice-test',
      seedHex: PROPOSER_SEED,
      localDescriptor: aliceDescriptor,
      peerDescriptorUrl: peerUrl,
      ...(initiatorRelayUrl ? { relayUrl: initiatorRelayUrl } : {}),
    });

    const relay: RelayInvitePayload = {
      session_id: 'sess-arb-001',
      responder_submit_token: 'submit-tok',
      responder_read_token: 'read-tok',
      relay_url: sessionRelayUrl,
    };

    const propose = makeFullPropose(aliceDescriptor);
    await transportA.sendPropose({
      propose,
      relay,
      templateId: 'mediation-demo.v1.standard',
      budgetTier: 'SMALL',
    });

    // Verify ADMIT was stored and relay_preference is visible
    const storedAdmit = transportA._getStoredAdmit(propose.proposal_id);
    expect(storedAdmit).toBeDefined();

    await transportA.commitAdmit(propose.proposal_id, {
      ...relay,
      contract_hash: 'c'.repeat(64),
    });

    return { proposalId: propose.proposal_id };
  }

  it('REQUIRED: initiator uses responder relay even when session has different relay_url', async () => {
    const peerUrl = await startResponder({
      relay_url: RESPONDER_RELAY,
      policy: 'REQUIRED',
    });

    // Initiator sends PROPOSE with a relay session pointing to a different URL.
    // commitAdmit() should override chosen_relay_url to the responder's relay,
    // so the responder accepts the COMMIT.
    await proposeAndCommit(peerUrl, undefined, INITIATOR_RELAY);

    // If we got here without throwing, the COMMIT was accepted.
    // Verify the responder queued the proposal.
    const inbox = await transportB.checkInbox();
    expect(inbox.invites).toHaveLength(1);
    expect(inbox.invites[0].from_agent_id).toBe('alice-test');
    // The committed relay_session.relay_url must be rewritten to the responder's relay
    expect(inbox.invites[0].payload['relay_url']).toBe(RESPONDER_RELAY);
  });

  it('PREFERRED: initiator overrides with explicit relayUrl config', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const peerUrl = await startResponder({
      relay_url: RESPONDER_RELAY,
      policy: 'PREFERRED',
    });

    // Initiator has an explicit relayUrl that differs from responder's preference.
    // With PREFERRED, the initiator's explicit config wins, and the responder
    // logs a warning but accepts.
    await proposeAndCommit(peerUrl, INITIATOR_RELAY, INITIATOR_RELAY);

    const inbox = await transportB.checkInbox();
    expect(inbox.invites).toHaveLength(1);

    // Responder should have logged a warning about the override
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('differs from preferred relay'),
    );
  });

  it('no relay_preference (old responder): initiator uses session relay_url', async () => {
    const peerUrl = await startResponder(undefined);

    const sessionRelay = 'http://initiator-chosen-relay.example.com';
    await proposeAndCommit(peerUrl, undefined, sessionRelay);

    const inbox = await transportB.checkInbox();
    expect(inbox.invites).toHaveLength(1);
    // The relay_url in the invite should be the session's original relay_url
    expect(inbox.invites[0].payload['relay_url']).toBe(sessionRelay);
  });
});

