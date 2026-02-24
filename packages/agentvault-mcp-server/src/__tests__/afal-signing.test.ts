import { describe, it, expect } from 'vitest';
import {
  DOMAIN_PREFIXES,
  computeDigestHex,
  sign,
  verify,
  signMessage,
  verifyMessage,
  stripSignature,
  contentHash,
} from '../afal-signing.js';

// Cross-language test vector from vcav/data/test-vectors/afal-propose-v1.json
const VECTOR = {
  seed_hex: '0101010101010101010101010101010101010101010101010101010101010101',
  verifying_key_hex: '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c',
  domain_prefix: DOMAIN_PREFIXES.PROPOSE,
  sha256_digest_hex: '17db7b1b758ce32e6be8f4eeaffbb66029e77891c7307c8e7814dd3f651103d4',
  unsigned_propose: {
    admission_tier_requested: 'DEFAULT',
    descriptor_hash: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    from: 'alice-test-agent',
    lane_id: 'SEALED_LOCAL',
    model_profile_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    model_profile_id: 'test-model',
    model_profile_version: '1.0',
    output_schema_id: 'urn:vcav:schema:dating.d2.v1',
    output_schema_version: '1.0',
    proposal_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    proposal_version: '1',
    purpose_code: 'COMPATIBILITY',
    requested_budget_tier: 'SMALL',
    requested_entropy_bits: 8,
    timestamp: '2026-01-01T00:05:00Z',
    to: 'bob-test-agent',
  } as Record<string, unknown>,
  expected_signature_hex:
    '756ab3e751b9314cdb7e7d88ebd3dfe047baabcac313cafc4e4d5e960e023aa4d344af6738b7c77a9a05ce8cdcdbc845b2ccc790a16d73c6a9ca4708cb9fb20a',
};

describe('computeDigestHex', () => {
  it('matches cross-language test vector SHA-256 digest', () => {
    const digest = computeDigestHex(VECTOR.domain_prefix, VECTOR.unsigned_propose);
    expect(digest).toBe(VECTOR.sha256_digest_hex);
  });
});

describe('sign', () => {
  it('produces the expected signature from test vector', () => {
    const sig = sign(VECTOR.domain_prefix, VECTOR.unsigned_propose, VECTOR.seed_hex);
    expect(sig).toBe(VECTOR.expected_signature_hex);
  });
});

describe('verify', () => {
  it('returns true for the expected signature and public key', () => {
    const result = verify(
      VECTOR.domain_prefix,
      VECTOR.unsigned_propose,
      VECTOR.expected_signature_hex,
      VECTOR.verifying_key_hex,
    );
    expect(result).toBe(true);
  });

  it('returns false for wrong public key', () => {
    const wrongKey = '1'.repeat(64);
    const result = verify(
      VECTOR.domain_prefix,
      VECTOR.unsigned_propose,
      VECTOR.expected_signature_hex,
      wrongKey,
    );
    expect(result).toBe(false);
  });

  it('returns false for tampered message', () => {
    const tampered = { ...VECTOR.unsigned_propose, from: 'evil-agent' };
    const result = verify(
      VECTOR.domain_prefix,
      tampered,
      VECTOR.expected_signature_hex,
      VECTOR.verifying_key_hex,
    );
    expect(result).toBe(false);
  });

  it('returns false (not throw) for invalid hex signature', () => {
    const result = verify(
      VECTOR.domain_prefix,
      VECTOR.unsigned_propose,
      'not-valid-hex!',
      VECTOR.verifying_key_hex,
    );
    expect(result).toBe(false);
  });

  it('returns false (not throw) for invalid hex public key', () => {
    const result = verify(
      VECTOR.domain_prefix,
      VECTOR.unsigned_propose,
      VECTOR.expected_signature_hex,
      'not-valid-hex!',
    );
    expect(result).toBe(false);
  });
});

