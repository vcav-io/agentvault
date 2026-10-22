/**
 * IFC with recipient-issued grants (VCAV-IFC-GRANT-V2).
 *
 * Bob is the recipient: he issues a grant to Alice for a session receipt he
 * holds, keeps the grant state, and enforces it when Alice's envelopes arrive.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { computeDigestHex, contentHash, DOMAIN_PREFIXES, signMessage, verifyMessage } from '../afal-signing.js';
import { IfcService, type IfcEnvelope, type IfcGrant, type IfcMessageClass } from '../ifc.js';
import { recordHeldReceipt } from '../held-receipts.js';
import { keyFingerprint } from '../pin-store.js';
import { InsecureStateFileError } from '../secure-fs.js';
import grantVector from './vectors/ifc-grant-v2.json';

const ALICE_SEED = '01'.repeat(32);
const ALICE_PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(ALICE_SEED)));
const BOB_SEED = '02'.repeat(32);
const BOB_PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(BOB_SEED)));
const MALLORY_SEED = '09'.repeat(32);
const MALLORY_PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(MALLORY_SEED)));
const RECEIPT_ID = 'c0ffee00-0000-4000-8000-000000000003';
const SESSION_ID = 'a'.repeat(64);
const POST_SESSION_POLICY_HASH = contentHash({
  policy_version: 'POST_SESSION_V1',
  allowed_classes: ['LOGISTICS', 'CONSENT', 'REFERENCE', 'ARTIFACT_TRANSFER'],
});
const posix = process.platform !== 'win32';

let bobDir: string;
let aliceDir: string;

beforeEach(() => {
  bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selkey-ifc-bob-'));
  aliceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selkey-ifc-alice-'));
});
afterEach(() => {
  fs.rmSync(bobDir, { recursive: true, force: true });
  fs.rmSync(aliceDir, { recursive: true, force: true });
});

function bobService(alicePub = ALICE_PUB): IfcService {
  return new IfcService({
    agentId: 'bob-test',
    seedHex: BOB_SEED,
    verifyingKeyHex: BOB_PUB,
    knownAgents: [{ agent_id: 'alice-test', aliases: ['Alice'], public_key_hex: alicePub }],
    stateDir: bobDir,
  });
}

function aliceService(): IfcService {
  return new IfcService({
    agentId: 'alice-test',
    seedHex: ALICE_SEED,
    verifyingKeyHex: ALICE_PUB,
    knownAgents: [
      {
        agent_id: 'bob-test',
        aliases: ['Bob'],
        public_key_hex: BOB_PUB,
        a2a_send_message_url: 'http://bob.example.com/a2a/send-message',
      },
    ],
    stateDir: aliceDir,
  });
}

/** Bob completed a session with `counterparty` and holds its receipt. */
function bobHoldsReceipt(counterparty = 'alice-test', receiptId = RECEIPT_ID): void {
  recordHeldReceipt(
    {
      agent_id: 'bob-test',
      receipt_id: receiptId,
      session_id: SESSION_ID,
      counterparty,
      role: 'RESPONDER',
      receipt_verified: true,
      recorded_at: new Date().toISOString(),
    },
    bobDir,
  );
}

function issueToAlice(
  bob: IfcService,
  overrides: Partial<{ message_classes: IfcMessageClass[]; max_uses: number; expires_in_seconds: number }> = {},
): IfcGrant {
  return bob.createGrant({
    audience: 'alice-test',
    receipt_id: RECEIPT_ID,
    message_classes: ['LOGISTICS', 'ARTIFACT_TRANSFER', 'REFERENCE'],
    max_uses: 2,
    expires_in_seconds: 60,
    ...overrides,
  }).grant;
}

function envelopeFrom(
  seed: string,
  grantId: string,
  overrides: Partial<Record<string, unknown>> = {},
): IfcEnvelope {
  return signMessage(
    DOMAIN_PREFIXES.IFC_ENVELOPE,
    {
      version: 'AV-IFC-MSG-V1',
      message_id: '33333333-3333-4333-8333-333333333333',
      created_at: new Date().toISOString(),
      sender: 'alice-test',
      recipient: 'bob-test',
      message_class: 'LOGISTICS',
      session_relation: 'POST_SESSION',
      payload: 'Meet at 10:30 UTC tomorrow.',
      related_receipt_id: RECEIPT_ID,
      related_session_id: SESSION_ID,
      grant_id: grantId,
      ifc_policy_hash: POST_SESSION_POLICY_HASH,
      label_receipt: { policy_version: 'POST_SESSION_V1', message_class: 'LOGISTICS', session_relation: 'POST_SESSION' },
      ...overrides,
    },
    seed,
  ) as unknown as IfcEnvelope;
}

