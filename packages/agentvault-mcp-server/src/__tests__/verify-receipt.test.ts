/**
 * Tests for agentvault.verify_receipt tool.
 *
 * Tests cover:
 * - v1 receipt sign+verify roundtrip
 * - v2 receipt sign+verify roundtrip
 * - Tampered receipt rejection (both versions)
 * - Version detection
 * - Missing signature
 */

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';
import { handleVerifyReceipt } from '../tools/verify-receipt.js';

// ---------------------------------------------------------------------------
// Test key generation helpers
// ---------------------------------------------------------------------------

function generateKeypair(): { seedHex: string; publicKeyHex: string } {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = ed25519.getPublicKey(seed);
  return {
    seedHex: bytesToHex(seed),
    publicKeyHex: bytesToHex(publicKey),
  };
}

// ---------------------------------------------------------------------------
// v1 signing helper
// ---------------------------------------------------------------------------

function signV1Receipt(
  receipt: Record<string, unknown>,
  seedHex: string,
): Record<string, unknown> {
  const { signature: _, ...unsigned } = receipt;
  const canonical = canonicalize(unsigned);
  const message = 'VCAV-RECEIPT-V1:' + canonical;
  const digest = sha256(utf8ToBytes(message));
  const sig = ed25519.sign(digest, hexToBytes(seedHex));
  return { ...unsigned, signature: bytesToHex(sig) };
}

function buildMinimalV1Receipt(): Record<string, unknown> {
  return {
    schema_version: '1.0.0',
    session_id: 'test-session-123',
    issued_at: '2024-01-01T00:00:00Z',
    purpose: 'MEDIATION',
    output: { mediation_signal: 'aligned' },
  };
}

// ---------------------------------------------------------------------------
// v2 signing helper
// ---------------------------------------------------------------------------

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signV2Receipt(
  receipt: Record<string, unknown>,
  seedHex: string,
): Record<string, unknown> {
  const { signature: _, ...unsigned } = receipt;
  const canonical = canonicalize(unsigned);
  const message = 'VCAV-RECEIPT-V2:' + canonical;
  const digest = sha256(utf8ToBytes(message));
  const sig = ed25519.sign(digest, hexToBytes(seedHex));
  return {
    ...unsigned,
    signature: {
      alg: 'Ed25519',
      value: bytesToBase64url(sig),
      signed_fields: Object.keys(unsigned),
    },
  };
}

function buildMinimalV2Receipt(): Record<string, unknown> {
  return {
    receipt_schema_version: '2.0.0',
    session_id: 'test-session-456',
    issued_at: '2024-01-01T00:00:00Z',
    purpose: 'MEDIATION',
    assurance_level: 'STANDARD',
    operator: { operator_id: 'op-test', operator_key_fingerprint: 'a'.repeat(64) },
    output: { mediation_signal: 'compatible' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleVerifyReceipt — version detection', () => {
  it('returns error for unknown schema version', async () => {
    const result = await handleVerifyReceipt({
      receipt: { some_field: 'value' },
      public_key_hex: '0'.repeat(64),
    });
    expect(result.ok).toBe(true);
    expect(result.data?.valid).toBe(false);
    expect(result.data?.errors.some((e) => e.includes('Cannot detect receipt version'))).toBe(true);
  });

  it('detects v1 from schema_version', async () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base = buildMinimalV1Receipt();
    const signed = signV1Receipt(base, seedHex);
    const result = await handleVerifyReceipt({ receipt: signed, public_key_hex: publicKeyHex });
    expect(result.data?.schema_version).toBe('1.0.0');
  });

  it('detects v2 from receipt_schema_version', async () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base = buildMinimalV2Receipt();
    const signed = signV2Receipt(base, seedHex);
    const result = await handleVerifyReceipt({ receipt: signed, public_key_hex: publicKeyHex });
    expect(result.data?.schema_version).toBe('2.0.0');
  });
});

