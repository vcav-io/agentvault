/**
 * Input commitments v3 (`SHA256_N32_JCS_V3`).
 *
 * ```text
 * input_commitment = hex(SHA-256("VCAV-INPUT-COMMIT-V3:" || nonce[32] || JCS_v3(context)))
 * ```
 *
 * The submitting client generates a fresh 32-byte nonce for every submission
 * and sends it to the relay as `commitment_nonce` (64 lowercase hex
 * characters). The nonce never appears in the receipt. The client keeps its
 * nonce and context locally so it can check its own commitment afterwards.
 *
 * Normative reference: vault-family-core `docs/receipt-v3.md`, section 5.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalizeV3, constantTimeEqual, isLowerHex } from './jcs-v3.js';

export const INPUT_COMMIT_DOMAIN_PREFIX_V3 = 'VCAV-INPUT-COMMIT-V3:';
export const INPUT_COMMITMENT_SCHEME_V3 = 'SHA256_N32_JCS_V3';
export const COMMITMENT_NONCE_BYTES = 32;

export class CommitmentError extends Error {
  constructor(
    public readonly code: 'INVALID_NONCE' | 'INVALID_COMMITMENT',
    message: string,
  ) {
    super(message);
    this.name = 'CommitmentError';
  }
}

/**
 * Generate a fresh commitment nonce: 32 bytes from the platform CSPRNG, as
 * 64 lowercase hex characters. Use a new nonce for every submission.
 */
export function generateCommitmentNonce(): string {
  const bytes = new Uint8Array(COMMITMENT_NONCE_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/** True if `nonceHex` is a well-formed commitment nonce (64 lowercase hex). */
export function isValidCommitmentNonce(nonceHex: unknown): nonceHex is string {
  return isLowerHex(nonceHex, COMMITMENT_NONCE_BYTES * 2);
}

/** Decode a wire-format commitment nonce, rejecting anything but 64 lowercase hex. */
export function parseCommitmentNonce(nonceHex: unknown): Uint8Array {
  if (!isValidCommitmentNonce(nonceHex)) {
    throw new CommitmentError(
      'INVALID_NONCE',
      'commitment nonce must be 64 lowercase hex characters (32 bytes)',
    );
  }
  return hexToBytes(nonceHex);
}

function commitmentBytes(nonceHex: string, context: unknown): Uint8Array {
  const nonce = parseCommitmentNonce(nonceHex);
  const canonical = canonicalizeV3(context);
  return sha256(
    concatBytes(utf8ToBytes(INPUT_COMMIT_DOMAIN_PREFIX_V3), nonce, utf8ToBytes(canonical)),
  );
}

/** Compute the v3 input commitment (lowercase hex) for `context` under `nonceHex`. */
export function computeInputCommitmentV3(nonceHex: string, context: unknown): string {
  return bytesToHex(commitmentBytes(nonceHex, context));
}

/**
 * Check that `expectedHex` is the v3 commitment to `context` under
 * `nonceHex`. The digests are compared in constant time.
 *
 * Throws on a malformed nonce, commitment or context; returns false on a
 * mismatch.
 */
export function verifyInputCommitmentV3(
  nonceHex: string,
  context: unknown,
  expectedHex: string,
): boolean {
  if (!isLowerHex(expectedHex, 64)) {
    throw new CommitmentError(
      'INVALID_COMMITMENT',
      'input commitment must be 64 lowercase hex characters',
    );
  }
  const computed = commitmentBytes(nonceHex, context);
  return constantTimeEqual(computed, hexToBytes(expectedHex));
}
