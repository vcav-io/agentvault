/**
 * AFAL M4 E2E test — full PROPOSE → ADMIT → COMMIT → checkInbox flow.
 *
 * Two DirectAfalTransport instances in one process:
 *   Agent A (INITIATE mode): sends signed PROPOSE + relay tokens
 *   Agent B (RESPOND mode): HTTP server receives, evaluates, returns ADMIT
 *
 * Verifies Ed25519 signatures at each step and COMMIT binding.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { DirectAfalTransport } from '../direct-afal-transport.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { signMessage, verifyMessage, DOMAIN_PREFIXES, contentHash } from '../afal-signing.js';
import { computeProposalId, generateNonce } from '../afal-types.js';
import type { AfalPropose, RelayInvitePayload } from '../afal-types.js';

// ── Test keypairs ────────────────────────────────────────────────────────────

const ALICE_SEED = '0101010101010101010101010101010101010101010101010101010101010101';
const ALICE_PUBKEY = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';

const BOB_SEED = '0202020202020202020202020202020202020202020202020202020202020202';
const BOB_PUBKEY = bytesToHex(ed25519.getPublicKey(hexToBytes(BOB_SEED)));

// ── Descriptor helpers ───────────────────────────────────────────────────────

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
    endpoints: { propose: '', commit: '' },
    capabilities: { supported_body_formats: ['wrapped_v1'], supports_commit: true },
    policy_commitments: {},
    ...overrides,
  };
  return signMessage(
    DOMAIN_PREFIXES.DESCRIPTOR,
    unsigned as Record<string, unknown>,
    seedHex,
  ) as unknown as AgentDescriptor;
}

/**
 * Build a complete AfalPropose with descriptor_hash and model_profile_hash
 * already set, so proposal_id covers ALL fields that sendPropose will sign.
 *
 * sendPropose adds descriptor_hash and model_profile_hash to the signed
 * message — proposal_id must match the full signed content.
 */
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AFAL M4 E2E', () => {
  let transportA: DirectAfalTransport;
  let transportB: DirectAfalTransport;

  afterEach(async () => {
    if (transportB) await transportB.stop();
  });

  /** Start Bob (RESPOND) and return the descriptor URL for Alice to use. */
  async function startResponder(
    trustedAgents: { agentId: string; publicKeyHex: string }[],
  ): Promise<string> {
    const bobDescriptor = makeDescriptor('bob-test', BOB_PUBKEY, BOB_SEED);

    transportB = new DirectAfalTransport({
      agentId: 'bob-test',
      seedHex: BOB_SEED,
      localDescriptor: bobDescriptor,
      respondMode: {
        httpPort: 0,
        bindAddress: '127.0.0.1',
        policy: {
          trustedAgents,
          allowedPurposeCodes: ['MEDIATION'],
          allowedLaneIds: ['API_MEDIATED'],
          maxEntropyBits: 256,
          defaultTier: 'DENY',
        },
      },
    });

    await transportB.start();

    // Get actual port after listen
    const server = transportB as unknown as { httpServer: { port: number } };
    return `http://127.0.0.1:${server.httpServer.port}/afal/descriptor`;
  }

  it('full PROPOSE → ADMIT → COMMIT → checkInbox flow', async () => {
    const peerUrl = await startResponder([{ agentId: 'alice-test', publicKeyHex: ALICE_PUBKEY }]);

    const aliceDescriptor = makeDescriptor('alice-test', ALICE_PUBKEY, ALICE_SEED);

    transportA = new DirectAfalTransport({
      agentId: 'alice-test',
      seedHex: ALICE_SEED,
      localDescriptor: aliceDescriptor,
      peerDescriptorUrl: peerUrl,
    });

    // ── Step 1: Agent A sends PROPOSE ──────────────────────────────────

    const relay: RelayInvitePayload = {
      session_id: 'sess-e2e-001',
      responder_submit_token: 'submit-tok-e2e',
      responder_read_token: 'read-tok-e2e',
      relay_url: 'http://relay.example.com',
    };

    const propose = makeFullPropose(aliceDescriptor);

    await transportA.sendPropose({
      propose,
      relay,
      templateId: 'mediation-demo.v1.standard',
      budgetTier: 'SMALL',
    });

    // Verify A stored the ADMIT
    const storedAdmit = transportA._getStoredAdmit(propose.proposal_id);
    expect(storedAdmit).toBeDefined();
    expect(storedAdmit!['outcome']).toBe('ADMIT');
    expect(storedAdmit!['proposal_id']).toBe(propose.proposal_id);

    // Verify ADMIT is signed by Bob
    expect(verifyMessage(DOMAIN_PREFIXES.ADMIT, storedAdmit!, BOB_PUBKEY)).toBe(true);

    // ── Step 2: Agent A sends COMMIT ───────────────────────────────────

    await transportA.acceptInvite(propose.proposal_id);

    // ADMIT should be consumed
    expect(transportA._getStoredAdmit(propose.proposal_id)).toBeUndefined();

    // ── Step 3: Agent B drains inbox ───────────────────────────────────

    const inbox = await transportB.checkInbox();
    expect(inbox.invites).toHaveLength(1);

    const invite = inbox.invites[0];
    expect(invite.from_agent_id).toBe('alice-test');
    expect(invite.payload_type).toBe('VCAV_E_INVITE_V1');
    expect(invite.payload!['session_id']).toBe('sess-e2e-001');
    expect(invite.payload!['responder_submit_token']).toBe('submit-tok-e2e');
    expect(invite.payload!['responder_read_token']).toBe('read-tok-e2e');
    expect(invite.payload!['relay_url']).toBe('http://relay.example.com');

    // Verify the AFAL propose is attached
    expect(invite.afalPropose).toBeDefined();
    expect(invite.afalPropose!.proposal_id).toBe(propose.proposal_id);
    expect(invite.afalPropose!.purpose_code).toBe('MEDIATION');

    // Second drain should be empty
    const inbox2 = await transportB.checkInbox();
    expect(inbox2.invites).toHaveLength(0);
  });

  it('rejects untrusted proposer', async () => {
    const peerUrl = await startResponder([]); // No trusted agents

    const aliceDescriptor = makeDescriptor('alice-test', ALICE_PUBKEY, ALICE_SEED);

    transportA = new DirectAfalTransport({
      agentId: 'alice-test',
      seedHex: ALICE_SEED,
      localDescriptor: aliceDescriptor,
      peerDescriptorUrl: peerUrl,
    });

    const propose = makeFullPropose(aliceDescriptor);

    await expect(
      transportA.sendPropose({
        propose,
        relay: {
          session_id: 'sess-e2e-002',
          responder_submit_token: 'sub',
          responder_read_token: 'read',
          relay_url: 'http://relay.example.com',
        },
        templateId: 't',
        budgetTier: 'SMALL',
      }),
    ).rejects.toThrow('Proposal denied');
  });
});
