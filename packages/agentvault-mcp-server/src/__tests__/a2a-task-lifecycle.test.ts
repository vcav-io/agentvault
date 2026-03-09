/**
 * A2A Task Lifecycle tests (#311b).
 *
 * Verifies:
 * - Propose with task_id → working state, in-flight task stored
 * - Propose DENY with task_id → failed state
 * - Session-tokens with task_id → completed state, in-flight task removed
 * - Old client (no task_id) → completed state, no in-flight task stored
 * - Contract negotiation → always completed (single-round)
 * - In-flight task TTL expiry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { AfalHttpServer } from '../afal-http-server.js';
import { AfalResponder } from '../afal-responder.js';
import type { AdmissionPolicy } from '../afal-responder.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { signMessage, DOMAIN_PREFIXES, contentHash } from '../afal-signing.js';
import { computeProposalId } from '../afal-types.js';
import type { AfalPropose, RelayInvitePayload } from '../afal-types.js';
import {
  A2A_SEND_MESSAGE_PATH,
  AGENTVAULT_ADMIT_MEDIA_TYPE,
  AGENTVAULT_DENY_MEDIA_TYPE,
  AGENTVAULT_PROPOSE_MEDIA_TYPE,
  AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE,
  AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
  AGENTVAULT_CONTRACT_OFFER_SELECTION_MEDIA_TYPE,
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

function makeAdmitPolicy(): AdmissionPolicy {
  return {
    trustedAgents: [{ agentId: 'alice-test', publicKeyHex: PROPOSER_PUBKEY }],
    allowedPurposeCodes: ['MEDIATION'],
    allowedLaneIds: ['API_MEDIATED'],
    maxEntropyBits: 256,
    defaultTier: 'DENY',
  };
}

function makeDenyPolicy(): AdmissionPolicy {
  return {
    trustedAgents: [], // No trusted agents → DENY all
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

async function startServer(
  policy: AdmissionPolicy,
  descriptorOverrides?: Partial<AgentDescriptor>,
): Promise<{ server: AfalHttpServer; baseUrl: string }> {
  const descriptor = makeDescriptor();
  if (descriptorOverrides) {
    Object.assign(descriptor, descriptorOverrides);
  }
  const responder = new AfalResponder({
    agentId: 'bob-test',
    seedHex: RESPONDER_SEED,
    policy,
  });
  const server = new AfalHttpServer({
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
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, baseUrl };
}

// ── Lifecycle tests ──────────────────────────────────────────────────────────

describe('A2A task lifecycle (#311b)', () => {
  let server: AfalHttpServer;
  let baseUrl: string;

  afterEach(async () => {
    if (server) await server.stop();
  });

  describe('propose → working → session-tokens → completed', () => {
    beforeEach(async () => {
      const s = await startServer(makeAdmitPolicy());
      server = s.server;
      baseUrl = s.baseUrl;
    });

    it('propose with task_id returns working state', async () => {
      const signed = makeSignedPropose();
      const taskId = 'task-propose-lifecycle-1';
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
      expect((body['status'] as Record<string, unknown>)['state']).toBe('working');

      // In-flight task should be tracked
      expect(server._hasInFlightTask(taskId)).toBe(true);
      expect(server._inFlightTaskCount).toBe(1);
    });

    it('session-tokens completes lifecycle and removes in-flight task', async () => {
      // First: admit via direct AFAL to get admit_token_id
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

      // Simulate in-flight task tracking (as if propose came via A2A)
      const taskId = 'task-propose-lifecycle-complete';
      (server as unknown as { _inFlightTasks: Map<string, unknown> })._inFlightTasks.set(taskId, {
        state: 'working',
        proposalId,
        expiresAt: Date.now() + 600_000,
      });
      expect(server._hasInFlightTask(taskId)).toBe(true);

      // Session-tokens via A2A
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
      expect((body['status'] as Record<string, unknown>)['state']).toBe('completed');

      // In-flight task should be removed
      expect(server._hasInFlightTask(taskId)).toBe(false);
    });
  });

  describe('propose → failed (DENY)', () => {
    beforeEach(async () => {
      const s = await startServer(makeDenyPolicy());
      server = s.server;
      baseUrl = s.baseUrl;
    });

    it('DENY response has failed state', async () => {
      const signed = makeSignedPropose();
      const taskId = 'task-propose-deny-1';
      const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildA2ASendMessageRequest({
            mediaType: AGENTVAULT_PROPOSE_MEDIA_TYPE,
            data: signed,
            acceptedOutputModes: [AGENTVAULT_ADMIT_MEDIA_TYPE, AGENTVAULT_DENY_MEDIA_TYPE],
            taskId,
          }),
        ),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['id']).toBe(taskId);
      expect((body['status'] as Record<string, unknown>)['state']).toBe('failed');

      // No in-flight task stored for DENY
      expect(server._hasInFlightTask(taskId)).toBe(false);
    });

    it('DENY without task_id also returns failed state', async () => {
      const signed = makeSignedPropose();
      const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildA2ASendMessageRequest({
            mediaType: AGENTVAULT_PROPOSE_MEDIA_TYPE,
            data: signed,
            acceptedOutputModes: [AGENTVAULT_ADMIT_MEDIA_TYPE, AGENTVAULT_DENY_MEDIA_TYPE],
          }),
        ),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect((body['status'] as Record<string, unknown>)['state']).toBe('failed');
      expect(server._inFlightTaskCount).toBe(0);
    });
  });

  describe('old client backward compatibility (no task_id)', () => {
    beforeEach(async () => {
      const s = await startServer(makeAdmitPolicy());
      server = s.server;
      baseUrl = s.baseUrl;
    });

    it('propose without task_id returns completed state', async () => {
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
      expect((body['status'] as Record<string, unknown>)['state']).toBe('completed');
      // No in-flight task stored
      expect(server._inFlightTaskCount).toBe(0);
    });
  });

  describe('contract negotiation — always completed', () => {
    it('negotiation response is completed regardless of task_id', async () => {
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
        policy: makeAdmitPolicy(),
      });
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

      const taskId = 'task-negotiate-lifecycle-1';
      const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildA2ASendMessageRequest({
            mediaType: AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
            data: {
              negotiation_id: 'neg-lifecycle-1',
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
      expect((body['status'] as Record<string, unknown>)['state']).toBe('completed');
      // No in-flight task for negotiation
      expect(server._inFlightTaskCount).toBe(0);
    });
  });

  describe('session-tokens task correlation enforcement', () => {
    beforeEach(async () => {
      const s = await startServer(makeAdmitPolicy());
      server = s.server;
      baseUrl = s.baseUrl;
    });

    it('rejects session-tokens with unknown task_id', async () => {
      // Send session-tokens with a task_id that has no matching in-flight task
      const relay = makeRelay();
      const propose = makePropose({ relay_binding_hash: contentHash(relay) });
      const signed = signMessage(
        DOMAIN_PREFIXES.PROPOSE,
        propose as unknown as Record<string, unknown>,
        PROPOSER_SEED,
      );

      // First admit via direct AFAL to get valid commit data
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

      const bogusTaskId = 'task-propose-does-not-exist';
      const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildA2ASendMessageRequest({
            mediaType: AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE,
            data: commitMsg,
            acceptedOutputModes: [AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE],
            taskId: bogusTaskId,
          }),
        ),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['id']).toBe(bogusTaskId);
      expect((body['status'] as Record<string, unknown>)['state']).toBe('failed');
    });

    it('allows session-tokens without task_id (old client backward compat)', async () => {
      // Session-tokens with no task_id should proceed (no correlation check)
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

      // No taskId — old client
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
      expect((body['status'] as Record<string, unknown>)['state']).toBe('completed');
    });

    it('rejects session-tokens when task_id maps to a different proposal', async () => {
      // Admit two proposals, then try to commit proposal A using proposal B's task_id
      const relay = makeRelay();

      // Proposal A
      const proposeA = makePropose({
        relay_binding_hash: contentHash(relay),
        nonce: 'a'.repeat(64),
      });
      const signedA = signMessage(
        DOMAIN_PREFIXES.PROPOSE,
        proposeA as unknown as Record<string, unknown>,
        PROPOSER_SEED,
      );
      const admitResA = await fetch(`${baseUrl}/afal/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propose: signedA, relay }),
      });
      const admitBodyA = (await admitResA.json()) as Record<string, unknown>;
      const proposalIdA = admitBodyA['proposal_id'] as string;

      // Proposal B (different nonce → different proposal_id)
      const proposeB = makePropose({
        relay_binding_hash: contentHash(relay),
        nonce: 'b'.repeat(64),
      });
      const signedB = signMessage(
        DOMAIN_PREFIXES.PROPOSE,
        proposeB as unknown as Record<string, unknown>,
        PROPOSER_SEED,
      );
      const admitResB = await fetch(`${baseUrl}/afal/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propose: signedB, relay }),
      });
      const admitBodyB = (await admitResB.json()) as Record<string, unknown>;
      const admitTokenIdB = admitBodyB['admit_token_id'] as string;
      const proposalIdB = admitBodyB['proposal_id'] as string;

      // Sanity: proposals are different
      expect(proposalIdA).not.toBe(proposalIdB);

      // Register task A as in-flight (bound to proposal A)
      const taskIdA = 'task-propose-A';
      (server as unknown as { _inFlightTasks: Map<string, unknown> })._inFlightTasks.set(taskIdA, {
        state: 'working',
        proposalId: proposalIdA,
        expiresAt: Date.now() + 600_000,
      });

      // Try to commit proposal B using task A's task_id → should be rejected
      const commitMsgB = signMessage(
        DOMAIN_PREFIXES.COMMIT,
        {
          commit_version: '1',
          proposal_id: proposalIdB,
          from: 'alice-test',
          admit_token_id: admitTokenIdB,
          relay_session: {
            ...relay,
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
            data: commitMsgB,
            acceptedOutputModes: [AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE],
            taskId: taskIdA, // Wrong task — belongs to proposal A
          }),
        ),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['id']).toBe(taskIdA);
      expect((body['status'] as Record<string, unknown>)['state']).toBe('failed');

      // Task A should NOT be removed (mismatch was rejected)
      expect(server._hasInFlightTask(taskIdA)).toBe(true);
    });
  });

  describe('in-flight task TTL expiry', () => {
    beforeEach(async () => {
      const s = await startServer(makeAdmitPolicy());
      server = s.server;
      baseUrl = s.baseUrl;
    });

    it('expired in-flight tasks are garbage-collected on next A2A request', async () => {
      // Manually insert an expired in-flight task
      const expiredTaskId = 'task-propose-expired';
      (server as unknown as { _inFlightTasks: Map<string, unknown> })._inFlightTasks.set(
        expiredTaskId,
        {
          state: 'working',
          proposalId: 'expired-proposal',
          expiresAt: Date.now() - 1000, // already expired
        },
      );
      expect(server._hasInFlightTask(expiredTaskId)).toBe(true);

      // Any A2A request triggers GC
      const signed = makeSignedPropose();
      await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
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

      // Expired task should be cleaned up
      expect(server._hasInFlightTask(expiredTaskId)).toBe(false);
    });

    it('non-expired in-flight tasks survive GC', async () => {
      const validTaskId = 'task-propose-valid';
      (server as unknown as { _inFlightTasks: Map<string, unknown> })._inFlightTasks.set(
        validTaskId,
        {
          state: 'working',
          proposalId: 'valid-proposal',
          expiresAt: Date.now() + 600_000, // 10 minutes from now
        },
      );

      // Trigger GC
      const signed = makeSignedPropose();
      await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
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

      // Valid task should survive
      expect(server._hasInFlightTask(validTaskId)).toBe(true);
    });
  });
});