describe('handleVerifyReceipt — v1 receipts', () => {
  it('verifies a valid v1 receipt', async () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base = buildMinimalV1Receipt();
    const signed = signV1Receipt(base, seedHex);

    const result = await handleVerifyReceipt({ receipt: signed, public_key_hex: publicKeyHex });
    expect(result.ok).toBe(true);
    expect(result.data?.valid).toBe(true);
    expect(result.data?.errors).toHaveLength(0);
    expect(result.data?.schema_version).toBe('1.0.0');
  });

  it('rejects a tampered v1 receipt', async () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base = buildMinimalV1Receipt();
    const signed = signV1Receipt(base, seedHex);

    // Tamper with output after signing
    const tampered = { ...signed, output: { mediation_signal: 'opposed' } };

    const result = await handleVerifyReceipt({ receipt: tampered, public_key_hex: publicKeyHex });
    expect(result.data?.valid).toBe(false);
    expect(result.data?.errors.some((e) => e.includes('Signature verification failed'))).toBe(true);
  });

  it('rejects v1 receipt with missing signature', async () => {
    const { publicKeyHex } = generateKeypair();
    const base = buildMinimalV1Receipt();

    const result = await handleVerifyReceipt({ receipt: base, public_key_hex: publicKeyHex });
    expect(result.data?.valid).toBe(false);
    expect(result.data?.errors.some((e) => e.includes('Missing or non-string signature'))).toBe(true);
  });

  it('rejects v1 receipt with wrong public key', async () => {
    const { seedHex } = generateKeypair();
    const { publicKeyHex: wrongPubKey } = generateKeypair();
    const base = buildMinimalV1Receipt();
    const signed = signV1Receipt(base, seedHex);

    const result = await handleVerifyReceipt({ receipt: signed, public_key_hex: wrongPubKey });
    expect(result.data?.valid).toBe(false);
    expect(result.data?.errors.some((e) => e.includes('Signature verification failed'))).toBe(true);
  });

  it('rejects v1 with invalid signature hex', async () => {
    const { publicKeyHex } = generateKeypair();
    const base = buildMinimalV1Receipt();
    const badSig = { ...base, signature: 'not-hex!!!' };

    const result = await handleVerifyReceipt({ receipt: badSig, public_key_hex: publicKeyHex });
    expect(result.data?.valid).toBe(false);
    expect(result.data?.errors.some((e) => e.includes('not valid hex'))).toBe(true);
  });
});

describe('handleVerifyReceipt — v2 receipts', () => {
  it('verifies a valid v2 receipt', async () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base = buildMinimalV2Receipt();
    const signed = signV2Receipt(base, seedHex);

    const result = await handleVerifyReceipt({ receipt: signed, public_key_hex: publicKeyHex });
    expect(result.ok).toBe(true);
    expect(result.data?.valid).toBe(true);
    expect(result.data?.errors).toHaveLength(0);
    expect(result.data?.schema_version).toBe('2.0.0');
    expect(result.data?.assurance_level).toBe('STANDARD');
    expect(result.data?.operator_id).toBe('op-test');
  });

  it('rejects a tampered v2 receipt', async () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base = buildMinimalV2Receipt();
    const signed = signV2Receipt(base, seedHex);

    const tampered = { ...signed, output: { mediation_signal: 'opposed' } };

    const result = await handleVerifyReceipt({ receipt: tampered, public_key_hex: publicKeyHex });
    expect(result.data?.valid).toBe(false);
    expect(result.data?.errors.some((e) => e.includes('Signature verification failed'))).toBe(true);
  });

  it('rejects v2 receipt with missing signature object', async () => {
    const { publicKeyHex } = generateKeypair();
    const base = buildMinimalV2Receipt();

    const result = await handleVerifyReceipt({ receipt: base, public_key_hex: publicKeyHex });
    expect(result.data?.valid).toBe(false);
    expect(result.data?.errors.some((e) => e.includes('Missing or invalid signature object'))).toBe(true);
  });

  it('rejects v2 receipt with unsupported algorithm', async () => {
    const { publicKeyHex } = generateKeypair();
    const base = buildMinimalV2Receipt();
    const withBadAlg = {
      ...base,
      signature: { alg: 'rsa', value: 'abc', signed_fields: [] },
    };

    const result = await handleVerifyReceipt({ receipt: withBadAlg, public_key_hex: publicKeyHex });
    expect(result.data?.valid).toBe(false);
    expect(result.data?.errors.some((e) => e.includes('Unsupported signature algorithm'))).toBe(true);
  });

  it('rejects v2 receipt with wrong public key', async () => {
    const { seedHex } = generateKeypair();
    const { publicKeyHex: wrongPubKey } = generateKeypair();
    const base = buildMinimalV2Receipt();
    const signed = signV2Receipt(base, seedHex);

    const result = await handleVerifyReceipt({ receipt: signed, public_key_hex: wrongPubKey });
    expect(result.data?.valid).toBe(false);
    expect(result.data?.errors.some((e) => e.includes('Signature verification failed'))).toBe(true);
  });

  it('rejects v2 with invalid base64url signature value', async () => {
    const { publicKeyHex } = generateKeypair();
    const base = buildMinimalV2Receipt();
    const withBadSig = {
      ...base,
      signature: { alg: 'Ed25519', value: '!!!invalid!!!', signed_fields: [] },
    };

    const result = await handleVerifyReceipt({ receipt: withBadSig, public_key_hex: publicKeyHex });
    expect(result.data?.valid).toBe(false);
    // Invalid base64url decodes to garbage bytes but won't throw; sig verification fails
    expect(result.data?.errors.length).toBeGreaterThan(0);
  });
});

describe('handleVerifyReceipt — public key fetching', () => {
  it('returns error when relay is unreachable and no public key provided', async () => {
    const { seedHex } = generateKeypair();
    const base = buildMinimalV1Receipt();
    const signed = signV1Receipt(base, seedHex);

    const result = await handleVerifyReceipt({
      receipt: signed,
      relay_url: 'http://localhost:19999', // nothing listening here
    });
    expect(result.data?.valid).toBe(false);
    expect(result.data?.errors.some((e) => e.includes('Failed to fetch public key'))).toBe(true);
  });
});