function auditEvents(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, 'ifc-audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('grant issuance (recipient side)', () => {
  it('issues a V2 grant for a held receipt whose counterparty is the audience', () => {
    bobHoldsReceipt();
    const grant = issueToAlice(bobService());
    expect(grant.version).toBe('VCAV-IFC-GRANT-V2');
    expect(grant.issuer).toBe('bob-test');
    expect(grant.audience).toBe('alice-test');
    expect(grant.audience_key_fpr).toBe(keyFingerprint(ALICE_PUB));
    expect(grant.provenance).toEqual({ receipt_id: RECEIPT_ID, session_id: SESSION_ID });
    expect(verifyMessage(DOMAIN_PREFIXES.IFC_GRANT, grant as unknown as Record<string, unknown>, BOB_PUB)).toBe(true);
    expect(auditEvents(bobDir).map((e) => e['event'])).toEqual(['ISSUE']);
  });

  it('refuses a receipt this agent does not hold', () => {
    expect(() => issueToAlice(bobService())).toThrow(/no held receipt/);
  });

  it('refuses an audience that was not the counterparty in the session', () => {
    bobHoldsReceipt('carol-test');
    expect(() => issueToAlice(bobService())).toThrow(/not the counterparty/);
  });

  it('refuses an unpinned audience', () => {
    bobHoldsReceipt();
    const bob = new IfcService({
      agentId: 'bob-test',
      seedHex: BOB_SEED,
      verifyingKeyHex: BOB_PUB,
      knownAgents: [{ agent_id: 'alice-test', aliases: [] }],
      stateDir: bobDir,
    });
    expect(() => issueToAlice(bob)).toThrow(/no pinned key for audience/);
  });

  it('caps the TTL at the policy ceiling', () => {
    bobHoldsReceipt();
    expect(() => issueToAlice(bobService(), { expires_in_seconds: 86401 })).toThrow(/expires_in_seconds/);
  });

  it.skipIf(!posix)('stores grants 0600 in a 0700 directory and refuses an insecure store', () => {
    bobHoldsReceipt();
    issueToAlice(bobService());
    const store = path.join(bobDir, 'ifc-grants.json');
    expect(fs.statSync(store).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(bobDir, 'ifc-audit.jsonl')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(bobDir).mode & 0o777).toBe(0o700);
    fs.chmodSync(store, 0o666);
    expect(() => bobService().listGrants()).toThrow(InsecureStateFileError);
  });
});

