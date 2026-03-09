import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { DirectAfalTransport } from '../direct-afal-transport.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { AGENTVAULT_A2A_EXTENSION_URI } from '../a2a-agent-card.js';
import { signMessage, DOMAIN_PREFIXES, contentHash } from '../afal-signing.js';
import type { AfalPropose, RelayInvitePayload } from '../afal-types.js';
import { computeProposalId } from '../afal-types.js';
import {
  AGENTVAULT_ADMIT_MEDIA_TYPE,
  AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
  AGENTVAULT_CONTRACT_OFFER_SELECTION_MEDIA_TYPE,
  AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE,
  buildA2ATaskResponse,
} from '../a2a-messages.js';

// ── Test keypairs ──────────────────────────────────────────────────────────

const TEST_SEED = '0101010101010101010101010101010101010101010101010101010101010101';
const TEST_PUBKEY = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';
const PEER_SEED = '0202020202020202020202020202020202020202020202020202020202020202';
const PEER_PUBKEY = bytesToHex(ed25519.getPublicKey(hexToBytes(PEER_SEED)));

// ── Descriptor helpers ─────────────────────────────────────────────────────

function makeDescriptor(
  agentId: string,
  pubkeyHex: string,
  seedHex: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  const unsigned: Omit<AgentDescriptor, 'signature'> = {
    descriptor_version: '1',
    agent_id: agentId,
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: '2099-12-31T23:59:59Z',
    identity_key: { algorithm: 'ed25519', public_key_hex: pubkeyHex },
    envelope_key: { algorithm: 'ed25519', public_key_hex: pubkeyHex },
    endpoints: {
      propose: 'http://peer.example.com/afal/propose',
      commit: 'http://peer.example.com/afal/commit',
    },
    capabilities: {},
    policy_commitments: {},
    ...overrides,
  };
  return signMessage(
    DOMAIN_PREFIXES.DESCRIPTOR,
    unsigned as Record<string, unknown>,
    seedHex,
  ) as unknown as AgentDescriptor;
}

function makeLocalDescriptor(): AgentDescriptor {
  return makeDescriptor('alice-test', TEST_PUBKEY, TEST_SEED);
}

function makePeerDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return makeDescriptor('bob-test', PEER_PUBKEY, PEER_SEED, overrides);
}

function makeAgentCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'bob-test',
    description: 'Supports AgentVault bounded-disclosure coordination sessions',
    version: '1.0.0',
    url: 'http://peer.example.com',
    capabilities: {
      extensions: [
        {
          uri: AGENTVAULT_A2A_EXTENSION_URI,
          description: 'Supports AgentVault bounded-disclosure coordination sessions',
          required: false,
          params: {
            public_key_hex: PEER_PUBKEY,
            relay_url: 'http://relay.example.com',
            supported_purposes: ['MEDIATION'],
            a2a_send_message_url: 'http://peer.example.com/a2a/send-message',
            afal_endpoint: 'http://peer.example.com/afal',
            supports_precontract_negotiation: true,
            supported_contract_offers: [
              {
                contract_offer_id: 'agentvault.mediation.v1.standard',
                supported_model_profiles: [
                  {
                    id: 'api-claude-sonnet-v1',
                    version: '1',
                    hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
                  },
                ],
              },
            ],
          },
        },
      ],
    },
    skills: [],
    ...overrides,
  };
}

// ── AfalPropose helper ─────────────────────────────────────────────────────

