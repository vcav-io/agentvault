/**
 * Shared receipt verification for AgentVault v1 and v2 receipts.
 *
 * Pure cryptographic verification — no MCP envelope wrapping.
 * Used by both the MCP server tool and the demo UI server.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyResult {
  valid: boolean;
  schema_version: string;
  assurance_level?: string;
  operator_id?: string;
  errors: string[];
  warnings: string[];
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

  if (alg !== 'Ed25519') {
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
// Public API
// ---------------------------------------------------------------------------

/** Detect receipt version from the receipt object. */
export function detectReceiptVersion(
  receipt: Record<string, unknown>,
): '1.0.0' | '2.0.0' | null {
  if (receipt['receipt_schema_version'] === '2.0.0') return '2.0.0';
  if (receipt['schema_version'] === '1.0.0') return '1.0.0';
  return null;
}

/**
 * Verify a receipt's cryptographic signature. Supports v1 and v2 receipts.
 *
 * @param receipt - The full receipt object (including signature)
 * @param publicKeyHex - The relay's Ed25519 public key in hex
 */
export function verifyReceipt(
  receipt: Record<string, unknown>,
  publicKeyHex: string,
): VerifyResult {
  const version = detectReceiptVersion(receipt);

  if (!version) {
    return {
      valid: false,
      schema_version: String(receipt['receipt_schema_version'] ?? receipt['schema_version'] ?? 'unknown'),
      errors: ['Cannot detect receipt version: expected receipt_schema_version "2.0.0" or schema_version "1.0.0"'],
      warnings: [],
    };
  }

  const result = version === '2.0.0'
    ? verifyV2(receipt, publicKeyHex)
    : verifyV1(receipt, publicKeyHex);

  const output: VerifyResult = {
    valid: result.valid,
    schema_version: version,
    errors: result.errors,
    warnings: result.warnings,
  };

  // Include v2-specific fields
  if (version === '2.0.0') {
    if (typeof receipt['assurance_level'] === 'string') {
      output.assurance_level = receipt['assurance_level'] as string;
    }
    const op = receipt['operator'];
    if (typeof op === 'object' && op !== null) {
      const opObj = op as Record<string, unknown>;
      if (typeof opObj['operator_id'] === 'string') {
        output.operator_id = opObj['operator_id'] as string;
      }
    }
  }

  return output;
}

/**
 * Fetch the relay's signing public key from its /health endpoint.
 */
export async function fetchRelayPublicKey(relayUrl: string): Promise<string> {
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
