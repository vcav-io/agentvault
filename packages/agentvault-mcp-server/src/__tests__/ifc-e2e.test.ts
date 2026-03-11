import { afterEach, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { DirectAfalTransport, type AgentDescriptor } from '../direct-afal-transport.js';
import { signMessage, DOMAIN_PREFIXES } from '../afal-signing.js';
import type { AdmissionPolicy } from '../afal-responder.js';
import { IfcService } from '../ifc.js';
import { createToolRegistry } from '../tool-registry.js';

const ALICE_SEED = '0101010101010101010101010101010101010101010101010101010101010101';
const BOB_SEED = '0202020202020202020202020202020202020202020202020202020202020202';
const ALICE_PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(ALICE_SEED)));
const BOB_PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(BOB_SEED)));

function makeDescriptor(
  agentId: string,
  pubkeyHex: string,
  seedHex: string,
  port: number,
): AgentDescriptor {
  const unsigned = {
    descriptor_version: '1',
    agent_id: agentId,
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: '2099-12-31T23:59:59Z',
    identity_key: { algorithm: 'ed25519', public_key_hex: pubkeyHex },
    envelope_key: { algorithm: 'ed25519', public_key_hex: pubkeyHex },
    endpoints: {
      propose: `http://127.0.0.1:${port}/afal/propose`,
      commit: `http://127.0.0.1:${port}/afal/commit`,
      negotiate: `http://127.0.0.1:${port}/afal/negotiate`,
    },
    capabilities: {},
    policy_commitments: {},
  };
  return signMessage(DOMAIN_PREFIXES.DESCRIPTOR, unsigned, seedHex) as unknown as AgentDescriptor;
}

const policy: AdmissionPolicy = {
  trustedAgents: [],
  allowedPurposeCodes: ['MEDIATION', 'COMPATIBILITY'],
  allowedLaneIds: ['API_MEDIATED'],
  maxEntropyBits: 32,
  defaultTier: 'LOW_TRUST',
};

describe('IFC first slice e2e', () => {
  const transports: DirectAfalTransport[] = [];

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop()));
    transports.length = 0;
  });

  it('sends a post-session logistics message over A2A and exposes it via read_ifc_messages', async () => {
    const bobTransport = new DirectAfalTransport({
      agentId: 'bob-test',
      seedHex: BOB_SEED,
      localDescriptor: makeDescriptor('bob-test', BOB_PUB, BOB_SEED, 0),
      respondMode: {
        httpPort: 0,
        policy,
      },
    });
    transports.push(bobTransport);
    await bobTransport.start();

    const bobUrl = bobTransport.a2aSendMessageUrl;
    expect(bobUrl).toBeTruthy();

    const aliceTransport = new DirectAfalTransport({
      agentId: 'alice-test',
      seedHex: ALICE_SEED,
      localDescriptor: makeDescriptor('alice-test', ALICE_PUB, ALICE_SEED, 0),
      respondMode: {
        httpPort: 0,
        policy,
      },
    });
    transports.push(aliceTransport);

    const bobIfc = new IfcService({
      agentId: 'bob-test',
      seedHex: BOB_SEED,
      verifyingKeyHex: BOB_PUB,
      knownAgents: [],
    });
    bobTransport.setIfcService(bobIfc);

    const aliceRegistry = createToolRegistry({
      transport: aliceTransport,
      knownAgents: [{ agent_id: 'bob-test', aliases: ['Bob'], a2a_send_message_url: bobUrl ?? undefined }],
      ifcSeedHex: ALICE_SEED,
    });
    const bobRegistry = createToolRegistry({
      transport: bobTransport,
      knownAgents: [{ agent_id: 'alice-test', aliases: ['Alice'] }],
      ifcService: bobIfc,
    });

    const grantResult = await aliceRegistry.handleCreateIfcGrant({
      audience: 'bob-test',
      receipt_id: 'd'.repeat(64),
      session_id: '44444444-4444-4444-4444-444444444444',
      message_classes: ['LOGISTICS'],
      max_uses: 1,
      expires_in_seconds: 60,
    });
    expect(grantResult.ok).toBe(true);

    const sendResult = await aliceRegistry.handleSendIfcMessage({
      counterparty: 'bob-test',
      grant: (grantResult.data as { grant: unknown }).grant as never,
      message_class: 'LOGISTICS',
      payload: 'Meet at 10:30 UTC tomorrow.',
      related_receipt_id: 'd'.repeat(64),
      related_session_id: '44444444-4444-4444-4444-444444444444',
    });
    expect(sendResult.ok).toBe(true);
    expect((sendResult.data as { decision: string }).decision).toBe('ALLOW');

    const identityBefore = await bobRegistry.handleGetIdentity();
    expect(identityBefore.data?.pending_ifc_messages).toBe(1);

    const readResult = await bobRegistry.handleReadIfcMessages({});
    expect(readResult.ok).toBe(true);
    const messages = (readResult.data as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.['payload']).toBe('Meet at 10:30 UTC tomorrow.');

    const identityAfter = await bobRegistry.handleGetIdentity();
    expect(identityAfter.data?.pending_ifc_messages).toBe(0);
  });
});
