/**
 * agentvault.verify_receipt — verify the cryptographic signature of a session receipt.
 *
 * Supports v1 receipts (schema_version: "1.0.0") and v2 receipts
 * (receipt_schema_version: "2.0.0").
 *
 * v1 algorithm:
 *   1. Strip `signature` (hex string) from receipt
 *   2. JCS canonicalize the remainder
 *   3. message = "VCAV-RECEIPT-V1:" + canonical
 *   4. digest = SHA-256(message)
 *   5. Verify Ed25519 signature over digest
 *
 * v2 algorithm:
 *   1. Strip `signature` object (has alg, value, signed_fields) from receipt
 *   2. JCS canonicalize the remainder
 *   3. message = "VCAV-RECEIPT-V2:" + canonical
 *   4. digest = SHA-256(message)
 *   5. Decode base64url signature.value
 *   6. Verify Ed25519 signature over digest
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';
import { buildSuccess } from '../envelope.js';
import type { ToolResponse } from '../envelope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyReceiptArgs {
  receipt: Record<string, unknown>;
  public_key_hex?: string;
  relay_url?: string;
}

export interface VerifyReceiptOutput {
  valid: boolean;
  schema_version: string;
  assurance_level?: string;
  operator_id?: string;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Public key resolution
// ---------------------------------------------------------------------------

async function fetchPublicKeyFromRelay(relayUrl: string): Promise<string> {
  const healthUrl = relayUrl.replace(/\/$/, '') + '/health';
  const resp = await fetch(healthUrl);
  if (!resp.ok) {
    throw new Error(`Relay /health returned ${resp.status}`);
  }
  const body = (await resp.json()) as Record<string, unknown>;
  if (typeof body['verifying_key_hex'] !== 'string') {
    throw new Error('Relay /health response missing verifying_key_hex');
  }
  return body['verifying_key_hex'] as string;
}

// ---------------------------------------------------------------------------
// Base64url decode (no padding required)
// ---------------------------------------------------------------------------

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Verify helpers
// ---------------------------------------------------------------------------

function verifyV1(
  receipt: Record<string, unknown>,
  publicKeyHex: string,
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const sigHex = receipt['signature'];
  if (typeof sigHex !== 'string') {
    errors.push('Missing or non-string signature field');
    return { valid: false, errors, warnings };
  }

  const { signature: _sig, ...unsigned } = receipt;
  const canonical = canonicalize(unsigned);
  const message = 'VCAV-RECEIPT-V1:' + canonical;
  const digest = sha256(utf8ToBytes(message));

  let sigBytes: Uint8Array;
  let pubKeyBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(sigHex);
  } catch {
    errors.push('signature is not valid hex');
    return { valid: false, errors, warnings };
  }
  try {
    pubKeyBytes = hexToBytes(publicKeyHex);
  } catch {
    errors.push('public_key_hex is not valid hex');
    return { valid: false, errors, warnings };
  }

  let valid: boolean;
  try {
    valid = ed25519.verify(sigBytes, digest, pubKeyBytes);
  } catch (err) {
    errors.push(`Ed25519 verification threw: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false, errors, warnings };
  }

  if (!valid) {
    errors.push('Signature verification failed — receipt may have been tampered');
  }

  return { valid, errors, warnings };
}

function verifyV2(
  receipt: Record<string, unknown>,
  publicKeyHex: string,
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const sigObj = receipt['signature'];
  if (typeof sigObj !== 'object' || sigObj === null) {
    errors.push('Missing or invalid signature object');
    return { valid: false, errors, warnings };
  }

  const sig = sigObj as Record<string, unknown>;
  const alg = sig['alg'];
  const value = sig['value'];

  if (alg !== 'ed25519') {
    errors.push(`Unsupported signature algorithm: ${String(alg)}`);
    return { valid: false, errors, warnings };
  }
  if (typeof value !== 'string') {
    errors.push('signature.value must be a string');
    return { valid: false, errors, warnings };
  }

  const { signature: _sig, ...unsigned } = receipt;
  const canonical = canonicalize(unsigned);
  const message = 'VCAV-RECEIPT-V2:' + canonical;
  const digest = sha256(utf8ToBytes(message));

  let sigBytes: Uint8Array;
  let pubKeyBytes: Uint8Array;
  try {
    sigBytes = base64urlToBytes(value);
  } catch {
    errors.push('signature.value is not valid base64url');
    return { valid: false, errors, warnings };
  }
  try {
    pubKeyBytes = hexToBytes(publicKeyHex);
  } catch {
    errors.push('public_key_hex is not valid hex');
    return { valid: false, errors, warnings };
  }

  let valid: boolean;
  try {
    valid = ed25519.verify(sigBytes, digest, pubKeyBytes);
  } catch (err) {
    errors.push(`Ed25519 verification threw: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false, errors, warnings };
  }

  if (!valid) {
    errors.push('Signature verification failed — receipt may have been tampered');
  }

  return { valid, errors, warnings };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleVerifyReceipt(
  args: VerifyReceiptArgs,
): Promise<ToolResponse<VerifyReceiptOutput>> {
  const { receipt, relay_url = 'http://localhost:4840' } = args;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Detect schema version
  const receiptSchemaVersion = receipt['receipt_schema_version'];
  const schemaVersion = receipt['schema_version'];

  let detectedVersion: string;
  if (receiptSchemaVersion === '2.0.0') {
    detectedVersion = '2.0.0';
  } else if (schemaVersion === '1.0.0') {
    detectedVersion = '1.0.0';
  } else {
    errors.push(
      'Cannot detect receipt version: expected receipt_schema_version "2.0.0" or schema_version "1.0.0"',
    );
    return buildSuccess('SUCCESS', {
      valid: false,
      schema_version: String(receiptSchemaVersion ?? schemaVersion ?? 'unknown'),
      errors,
      warnings,
    });
  }

  // Resolve public key
  let publicKeyHex: string;
  if (args.public_key_hex) {
    publicKeyHex = args.public_key_hex;
  } else {
    try {
      publicKeyHex = await fetchPublicKeyFromRelay(relay_url);
    } catch (err) {
      errors.push(
        `Failed to fetch public key from relay (${relay_url}): ${err instanceof Error ? err.message : String(err)}. ` +
          'Pass public_key_hex explicitly to bypass.',
      );
      return buildSuccess('SUCCESS', {
        valid: false,
        schema_version: detectedVersion,
        errors,
        warnings,
      });
    }
  }

  // Verify
  let result: { valid: boolean; errors: string[]; warnings: string[] };
  if (detectedVersion === '2.0.0') {
    result = verifyV2(receipt, publicKeyHex);
  } else {
    result = verifyV1(receipt, publicKeyHex);
  }

  const output: VerifyReceiptOutput = {
    valid: result.valid,
    schema_version: detectedVersion,
    errors: [...errors, ...result.errors],
    warnings: [...warnings, ...result.warnings],
  };

  // Include v2-specific fields
  if (detectedVersion === '2.0.0') {
    if (typeof receipt['assurance_level'] === 'string') {
      output.assurance_level = receipt['assurance_level'] as string;
    }
    if (typeof receipt['operator_id'] === 'string') {
      output.operator_id = receipt['operator_id'] as string;
    }
  }

  return buildSuccess('SUCCESS', output);
}
