/**
 * A2A Task ID plumbing tests.
 *
 * Verifies:
 * - buildA2ASendMessageRequest includes task_id in configuration when provided
 * - buildA2ATaskResponse uses explicit taskId or falls back to random ID
 * - parseA2ASendMessagePart extracts taskId from configuration.task_id
 * - parseA2ATaskPart extracts taskId from response id field
 * - Server echoes task_id from request to response
 * - Server generates random ID when no task_id provided (backward compat)
 * - Initiator detects mismatched task_id in response
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { AfalHttpServer } from '../afal-http-server.js';
import { AfalResponder } from '../afal-responder.js';
import type { AdmissionPolicy } from '../afal-responder.js';
import { DirectAfalTransport } from '../direct-afal-transport.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { AGENTVAULT_A2A_EXTENSION_URI } from '../a2a-agent-card.js';
import { signMessage, DOMAIN_PREFIXES, contentHash } from '../afal-signing.js';
import { computeProposalId } from '../afal-types.js';
import type { AfalPropose, RelayInvitePayload } from '../afal-types.js';
import {
  A2A_SEND_MESSAGE_PATH,
  AGENTVAULT_ADMIT_MEDIA_TYPE,
  AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
  AGENTVAULT_CONTRACT_OFFER_SELECTION_MEDIA_TYPE,
  AGENTVAULT_PROPOSE_MEDIA_TYPE,
  AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE,
  buildA2ASendMessageRequest,
  buildA2ATaskResponse,
  parseA2ASendMessagePart,
  parseA2ATaskPart,
} from '../a2a-messages.js';

// ── Test keypairs ────────────────────────────────────────────────────────────

const RESPONDER_SEED = '0202020202020202020202020202020202020202020202020202020202020202';
const RESPONDER_PUBKEY = bytesToHex(ed25519.getPublicKey(hexToBytes(RESPONDER_SEED)));
const PROPOSER_SEED = '0101010101010101010101010101010101010101010101010101010101010101';
const PROPOSER_PUBKEY = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDescriptor(): AgentDescriptor {
  const unsigned: Omit<AgentDescriptor, 'signature'> = {
    descriptor_version: '1',
    agent_id: 'bob-test',
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: '2099-12-31T23:59:59Z',
    identity_key: { algorithm: 'ed25519', public_key_hex: RESPONDER_PUBKEY },
    envelope_key: { algorithm: 'ed25519', public_key_hex: RESPONDER_PUBKEY },
    endpoints: { propose: '', commit: '' },
    capabilities: { supported_body_formats: ['wrapped_v1'], supports_commit: true },
    policy_commitments: {},
  };
  return signMessage(
    DOMAIN_PREFIXES.DESCRIPTOR,
    unsigned as Record<string, unknown>,
    RESPONDER_SEED,
  ) as unknown as AgentDescriptor;
}

function makePolicy(): AdmissionPolicy {
  return {
    trustedAgents: [{ agentId: 'alice-test', publicKeyHex: PROPOSER_PUBKEY }],
    allowedPurposeCodes: ['MEDIATION'],
    allowedLaneIds: ['API_MEDIATED'],
    maxEntropyBits: 256,
    defaultTier: 'DENY',
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

function makeSignedPropose(): Record<string, unknown> {
  const relay = makeRelay();
  const propose = makePropose({ relay_binding_hash: contentHash(relay) });
  return signMessage(
    DOMAIN_PREFIXES.PROPOSE,
    propose as unknown as Record<string, unknown>,
    PROPOSER_SEED,
  );
}

// ── Unit tests: build/parse functions ────────────────────────────────────────

describe('A2A task ID — unit', () => {
  describe('buildA2ASendMessageRequest', () => {
    it('includes task_id in configuration when provided', () => {
      const req = buildA2ASendMessageRequest({
        mediaType: AGENTVAULT_PROPOSE_MEDIA_TYPE,
        data: { test: true },
        taskId: 'task-propose-abc123',
      });
      const params = req['params'] as Record<string, unknown>;
      const config = params['configuration'] as Record<string, unknown>;
      expect(config['task_id']).toBe('task-propose-abc123');
    });

    it('omits task_id from configuration when not provided', () => {
      const req = buildA2ASendMessageRequest({
        mediaType: AGENTVAULT_PROPOSE_MEDIA_TYPE,
        data: { test: true },
      });
      const params = req['params'] as Record<string, unknown>;
      // No configuration at all when neither acceptedOutputModes nor taskId
      expect(params['configuration']).toBeUndefined();
    });

    it('includes both task_id and accepted_output_modes when both provided', () => {
      const req = buildA2ASendMessageRequest({
        mediaType: AGENTVAULT_PROPOSE_MEDIA_TYPE,
        data: { test: true },
        acceptedOutputModes: [AGENTVAULT_ADMIT_MEDIA_TYPE],
        taskId: 'task-123',
      });
      const params = req['params'] as Record<string, unknown>;
      const config = params['configuration'] as Record<string, unknown>;
      expect(config['task_id']).toBe('task-123');
      expect(config['accepted_output_modes']).toEqual([AGENTVAULT_ADMIT_MEDIA_TYPE]);
    });
  });

  describe('buildA2ATaskResponse', () => {
    it('uses explicit taskId when provided', () => {
      const resp = buildA2ATaskResponse({
        mediaType: AGENTVAULT_ADMIT_MEDIA_TYPE,
        data: { outcome: 'ADMIT' },
        taskId: 'task-propose-xyz',
      });
      expect(resp['id']).toBe('task-propose-xyz');
    });

    it('generates random ID when taskId not provided (backward compat)', () => {
      const resp = buildA2ATaskResponse({
        mediaType: AGENTVAULT_ADMIT_MEDIA_TYPE,
        data: { outcome: 'ADMIT' },
      });
      expect(typeof resp['id']).toBe('string');
      expect((resp['id'] as string).startsWith('task-')).toBe(true);
    });
  });

  describe('parseA2ASendMessagePart', () => {
    it('extracts taskId from configuration.task_id', () => {
      const req = buildA2ASendMessageRequest({
        mediaType: AGENTVAULT_PROPOSE_MEDIA_TYPE,
        data: { test: true },
        taskId: 'task-propose-abc',
      });
      const parsed = parseA2ASendMessagePart(req, [AGENTVAULT_PROPOSE_MEDIA_TYPE]);
      expect(parsed).not.toBeNull();
      expect(parsed!.taskId).toBe('task-propose-abc');
    });

    it('returns undefined taskId when configuration.task_id is absent', () => {
      const req = buildA2ASendMessageRequest({
        mediaType: AGENTVAULT_PROPOSE_MEDIA_TYPE,
        data: { test: true },
      });
      const parsed = parseA2ASendMessagePart(req, [AGENTVAULT_PROPOSE_MEDIA_TYPE]);
      expect(parsed).not.toBeNull();
      expect(parsed!.taskId).toBeUndefined();
    });
  });

  describe('parseA2ATaskPart', () => {
    it('extracts taskId from response id field', () => {
      const resp = buildA2ATaskResponse({
        mediaType: AGENTVAULT_ADMIT_MEDIA_TYPE,
        data: { outcome: 'ADMIT' },
        taskId: 'task-propose-xyz',
      });
      const parsed = parseA2ATaskPart(resp, [AGENTVAULT_ADMIT_MEDIA_TYPE]);
      expect(parsed).not.toBeNull();
      expect(parsed!.taskId).toBe('task-propose-xyz');
    });

    it('returns taskId for auto-generated IDs', () => {
      const resp = buildA2ATaskResponse({
        mediaType: AGENTVAULT_ADMIT_MEDIA_TYPE,
        data: { outcome: 'ADMIT' },
      });
      const parsed = parseA2ATaskPart(resp, [AGENTVAULT_ADMIT_MEDIA_TYPE]);
      expect(parsed).not.toBeNull();
      expect(parsed!.taskId).toBeDefined();
      expect(parsed!.taskId!.startsWith('task-')).toBe(true);
    });

    it('extracts taskState from status.state', () => {
      const resp = buildA2ATaskResponse({
        mediaType: AGENTVAULT_ADMIT_MEDIA_TYPE,
        data: { outcome: 'ADMIT' },
        taskId: 'task-propose-xyz',
        state: 'working',
      });
      const parsed = parseA2ATaskPart(resp, [AGENTVAULT_ADMIT_MEDIA_TYPE]);
      expect(parsed).not.toBeNull();
      expect(parsed!.taskState).toBe('working');
    });

    it('returns undefined taskState when status is absent', () => {
      const resp = {
        id: 'task-123',
        history: [
          { role: 'agent', parts: [{ data: {}, media_type: AGENTVAULT_ADMIT_MEDIA_TYPE }] },
        ],
      };
      const parsed = parseA2ATaskPart(resp, [AGENTVAULT_ADMIT_MEDIA_TYPE]);
      expect(parsed).not.toBeNull();
      expect(parsed!.taskState).toBeUndefined();
    });
  });
});

// ── Integration tests: server echoes task ID ─────────────────────────────────

describe('A2A task ID — server echo', () => {
  let server: AfalHttpServer;
  let baseUrl: string;

  beforeEach(async () => {
    const descriptor = makeDescriptor();
    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: RESPONDER_SEED,
      policy: makePolicy(),
    });
    server = new AfalHttpServer({
      port: 0,
      responder,
      localDescriptor: descriptor,
      relayUrl: 'http://relay.example.com',
      supportedPurposes: ['MEDIATION'],
    });
    await server.start();
    const addr = (
      server as unknown as { server: { address(): { port: number } } }
    ).server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('echoes task_id from SendMessage request in propose response', async () => {
    const signed = makeSignedPropose();
    const taskId = 'task-propose-test-echo';
    const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildA2ASendMessageRequest({
          mediaType: AGENTVAULT_PROPOSE_MEDIA_TYPE,
          data: signed,
          acceptedOutputModes: [AGENTVAULT_ADMIT_MEDIA_TYPE],
          taskId,
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['id']).toBe(taskId);
    // With task_id present, ADMIT propose → working state (stateful lifecycle)
    expect((body['status'] as Record<string, unknown>)['state']).toBe('working');
  });

  it('generates random task ID when no task_id in request (backward compat)', async () => {
    const signed = makeSignedPropose();
    const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildA2ASendMessageRequest({
          mediaType: AGENTVAULT_PROPOSE_MEDIA_TYPE,
          data: signed,
          acceptedOutputModes: [AGENTVAULT_ADMIT_MEDIA_TYPE],
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body['id']).toBe('string');
    expect((body['id'] as string).startsWith('task-')).toBe(true);
  });

  it('echoes task_id in contract-offer negotiation response', async () => {
    const descriptor = makeDescriptor();
    (descriptor.capabilities as Record<string, unknown>)['supported_contract_offers'] = [
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
    ];
    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: RESPONDER_SEED,
      policy: makePolicy(),
    });
    await server.stop();
    server = new AfalHttpServer({
      port: 0,
      responder,
      localDescriptor: descriptor,
      relayUrl: 'http://relay.example.com',
      supportedPurposes: ['MEDIATION'],
    });
    await server.start();
    const addr = (server as unknown as { server: { address(): { port: number } } }).server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const taskId = 'task-negotiate-neg-456';
    const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildA2ASendMessageRequest({
          mediaType: AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
          data: {
            negotiation_id: 'neg-456',
            acceptable_offers: [
              {
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
          },
          acceptedOutputModes: [AGENTVAULT_CONTRACT_OFFER_SELECTION_MEDIA_TYPE],
          taskId,
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['id']).toBe(taskId);
  });

  it('echoes task_id in session-token follow-up response', async () => {
    // First admit a proposal via direct AFAL
    const relay = makeRelay();
    const propose = makePropose({ relay_binding_hash: contentHash(relay) });
    const signed = signMessage(
      DOMAIN_PREFIXES.PROPOSE,
      propose as unknown as Record<string, unknown>,
      PROPOSER_SEED,
    );
    const admitRes = await fetch(`${baseUrl}/afal/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propose: signed, relay }),
    });
    const admitBody = (await admitRes.json()) as Record<string, unknown>;
    const admitTokenId = admitBody['admit_token_id'] as string;
    const proposalId = admitBody['proposal_id'] as string;

    const commitMsg = signMessage(
      DOMAIN_PREFIXES.COMMIT,
      {
        commit_version: '1',
        proposal_id: proposalId,
        from: 'alice-test',
        admit_token_id: admitTokenId,
        relay_session: {
          ...relay,
          contract_hash: 'c'.repeat(64),
        },
      },
      PROPOSER_SEED,
    );

    const taskId = 'task-commit-test-echo';
    // Register as in-flight (as if propose came via A2A with this task_id)
    (server as unknown as { _inFlightTasks: Map<string, unknown> })._inFlightTasks.set(taskId, {
      state: 'working',
      proposalId,
      expiresAt: Date.now() + 600_000,
    });
    const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildA2ASendMessageRequest({
          mediaType: AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE,
          data: commitMsg,
          acceptedOutputModes: [AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE],
          taskId,
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['id']).toBe(taskId);
  });
});

// ── Client-side task ID validation ───────────────────────────────────────────

describe('A2A task ID — client validation', () => {
  it('parseA2ATaskPart detects mismatched task ID', () => {
    const resp = buildA2ATaskResponse({
      mediaType: AGENTVAULT_ADMIT_MEDIA_TYPE,
      data: { outcome: 'ADMIT' },
      taskId: 'task-propose-wrong',
    });
    const parsed = parseA2ATaskPart(resp, [AGENTVAULT_ADMIT_MEDIA_TYPE]);
    expect(parsed).not.toBeNull();
    expect(parsed!.taskId).toBe('task-propose-wrong');
    // Client code would check: parsed.taskId !== expectedTaskId → throw
    expect(parsed!.taskId).not.toBe('task-propose-expected');
  });
});

// ── Transport-layer helpers ──────────────────────────────────────────────────

function makeTransportDescriptor(
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
    capabilities: {},
    policy_commitments: {},
  };
  return signMessage(
    DOMAIN_PREFIXES.DESCRIPTOR,
    unsigned as Record<string, unknown>,
    seedHex,
  ) as unknown as AgentDescriptor;
}

function makeTransportSignedAdmit(proposalId: string): Record<string, unknown> {
  return signMessage(
    DOMAIN_PREFIXES.ADMIT,
    {
      admission_version: '1',
      outcome: 'ADMIT',
      proposal_id: proposalId,
      admit_token_id: 'a'.repeat(64),
      admission_tier: 'DEFAULT',
      expires_at: '2026-01-01T00:15:00Z',
    },
    RESPONDER_SEED,
  );
}

// ── Transport-layer task ID mismatch ─────────────────────────────────────────

describe('A2A task ID — transport mismatch throws', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sendPropose throws on task ID mismatch from A2A-only peer', async () => {
    const localDescriptor = makeTransportDescriptor('alice-test', PROPOSER_PUBKEY, PROPOSER_SEED);
    const transport = new DirectAfalTransport({
      agentId: 'alice-test',
      seedHex: PROPOSER_SEED,
      localDescriptor,
      peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-card.json',
    });

    const propose = makePropose();
    const admit = makeTransportSignedAdmit(propose.proposal_id);

    // First call: agent card discovery (A2A-only peer — no afal_endpoint)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          name: 'bob-test',
          url: 'http://peer.example.com',
          capabilities: {
            extensions: [
              {
                uri: AGENTVAULT_A2A_EXTENSION_URI,
                params: {
                  public_key_hex: RESPONDER_PUBKEY,
                  relay_url: 'http://relay.example.com',
                  supported_purposes: ['MEDIATION'],
                  a2a_send_message_url: 'http://peer.example.com/a2a/send-message',
                },
              },
            ],
          },
          skills: [],
        }),
    });

    // Second call: sendPropose response — returns a WRONG task ID
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve(
          buildA2ATaskResponse({
            mediaType: AGENTVAULT_ADMIT_MEDIA_TYPE,
            data: admit,
            taskId: 'task-propose-wrong-id',
          }),
        ),
    });

    await expect(
      transport.sendPropose({
        propose,
        templateId: 't',
        budgetTier: 'SMALL',
      }),
    ).rejects.toThrow('A2A task ID mismatch');
  });
});
