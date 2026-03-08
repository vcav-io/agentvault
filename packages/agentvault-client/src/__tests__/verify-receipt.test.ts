/**
 * Tests for verify-receipt: signature verification + commitment recomputation.
 */

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  verifyReceipt,
  computeCommitmentHash,
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
        prompt_template_hash: expectedHashes.prompt_template_hash,
      },
    };
    const signed = signV2(base, seedHex);

    const artefacts: VerifyArtefacts = {
      output: sampleOutput,
      contract: sampleContract,
      outputSchema: sampleSchema,
      promptTemplate: samplePromptTemplate,
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
      output_hash: expectedHashes.output_hash,
      contract_hash: expectedHashes.contract_hash,
      schema_hash: expectedHashes.schema_hash,
      prompt_template_hash: expectedHashes.prompt_template_hash,
    };
    const signed = signV1(base, seedHex);

    const artefacts: VerifyArtefacts = {
      output: sampleOutput,
      contract: sampleContract,
      outputSchema: sampleSchema,
      promptTemplate: samplePromptTemplate,
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
