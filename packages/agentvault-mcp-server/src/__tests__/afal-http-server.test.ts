import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { AfalHttpServer } from '../afal-http-server.js';
import { AfalResponder } from '../afal-responder.js';
import type { AdmissionPolicy } from '../afal-responder.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { signMessage, DOMAIN_PREFIXES } from '../afal-signing.js';
import { computeProposalId } from '../afal-types.js';
import type { AfalPropose, RelayInvitePayload } from '../afal-types.js';

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
  return signMessage(DOMAIN_PREFIXES.DESCRIPTOR, unsigned as Record<string, unknown>, RESPONDER_SEED) as unknown as AgentDescriptor;
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

function makePropose(): AfalPropose {
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
  const propose = makePropose();
  const signed = signMessage(DOMAIN_PREFIXES.PROPOSE, propose as unknown as Record<string, unknown>, PROPOSER_SEED);
  return { propose: signed, relay: makeRelay() };
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
    });
    await server.start();
    // Get actual port from the underlying server
    const addr = (server as unknown as { server: { address(): { port: number } } }).server.address();
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
    expect((body['capabilities'] as Record<string, unknown>)['supported_body_formats']).toEqual(['wrapped_v1']);
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
    const signed = signMessage(DOMAIN_PREFIXES.PROPOSE, propose as unknown as Record<string, unknown>, PROPOSER_SEED);
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
