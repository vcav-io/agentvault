import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { AfalHttpServer } from '../afal-http-server.js';
import { AfalResponder } from '../afal-responder.js';
import type { AdmissionPolicy } from '../afal-responder.js';
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

function makeWrappedBody(): { propose: Record<string, unknown>; relay: RelayInvitePayload } {
  const relay = makeRelay();
  const propose = makePropose({
    relay_binding_hash: contentHash(relay),
  });
  const signed = signMessage(
    DOMAIN_PREFIXES.PROPOSE,
    propose as unknown as Record<string, unknown>,
    PROPOSER_SEED,
  );
  return { propose: signed, relay };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AfalHttpServer', () => {
  let server: AfalHttpServer;
  let baseUrl: string;

  beforeEach(async () => {
    const descriptor = makeDescriptor();
    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: RESPONDER_SEED,
      policy: makePolicy(),
    });
    // Use port 0 to pick a random available port
    server = new AfalHttpServer({
      port: 0,
      responder,
      localDescriptor: descriptor,
      relayUrl: 'http://relay.example.com',
      supportedPurposes: ['MEDIATION'],
    });
    await server.start();
    // Get actual port from the underlying server
    const addr = (
      server as unknown as { server: { address(): { port: number } } }
    ).server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('GET /afal/descriptor returns descriptor', async () => {
    const res = await fetch(`${baseUrl}/afal/descriptor`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['agent_id']).toBe('bob-test');
    expect((body['capabilities'] as Record<string, unknown>)['supported_body_formats']).toEqual([
      'wrapped_v1',
    ]);
  });

  it('GET /.well-known/agent-card.json returns an Agent Card with the AgentVault extension', async () => {
    const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['name']).toBe('bob-test');
    expect(body['url']).toBe(baseUrl);
    const capabilities = body['capabilities'] as Record<string, unknown>;
    const extensions = capabilities['extensions'] as Array<Record<string, unknown>>;
    expect(extensions).toHaveLength(1);
    expect(extensions[0]['uri']).toBe(AGENTVAULT_A2A_EXTENSION_URI);
    expect(extensions[0]['required']).toBe(false);
    const params = extensions[0]['params'] as Record<string, unknown>;
    expect(params['relay_url']).toBe('http://relay.example.com');
    expect(params['public_key_hex']).toBe(RESPONDER_PUBKEY);
    expect(params['supported_purposes']).toEqual(['MEDIATION']);
    expect(params['a2a_send_message_url']).toBe(`${baseUrl}/a2a/send-message`);
    expect(params['afal_endpoint']).toBe(`${baseUrl}/afal`);
  });

  it('GET /.well-known/agent-card.json advertises negotiation capabilities when present', async () => {
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

    const res = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    const body = (await res.json()) as Record<string, unknown>;
    const capabilities = body['capabilities'] as Record<string, unknown>;
    const extensions = capabilities['extensions'] as Array<Record<string, unknown>>;
    const params = extensions[0]['params'] as Record<string, unknown>;
    expect(params['supports_precontract_negotiation']).toBe(true);
    expect(params['supported_contract_offers']).toEqual(
      (descriptor.capabilities as Record<string, unknown>)['supported_contract_offers'],
    );
  });

  it('POST /afal/propose returns ADMIT for valid body', async () => {
    const res = await fetch(`${baseUrl}/afal/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeWrappedBody()),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['outcome']).toBe('ADMIT');
    expect(body['admit_token_id']).toBeDefined();
  });

  it('POST /afal/propose returns DENY for flat M3 body', async () => {
    const propose = makePropose();
    const signed = signMessage(
      DOMAIN_PREFIXES.PROPOSE,
      propose as unknown as Record<string, unknown>,
      PROPOSER_SEED,
    );
    const res = await fetch(`${baseUrl}/afal/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['outcome']).toBe('DENY');
    expect(body['deny_code']).toBe('UNSUPPORTED');
  });

  it('POST /a2a/send-message returns an ADMIT task for valid propose parts', async () => {
    const wrapped = makeWrappedBody();
    const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildA2ASendMessageRequest({
          mediaType: AGENTVAULT_PROPOSE_MEDIA_TYPE,
          data: wrapped.propose,
          acceptedOutputModes: [AGENTVAULT_ADMIT_MEDIA_TYPE],
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const history = body['history'] as Array<Record<string, unknown>>;
    const parts = history[0]?.['parts'] as Array<Record<string, unknown>>;
    expect(parts[0]?.['media_type']).toBe(AGENTVAULT_ADMIT_MEDIA_TYPE);
    expect((parts[0]?.['data'] as Record<string, unknown>)['outcome']).toBe('ADMIT');
  });

  it('POST /a2a/send-message returns a contract-offer selection task for negotiation proposals', async () => {
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

    const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildA2ASendMessageRequest({
          mediaType: AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
          data: {
            negotiation_id: 'neg-123',
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
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const history = body['history'] as Array<Record<string, unknown>>;
    const parts = history[0]?.['parts'] as Array<Record<string, unknown>>;
    expect(parts[0]?.['media_type']).toBe(AGENTVAULT_CONTRACT_OFFER_SELECTION_MEDIA_TYPE);
    expect((parts[0]?.['data'] as Record<string, unknown>)['state']).toBe('AGREED');
  });

  it('POST /afal/negotiate returns a direct contract-offer selection for negotiation proposals', async () => {
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

    const res = await fetch(`${baseUrl}/afal/negotiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        negotiation_id: 'neg-123',
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
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['state']).toBe('AGREED');
    expect(body['selected_contract_offer_id']).toBe('agentvault.mediation.v1.standard');
  });

  it('POST /afal/commit returns 200 for valid COMMIT', async () => {
    // First admit a proposal
    const wrapped = makeWrappedBody();
    const admitRes = await fetch(`${baseUrl}/afal/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wrapped),
    });
    const admitBody = (await admitRes.json()) as Record<string, unknown>;
    const admitTokenId = admitBody['admit_token_id'] as string;
    const proposalId = admitBody['proposal_id'] as string;

    // Send COMMIT
    const commitMsg: Record<string, unknown> = {
      commit_version: '1',
      proposal_id: proposalId,
      from: 'alice-test',
      admit_token_id: admitTokenId,
      relay_session: {
        ...makeRelay(),
        contract_hash: 'c'.repeat(64),
      },
    };
    const signedCommit = signMessage(DOMAIN_PREFIXES.COMMIT, commitMsg, PROPOSER_SEED);

    const res = await fetch(`${baseUrl}/afal/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedCommit),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
  });

  it('POST /a2a/send-message accepts session-token follow-up parts', async () => {
    const wrapped = makeWrappedBody();
    const admitRes = await fetch(`${baseUrl}/afal/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wrapped),
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
          ...makeRelay(),
          contract_hash: 'c'.repeat(64),
        },
      },
      PROPOSER_SEED,
    );

    const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildA2ASendMessageRequest({
          mediaType: AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE,
          data: commitMsg,
          acceptedOutputModes: [AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE],
        }),
      ),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const history = body['history'] as Array<Record<string, unknown>>;
    const parts = history[0]?.['parts'] as Array<Record<string, unknown>>;
    expect(parts[0]?.['media_type']).toBe(AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE);
    expect((parts[0]?.['data'] as Record<string, unknown>)['ok']).toBe(true);
  });

  it('rejects POST without application/json content type', async () => {
    const res = await fetch(`${baseUrl}/afal/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json',
    });
    expect(res.status).toBe(415);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${baseUrl}/afal/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });
});