function makePropose(overrides: Partial<Omit<AfalPropose, 'proposal_id'>> = {}): AfalPropose {
  const fields: Omit<AfalPropose, 'proposal_id'> = {
    proposal_version: '1',
    nonce: 'a'.repeat(64),
    timestamp: '2026-02-24T10:00:00.000Z',
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

// ── Signed ADMIT/DENY helpers ──────────────────────────────────────────────

function makeSignedAdmit(
  proposalId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const unsigned = {
    admission_version: '1',
    outcome: 'ADMIT',
    proposal_id: proposalId,
    admit_token_id: 'a'.repeat(64),
    admission_tier: 'DEFAULT',
    expires_at: '2026-01-01T00:15:00Z',
    ...overrides,
  };
  return signMessage(DOMAIN_PREFIXES.ADMIT, unsigned as Record<string, unknown>, PEER_SEED);
}

function makeSignedDeny(proposalId: string): Record<string, unknown> {
  const unsigned = {
    admission_version: '1',
    outcome: 'DENY',
    proposal_id: proposalId,
    deny_code: 'POLICY',
    expires_at: '2026-01-01T00:15:00Z',
  };
  return signMessage(DOMAIN_PREFIXES.DENY, unsigned as Record<string, unknown>, PEER_SEED);
}

// ── Test setup ─────────────────────────────────────────────────────────────

describe('DirectAfalTransport', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let transport: DirectAfalTransport;
  let localDescriptor: AgentDescriptor;
  let peerDescriptor: AgentDescriptor;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    localDescriptor = makeLocalDescriptor();
    peerDescriptor = makePeerDescriptor();

    transport = new DirectAfalTransport({
      agentId: 'alice-test',
      seedHex: TEST_SEED,
      localDescriptor,
      peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
    });

    // Pre-inject peer descriptor so most tests skip HTTP resolution
    transport._setPeerDescriptorForTesting(peerDescriptor);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── agentId ──────────────────────────────────────────────────────────────

  describe('agentId', () => {
    it('returns the configured agentId', () => {
      expect(transport.agentId).toBe('alice-test');
    });
  });

  // ── checkInbox ────────────────────────────────────────────────────────────

  describe('checkInbox', () => {
    it('returns empty invites (INITIATE mode only)', async () => {
      const result = await transport.checkInbox();
      expect(result.invites).toEqual([]);
    });

    it('does not call fetch', async () => {
      await transport.checkInbox();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── sendPropose — happy path ───────────────────────────────────────────────

  describe('sendPropose', () => {
    it('POSTs a wrapped body with signed PROPOSE and relay tokens', async () => {
      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      const relay = makeRelay();
      await transport.sendPropose({ propose, relay, templateId: 't', budgetTier: 'SMALL' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://peer.example.com/afal/propose');
      expect(init.method).toBe('POST');

      const body = JSON.parse(init.body as string) as {
        propose: Record<string, unknown>;
        relay: Record<string, unknown>;
      };
      expect(typeof body.propose['signature']).toBe('string');
      expect(body.propose['from']).toBe('alice-test');
      expect(body.propose['to']).toBe('bob-test');
      expect(body.propose['relay_binding_hash']).toBe(contentHash(body.relay));
      expect(body.relay['session_id']).toBe('sess-001');
    });

    it('stores the ADMIT for a later COMMIT', async () => {
      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await transport.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      const stored = transport._getStoredAdmit(propose.proposal_id);
      expect(stored).toBeDefined();
      expect(stored!['outcome']).toBe('ADMIT');
      expect(stored!['admit_token_id']).toBe('a'.repeat(64));
    });

    it('returns selected_model_profile from ADMIT responses', async () => {
      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id, {
        selected_model_profile: {
          id: 'api-openai-4.1-mini-v1',
          version: '1',
          hash: 'b'.repeat(64),
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      const result = await transport.sendPropose({
        propose,
        templateId: 't',
        budgetTier: 'SMALL',
      });

      expect(result?.selectedModelProfile).toEqual({
        id: 'api-openai-4.1-mini-v1',
        version: '1',
        hash: 'b'.repeat(64),
      });
    });

    it('includes descriptor_hash in wire message when present in propose', async () => {
      const customHash = 'd'.repeat(64);
      const propose = makePropose({ descriptor_hash: customHash });
      const admit = makeSignedAdmit(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await transport.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { propose: Record<string, unknown> };
      expect(body.propose['descriptor_hash']).toBe(customHash);
    });

    it('omits descriptor_hash when not in propose', async () => {
      const propose = makePropose(); // no descriptor_hash
      const admit = makeSignedAdmit(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await transport.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { propose: Record<string, unknown> };
      expect(body.propose['descriptor_hash']).toBeUndefined();
    });

    it('omits model_profile_hash when not in propose', async () => {
      const propose = makePropose(); // no model_profile_hash
      const admit = makeSignedAdmit(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await transport.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { propose: Record<string, unknown> };
      expect(body.propose['model_profile_hash']).toBeUndefined();
    });

    it('includes prev_receipt_hash when present in propose', async () => {
      const prevHash = 'e'.repeat(64);
      const propose = makePropose({ prev_receipt_hash: prevHash });
      const admit = makeSignedAdmit(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await transport.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { propose: Record<string, unknown> };
      expect(body.propose['prev_receipt_hash']).toBe(prevHash);
    });

    it('omits prev_receipt_hash when absent from propose', async () => {
      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await transport.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { propose: Record<string, unknown> };
      expect('prev_receipt_hash' in body.propose).toBe(false);
    });

    it('rejects a valid descriptor for the wrong peer agent_id', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makePeerDescriptor({ agent_id: 'mallory-test' })),
      });

      const propose = makePropose({ to: 'bob-test' });
      await expect(
        fresh.sendPropose({ propose, relay: makeRelay(), templateId: 't', budgetTier: 'SMALL' }),
      ).rejects.toThrow('Peer descriptor identity mismatch');
    });

    it('ADMIT succeeds when propose has no descriptor_hash or model_profile_hash (regression)', async () => {
      // This test covers the bug where _sendProposeOnce injected descriptor_hash
      // and model_profile_hash post-hoc, breaking proposal_id integrity on the receiver.
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
      });

      const propose = makePropose(); // has no descriptor_hash or model_profile_hash
      const admit = makeSignedAdmit(propose.proposal_id);

      // Agent Card probe misses, then fall back to signed descriptor fetch
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
      // descriptor fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(peerDescriptor),
      });
      // propose → ADMIT
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await fresh.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      // Verify the wire message did NOT include descriptor_hash or model_profile_hash
      const sentBody = JSON.parse(mockFetch.mock.calls[2][1].body as string);
      expect(sentBody.propose['descriptor_hash']).toBeUndefined();
      expect(sentBody.propose['model_profile_hash']).toBeUndefined();

      // Verify ADMIT was stored
      expect(fresh._getStoredAdmit(propose.proposal_id)).toBeDefined();
    });
  });

  // ── sendPropose — DENY ────────────────────────────────────────────────────

  describe('sendPropose — DENY response', () => {
    it('throws with "denied" when peer returns valid signed DENY', async () => {
      const propose = makePropose();
      const deny = makeSignedDeny(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(deny),
      });

      await expect(
        transport.sendPropose({
          propose,
          relay: makeRelay(),
          templateId: 't',
          budgetTier: 'SMALL',
        }),
      ).rejects.toThrow(/Proposal denied \(deny_code=/);
    });

    it('does not store anything when denied', async () => {
      const propose = makePropose();
      const deny = makeSignedDeny(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(deny),
      });

      try {
        await transport.sendPropose({
          propose,
          relay: makeRelay(),
          templateId: 't',
          budgetTier: 'SMALL',
        });
      } catch {
        // expected
      }

      expect(transport._getStoredAdmit(propose.proposal_id)).toBeUndefined();
    });
  });

  // ── sendPropose — invalid signatures ──────────────────────────────────────

  describe('sendPropose — invalid ADMIT signature', () => {
    it('throws when ADMIT signature is invalid', async () => {
      const propose = makePropose();
      const tampered = {
        ...makeSignedAdmit(propose.proposal_id),
        outcome: 'ADMIT',
        admit_token_id: 'evil-token',
        signature: 'f'.repeat(128),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(tampered),
      });

      await expect(
        transport.sendPropose({
          propose,
          relay: makeRelay(),
          templateId: 't',
          budgetTier: 'SMALL',
        }),
      ).rejects.toThrow('ADMIT signature verification failed');
    });

    it('throws when DENY signature is invalid', async () => {
      const propose = makePropose();
      const tampered = {
        ...makeSignedDeny(propose.proposal_id),
        outcome: 'DENY',
        deny_code: 'INJECTED',
        signature: '0'.repeat(128),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(tampered),
      });

      await expect(
        transport.sendPropose({
          propose,
          relay: makeRelay(),
          templateId: 't',
          budgetTier: 'SMALL',
        }),
      ).rejects.toThrow('DENY signature verification failed');
    });
  });

  // ── sendPropose — HTTP errors ─────────────────────────────────────────────

  describe('sendPropose — HTTP errors', () => {
    it('throws on non-200 response', async () => {
      const propose = makePropose();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad Request'),
      });

      await expect(
        transport.sendPropose({
          propose,
          relay: makeRelay(),
          templateId: 't',
          budgetTier: 'SMALL',
        }),
      ).rejects.toThrow('PROPOSE rejected: 400 Bad Request');
    });

    it('throws on unexpected outcome', async () => {
      const propose = makePropose();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ outcome: 'REDIRECT', location: 'http://evil.example.com' }),
      });

      await expect(
        transport.sendPropose({
          propose,
          relay: makeRelay(),
          templateId: 't',
          budgetTier: 'SMALL',
        }),
      ).rejects.toThrow('Unexpected response outcome: REDIRECT');
    });
  });

  // ── commitAdmit ─────────────────────────────────────────────────────────

  describe('commitAdmit', () => {
    it('sends a signed COMMIT to the peer commit endpoint', async () => {
      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);
      const relaySession = { ...makeRelay(), contract_hash: 'c'.repeat(64) };

      // Seed the stored ADMIT manually
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });
      await transport.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      // Now send COMMIT
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
      await transport.commitAdmit!(propose.proposal_id, relaySession);

      // Should have been called twice total
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const [url, init] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(url).toBe('http://peer.example.com/afal/commit');
      expect(init.method).toBe('POST');

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['from']).toBe('alice-test');
      expect(body['admit_token_id']).toBe('a'.repeat(64));
      expect(body['proposal_id']).toBe(propose.proposal_id);
      expect(body['relay_session']).toEqual(relaySession);
      expect(typeof body['signature']).toBe('string');
    });

    it('removes stored ADMIT after successful COMMIT', async () => {
      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);
      const relaySession = { ...makeRelay(), contract_hash: 'c'.repeat(64) };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });
      await transport.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
      await transport.commitAdmit!(propose.proposal_id, relaySession);

      expect(transport._getStoredAdmit(propose.proposal_id)).toBeUndefined();
    });

    it('throws when no stored ADMIT exists for the proposal_id', async () => {
      await expect(
        transport.commitAdmit!('no-such-proposal-id', { ...makeRelay(), contract_hash: 'c'.repeat(64) }),
      ).rejects.toThrow(
        'No stored ADMIT for proposal_id: no-such-proposal-id',
      );
    });

    it('throws when COMMIT endpoint returns non-200', async () => {
      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);
      const relaySession = { ...makeRelay(), contract_hash: 'c'.repeat(64) };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });
      await transport.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: () => Promise.resolve('Conflict'),
      });

      await expect(transport.commitAdmit!(propose.proposal_id, relaySession)).rejects.toThrow(
        'COMMIT rejected: 409 Conflict',
      );
    });

    it('sends relay session tokens over A2A SendMessage for A2A-only peers', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-card.json',
      });

      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);
      const relaySession = { ...makeRelay(), contract_hash: 'c'.repeat(64) };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            makeAgentCard({
              capabilities: {
                extensions: [
                  {
                    uri: AGENTVAULT_A2A_EXTENSION_URI,
                    params: {
                      public_key_hex: PEER_PUBKEY,
                      relay_url: 'http://relay.example.com',
                      supported_purposes: ['MEDIATION'],
                    },
                  },
                ],
              },
            }),
          ),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            buildA2ATaskResponse({
              mediaType: AGENTVAULT_ADMIT_MEDIA_TYPE,
              data: admit,
            }),
          ),
      });
      await fresh.sendPropose({
        propose,
        templateId: 't',
        budgetTier: 'SMALL',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            buildA2ATaskResponse({
              mediaType: AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE,
              data: { ok: true },
            }),
          ),
      });

      await fresh.commitAdmit!(propose.proposal_id, relaySession);

      expect(mockFetch.mock.calls[2]?.[0]).toBe('http://peer.example.com/a2a/send-message');
    });
  });

  // ── resolvePeerDescriptor — caching ───────────────────────────────────────

  describe('resolvePeerDescriptor', () => {
    it('returns relay and purpose metadata from Agent Card discovery', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeAgentCard()),
      });

      await expect(fresh.discoverPeerAgentCard('bob-test')).resolves.toEqual({
        a2aSendMessageUrl: 'http://peer.example.com/a2a/send-message',
        afalEndpoint: 'http://peer.example.com/afal',
        relayUrl: 'http://relay.example.com',
        supportedPurposes: ['MEDIATION'],
        supportsPrecontractNegotiation: true,
        supportedContractOffers: [
          {
            contract_offer_id: 'agentvault.mediation.v1.standard',
            supported_model_profiles: [
              {
                id: 'api-claude-sonnet-v1',
                version: '1',
                hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
              },
            ],
          },
        ],
      });
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0]?.[0]).toBe('http://peer.example.com/.well-known/agent-card.json');
    });

    it('prefers Agent Card discovery before AFAL descriptor fetch', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
      });

      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeAgentCard()),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await fresh.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]?.[0]).toBe('http://peer.example.com/.well-known/agent-card.json');
      expect(mockFetch.mock.calls[1]?.[0]).toBe('http://peer.example.com/afal/propose');
    });

    it('discovers negotiation capability from the Agent Card extension', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeAgentCard()),
      });

      const discovery = await transport.discoverPeerAgentCard('bob-test');
      expect(discovery?.supportsPrecontractNegotiation).toBe(true);
      expect(discovery?.supportedContractOffers?.[0]?.contract_offer_id).toBe(
        'agentvault.mediation.v1.standard',
      );
    });

    it('sends contract-offer proposals over A2A and parses agreed selections', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-card.json',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeAgentCard()),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            buildA2ATaskResponse({
              mediaType: AGENTVAULT_CONTRACT_OFFER_SELECTION_MEDIA_TYPE,
              data: {
                negotiation_id: 'neg-123',
                state: 'AGREED',
                selected_contract_offer_id: 'agentvault.mediation.v1.standard',
                selected_model_profile: {
                  id: 'api-claude-sonnet-v1',
                  version: '1',
                  hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
                },
              },
            }),
          ),
      });

      const selection = await fresh.negotiateContractOffer({
        negotiation_id: 'neg-123',
        acceptable_offers: [
          {
            kind: 'offer',
            contract_offer_id: 'agentvault.mediation.v1.standard',
            acceptable_model_profiles: [
              {
                id: 'api-claude-sonnet-v1',
                version: '1',
                hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
              },
            ],
          },
        ],
        expected_counterparty: 'bob-test',
      });

      expect(selection?.state).toBe('AGREED');
      const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      const params = body['params'] as Record<string, unknown>;
      const message = params['message'] as Record<string, unknown>;
      const parts = message['parts'] as Array<Record<string, unknown>>;
      expect(parts[0]?.['media_type']).toBe(AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE);
    });

    it('falls back to signed descriptor capabilities and POST /afal/negotiate for direct peers', async () => {
      const freshPeerDescriptor = makePeerDescriptor({
        endpoints: {
          propose: 'http://peer.example.com/afal/propose',
          commit: 'http://peer.example.com/afal/commit',
          negotiate: 'http://peer.example.com/afal/negotiate',
        },
        capabilities: {
          supported_contract_offers: [
            {
              contract_offer_id: 'agentvault.mediation.v1.standard',
              supported_model_profiles: [
                {
                  id: 'api-claude-sonnet-v1',
                  version: '1',
                  hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
                },
              ],
            },
          ],
        },
      });
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(freshPeerDescriptor),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            negotiation_id: 'neg-123',
            state: 'AGREED',
            selected_contract_offer_id: 'agentvault.mediation.v1.standard',
            selected_model_profile: {
              id: 'api-claude-sonnet-v1',
              version: '1',
              hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
            },
          }),
      });

      const discovery = await fresh.discoverPeerAgentCard('bob-test');
      expect(discovery?.supportsPrecontractNegotiation).toBe(true);

      const selection = await fresh.negotiateContractOffer({
        negotiation_id: 'neg-123',
        acceptable_offers: [
          {
            kind: 'offer',
            contract_offer_id: 'agentvault.mediation.v1.standard',
            acceptable_model_profiles: [
              {
                id: 'api-claude-sonnet-v1',
                version: '1',
                hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
              },
            ],
          },
        ],
        expected_counterparty: 'bob-test',
      });

      expect(selection?.state).toBe('AGREED');
      const [url, init] = mockFetch.mock.calls[2] as [string, RequestInit];
      expect(url).toBe('http://peer.example.com/afal/negotiate');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toMatchObject({
        negotiation_id: 'neg-123',
      });
    });

    it('derives /afal/negotiate from the propose endpoint when no explicit negotiate endpoint is present', async () => {
      const freshPeerDescriptor = makePeerDescriptor({
        endpoints: {
          propose: 'http://peer.example.com/afal/propose',
          commit: 'http://peer.example.com/afal/commit',
        },
        capabilities: {
          supported_contract_offers: [
            {
              contract_offer_id: 'agentvault.mediation.v1.standard',
              supported_model_profiles: [
                {
                  id: 'api-claude-sonnet-v1',
                  version: '1',
                  hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
                },
              ],
            },
          ],
        },
      });
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(freshPeerDescriptor),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            negotiation_id: 'neg-124',
            state: 'AGREED',
            selected_contract_offer_id: 'agentvault.mediation.v1.standard',
            selected_model_profile: {
              id: 'api-claude-sonnet-v1',
              version: '1',
              hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
            },
          }),
      });

      const selection = await fresh.negotiateContractOffer({
        negotiation_id: 'neg-124',
        acceptable_offers: [
          {
            kind: 'offer',
            contract_offer_id: 'agentvault.mediation.v1.standard',
            acceptable_model_profiles: [
              {
                id: 'api-claude-sonnet-v1',
                version: '1',
                hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
              },
            ],
          },
        ],
        expected_counterparty: 'bob-test',
      });

      expect(selection?.state).toBe('AGREED');
      const [url] = mockFetch.mock.calls[2] as [string, RequestInit];
      expect(url).toBe('http://peer.example.com/afal/negotiate');
    });

    it('rejects mismatched negotiation_id echoes from A2A negotiation responses', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-card.json',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeAgentCard()),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            buildA2ATaskResponse({
              mediaType: AGENTVAULT_CONTRACT_OFFER_SELECTION_MEDIA_TYPE,
              data: {
                negotiation_id: 'wrong-negotiation',
                state: 'AGREED',
                selected_contract_offer_id: 'agentvault.mediation.v1.standard',
                selected_model_profile: {
                  id: 'api-claude-sonnet-v1',
                  version: '1',
                  hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
                },
              },
            }),
          ),
      });

      await expect(
        fresh.negotiateContractOffer({
          negotiation_id: 'neg-123',
          acceptable_offers: [
            {
              kind: 'offer',
              contract_offer_id: 'agentvault.mediation.v1.standard',
              acceptable_model_profiles: [
                {
                  id: 'api-claude-sonnet-v1',
                  version: '1',
                  hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
                },
              ],
            },
          ],
          expected_counterparty: 'bob-test',
        }),
      ).rejects.toThrow('mismatched negotiation_id');
    });

    it('uses A2A SendMessage when the Agent Card omits afal_endpoint', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-card.json',
      });

      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            makeAgentCard({
              capabilities: {
                extensions: [
                  {
                    uri: AGENTVAULT_A2A_EXTENSION_URI,
                    params: {
                      public_key_hex: PEER_PUBKEY,
                      relay_url: 'http://relay.example.com',
                      supported_purposes: ['MEDIATION'],
                      a2a_send_message_url: 'http://peer.example.com/custom-a2a',
                    },
                  },
                ],
              },
            }),
          ),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            buildA2ATaskResponse({
              mediaType: AGENTVAULT_ADMIT_MEDIA_TYPE,
              data: admit,
            }),
          ),
      });

      await fresh.sendPropose({
        propose,
        templateId: 't',
        budgetTier: 'SMALL',
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1]?.[0]).toBe('http://peer.example.com/custom-a2a');
      const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['method']).toBe('SendMessage');
    });

    it('falls back to signed AFAL descriptor when no AgentVault A2A extension is present', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
      });

      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'bob-test', capabilities: { extensions: [] } }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(peerDescriptor),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await fresh.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[0]?.[0]).toBe('http://peer.example.com/.well-known/agent-card.json');
      expect(mockFetch.mock.calls[1]?.[0]).toBe('http://peer.example.com/afal/descriptor');
      expect(mockFetch.mock.calls[2]?.[0]).toBe('http://peer.example.com/afal/propose');
    });

    it('rejects Agent Card discovery for the wrong peer agent_id', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeAgentCard({ name: 'mallory-test' })),
      });

      const propose = makePropose({ to: 'bob-test' });
      await expect(
        fresh.sendPropose({ propose, relay: makeRelay(), templateId: 't', budgetTier: 'SMALL' }),
      ).rejects.toThrow('Peer agent card identity mismatch');
    });

    it('rejects purposes the peer Agent Card does not advertise', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            makeAgentCard({
              capabilities: {
                extensions: [
                  {
                    uri: AGENTVAULT_A2A_EXTENSION_URI,
                    params: {
                      public_key_hex: PEER_PUBKEY,
                      relay_url: 'http://relay.example.com',
                      supported_purposes: ['COMPATIBILITY'],
                      afal_endpoint: 'http://peer.example.com/afal',
                    },
                  },
                ],
              },
            }),
          ),
      });

      await expect(
        fresh.sendPropose({
          propose: makePropose({ purpose_code: 'MEDIATION' }),
          relay: makeRelay(),
          templateId: 't',
          budgetTier: 'SMALL',
        }),
      ).rejects.toThrow('Peer agent card does not advertise support for purpose_code "MEDIATION"');
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('fetches descriptor on first sendPropose when not pre-injected', async () => {
      // Create fresh transport without pre-injected descriptor
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
      });

      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);

      // First call: agent card probe (falls back)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      // Second call: descriptor fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(peerDescriptor),
      });
      // Third call: propose POST
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await fresh.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const [descriptorUrl] = mockFetch.mock.calls[1] as [string];
      expect(descriptorUrl).toBe('http://peer.example.com/.well-known/agent-descriptor.json');
    });

    it('caches the descriptor across multiple sendPropose calls', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
      });

      // First resolution: agent card probe + descriptor + propose
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(peerDescriptor),
      });
      const propose1 = makePropose({ nonce: 'a'.repeat(64) });
      const admit1 = makeSignedAdmit(propose1.proposal_id);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit1),
      });
      await fresh.sendPropose({
        propose: propose1,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      // Second sendPropose: should NOT re-fetch descriptor
      const propose2 = makePropose({ nonce: 'b'.repeat(64) });
      const admit2 = makeSignedAdmit(propose2.proposal_id);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit2),
      });
      await fresh.sendPropose({
        propose: propose2,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      // 4 calls total: 1 agent card probe + 1 descriptor + 2 propose POSTs
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('re-fetches descriptor when cached one has expired', async () => {
      const expiredDescriptor = makePeerDescriptor({ expires_at: '2000-01-01T00:00:00Z' });
      transport._setPeerDescriptorForTesting(expiredDescriptor);

      const propose = makePropose();
      const admit = makeSignedAdmit(propose.proposal_id);

      // First call: agent card probe (falls back)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      // Second call: re-fetch expired descriptor
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(peerDescriptor),
      });
      // Third call: propose POST
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      });

      await transport.sendPropose({
        propose,
        relay: makeRelay(),
        templateId: 't',
        budgetTier: 'SMALL',
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('rejects descriptor with invalid signature', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
      });

      // Return a descriptor with a tampered signature
      const badDescriptor = { ...peerDescriptor, agent_id: 'evil-agent' };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(badDescriptor),
      });

      const propose = makePropose();
      await expect(
        fresh.sendPropose({ propose, relay: makeRelay(), templateId: 't', budgetTier: 'SMALL' }),
      ).rejects.toThrow('Peer descriptor signature verification failed');
    });

    it('rejects a valid descriptor for the wrong peer agent_id', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makePeerDescriptor({ agent_id: 'mallory-test' })),
      });

      const propose = makePropose({ to: 'bob-test' });
      await expect(
        fresh.sendPropose({ propose, relay: makeRelay(), templateId: 't', budgetTier: 'SMALL' }),
      ).rejects.toThrow('Peer descriptor identity mismatch');
    });

    it('throws when no peerDescriptorUrl is configured', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        // no peerDescriptorUrl
      });

      const propose = makePropose();
      await expect(
        fresh.sendPropose({ propose, relay: makeRelay(), templateId: 't', budgetTier: 'SMALL' }),
      ).rejects.toThrow('Cannot initiate: no peer connection configured');
    });

    it('rejects fetched descriptor with expired expires_at', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
      });

      const expiredPeer = makePeerDescriptor({ expires_at: '2000-01-01T00:00:00Z' });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(expiredPeer),
      });

      const propose = makePropose();
      await expect(
        fresh.sendPropose({ propose, relay: makeRelay(), templateId: 't', budgetTier: 'SMALL' }),
      ).rejects.toThrow(/Fetched peer descriptor expired or invalid expires_at/);
    });

    it('throws when descriptor fetch returns non-200', async () => {
      const fresh = new DirectAfalTransport({
        agentId: 'alice-test',
        seedHex: TEST_SEED,
        localDescriptor,
        peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const propose = makePropose();
      await expect(
        fresh.sendPropose({ propose, relay: makeRelay(), templateId: 't', budgetTier: 'SMALL' }),
      ).rejects.toThrow('Failed to fetch peer descriptor: 404');
    });
  });

  // ── RESPOND mode ──────────────────────────────────────────────────────────

  describe('RESPOND mode', () => {
    let respondTransport: DirectAfalTransport;

    beforeEach(() => {
      respondTransport = new DirectAfalTransport({
        agentId: 'bob-test',
        seedHex: PEER_SEED,
        localDescriptor: peerDescriptor,
        respondMode: {
          httpPort: 0,
          policy: {
            trustedAgents: [{ agentId: 'alice-test', publicKeyHex: TEST_PUBKEY }],
            allowedPurposeCodes: ['MEDIATION'],
            allowedLaneIds: ['API_MEDIATED'],
            maxEntropyBits: 256,
            defaultTier: 'DENY',
          },
        },
      });
    });

    it('checkInbox returns empty when no proposals received', async () => {
      const result = await respondTransport.checkInbox();
      expect(result.invites).toEqual([]);
    });

    it('acceptInvite is a no-op in RESPOND mode', async () => {
      // Should not throw
      await respondTransport.acceptInvite('any-id');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

// ── End-to-end: proposal_id integrity via AfalResponder ────────────────────

import { AfalResponder } from '../afal-responder.js';

describe('proposal_id integrity (end-to-end)', () => {
  it('responder ADMITs when optional hashable fields are absent', () => {
    // End-to-end: build propose like phaseInvite (no descriptor_hash,
    // no model_profile_hash), sign it, send to AfalResponder, verify ADMIT.

    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: PEER_SEED,
      policy: {
        trustedAgents: [{ agentId: 'alice-test', publicKeyHex: TEST_PUBKEY }],
        allowedPurposeCodes: ['MEDIATION'],
        allowedLaneIds: ['API_MEDIATED'],
        maxEntropyBits: 256,
        defaultTier: 'DENY',
      },
    });

    // Use fresh timestamp to avoid STALE rejection
    const relay = makeRelay();
    const propose = makePropose({
      timestamp: new Date().toISOString(),
      relay_binding_hash: contentHash(relay),
    });
    const signed = signMessage(
      DOMAIN_PREFIXES.PROPOSE,
      propose as unknown as Record<string, unknown>,
      TEST_SEED,
    );
    const body = { propose: signed, relay };
    const result = responder.handlePropose(body);
    expect(result.outcome).toBe('ADMIT');
  });

  it('responder DENYs with INTEGRITY when descriptor_hash is injected post-hoc', () => {
    // Reproduces the original bug: propose computed without descriptor_hash,
    // but wire message includes it → proposal_id mismatch → DENY.
    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: PEER_SEED,
      policy: {
        trustedAgents: [{ agentId: 'alice-test', publicKeyHex: TEST_PUBKEY }],
        allowedPurposeCodes: ['MEDIATION'],
        allowedLaneIds: ['API_MEDIATED'],
        maxEntropyBits: 256,
        defaultTier: 'DENY',
      },
    });

    // Use fresh timestamp to avoid STALE rejection
    const propose = makePropose({ timestamp: new Date().toISOString() });
    // Inject descriptor_hash post-hoc (the old bug)
    const tamperedPropose = {
      ...(propose as unknown as Record<string, unknown>),
      descriptor_hash: 'injected-hash',
    };
    const signed = signMessage(DOMAIN_PREFIXES.PROPOSE, tamperedPropose, TEST_SEED);
    const body = { propose: signed, relay: makeRelay() };
    const result = responder.handlePropose(body);
    expect(result.outcome).toBe('DENY');
    expect(result.response['deny_code']).toBe('INTEGRITY');
  });
});
