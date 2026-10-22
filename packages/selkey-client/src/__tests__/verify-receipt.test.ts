/**
 * Tests for verify-receipt: signature verification + commitment recomputation.
 */

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  verifyReceipt,
  computeCommitmentHash,
  computePromptProgramHash,
  computePromptTemplateHash,
} from '../verify-receipt.js';
import type { VerifyArtefacts } from '../verify-receipt.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateKeypair(): { seedHex: string; publicKeyHex: string } {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = ed25519.getPublicKey(seed);
  return { seedHex: bytesToHex(seed), publicKeyHex: bytesToHex(publicKey) };
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signV1(receipt: Record<string, unknown>, seedHex: string): Record<string, unknown> {
  const { signature: _, ...unsigned } = receipt;
  const canonical = canonicalize(unsigned);
  const message = 'VCAV-RECEIPT-V1:' + canonical;
  const digest = sha256(utf8ToBytes(message));
  const sig = ed25519.sign(digest, hexToBytes(seedHex));
  return { ...unsigned, signature: bytesToHex(sig) };
}

function signV2(receipt: Record<string, unknown>, seedHex: string): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(__dirname, '../../../../tests/fixtures/receipt-v2');

function loadFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

function loadTextFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

const expectedHashes = loadFixture('expected-hashes.json') as Record<string, string>;
const sampleContract = loadFixture('sample-contract.json');
const sampleOutput = loadFixture('sample-output.json');
const sampleSchema = loadFixture('sample-schema.json');
const samplePromptTemplate = loadTextFixture('sample-prompt-template.txt');
// A prompt program: prompt_template_hash is the hash of its JCS form.
const sampleProgram = {
  version: '1.0.0',
  system_instruction: samplePromptTemplate,
  input_format: 'json',
};
// computePromptProgramHash(program) is SHA-256 of the JCS form of the program.
const sampleProgramHash = computeCommitmentHash(sampleProgram);

// ---------------------------------------------------------------------------
// computeCommitmentHash — golden vectors
// ---------------------------------------------------------------------------

describe('computeCommitmentHash', () => {
  it('computes correct hash for contract fixture', () => {
    expect(computeCommitmentHash(sampleContract)).toBe(expectedHashes.contract_hash);
  });

  it('computes correct hash for output fixture', () => {
    expect(computeCommitmentHash(sampleOutput)).toBe(expectedHashes.output_hash);
  });

  it('computes correct hash for schema fixture', () => {
    expect(computeCommitmentHash(sampleSchema)).toBe(expectedHashes.schema_hash);
  });

  it('computes correct hash for prompt template (string)', () => {
    expect(computePromptTemplateHash(samplePromptTemplate)).toBe(
      expectedHashes.prompt_template_hash,
    );
  });
});

// ---------------------------------------------------------------------------
// verifyReceipt — signature only (backward compat)
// ---------------------------------------------------------------------------

