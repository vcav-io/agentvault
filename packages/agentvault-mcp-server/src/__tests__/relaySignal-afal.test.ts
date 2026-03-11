/**
 * Tests for AFAL-shaped relay signal behavior.
 *
 * These test the integration of AfalTransport into relaySignal — verifying
 * that INITIATE builds AfalPropose and RESPOND extracts it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleRelaySignal, _setDiscoverPollConfigForTesting } from '../tools/relaySignal.js';
import { _resetHandlesForTesting } from '../tools/relayHandles.js';
import type { AfalTransport, AfalInviteMessage } from '../afal-transport.js';
import type { AfalPropose } from '../afal-types.js';
import { computeProposalId } from '../afal-types.js';
import { DirectAfalTransport } from '../direct-afal-transport.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { AGENTVAULT_A2A_EXTENSION_URI } from '../a2a-agent-card.js';
import { signMessage, DOMAIN_PREFIXES } from '../afal-signing.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { ed25519 } from '@noble/curves/ed25519';
import { createAndSubmit } from 'agentvault-client';

// Mock agentvault-client to avoid real HTTP calls
vi.mock('agentvault-client', () => ({
  createAndSubmit: vi.fn().mockResolvedValue({
    sessionId: 'sess-mock',
    contractHash: 'hash-mock',
    initiatorReadToken: 'init-read-tok',
    responderSubmitToken: 'resp-sub-tok',
    responderReadToken: 'resp-read-tok',
  }),
  pollUntilDone: vi.fn().mockResolvedValue({ state: 'WAITING' }),
  joinAndWait: vi.fn(),
}));

vi.mock('agentvault-client/http', () => ({
  submitInput: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('agentvault-client/contracts', () => ({
  buildRelayContract: vi.fn().mockImplementation((
    purpose: string,
    participants: string[],
    modelProfileId?: string,
  ) => {
    if (purpose === 'MEDIATION') {
      return {
        purpose_code: 'MEDIATION',
        output_schema_id: 'vcav_e_mediation_signal_v2',
        participants,
        entropy_budget_bits: 12,
        model_profile_id: modelProfileId ?? 'api-claude-sonnet-v1',
        model_profile_hash:
          modelProfileId === 'api-gpt41mini-v1'
            ? 'gpt41mini-hash'
            : modelProfileId === 'api-gemini3flash-v1'
              ? 'gemini3flash-hash'
              : '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
        metadata: { scenario: 'cofounder-mediation', version: '3' },
      };
    }
    return undefined;
  }),
  listRelayPurposes: vi.fn().mockReturnValue(['MEDIATION', 'COMPATIBILITY']),
  computeRelayContractHash: vi.fn().mockReturnValue('relay-hash-mock'),
  withRelayContractModelProfile: vi.fn().mockImplementation((contract, profile) => ({
    ...contract,
    model_profile_id: profile.id,
    model_profile_hash: profile.hash,
  })),
}));

function createMockAfalTransport(invites: AfalInviteMessage[] = []): AfalTransport {
  return {
    sendPropose: vi.fn().mockResolvedValue(undefined),
    checkInbox: vi.fn().mockResolvedValue({ invites }),
    peekInbox: vi.fn().mockResolvedValue({ invites }),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    agentId: 'alice-demo',
  };
}

const TEST_SEED = '0101010101010101010101010101010101010101010101010101010101010101';
const TEST_PUBKEY = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';
const PEER_SEED = '0202020202020202020202020202020202020202020202020202020202020202';
const PEER_PUBKEY = bytesToHex(ed25519.getPublicKey(hexToBytes(PEER_SEED)));

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
  return makeDescriptor('alice-demo', TEST_PUBKEY, TEST_SEED);
}

function makeSignedAdmit(
  proposalId: string,
  selectedModelProfile?: { id: string; version: string; hash: string },
): Record<string, unknown> {
  return signMessage(
    DOMAIN_PREFIXES.ADMIT,
    {
      admission_version: '1',
      outcome: 'ADMIT',
      proposal_id: proposalId,
      admit_token_id: 'a'.repeat(64),
      admission_tier: 'DEFAULT',
      expires_at: '2026-01-01T00:15:00Z',
      ...(selectedModelProfile ? { selected_model_profile: selectedModelProfile } : {}),
    },
    PEER_SEED,
  );
}

beforeEach(() => {
  _resetHandlesForTesting();
  // Disable bounded polling — single check, no sleep
  _setDiscoverPollConfigForTesting(0, 0);
  process.env['AV_RELAY_URL'] = 'http://relay.test';
  process.env['AV_AGENT_ID'] = 'alice-demo';
  vi.mocked(createAndSubmit).mockClear();
});

afterEach(() => {
  _setDiscoverPollConfigForTesting(30_000, 3_000);
});

describe('INITIATE with AFAL', () => {
  it('constructs AfalPropose with correct fields from purpose', async () => {
    const transport = createMockAfalTransport();

    await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    expect(transport.sendPropose).toHaveBeenCalledOnce();
    const call = vi.mocked(transport.sendPropose).mock.calls[0][0];
    const propose = call.propose;

    expect(propose.proposal_version).toBe('1');
    expect(propose.from).toBe('alice-demo');
    expect(propose.to).toBe('bob-demo');
    expect(propose.purpose_code).toBe('MEDIATION');
    expect(propose.lane_id).toBe('API_MEDIATED');
    expect(propose.output_schema_id).toBe('vcav_e_mediation_signal_v2');
    expect(propose.output_schema_version).toBe('1');
    expect(propose.requested_entropy_bits).toBe(12);
    expect(propose.model_profile_id).toBe('api-claude-sonnet-v1');
    expect(propose.model_profile_version).toBe('1');
    expect(propose.admission_tier_requested).toBe('DEFAULT');
    expect(propose.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(propose.proposal_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sends propose via adapter with relay tokens', async () => {
    const transport = createMockAfalTransport();

    await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    const call = vi.mocked(transport.sendPropose).mock.calls[0][0];
    expect(call.relay?.session_id).toBe('sess-mock');
    expect(call.relay?.responder_submit_token).toBe('resp-sub-tok');
    expect(call.relay?.responder_read_token).toBe('resp-read-tok');
    expect(call.templateId).toBe('mediation-demo.v1.standard');
    expect(call.budgetTier).toBe('SMALL');
  });

  it('proposal_id is stable (recomputable from same fields)', async () => {
    const transport = createMockAfalTransport();

    await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    const call = vi.mocked(transport.sendPropose).mock.calls[0][0];
    const propose = call.propose;

    // Recompute proposal_id from the propose fields
    const { proposal_id: _id, ...fields } = propose;
    const recomputed = computeProposalId(fields);
    expect(recomputed).toBe(propose.proposal_id);
  });

  it('uses peer Agent Card relay_url for direct AFAL when no relay_url was provided', async () => {
    delete process.env['AV_RELAY_URL'];
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const transport = new DirectAfalTransport({
      agentId: 'alice-demo',
      seedHex: TEST_SEED,
      localDescriptor: makeLocalDescriptor(),
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: 'bob-demo',
          capabilities: {
            extensions: [
              {
                uri: AGENTVAULT_A2A_EXTENSION_URI,
                params: {
                  public_key_hex: PEER_PUBKEY,
                  relay_url: 'http://relay.from.card',
                  supported_purposes: ['MEDIATION'],
                  afal_endpoint: 'http://peer.example.com/afal',
                },
              },
            ],
          },
        }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeSignedAdmit('d'.repeat(64))),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('ok'),
    });

    await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    expect(vi.mocked(createAndSubmit)).toHaveBeenCalledWith(
      { relay_url: 'http://relay.from.card' },
      expect.any(Object),
      'hello',
      'initiator',
    );
  });

  it('does not reject collision redirect against a stale pre-negotiation contract hash', async () => {
    const transport = createMockAfalTransport([
      {
        invite_id: 'inv-1',
        from_agent_id: 'bob-demo',
        template_id: 'compatibility-demo.v1.standard',
        contract_hash: 'negotiated-hash-from-peer',
        payload_type: 'VCAV_E_INVITE_V1',
        payload: {
          session_id: 'sess-123',
          responder_submit_token: 'resp-submit',
          responder_read_token: 'resp-read',
          relay_url: 'http://relay.test',
        },
        afalPropose: {
          purpose_code: 'MEDIATION',
        } as AfalPropose,
      },
    ]);

    const result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );
    const data = result.data as unknown as Record<string, unknown>;

    expect(result.status).toBe('PENDING');
    expect(data['phase']).toBe('JOIN');
    expect(data['from']).toBe('bob-demo');
    expect(data['contract_hash']).toBe('negotiated-hash-from-peer');
  });

  it('adopts the counterparty purpose on collision redirect when the local purpose differs', async () => {
    const transport = createMockAfalTransport([
      {
        invite_id: 'inv-2',
        from_agent_id: 'bob-demo',
        template_id: 'mediation-demo.v1.standard',
        contract_hash: 'peer-mediation-hash',
        payload_type: 'VCAV_E_INVITE_V1',
        payload: {
          session_id: 'sess-456',
          responder_submit_token: 'resp-submit',
          responder_read_token: 'resp-read',
          relay_url: 'http://relay.test',
        },
        afalPropose: {
          purpose_code: 'MEDIATION',
        } as AfalPropose,
      },
    ]);

    const result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'COMPATIBILITY', my_input: 'hello' },
      transport,
    );
    const data = result.data as unknown as Record<string, unknown>;

    expect(result.status).toBe('PENDING');
    expect(data['phase']).toBe('JOIN');
    expect(data['from']).toBe('bob-demo');
    expect(data['contract_hash']).toBe('peer-mediation-hash');
    expect(data['purpose_override']).toEqual({
      requested_purpose: 'COMPATIBILITY',
      adopted_purpose: 'MEDIATION',
    });
  });

  it('negotiates a contract offer before bootstrap when the peer advertises negotiation', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const transport = new DirectAfalTransport({
      agentId: 'alice-demo',
      seedHex: TEST_SEED,
      localDescriptor: makeLocalDescriptor(),
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: 'bob-demo',
          capabilities: {
            extensions: [
              {
                uri: AGENTVAULT_A2A_EXTENSION_URI,
                params: {
                  public_key_hex: PEER_PUBKEY,
                  relay_url: 'http://relay.from.card',
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
        }),
    });
    mockFetch.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const params = body['params'] as Record<string, unknown>;
      const message = params['message'] as Record<string, unknown>;
      const parts = message['parts'] as Array<Record<string, unknown>>;
      const proposal = parts[0]?.['data'] as Record<string, unknown>;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            history: [
              {
                role: 'agent',
                parts: [
                  {
                    media_type: 'application/vnd.agentvault.contract-offer-selection+json',
                    data: {
                      negotiation_id: proposal['negotiation_id'],
                      state: 'AGREED',
                      selected_contract_offer_id: 'agentvault.mediation.v1.standard',
                      selected_model_profile: {
                        id: 'api-claude-sonnet-v1',
                        version: '1',
                        hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
                      },
                    },
                  },
                ],
              },
            ],
          }),
      };
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeSignedAdmit('d'.repeat(64))),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('ok'),
    });

    const result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    const negotiateCall = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(negotiateCall[0]).toBe('http://peer.example.com/a2a/send-message');
    const negotiateBody = JSON.parse(negotiateCall[1].body as string) as Record<string, unknown>;
    const params = negotiateBody['params'] as Record<string, unknown>;
    const message = params['message'] as Record<string, unknown>;
    const parts = message['parts'] as Array<Record<string, unknown>>;
    const proposal = parts[0]?.['data'] as Record<string, unknown>;
    expect(parts[0]?.['media_type']).toBe(
      'application/vnd.agentvault.contract-offer-proposal+json',
    );
    expect(proposal['acceptable_offers']).toBeDefined();

    expect(vi.mocked(createAndSubmit)).toHaveBeenCalledWith(
      { relay_url: 'http://relay.test' },
      expect.objectContaining({
        purpose_code: 'MEDIATION',
        model_profile_id: 'api-claude-sonnet-v1',
        model_profile_hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
      }),
      'hello',
      'initiator',
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        negotiated_contract: {
          contract_offer_id: 'agentvault.mediation.v1.standard',
          selected_model_profile: {
            id: 'api-claude-sonnet-v1',
          },
        },
      },
    });
  });

  it('offers acceptable_purposes in order and binds the negotiated purpose', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const transport = new DirectAfalTransport({
      agentId: 'alice-demo',
      seedHex: TEST_SEED,
      localDescriptor: makeLocalDescriptor(),
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: 'bob-demo',
          capabilities: {
            extensions: [
              {
                uri: AGENTVAULT_A2A_EXTENSION_URI,
                params: {
                  public_key_hex: PEER_PUBKEY,
                  relay_url: 'http://relay.from.card',
                  supported_purposes: ['MEDIATION', 'COMPATIBILITY'],
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
                    {
                      contract_offer_id: 'agentvault.compatibility.v1.standard',
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
        }),
    });
    mockFetch.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const params = body['params'] as Record<string, unknown>;
      const message = params['message'] as Record<string, unknown>;
      const parts = message['parts'] as Array<Record<string, unknown>>;
      const proposal = parts[0]?.['data'] as Record<string, unknown>;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            history: [
              {
                role: 'agent',
                parts: [
                  {
                    media_type: 'application/vnd.agentvault.contract-offer-selection+json',
                    data: {
                      negotiation_id: proposal['negotiation_id'],
                      state: 'AGREED',
                      selected_contract_offer_id: 'agentvault.mediation.v1.standard',
                      selected_model_profile: {
                        id: 'api-claude-sonnet-v1',
                        version: '1',
                        hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
                      },
                    },
                  },
                ],
              },
            ],
          }),
      };
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeSignedAdmit('d'.repeat(64))),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('ok'),
    });

    await handleRelaySignal(
      {
        mode: 'INITIATE',
        counterparty: 'bob-demo',
        acceptable_purposes: ['MEDIATION', 'COMPATIBILITY'],
        my_input: 'hello',
      },
      transport,
    );

    const negotiateCall = mockFetch.mock.calls[1] as [string, RequestInit];
    const negotiateBody = JSON.parse(negotiateCall[1].body as string) as Record<string, unknown>;
    const params = negotiateBody['params'] as Record<string, unknown>;
    const message = params['message'] as Record<string, unknown>;
    const parts = message['parts'] as Array<Record<string, unknown>>;
    const proposal = parts[0]?.['data'] as Record<string, unknown>;
    const acceptableOffers = proposal['acceptable_offers'] as Array<Record<string, unknown>>;

    expect(acceptableOffers.map((offer) => offer['contract_offer_id'])).toEqual([
      'agentvault.mediation.v1.standard',
      'agentvault.compatibility.v1.standard',
    ]);
    expect(vi.mocked(createAndSubmit)).toHaveBeenCalledWith(
      { relay_url: 'http://relay.test' },
      expect.objectContaining({
        purpose_code: 'MEDIATION',
      }),
      'hello',
      'initiator',
    );
  });

  it('aligns on a bounded topic code before contract negotiation when requested', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const transport = new DirectAfalTransport({
      agentId: 'alice-demo',
      seedHex: TEST_SEED,
      localDescriptor: makeLocalDescriptor(),
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: 'bob-demo',
          capabilities: {
            extensions: [
              {
                uri: AGENTVAULT_A2A_EXTENSION_URI,
                params: {
                  public_key_hex: PEER_PUBKEY,
                  relay_url: 'http://relay.from.card',
                  supported_purposes: ['MEDIATION'],
                  supported_topic_codes: ['salary_alignment', 'reference_check'],
                  supports_topic_alignment: true,
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
        }),
    });
    mockFetch.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const params = body['params'] as Record<string, unknown>;
      const message = params['message'] as Record<string, unknown>;
      const parts = message['parts'] as Array<Record<string, unknown>>;
      const proposal = parts[0]?.['data'] as Record<string, unknown>;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            history: [
              {
                role: 'agent',
                parts: [
                  {
                    media_type: 'application/vnd.agentvault.topic-alignment-selection+json',
                    data: {
                      alignment_id: proposal['alignment_id'],
                      state: 'ALIGNED',
                      selected_topic_code: 'salary_alignment',
                    },
                  },
                ],
              },
            ],
          }),
      };
    });
    mockFetch.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const params = body['params'] as Record<string, unknown>;
      const message = params['message'] as Record<string, unknown>;
      const parts = message['parts'] as Array<Record<string, unknown>>;
      const proposal = parts[0]?.['data'] as Record<string, unknown>;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            history: [
              {
                role: 'agent',
                parts: [
                  {
                    media_type: 'application/vnd.agentvault.contract-offer-selection+json',
                    data: {
                      negotiation_id: proposal['negotiation_id'],
                      state: 'AGREED',
                      selected_contract_offer_id: 'agentvault.mediation.v1.standard',
                      selected_model_profile: {
                        id: 'api-claude-sonnet-v1',
                        version: '1',
                        hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
                      },
                    },
                  },
                ],
              },
            ],
          }),
      };
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeSignedAdmit('d'.repeat(64))),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('ok'),
    });

    const result = await handleRelaySignal(
      {
        mode: 'INITIATE',
        counterparty: 'bob-demo',
        purpose: 'MEDIATION',
        acceptable_topic_codes: ['salary_alignment', 'reference_check'],
        my_input: 'hello',
      },
      transport,
    );

    const alignmentCall = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(alignmentCall[0]).toBe('http://peer.example.com/a2a/send-message');
    expect(result).toMatchObject({
      ok: true,
      data: {
        aligned_topic_code: 'salary_alignment',
        negotiated_contract: {
          contract_offer_id: 'agentvault.mediation.v1.standard',
        },
      },
    });
  });

  it('negotiates over direct AFAL when the peer advertises negotiation via signed descriptor', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const transport = new DirectAfalTransport({
      agentId: 'alice-demo',
      seedHex: TEST_SEED,
      localDescriptor: makeLocalDescriptor(),
      peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-descriptor.json',
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({}),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve(
          makeDescriptor('bob-demo', PEER_PUBKEY, PEER_SEED, {
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
          }),
        ),
    });
    mockFetch.mockImplementationOnce(async (_url, init) => {
      const proposal = JSON.parse(init?.body as string) as Record<string, unknown>;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            negotiation_id: proposal['negotiation_id'],
            state: 'AGREED',
            selected_contract_offer_id: 'agentvault.mediation.v1.standard',
            selected_model_profile: {
              id: 'api-claude-sonnet-v1',
              version: '1',
              hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
            },
          }),
      };
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(makeSignedAdmit('d'.repeat(64))),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('ok'),
    });

    const result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    const calledUrls = mockFetch.mock.calls.map((call) => call[0]);
    expect(calledUrls).toContain('http://peer.example.com/afal/negotiate');
    expect(vi.mocked(createAndSubmit)).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      data: {
        negotiated_contract: {
          contract_offer_id: 'agentvault.mediation.v1.standard',
          selected_model_profile: {
            id: 'api-claude-sonnet-v1',
          },
        },
      },
    });
  });

  it('fails cleanly when pre-contract negotiation returns NO_COMMON_CONTRACT', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const transport = new DirectAfalTransport({
      agentId: 'alice-demo',
      seedHex: TEST_SEED,
      localDescriptor: makeLocalDescriptor(),
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: 'bob-demo',
          capabilities: {
            extensions: [
              {
                uri: AGENTVAULT_A2A_EXTENSION_URI,
                params: {
                  public_key_hex: PEER_PUBKEY,
                  relay_url: 'http://relay.from.card',
                  supported_purposes: ['MEDIATION'],
                  a2a_send_message_url: 'http://peer.example.com/a2a/send-message',
                  afal_endpoint: 'http://peer.example.com/afal',
                  supports_precontract_negotiation: true,
                  supported_contract_offers: [
                    {
                      contract_offer_id: 'agentvault.mediation.v1.standard',
                      supported_model_profiles: [],
                    },
                  ],
                },
              },
            ],
          },
        }),
    });
    mockFetch.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const params = body['params'] as Record<string, unknown>;
      const message = params['message'] as Record<string, unknown>;
      const parts = message['parts'] as Array<Record<string, unknown>>;
      const proposal = parts[0]?.['data'] as Record<string, unknown>;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            history: [
              {
                role: 'agent',
                parts: [
                  {
                    media_type: 'application/vnd.agentvault.contract-offer-selection+json',
                    data: {
                      negotiation_id: proposal['negotiation_id'],
                      state: 'NO_COMMON_CONTRACT',
                    },
                  },
                ],
              },
            ],
          }),
      };
    });

    await expect(
      handleRelaySignal(
        { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
        transport,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({
        code: 'SESSION_ERROR',
        detail: expect.stringContaining('No common bounded contract and model profile combination'),
      }),
    });
    expect(vi.mocked(createAndSubmit)).not.toHaveBeenCalled();
  });

  it('fails cleanly when bounded topic alignment returns NOT_ALIGNED', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const transport = new DirectAfalTransport({
      agentId: 'alice-demo',
      seedHex: TEST_SEED,
      localDescriptor: makeLocalDescriptor(),
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: 'bob-demo',
          capabilities: {
            extensions: [
              {
                uri: AGENTVAULT_A2A_EXTENSION_URI,
                params: {
                  public_key_hex: PEER_PUBKEY,
                  relay_url: 'http://relay.from.card',
                  supported_purposes: ['MEDIATION'],
                  supported_topic_codes: ['technical_architecture'],
                  supports_topic_alignment: true,
                  a2a_send_message_url: 'http://peer.example.com/a2a/send-message',
                  afal_endpoint: 'http://peer.example.com/afal',
                },
              },
            ],
          },
        }),
    });
    mockFetch.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const params = body['params'] as Record<string, unknown>;
      const message = params['message'] as Record<string, unknown>;
      const parts = message['parts'] as Array<Record<string, unknown>>;
      const proposal = parts[0]?.['data'] as Record<string, unknown>;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            history: [
              {
                role: 'agent',
                parts: [
                  {
                    media_type: 'application/vnd.agentvault.topic-alignment-selection+json',
                    data: {
                      alignment_id: proposal['alignment_id'],
                      state: 'NOT_ALIGNED',
                    },
                  },
                ],
              },
            ],
          }),
      };
    });

    await expect(
      handleRelaySignal(
        {
          mode: 'INITIATE',
          counterparty: 'bob-demo',
          purpose: 'MEDIATION',
          acceptable_topic_codes: ['salary_alignment'],
          my_input: 'hello',
        },
        transport,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({
        code: 'SESSION_ERROR',
        detail: expect.stringContaining('No common bounded topic code'),
      }),
    });
    expect(vi.mocked(createAndSubmit)).not.toHaveBeenCalled();
  });

  it('fails cleanly when pre-contract negotiation is rejected', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const transport = new DirectAfalTransport({
      agentId: 'alice-demo',
      seedHex: TEST_SEED,
      localDescriptor: makeLocalDescriptor(),
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: 'bob-demo',
          capabilities: {
            extensions: [
              {
                uri: AGENTVAULT_A2A_EXTENSION_URI,
                params: {
                  public_key_hex: PEER_PUBKEY,
                  relay_url: 'http://relay.from.card',
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
        }),
    });
    mockFetch.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      const params = body['params'] as Record<string, unknown>;
      const message = params['message'] as Record<string, unknown>;
      const parts = message['parts'] as Array<Record<string, unknown>>;
      const proposal = parts[0]?.['data'] as Record<string, unknown>;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            history: [
              {
                role: 'agent',
                parts: [
                  {
                    media_type: 'application/vnd.agentvault.contract-offer-selection+json',
                    data: {
                      negotiation_id: proposal['negotiation_id'],
                      state: 'REJECTED',
                    },
                  },
                ],
              },
            ],
          }),
      };
    });

    await expect(
      handleRelaySignal(
        { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
        transport,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.objectContaining({
        code: 'SESSION_ERROR',
        detail: expect.stringContaining('rejected pre-contract negotiation'),
      }),
    });
    expect(vi.mocked(createAndSubmit)).not.toHaveBeenCalled();
  });
});

describe('legacy payload type guard (isRelayInvitePayload)', () => {
  it('skips legacy invite when payload fields are truthy non-strings', async () => {
    // session_id: true passes the pre-filter's truthiness check but fails
    // the type guard's typeof === 'string' check — this exercises isRelayInvitePayload
    const invite: AfalInviteMessage = {
      invite_id: 'inv-truthy',
      from_agent_id: 'bob-demo',
      payload_type: 'VCAV_E_INVITE_V1',
      template_id: 'mediation-demo.v1.standard',
      payload: {
        session_id: true, // truthy but not string — passes pre-filter, fails type guard
        responder_submit_token: 'sub-tok',
        responder_read_token: 'read-tok',
        relay_url: 'http://relay.test',
      },
    };

    const transport = createMockAfalTransport([invite]);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'hi' },
      transport,
    );

    // Invite passes pre-filter but is rejected by isRelayInvitePayload type guard
    expect(result.status).toBe('PENDING');
    const data = result.data as { phase: string };
    expect(data.phase).toBe('DISCOVER');
  });

  it('skips legacy invite when payload fields are non-string', async () => {
    const invite: AfalInviteMessage = {
      invite_id: 'inv-badtype',
      from_agent_id: 'bob-demo',
      payload_type: 'VCAV_E_INVITE_V1',
      template_id: 'mediation-demo.v1.standard',
      payload: {
        session_id: 42, // should be string
        responder_submit_token: 'sub-tok',
        responder_read_token: 'read-tok',
        relay_url: 'http://relay.test',
      },
    };

    const transport = createMockAfalTransport([invite]);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'hi' },
      transport,
    );

    // Invite is skipped due to non-string session_id — should still be in DISCOVER
    expect(result.status).toBe('PENDING');
    const data = result.data as { phase: string };
    expect(data.phase).toBe('DISCOVER');
  });
});

describe('RESPOND with AFAL', () => {
  it('returns PURPOSE_MISMATCH when an AFAL invite advertises a different purpose', async () => {
    const afalPropose: AfalPropose = {
      proposal_version: '1',
      proposal_id: 'c'.repeat(64),
      nonce: 'd'.repeat(64),
      timestamp: '2026-02-24T10:00:00.000Z',
      from: 'bob-demo',
      to: 'alice-demo',
      purpose_code: 'COMPATIBILITY',
      lane_id: 'API_MEDIATED',
      output_schema_id: 'vcav_e_compatibility_signal_v2',
      output_schema_version: '1',
      requested_budget_tier: 'SMALL',
      requested_entropy_bits: 12,
      model_profile_id: 'api-claude-sonnet-v1',
      model_profile_version: '1',
      admission_tier_requested: 'DEFAULT',
    };

    const invite: AfalInviteMessage = {
      invite_id: 'inv-purpose-mismatch',
      from_agent_id: 'bob-demo',
      payload_type: 'VCAV_E_INVITE_V1',
      template_id: 'dating.v1.d2',
      payload: {
        session_id: 'sess-bob',
        responder_submit_token: 'sub-tok',
        responder_read_token: 'read-tok',
        relay_url: 'http://relay.test',
      },
      afalPropose,
    };

    const transport = createMockAfalTransport([invite]);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'hi' },
      transport,
    );

    expect(result.status).toBe('ERROR');
    const data = result.data as { phase: string; state: string; error_code: string; user_message: string };
    expect(data.phase).toBe('FAILED');
    expect(data.state).toBe('FAILED');
    expect(data.error_code).toBe('PURPOSE_MISMATCH');
    expect(data.user_message).toContain('COMPATIBILITY');
    expect(data.user_message).toContain('MEDIATION');
  });

  it('extracts AfalPropose from enriched inbox invite', async () => {
    const afalPropose: AfalPropose = {
      proposal_version: '1',
      proposal_id: 'a'.repeat(64),
      nonce: 'b'.repeat(64),
      timestamp: '2026-02-24T10:00:00.000Z',
      from: 'bob-demo',
      to: 'alice-demo',
      purpose_code: 'MEDIATION',
      lane_id: 'API_MEDIATED',
      output_schema_id: 'vcav_e_mediation_signal_v2',
      output_schema_version: '1',
      requested_budget_tier: 'SMALL',
      requested_entropy_bits: 12,
      model_profile_id: 'api-claude-sonnet-v1',
      model_profile_version: '1',
      admission_tier_requested: 'DEFAULT',
    };

    const invite: AfalInviteMessage = {
      invite_id: 'inv-1',
      from_agent_id: 'bob-demo',
      payload_type: 'VCAV_E_INVITE_V1',
      template_id: 'mediation-demo.v1.standard',
      payload: {
        session_id: 'sess-bob',
        responder_submit_token: 'sub-tok',
        responder_read_token: 'read-tok',
        relay_url: 'http://relay.test',
      },
      afalPropose,
    };

    const transport = createMockAfalTransport([invite]);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'hi' },
      transport,
    );

    // Should have found the invite and transitioned to JOIN
    expect(result.status).toBe('PENDING');
    const data = result.data as { phase: string; from: string };
    expect(data.phase).toBe('JOIN');
    expect(data.from).toBe('bob-demo');
  });

  it('falls back to legacy handling for old-format invites', async () => {
    const invite: AfalInviteMessage = {
      invite_id: 'inv-2',
      from_agent_id: 'bob-demo',
      payload_type: 'VCAV_E_INVITE_V1',
      template_id: 'mediation-demo.v1.standard',
      payload: {
        session_id: 'sess-bob',
        responder_submit_token: 'sub-tok',
        responder_read_token: 'read-tok',
        relay_url: 'http://relay.test',
      },
      // No afalPropose — legacy invite
    };

    const transport = createMockAfalTransport([invite]);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'hi' },
      transport,
    );

    expect(result.status).toBe('PENDING');
    const data = result.data as { phase: string };
    expect(data.phase).toBe('JOIN');
  });
});