describe('receiving envelopes (recipient enforces its own store)', () => {
  it('accepts a message from the audience under an active grant', () => {
    bobHoldsReceipt();
    const bob = bobService();
    const grant = issueToAlice(bob);
    const delivery = bob.receiveEnvelope({ envelope: envelopeFrom(ALICE_SEED, grant.grant_id) });
    expect(delivery.decision).toBe('ALLOW');
    expect(bob.readMessages().messages[0]?.['payload']).toBe('Meet at 10:30 UTC tomorrow.');
  });

  it('blocks a grant the sender issued to itself', () => {
    // Alice holds the receipt on her side and mints a grant naming Bob; Bob
    // never issued it, so it is not in his store.
    recordHeldReceipt(
      {
        agent_id: 'alice-test',
        receipt_id: RECEIPT_ID,
        session_id: SESSION_ID,
        counterparty: 'bob-test',
        role: 'INITIATOR',
        receipt_verified: true,
        recorded_at: new Date().toISOString(),
      },
      aliceDir,
    );
    const selfIssued = aliceService().createGrant({
      audience: 'bob-test',
      receipt_id: RECEIPT_ID,
      message_classes: ['LOGISTICS'],
      max_uses: 5,
      expires_in_seconds: 60,
    }).grant;
    const delivery = bobService().receiveEnvelope({
      envelope: envelopeFrom(ALICE_SEED, selfIssued.grant_id),
      grant: selfIssued,
    });
    expect(delivery.decision).toBe('BLOCK');
    expect(delivery.error).toBe('unknown grant_id');
  });

  it('blocks a replayed message_id', () => {
    bobHoldsReceipt();
    const bob = bobService();
    const grant = issueToAlice(bob, { max_uses: 5 });
    const envelope = envelopeFrom(ALICE_SEED, grant.grant_id);
    expect(bob.receiveEnvelope({ envelope }).decision).toBe('ALLOW');
    const replay = bob.receiveEnvelope({ envelope });
    expect(replay.decision).toBe('BLOCK');
    expect(replay.error).toBe('duplicate message_id');
  });

  it('keeps use counts and seen message_ids across restarts', () => {
    bobHoldsReceipt();
    const grant = issueToAlice(bobService(), { max_uses: 1 });
    expect(bobService().receiveEnvelope({ envelope: envelopeFrom(ALICE_SEED, grant.grant_id) }).decision).toBe('ALLOW');
    const restarted = bobService();
    const second = restarted.receiveEnvelope({
      envelope: envelopeFrom(ALICE_SEED, grant.grant_id, { message_id: '44444444-4444-4444-8444-444444444444' }),
    });
    expect(second.decision).toBe('BLOCK');
    expect(second.error).toBe('grant exhausted');
    const issued = restarted.listGrants().issued[0];
    expect(issued?.['uses']).toBe(1);
    expect(issued?.['state']).toBe('EXHAUSTED');
  });

  it('blocks a revoked grant immediately', () => {
    bobHoldsReceipt();
    const bob = bobService();
    const grant = issueToAlice(bob);
    bob.revokeGrant({ grant_id: grant.grant_id, reason: 'no longer needed' });
    const delivery = bob.receiveEnvelope({ envelope: envelopeFrom(ALICE_SEED, grant.grant_id) });
    expect(delivery.decision).toBe('BLOCK');
    expect(delivery.error).toBe('grant revoked');
    expect(bob.listGrants().issued[0]?.['state']).toBe('REVOKED');
  });

  it('judges expiry by the stored grant and logs it once', async () => {
    bobHoldsReceipt();
    const bob = bobService();
    const grant = issueToAlice(bob, { expires_in_seconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const delivery = bob.receiveEnvelope({ envelope: envelopeFrom(ALICE_SEED, grant.grant_id) });
    expect(delivery.decision).toBe('BLOCK');
    expect(delivery.error).toBe('grant expired');
    bob.listGrants();
    expect(auditEvents(bobDir).filter((e) => e['event'] === 'EXPIRE')).toHaveLength(1);
  });

  it('blocks an envelope not signed by the audience pin', () => {
    bobHoldsReceipt();
    const bob = bobService();
    const grant = issueToAlice(bob);
    const delivery = bob.receiveEnvelope({ envelope: envelopeFrom(MALLORY_SEED, grant.grant_id) });
    expect(delivery.decision).toBe('BLOCK');
    expect(delivery.error).toMatch(/does not verify under the audience pin/);
  });

  it('blocks when the audience key changed since issuance', () => {
    bobHoldsReceipt();
    const grant = issueToAlice(bobService());
    const delivery = bobService(MALLORY_PUB).receiveEnvelope({ envelope: envelopeFrom(MALLORY_SEED, grant.grant_id) });
    expect(delivery.decision).toBe('BLOCK');
    expect(delivery.error).toBe('grant audience key changed since issuance');
  });

  it('blocks a message class outside the grant scope', () => {
    bobHoldsReceipt();
    const bob = bobService();
    const grant = issueToAlice(bob, { message_classes: ['LOGISTICS'] });
    const delivery = bob.receiveEnvelope({
      envelope: envelopeFrom(ALICE_SEED, grant.grant_id, { message_class: 'CONSENT' }),
    });
    expect(delivery.error).toBe('grant scope mismatch');
  });

  it('blocks an envelope that carries a V1 grant', () => {
    bobHoldsReceipt();
    const bob = bobService();
    const grant = issueToAlice(bob);
    const delivery = bob.receiveEnvelope({
      envelope: envelopeFrom(ALICE_SEED, grant.grant_id),
      grant: { ...grant, version: 'AV-IFC-GRANT-V1' },
    });
    expect(delivery.decision).toBe('BLOCK');
    expect(delivery.error).toMatch(/unsupported grant version/);
  });

  it('returns HIDE for ARTIFACT_TRANSFER and ESCALATE for REFERENCE', () => {
    bobHoldsReceipt();
    const bob = bobService();
    const grant = issueToAlice(bob, { max_uses: 5 });
    const hidden = bob.receiveEnvelope({
      envelope: envelopeFrom(ALICE_SEED, grant.grant_id, {
        message_class: 'ARTIFACT_TRANSFER',
        message_id: '55555555-5555-4555-8555-555555555555',
      }),
    });
    expect(hidden.decision).toBe('HIDE');
    expect(hidden.hidden_variable_id).toMatch(/^ifc_var_/);
    const escalated = bob.receiveEnvelope({
      envelope: envelopeFrom(ALICE_SEED, grant.grant_id, {
        message_class: 'REFERENCE',
        message_id: '66666666-6666-4666-8666-666666666666',
      }),
    });
    expect(escalated.decision).toBe('ESCALATE');
  });

  it('writes an append-only audit trail of issue, use, deny and revoke', () => {
    bobHoldsReceipt();
    const bob = bobService();
    const grant = issueToAlice(bob);
    bob.receiveEnvelope({ envelope: envelopeFrom(ALICE_SEED, grant.grant_id) });
    bob.receiveEnvelope({ envelope: envelopeFrom(ALICE_SEED, grant.grant_id) });
    bob.revokeGrant({ grant_id: grant.grant_id });
    expect(auditEvents(bobDir).map((e) => e['event'])).toEqual(['ISSUE', 'USE', 'DENY', 'REVOKE']);
  });
});

describe('sending (sender side uses a received grant)', () => {
  it('rejects a V1 grant', async () => {
    bobHoldsReceipt();
    const grant = issueToAlice(bobService());
    await expect(
      aliceService().sendMessage({
        counterparty: 'bob-test',
        grant: { ...grant, version: 'AV-IFC-GRANT-V1' } as unknown as IfcGrant,
        message_class: 'LOGISTICS',
        payload: 'hi',
      }),
    ).rejects.toThrow(/unsupported grant version/);
  });

  it('rejects a grant that was not issued by the counterparty', async () => {
    bobHoldsReceipt();
    const grant = issueToAlice(bobService());
    const alice = new IfcService({
      agentId: 'alice-test',
      seedHex: ALICE_SEED,
      verifyingKeyHex: ALICE_PUB,
      knownAgents: [
        { agent_id: 'bob-test', aliases: [], public_key_hex: BOB_PUB },
        { agent_id: 'carol-test', aliases: [], public_key_hex: MALLORY_PUB, a2a_send_message_url: 'http://c' },
      ],
      stateDir: aliceDir,
    });
    await expect(
      alice.sendMessage({ counterparty: 'carol-test', grant, message_class: 'LOGISTICS', payload: 'hi' }),
    ).rejects.toThrow(/not issued by the counterparty/);
  });

  it('rejects a grant whose signature does not verify under the issuer pin', async () => {
    bobHoldsReceipt();
    const grant = issueToAlice(bobService());
    const { signature: _s, ...unsigned } = grant;
    const resigned = signMessage(DOMAIN_PREFIXES.IFC_GRANT, unsigned, MALLORY_SEED) as IfcGrant;
    await expect(
      aliceService().sendMessage({ counterparty: 'bob-test', grant: resigned, message_class: 'LOGISTICS', payload: 'hi' }),
    ).rejects.toThrow(/does not verify under the issuer pin/);
  });

  it('stores a delivered grant and can send by grant_id', () => {
    bobHoldsReceipt();
    const grant = issueToAlice(bobService());
    const alice = aliceService();
    expect(alice.receiveGrant({ grant })).toEqual({ accepted: true, grant_id: grant.grant_id });
    expect(alice.listGrants().received[0]?.['grant_id']).toBe(grant.grant_id);
  });
});

describe('VCAV-IFC-GRANT-V2 vector', () => {
  it('matches the published grant_id, signing digest and signature', () => {
    const { unsigned, grant_id, digest_hex, signature, signer_seed_hex, signer_public_key_hex } = grantVector;
    expect(bytesToHex(ed25519.getPublicKey(hexToBytes(signer_seed_hex)))).toBe(signer_public_key_hex);
    expect(contentHash(unsigned)).toBe(grant_id);
    expect(computeDigestHex(DOMAIN_PREFIXES.IFC_GRANT, { ...unsigned, grant_id })).toBe(digest_hex);
    const signed = signMessage(DOMAIN_PREFIXES.IFC_GRANT, { ...unsigned, grant_id }, signer_seed_hex);
    expect(signed.signature).toBe(signature);
    expect(verifyMessage(DOMAIN_PREFIXES.IFC_GRANT, signed, signer_public_key_hex)).toBe(true);
    // The V1 domain prefix must not verify a V2 grant.
    expect(DOMAIN_PREFIXES.IFC_GRANT).toBe('VCAV-IFC-GRANT-V2:');
  });
});