describe('verifyReceipt — no artefacts (backward compat)', () => {
  it('verifies a valid v1 receipt', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base: Record<string, unknown> = {
      schema_version: '1.0.0',
      session_id: 'sess-1',
      issued_at: '2024-01-01T00:00:00Z',
    };
    const signed = signV1(base, seedHex);
    const result = verifyReceipt(signed, publicKeyHex);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.commitment_checks).toBeUndefined();
  });

  it('verifies a valid v2 receipt', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-2',
      issued_at: '2024-01-01T00:00:00Z',
    };
    const signed = signV2(base, seedHex);
    const result = verifyReceipt(signed, publicKeyHex);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('surfaces assurance_level and operator_id for v2.1.0 receipt', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.1.0',
      session_id: 'sess-v21',
      issued_at: '2024-01-01T00:00:00Z',
      assurance_level: 'VERIFIED',
      operator: { operator_id: 'op-123' },
    };
    const signed = signV2(base, seedHex);
    const result = verifyReceipt(signed, publicKeyHex);
    expect(result.valid).toBe(true);
    expect(result.schema_version).toBe('2.1.0');
    expect(result.assurance_level).toBe('VERIFIED');
    expect(result.operator_id).toBe('op-123');
  });

  it('rejects a tampered receipt', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base: Record<string, unknown> = {
      schema_version: '1.0.0',
      session_id: 'sess-1',
      value: 'original',
    };
    const signed = signV1(base, seedHex);
    const tampered = { ...signed, value: 'changed' };
    const result = verifyReceipt(tampered, publicKeyHex);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Signature verification failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyReceipt — with artefacts (commitment checks)
// ---------------------------------------------------------------------------

describe('verifyReceipt — with artefacts', () => {
  it('passes when all commitment hashes match (v2)', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-3',
      commitments: {
        output_hash: expectedHashes.output_hash,
        contract_hash: expectedHashes.contract_hash,
        schema_hash: expectedHashes.schema_hash,
        prompt_template_hash: sampleProgramHash,
      },
    };
    const signed = signV2(base, seedHex);

    const artefacts: VerifyArtefacts = {
      output: sampleOutput,
      contract: sampleContract,
      outputSchema: sampleSchema,
      promptProgram: sampleProgram,
    };
    const result = verifyReceipt(signed, publicKeyHex, artefacts);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.commitment_checks).toHaveLength(4);
    expect(result.commitment_checks!.every((c) => c.match)).toBe(true);
  });

  it('passes when all commitment hashes match (v1 — top-level fields)', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base: Record<string, unknown> = {
      schema_version: '1.0.0',
      session_id: 'sess-4',
      output: sampleOutput,
      contract_hash: expectedHashes.contract_hash,
      output_schema_hash: expectedHashes.schema_hash,
      prompt_template_hash: sampleProgramHash,
    };
    const signed = signV1(base, seedHex);

    const artefacts: VerifyArtefacts = {
      output: sampleOutput,
      contract: sampleContract,
      outputSchema: sampleSchema,
      promptProgram: sampleProgram,
    };
    const result = verifyReceipt(signed, publicKeyHex, artefacts);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.commitment_checks).toHaveLength(4);
  });

  it('fails when output hash mismatches', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-5',
      commitments: {
        output_hash: 'deadbeef'.repeat(8),
      },
    };
    const signed = signV2(base, seedHex);

    const artefacts: VerifyArtefacts = { output: sampleOutput };
    const result = verifyReceipt(signed, publicKeyHex, artefacts);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Commitment mismatch: output_hash'))).toBe(true);
    expect(result.commitment_checks).toHaveLength(1);
    expect(result.commitment_checks![0].match).toBe(false);
  });

  it('skips commitment checks for artefacts not provided', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-6',
      commitments: {
        output_hash: expectedHashes.output_hash,
        contract_hash: 'deadbeef'.repeat(8),
      },
    };
    const signed = signV2(base, seedHex);

    // Only provide output artefact — contract mismatch should not be checked
    const artefacts: VerifyArtefacts = { output: sampleOutput };
    const result = verifyReceipt(signed, publicKeyHex, artefacts);
    expect(result.valid).toBe(true);
    expect(result.commitment_checks).toHaveLength(1);
    expect(result.commitment_checks![0].field).toBe('output_hash');
    expect(result.commitment_checks![0].match).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyReceipt — relay key pinning (#184)
// ---------------------------------------------------------------------------

describe('verifyReceipt — relay key pinning', () => {
  it('passes when contract relay key matches public key', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const contractWithKey = { ...sampleContract as object, relay_verifying_key_hex: publicKeyHex };
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-7',
      commitments: {
        contract_hash: computeCommitmentHash(contractWithKey),
      },
    };
    const signed = signV2(base, seedHex);

    const result = verifyReceipt(signed, publicKeyHex, { contract: contractWithKey });
    expect(result.valid).toBe(true);
  });

  it('accepts a contract relay key pinned in uppercase hex', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const contractWithKey = {
      ...sampleContract as object,
      relay_verifying_key_hex: publicKeyHex.toUpperCase(),
    };
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-7u',
      commitments: {
        contract_hash: computeCommitmentHash(contractWithKey),
      },
    };
    const signed = signV2(base, seedHex);

    const result = verifyReceipt(signed, publicKeyHex, { contract: contractWithKey });
    expect(result.valid).toBe(true);
  });

  it('fails when contract relay key mismatches public key', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const { publicKeyHex: otherKey } = generateKeypair();
    const contractWithKey = { ...sampleContract as object, relay_verifying_key_hex: otherKey };
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-8',
      commitments: {
        contract_hash: computeCommitmentHash(contractWithKey),
      },
    };
    const signed = signV2(base, seedHex);

    const result = verifyReceipt(signed, publicKeyHex, { contract: contractWithKey });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Contract pins relay key'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyReceipt — TEE pubkey binding (#282)
// ---------------------------------------------------------------------------

