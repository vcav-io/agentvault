/**
 * Conformance with the vault-family-core receipt v3 golden vectors.
 *
 * The vectors are copied into test-vectors/vfc/ by scripts/sync-vfc-vectors.sh
 * (the source revision is in test-vectors/vfc/VFC_REVISION). Every positive
 * case must be accepted with the expected values and every negative case must
 * be rejected; error classes are informative only.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import canonicalize from 'canonicalize';
import { ed25519 } from '@noble/curves/ed25519';
import { hexToBytes } from '@noble/hashes/utils';
import { canonicalizeV3, parseJsonStrict, sha256Hex } from '../jcs-v3.js';
import { computeInputCommitmentV3, verifyInputCommitmentV3 } from '../commitment-v3.js';
import { computeContractHashV2Str, normalizeContractV2 } from '../contract-hash-v2.js';
import {
  checkContractV3,
  checkOwnInputV3,
  checkReceivedOutputV3,
  decodeBase64urlCanonical,
  signingDigestV3,
  verifyReceiptV3,
} from '../receipt-v3.js';
import { verifyReceipt } from '../verify-receipt.js';

const VECTOR_DIR = path.resolve(__dirname, '../../test-vectors/vfc');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, name), 'utf8'));
}

const EXPECTED_FILES = [
  'contract_hash_v2.json',
  'input_commitment_v3.json',
  'jcs_rfc8785_numbers.json',
  'jcs_rfc8785_testdata.json',
  'jcs_v3_profile.json',
  'receipt_v3_negative.json',
  'receipt_v3_positive_01.json',
  'receipt_v3_positive_02.json',
];

describe('VFC vector set', () => {
  it('contains every receipt v3 vector file', () => {
    const present = fs
      .readdirSync(VECTOR_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(present).toEqual(EXPECTED_FILES);
    expect(fs.readFileSync(path.join(VECTOR_DIR, 'VFC_REVISION'), 'utf8').trim()).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });
});

describe('jcs_rfc8785_testdata.json', () => {
  const v = load('jcs_rfc8785_testdata.json');
  for (const c of v.cases) {
    it(`canonicalises ${c.name}`, () => {
      expect(canonicalize(JSON.parse(c.input_json))).toBe(c.expected_canonical);
      expect(sha256Hex(c.expected_canonical)).toBe(c.expected_sha256_hex);
      if (c.within_v3_number_limit) {
        expect(canonicalizeV3(parseJsonStrict(c.input_json))).toBe(c.expected_canonical);
      } else {
        expect(() => canonicalizeV3(parseJsonStrict(c.input_json))).toThrow();
      }
    });
  }
});

describe('jcs_rfc8785_numbers.json', () => {
  const v = load('jcs_rfc8785_numbers.json');
  for (const c of v.cases) {
    it(`serialises IEEE-754 ${c.ieee754_hex}`, () => {
      const n = new DataView(hexToBytes(c.ieee754_hex).buffer).getFloat64(0, false);
      expect(canonicalize(n)).toBe(c.expected_canonical);
      if (c.within_v3_number_limit) {
        expect(canonicalizeV3(n)).toBe(c.expected_canonical);
      } else {
        expect(() => canonicalizeV3(n)).toThrow();
      }
    });
  }
});

describe('jcs_v3_profile.json', () => {
  const v = load('jcs_v3_profile.json');
  for (const c of v.accepted) {
    it(`accepts ${c.name}`, () => {
      const canonical = canonicalizeV3(parseJsonStrict(c.input_json));
      expect(canonical).toBe(c.expected_canonical);
      expect(sha256Hex(canonical)).toBe(c.expected_sha256_hex);
    });
  }
  for (const c of v.rejected) {
    it(`rejects ${c.name}`, () => {
      expect(() => canonicalizeV3(parseJsonStrict(c.input_json))).toThrow();
    });
  }
});

describe('input_commitment_v3.json', () => {
  const v = load('input_commitment_v3.json');
  for (const c of v.positive) {
    it(`computes ${c.name}`, () => {
      const context = parseJsonStrict(c.context_json);
      expect(canonicalizeV3(context)).toBe(c.expected_canonical_context);
      expect(computeInputCommitmentV3(c.nonce_hex, context)).toBe(c.expected_commitment);
      expect(sha256Hex(hexToBytes(c.expected_preimage_hex))).toBe(c.expected_commitment);
      expect(verifyInputCommitmentV3(c.nonce_hex, context, c.expected_commitment)).toBe(true);
    });
  }
  for (const c of v.negative) {
    it(`rejects ${c.name}`, () => {
      let accepted = false;
      try {
        accepted = verifyInputCommitmentV3(
          c.nonce_hex,
          parseJsonStrict(c.context_json),
          c.commitment,
        );
      } catch {
        accepted = false;
      }
      expect(accepted).toBe(false);
    });
  }
});

describe('contract_hash_v2.json', () => {
  const v = load('contract_hash_v2.json');
  for (const c of v.positive) {
    it(`hashes ${c.name}`, () => {
      expect(computeContractHashV2Str(c.contract_json)).toBe(c.expected_contract_hash);
      expect(canonicalizeV3(normalizeContractV2(parseJsonStrict(c.contract_json)))).toBe(
        c.expected_normalized_canonical,
      );
    });
  }
  for (const c of v.negative) {
    it(`rejects ${c.name}`, () => {
      expect(() => computeContractHashV2Str(c.contract_json)).toThrow();
    });
  }
});

describe('receipt_v3_positive_*.json', () => {
  for (const file of ['receipt_v3_positive_01.json', 'receipt_v3_positive_02.json']) {
    const v = load(file);
    it(`${file} verifies against the pinned key`, () => {
      const result = verifyReceiptV3(v.input.receipt_json, v.input.verifying_key_hex);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.receipt).toEqual(v.receipt);
      expect(
        canonicalizeV3(
          Object.fromEntries(Object.entries(result.receipt).filter(([k]) => k !== 'signature')),
        ),
      ).toBe(v.expected.canonical_unsigned);
      expect(Buffer.from(signingDigestV3(result.receipt)).toString('hex')).toBe(
        v.expected.signing_digest_hex,
      );
      expect(result.receipt.operator.operator_key_fingerprint).toBe(
        v.expected.operator_key_fingerprint,
      );
    });

    it(`${file} verifies through verifyReceipt (text and object input)`, () => {
      expect(verifyReceipt(v.input.receipt_json, v.input.verifying_key_hex).valid).toBe(true);
      expect(verifyReceipt(v.receipt, v.input.verifying_key_hex).valid).toBe(true);
    });
  }

  const v1 = load('receipt_v3_positive_01.json');
  const verified = verifyReceiptV3(v1.input.receipt_json, v1.input.verifying_key_hex);
  if (!verified.ok) throw new Error('receipt_v3_positive_01 must verify');

  it('own-input check passes for each participant with their nonce', () => {
    for (const p of v1.participants_private) {
      expect(() =>
        checkOwnInputV3(verified.receipt, {
          participantId: p.participant_id,
          context: parseJsonStrict(p.context_json),
          commitmentNonce: p.nonce_hex,
        }),
      ).not.toThrow();
    }
  });

  it('own-input check fails with another participant nonce', () => {
    const [alice, bob] = v1.participants_private;
    expect(() =>
      checkOwnInputV3(verified.receipt, {
        participantId: alice.participant_id,
        context: parseJsonStrict(alice.context_json),
        commitmentNonce: bob.nonce_hex,
      }),
    ).toThrow(/does not match/);
  });

  it('output and contract checks pass with the vector data', () => {
    expect(() =>
      checkReceivedOutputV3(verified.receipt, parseJsonStrict(v1.received_output_json)),
    ).not.toThrow();
    expect(() =>
      checkContractV3(verified.receipt, parseJsonStrict(v1.contract_json)),
    ).not.toThrow();
  });

  it('output check fails for a different output', () => {
    expect(() =>
      checkReceivedOutputV3(verified.receipt, { decision: 'DECLINE', note: 'x' }),
    ).toThrow();
  });
});

describe('receipt_v3_negative.json', () => {
  const v = load('receipt_v3_negative.json');
  it('has cases', () => {
    expect(v.cases.length).toBeGreaterThan(0);
  });
  for (const c of v.cases) {
    it(`rejects ${c.name}`, () => {
      const result = verifyReceiptV3(c.receipt_json, c.verifying_key_hex);
      expect(result.ok).toBe(false);
      expect(verifyReceipt(c.receipt_json, c.verifying_key_hex).valid).toBe(false);
    });
  }
});

describe('strict Ed25519 (mixed-order vectors)', () => {
  const v = load('receipt_v3_negative.json');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byName = (n: string) => v.cases.find((c: any) => c.name === n);

  it('rejects a signature whose R has a torsion component that the cofactored check accepts', () => {
    const c = byName('mixed_order_signature_point');
    const parsed = parseJsonStrict(c.receipt_json) as Record<string, unknown>;
    // The signature satisfies the cofactored equation used by default
    // Ed25519 verification ...
    const sig = decodeBase64urlCanonical((parsed.signature as { value: string }).value)!;
    const { signature: _s, ...unsigned } = parsed;
    const digest = hexToBytes(
      sha256Hex(new TextEncoder().encode('VCAV-RECEIPT-V3:' + canonicalizeV3(unsigned))),
    );
    expect(ed25519.verify(sig, digest, hexToBytes(c.verifying_key_hex))).toBe(true);
    // ... and the v3 verifier still rejects it.
    expect(verifyReceiptV3(c.receipt_json, c.verifying_key_hex)).toMatchObject({
      ok: false,
      errorClass: 'SIGNATURE_INVALID',
    });
  });

  it('rejects a pinned key with a torsion component', () => {
    const c = byName('mixed_order_public_key');
    expect(verifyReceiptV3(c.receipt_json, c.verifying_key_hex)).toMatchObject({
      ok: false,
      errorClass: 'INVALID_KEY',
    });
  });

  it('rejects small-order R and small-order keys', () => {
    for (const name of ['small_order_signature_point', 'small_order_public_key']) {
      const c = byName(name);
      expect(verifyReceiptV3(c.receipt_json, c.verifying_key_hex).ok).toBe(false);
    }
  });
});
