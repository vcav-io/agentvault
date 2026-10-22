/**
 * Conformance with the vault-family-core IFC grant v2 and key rotation
 * vectors (copied into packages/selkey-client/test-vectors/vfc/ by
 * scripts/sync-vfc-vectors.sh). Every positive case must be accepted and
 * every negative case rejected; expected_error is informative only.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { computeDigestHex, contentHash, DOMAIN_PREFIXES, signMessage, stripSignature } from '../afal-signing.js';
import { verifyGrantV2 } from '../ifc.js';
import { PinStore, keyFingerprint, type KeyRotationStatement } from '../pin-store.js';

const VECTOR_DIR = path.resolve(__dirname, '../../../selkey-client/test-vectors/vfc');
/** A fixed "now" after every vector's issued_at, so the future-skew check never applies. */
const NOW_MS = Date.parse('2026-10-22T13:00:00Z');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, name), 'utf8'));
}

describe('VCAV-IFC-GRANT-V2 vectors', () => {
  for (const file of ['ifc_grant_v2_positive_01.json', 'ifc_grant_v2_positive_02.json']) {
    it(`accepts ${file}`, () => {
      const v = load(file);
      expect(v.domain_prefix).toBe(DOMAIN_PREFIXES.IFC_GRANT);
      expect(bytesToHex(ed25519.getPublicKey(hexToBytes(v.signer_seed_hex)))).toBe(v.signer_public_key_hex);
      expect(contentHash(v.unsigned)).toBe(v.grant_id);
      expect(computeDigestHex(DOMAIN_PREFIXES.IFC_GRANT, { ...v.unsigned, grant_id: v.grant_id })).toBe(v.digest_hex);
      expect(v.unsigned.audience_key_fpr).toBe(keyFingerprint(v.audience_public_key_hex));
      const grant = { ...v.unsigned, grant_id: v.grant_id, signature: v.signature };
      expect(verifyGrantV2(grant, v.signer_public_key_hex).grant_id).toBe(v.grant_id);
      // Ed25519 signing is deterministic: re-signing reproduces the signature.
      expect(signMessage(DOMAIN_PREFIXES.IFC_GRANT, { ...v.unsigned, grant_id: v.grant_id }, v.signer_seed_hex).signature).toBe(
        v.signature,
      );
    });
  }

  const negative = load('ifc_grant_v2_negative.json');
  for (const c of negative.cases) {
    it(`rejects ${c.name} (${c.expected_error})`, () => {
      expect(() => verifyGrantV2(c.grant, negative.issuer_public_key_hex)).toThrow();
    });
  }
});

describe('VCAV-KEY-ROTATION-V1 vectors', () => {
  const rust = load('afal-key-rotation-v1.json');
  const ts = load('afal-key-rotation-ts-01.json');
  const positives = [
    ...rust.positive.map((c: { statement: KeyRotationStatement }, i: number) => ({ name: `rust #${i + 1}`, ...c })),
    { name: 'typescript', ...ts },
  ];

  for (const c of positives) {
    it(`applies the ${c.name} statement`, () => {
      expect(c.domain_prefix).toBe(DOMAIN_PREFIXES.KEY_ROTATION);
      expect(bytesToHex(ed25519.getPublicKey(hexToBytes(c.old_seed_hex)))).toBe(c.old_public_key_hex);
      expect(computeDigestHex(DOMAIN_PREFIXES.KEY_ROTATION, stripSignature(c.statement))).toBe(c.digest_hex);
      const store = PinStore.inMemory([{ agentId: c.statement.agent_id, publicKeyHex: c.old_public_key_hex }]);
      const pin = store.applyRotation(c.statement, c.new_public_key_hex, NOW_MS);
      expect(pin.public_key_hex).toBe(c.new_public_key_hex);
      expect(pin.source).toBe('rotation');
    });
  }

  for (const c of rust.negative) {
    it(`rejects ${c.name} (${c.expected_error})`, () => {
      const agentId = typeof c.statement?.agent_id === 'string' ? c.statement.agent_id : 'bob-test';
      const store = PinStore.inMemory([{ agentId, publicKeyHex: c.pinned_public_key_hex }]);
      expect(() => store.applyRotation(c.statement, c.new_public_key_hex, NOW_MS)).toThrow();
      expect(store.pinnedKeyFor(agentId)).toBe(c.pinned_public_key_hex);
    });
  }
});