describe('verifyReceipt — TEE pubkey binding', () => {
  it('passes when tee_attestation.receipt_signing_pubkey_hex matches caller key', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-tee-1',
      issued_at: '2024-01-01T00:00:00Z',
      tee_attestation: {
        tee_type: 'Simulated',
        measurement: 'abc123',
        attestation_hash: 'def456',
        receipt_signing_pubkey_hex: publicKeyHex,
        transcript_hash_hex: '789aaa',
      },
    };
    const signed = signV2(base, seedHex);
    const result = verifyReceipt(signed, publicKeyHex);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('rejects a receipt whose TEE-declared key differs from the pinned relay key', () => {
    const { seedHex, publicKeyHex: teeKey } = generateKeypair();
    const { publicKeyHex: callerKey } = generateKeypair();
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-tee-2',
      issued_at: '2024-01-01T00:00:00Z',
      tee_attestation: {
        tee_type: 'Simulated',
        measurement: 'abc123',
        attestation_hash: 'def456',
        receipt_signing_pubkey_hex: teeKey,
        transcript_hash_hex: '789aaa',
      },
    };
    // Receipt is signed with the key declared in tee_attestation, not the pinned key
    const signed = signV2(base, seedHex);
    const result = verifyReceipt(signed, callerKey);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('does not match the pinned relay key'))).toBe(true);
  });

  it('rejects a receipt re-signed with a fresh key declared in tee_attestation', () => {
    // Genuine receipt signed by the relay key
    const relay = generateKeypair();
    const genuine = signV2(
      {
        receipt_schema_version: '2.1.0',
        session_id: 'sess-tee-resign',
        issued_at: '2024-01-01T00:00:00Z',
        assurance_level: 'SELF_ASSERTED',
        commitments: { output_hash: 'a'.repeat(64) },
      },
      relay.seedHex,
    );
    expect(verifyReceipt(genuine, relay.publicKeyHex).valid).toBe(true);

    // Same receipt with altered content, re-signed under a fresh key that the
    // receipt itself declares as its TEE signing key
    const fresh = generateKeypair();
    const { signature: _sig, ...unsigned } = genuine;
    const altered: Record<string, unknown> = {
      ...unsigned,
      commitments: { output_hash: 'b'.repeat(64) },
      assurance_level: 'TEE_ATTESTED',
      tee_attestation: { receipt_signing_pubkey_hex: fresh.publicKeyHex },
    };
    const resigned = signV2(altered, fresh.seedHex);

    const result = verifyReceipt(resigned, relay.publicKeyHex);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('requires a caller-supplied key even when tee_attestation declares one', () => {
    const { seedHex, publicKeyHex: teeKey } = generateKeypair();
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-tee-3',
      issued_at: '2024-01-01T00:00:00Z',
      tee_attestation: {
        tee_type: 'Simulated',
        measurement: 'abc123',
        attestation_hash: 'def456',
        receipt_signing_pubkey_hex: teeKey,
        transcript_hash_hex: '789aaa',
      },
    };
    const signed = signV2(base, seedHex);
    const result = verifyReceipt(signed);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('No verification key'))).toBe(true);
  });

  it('returns invalid rather than throwing for a non-string key', () => {
    const { seedHex } = generateKeypair();
    const signed = signV2(
      { receipt_schema_version: '2.0.0', session_id: 'sess-tee-5', issued_at: '2024-01-01T00:00:00Z' },
      seedHex,
    );
    const result = verifyReceipt(signed, 42 as unknown as string);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('No verification key'))).toBe(true);
  });

  it('fails when no key is available (no caller key, no TEE key)', () => {
    const { seedHex } = generateKeypair();
    const base: Record<string, unknown> = {
      receipt_schema_version: '2.0.0',
      session_id: 'sess-tee-4',
      issued_at: '2024-01-01T00:00:00Z',
    };
    const signed = signV2(base, seedHex);
    const result = verifyReceipt(signed);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('No verification key'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyReceipt — commitment field mapping and cross-checks (v1, v2)
// ---------------------------------------------------------------------------

describe('verifyReceipt — v1 commitment fields', () => {
  it('checks the schema against output_schema_hash on v1 receipts', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const signed = signV1(
      {
        schema_version: '1.0.0',
        session_id: 'sess-v1-schema',
        output_schema_hash: 'deadbeef'.repeat(8),
      },
      seedHex,
    );
    const result = verifyReceipt(signed, publicKeyHex, { outputSchema: sampleSchema });
    expect(result.valid).toBe(false);
    expect(result.commitment_checks?.[0]).toMatchObject({ field: 'output_schema_hash', match: false });
  });

  it('checks the received output against the inline output on v1 receipts', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const signed = signV1(
      { schema_version: '1.0.0', session_id: 'sess-v1-output', output: { decision: 'reject' } },
      seedHex,
    );
    expect(verifyReceipt(signed, publicKeyHex, { output: { decision: 'approve' } }).valid).toBe(false);
    expect(verifyReceipt(signed, publicKeyHex, { output: { decision: 'reject' } }).valid).toBe(true);
  });
});

describe('verifyReceipt — prompt program hash', () => {
  it('checks prompt_template_hash as the hash of the JCS prompt program', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const signed = signV2(
      {
        receipt_schema_version: '2.0.0',
        session_id: 'sess-prog',
        commitments: { prompt_template_hash: sampleProgramHash },
      },
      seedHex,
    );
    const ok = verifyReceipt(signed, publicKeyHex, { promptProgram: sampleProgram });
    expect(ok.valid).toBe(true);
    expect(ok.commitment_checks).toEqual([
      expect.objectContaining({ field: 'prompt_template_hash', match: true }),
    ]);
    const changed = verifyReceipt(signed, publicKeyHex, {
      promptProgram: { ...sampleProgram, input_format: 'text' },
    });
    expect(changed.valid).toBe(false);
  });

  it('the program hash is not the hash of the raw template text', () => {
    expect(computePromptProgramHash(sampleProgram)).toBe(sampleProgramHash);
    expect(computePromptProgramHash(sampleProgram)).not.toBe(
      computePromptTemplateHash(samplePromptTemplate),
    );
  });
});

