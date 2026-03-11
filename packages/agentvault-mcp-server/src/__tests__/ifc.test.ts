import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { contentHash, DOMAIN_PREFIXES, signMessage } from '../afal-signing.js';
import { IfcService, type IfcEnvelope, type IfcGrant } from '../ifc.js';

const ALICE_SEED = '0101010101010101010101010101010101010101010101010101010101010101';
const ALICE_PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(ALICE_SEED)));

function createService(agentId = 'alice-test') {
  return new IfcService({
    agentId,
    seedHex: ALICE_SEED,
    verifyingKeyHex: ALICE_PUB,
    knownAgents: [],
  });
}

describe('IfcService', () => {
  it('creates and verifies a valid grant', () => {
    const service = createService();
    const result = service.createGrant({
      audience: 'bob-test',
      receipt_id: 'a'.repeat(64),
      session_id: '11111111-1111-1111-1111-111111111111',
      message_classes: ['LOGISTICS', 'CONSENT'],
      max_uses: 2,
      expires_in_seconds: 60,
    });

    expect(result.grant_id).toHaveLength(64);
    expect(result.grant.scope.message_classes).toEqual(['LOGISTICS', 'CONSENT']);
    expect(() => service.verifyGrant(result.grant)).not.toThrow();
  });

  it('rejects an expired grant', () => {
    const service = createService();
    const result = service.createGrant({
      audience: 'bob-test',
      receipt_id: 'a'.repeat(64),
      session_id: '11111111-1111-1111-1111-111111111111',
      message_classes: ['LOGISTICS'],
      max_uses: 1,
      expires_in_seconds: 60,
    });
    const { signature: _sig, grant_id: _grantId, ...unsigned } = result.grant;
    const expired = signMessage(
      DOMAIN_PREFIXES.IFC_GRANT,
      {
        ...unsigned,
        expires_at: '2000-01-01T00:00:00.000Z',
        grant_id: contentHash({
          ...unsigned,
          expires_at: '2000-01-01T00:00:00.000Z',
        }),
      },
      ALICE_SEED,
    ) as IfcGrant;

    expect(() => service.verifyGrant(expired)).toThrow('grant expired');
  });

  it('returns HIDE for ARTIFACT_TRANSFER and stores a hidden reference', () => {
    const alice = createService('alice-test');
    const bob = new IfcService({
      agentId: 'bob-test',
      seedHex: '0202020202020202020202020202020202020202020202020202020202020202',
      verifyingKeyHex: bytesToHex(
        ed25519.getPublicKey(
          hexToBytes('0202020202020202020202020202020202020202020202020202020202020202'),
        ),
      ),
      knownAgents: [],
    });

    const { grant } = alice.createGrant({
      audience: 'bob-test',
      receipt_id: 'b'.repeat(64),
      session_id: '22222222-2222-2222-2222-222222222222',
      message_classes: ['ARTIFACT_TRANSFER'],
      max_uses: 1,
      expires_in_seconds: 60,
    });

    const envelope = signMessage(
      DOMAIN_PREFIXES.IFC_ENVELOPE,
      {
        version: 'AV-IFC-MSG-V1',
        message_id: '33333333-3333-3333-3333-333333333333',
        created_at: new Date().toISOString(),
        sender: 'alice-test',
        recipient: 'bob-test',
        message_class: 'ARTIFACT_TRANSFER',
        session_relation: 'POST_SESSION',
        payload: 'artifact-pointer',
        related_receipt_id: 'b'.repeat(64),
        related_session_id: '22222222-2222-2222-2222-222222222222',
        grant_id: grant.grant_id,
        ifc_policy_hash: 'c'.repeat(64),
        label_receipt: {
          policy_version: 'POST_SESSION_V1',
          message_class: 'ARTIFACT_TRANSFER',
          session_relation: 'POST_SESSION',
        },
      },
      ALICE_SEED,
    ) as IfcEnvelope;

    const delivery = bob.receiveEnvelope({
      grant,
      envelope,
    });

    expect(delivery.decision).toBe('HIDE');
    expect(delivery.hidden_variable_id).toMatch(/^ifc_var_/);

    const readResult = bob.readMessages();
    expect(readResult.messages).toHaveLength(1);
    expect(readResult.messages[0]?.['decision']).toBe('HIDE');
    expect(readResult.messages[0]?.['hidden_variable_id']).toMatch(/^ifc_var_/);
  });

  it('blocks an envelope with an invalid signature', () => {
    const alice = createService('alice-test');
    const bob = new IfcService({
      agentId: 'bob-test',
      seedHex: '0202020202020202020202020202020202020202020202020202020202020202',
      verifyingKeyHex: bytesToHex(
        ed25519.getPublicKey(
          hexToBytes('0202020202020202020202020202020202020202020202020202020202020202'),
        ),
      ),
      knownAgents: [],
    });

    const { grant } = alice.createGrant({
      audience: 'bob-test',
      receipt_id: 'b'.repeat(64),
      session_id: '22222222-2222-2222-2222-222222222222',
      message_classes: ['LOGISTICS'],
      max_uses: 1,
      expires_in_seconds: 60,
    });

    const delivery = bob.receiveEnvelope({
      grant,
      envelope: {
        version: 'AV-IFC-MSG-V1',
        message_id: '33333333-3333-3333-3333-333333333333',
        created_at: '2026-03-11T18:00:00.000Z',
        sender: 'alice-test',
        recipient: 'bob-test',
        message_class: 'LOGISTICS',
        session_relation: 'POST_SESSION',
        payload: 'Meet at 10:30 UTC tomorrow.',
        related_receipt_id: 'b'.repeat(64),
        related_session_id: '22222222-2222-2222-2222-222222222222',
        grant_id: grant.grant_id,
        ifc_policy_hash: 'c'.repeat(64),
        label_receipt: {
          policy_version: 'POST_SESSION_V1',
          message_class: 'LOGISTICS',
          session_relation: 'POST_SESSION',
        },
        signature: '',
      } as IfcEnvelope,
    });

    expect(delivery.decision).toBe('BLOCK');
  });
});