describe('signMessage', () => {
  it('adds correct signature to message', () => {
    const signed = signMessage(VECTOR.domain_prefix, VECTOR.unsigned_propose, VECTOR.seed_hex);
    expect(signed.signature).toBe(VECTOR.expected_signature_hex);
  });

  it('preserves all original fields', () => {
    const signed = signMessage(VECTOR.domain_prefix, VECTOR.unsigned_propose, VECTOR.seed_hex);
    for (const [key, value] of Object.entries(VECTOR.unsigned_propose)) {
      expect(signed[key]).toBe(value);
    }
  });
});

describe('verifyMessage', () => {
  it('validates a correctly signed message', () => {
    const signed = signMessage(VECTOR.domain_prefix, VECTOR.unsigned_propose, VECTOR.seed_hex);
    const result = verifyMessage(VECTOR.domain_prefix, signed, VECTOR.verifying_key_hex);
    expect(result).toBe(true);
  });

  it('rejects message without signature field', () => {
    const result = verifyMessage(
      VECTOR.domain_prefix,
      VECTOR.unsigned_propose,
      VECTOR.verifying_key_hex,
    );
    expect(result).toBe(false);
  });

  it('rejects message with non-string signature', () => {
    const result = verifyMessage(
      VECTOR.domain_prefix,
      { ...VECTOR.unsigned_propose, signature: 12345 },
      VECTOR.verifying_key_hex,
    );
    expect(result).toBe(false);
  });
});

describe('stripSignature', () => {
  it('removes the signature field', () => {
    const message = { ...VECTOR.unsigned_propose, signature: 'abc123' };
    const stripped = stripSignature(message);
    expect('signature' in stripped).toBe(false);
  });

  it('preserves all non-signature fields', () => {
    const message = { ...VECTOR.unsigned_propose, signature: 'abc123' };
    const stripped = stripSignature(message);
    for (const [key, value] of Object.entries(VECTOR.unsigned_propose)) {
      expect((stripped as Record<string, unknown>)[key]).toBe(value);
    }
  });

  it('is a no-op on messages without a signature', () => {
    const stripped = stripSignature(VECTOR.unsigned_propose);
    expect(stripped).toEqual(VECTOR.unsigned_propose);
  });
});

describe('contentHash', () => {
  it('produces consistent output for the same object', () => {
    const h1 = contentHash({ a: 1, b: 2 });
    const h2 = contentHash({ b: 2, a: 1 });
    expect(h1).toBe(h2);
  });

  it('produces different output for different objects', () => {
    const h1 = contentHash({ a: 1 });
    const h2 = contentHash({ a: 2 });
    expect(h1).not.toBe(h2);
  });

  it('returns a 64-character hex string', () => {
    const h = contentHash({ hello: 'world' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('round-trip sign/verify', () => {
  it('sign then verify succeeds', () => {
    const payload = { msg: 'hello', ts: '2026-01-01T00:00:00Z' } as Record<string, unknown>;
    const signed = signMessage(DOMAIN_PREFIXES.MESSAGE, payload, VECTOR.seed_hex);
    const result = verifyMessage(DOMAIN_PREFIXES.MESSAGE, signed, VECTOR.verifying_key_hex);
    expect(result).toBe(true);
  });

  it('verify fails after field modification', () => {
    const payload = { msg: 'hello', ts: '2026-01-01T00:00:00Z' } as Record<string, unknown>;
    const signed = signMessage(DOMAIN_PREFIXES.MESSAGE, payload, VECTOR.seed_hex);
    const tampered = { ...signed, msg: 'goodbye' };
    const result = verifyMessage(DOMAIN_PREFIXES.MESSAGE, tampered, VECTOR.verifying_key_hex);
    expect(result).toBe(false);
  });

  it('verify fails with different domain prefix', () => {
    const payload = { msg: 'hello' } as Record<string, unknown>;
    const signed = signMessage(DOMAIN_PREFIXES.MESSAGE, payload, VECTOR.seed_hex);
    // Try to verify under a different domain prefix
    const result = verifyMessage(DOMAIN_PREFIXES.REQUEST, signed, VECTOR.verifying_key_hex);
    expect(result).toBe(false);
  });
});