describe('verifyReceipt — contract envelope', () => {
  it('ignores a stored contract_hash member when checking the contract (v2)', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const signed = signV2(
      {
        receipt_schema_version: '2.0.0',
        session_id: 'sess-envelope',
        commitments: { contract_hash: expectedHashes.contract_hash },
      },
      seedHex,
    );
    const stored = { ...(sampleContract as object), contract_hash: expectedHashes.contract_hash };
    const result = verifyReceipt(signed, publicKeyHex, { contract: stored });
    expect(result.valid).toBe(true);
    expect(result.commitment_checks?.[0]).toMatchObject({ field: 'contract_hash', match: true });
  });
});

describe('verifyReceipt — own input and output cross-checks (v2)', () => {
  const myContext = { offer: 120 };

  function v2WithInputs(seedHex: string, extra: Record<string, unknown> = {}) {
    return signV2(
      {
        receipt_schema_version: '2.0.0',
        session_id: 'sess-own',
        commitments: {
          output_hash: expectedHashes.output_hash,
          input_commitments: [
            {
              participant_id: 'alice',
              input_hash: computeCommitmentHash(myContext),
              hash_alg: 'SHA-256',
              canonicalization: 'CANONICAL_JSON_V1',
            },
          ],
          ...extra,
        },
      },
      seedHex,
    );
  }

  it('passes for this participant input', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const result = verifyReceipt(v2WithInputs(seedHex), publicKeyHex, {
      ownInput: { participantId: 'alice', context: myContext },
    });
    expect(result.valid).toBe(true);
  });

  it('fails when the committed input differs from this participant input', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const result = verifyReceipt(v2WithInputs(seedHex), publicKeyHex, {
      ownInput: { participantId: 'alice', context: { offer: 121 } },
    });
    expect(result.valid).toBe(false);
  });

  it('fails when the receipt has no entry for this participant', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const result = verifyReceipt(v2WithInputs(seedHex), publicKeyHex, {
      ownInput: { participantId: 'bob', context: myContext },
    });
    expect(result.valid).toBe(false);
  });

  it('fails when the inline output differs from the received output', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const signed = v2WithInputs(seedHex, { output: { decision: 'reject' } });
    const result = verifyReceipt(signed, publicKeyHex, { output: sampleOutput });
    expect(result.valid).toBe(false);
  });

  it('fails a requested check when the receipt lacks that commitment', () => {
    const { seedHex, publicKeyHex } = generateKeypair();
    const signed = signV2(
      { receipt_schema_version: '2.0.0', session_id: 'sess-missing', commitments: {} },
      seedHex,
    );
    expect(verifyReceipt(signed, publicKeyHex, { outputSchema: sampleSchema }).valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyReceipt — strict signature encoding (v1, v2)
// ---------------------------------------------------------------------------

describe('verifyReceipt — strict signature encoding (v1, v2)', () => {
  const ORDER_L = 2n ** 252n + 27742317777372353535851937790883648493n;
  // A point of order 8.
  const TORSION_POINT_HEX = 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a';

  function le(bytes: Uint8Array): bigint {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
    return n;
  }

  function toLE32(value: bigint): Uint8Array {
    const out = new Uint8Array(32);
    let n = value;
    for (let i = 0; i < 32; i++) {
      out[i] = Number(n & 255n);
      n >>= 8n;
    }
    return out;
  }

  /** A signature whose R carries a small-order component (cofactored-valid only). */
  function signWithMixedOrderR(message: Uint8Array, seed: Uint8Array): Uint8Array {
    const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(seed);
    const torsion = ed25519.ExtendedPoint.fromHex(TORSION_POINT_HEX);
    const r = 987654321987654321987654321n;
    const R = ed25519.ExtendedPoint.BASE.multiply(r).add(torsion).toRawBytes();
    const k = le(sha512(new Uint8Array([...R, ...pointBytes, ...message]))) % ORDER_L;
    const s = (r + k * scalar) % ORDER_L;
    return new Uint8Array([...R, ...toLE32(s)]);
  }

  const seed = new Uint8Array(32).fill(7);
  const publicKeyHex = bytesToHex(ed25519.getPublicKey(seed));

  it('rejects a v1 signature whose R has a small-order component', () => {
    const unsigned = { schema_version: '1.0.0', session_id: 'sess-strict-1' };
    const digest = sha256(utf8ToBytes('VCAV-RECEIPT-V1:' + canonicalize(unsigned)));
    const sig = signWithMixedOrderR(digest, seed);
    // Plain cofactored verification accepts it; strict verification must not.
    expect(ed25519.verify(sig, digest, hexToBytes(publicKeyHex))).toBe(true);
    const result = verifyReceipt({ ...unsigned, signature: bytesToHex(sig) }, publicKeyHex);
    expect(result.valid).toBe(false);
  });

  it('rejects a v2 signature whose R has a small-order component', () => {
    const unsigned = { receipt_schema_version: '2.0.0', session_id: 'sess-strict-2' };
    const digest = sha256(utf8ToBytes('VCAV-RECEIPT-V2:' + canonicalize(unsigned)));
    const sig = signWithMixedOrderR(digest, seed);
    expect(ed25519.verify(sig, digest, hexToBytes(publicKeyHex))).toBe(true);
    const result = verifyReceipt(
      { ...unsigned, signature: { alg: 'Ed25519', value: bytesToBase64url(sig) } },
      publicKeyHex,
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a v2 signature value with base64 padding', () => {
    const signed = signV2({ receipt_schema_version: '2.0.0', session_id: 'sess-pad' }, bytesToHex(seed));
    const sig = signed['signature'] as Record<string, unknown>;
    const padded = { ...signed, signature: { ...sig, value: `${sig['value'] as string}==` } };
    expect(verifyReceipt(signed, publicKeyHex).valid).toBe(true);
    const result = verifyReceipt(padded, publicKeyHex);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('canonical unpadded base64url');
  });

  it('rejects a v2 signature value with non-zero trailing bits', () => {
    const signed = signV2({ receipt_schema_version: '2.0.0', session_id: 'sess-bits' }, bytesToHex(seed));
    const sig = signed['signature'] as Record<string, unknown>;
    const value = sig['value'] as string;
    // 64 bytes encode to 86 characters; the last one carries 4 unused bits.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(value[value.length - 1]!);
    const altered = value.slice(0, -1) + alphabet[last | 1];
    expect(altered).not.toBe(value);
    const result = verifyReceipt({ ...signed, signature: { ...sig, value: altered } }, publicKeyHex);
    expect(result.valid).toBe(false);
  });

  it('rejects a v2 signature value with characters outside the base64url alphabet', () => {
    const signed = signV2({ receipt_schema_version: '2.0.0', session_id: 'sess-alpha' }, bytesToHex(seed));
    const sig = signed['signature'] as Record<string, unknown>;
    // Same bytes in the standard base64 alphabet ('+' and '/').
    expect(sig['value'] as string).toMatch(/[-_]/);
    const withStd = (sig['value'] as string).replace(/-/g, '+').replace(/_/g, '/');
    const result = verifyReceipt({ ...signed, signature: { ...sig, value: withStd } }, publicKeyHex);
    expect(result.valid).toBe(false);
  });
});
