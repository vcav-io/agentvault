/**
 * AFAL signing utilities — domain-separated Ed25519 signing and verification.
 *
 * Implements the signing protocol from AFAL Binding Specification v1, Section 4:
 *   1. unsigned = message with `signature` field removed
 *   2. canonical = canonicalize(unsigned)        // JCS RFC 8785
 *   3. prefixed = utf8(D + canonical)            // Domain-separated
 *   4. digest = SHA-256(prefixed)                // 32 bytes
 *   5. signature = Ed25519.sign(digest, seed)    // 64 bytes → 128 hex
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';

// ---------------------------------------------------------------------------
// Domain prefix constants
// ---------------------------------------------------------------------------

export const DOMAIN_PREFIXES = {
  DESCRIPTOR: 'VCAV-DESCRIPTOR-V1:',
  PROPOSE: 'VCAV-PROPOSE-V1:',
  ADMIT: 'VCAV-ADMIT-V1:',
  DENY: 'VCAV-DENY-V1:',
  COMMIT: 'VCAV-COMMIT-V1:',
  MESSAGE: 'VCAV-MESSAGE-V1:',
  REQUEST: 'VCAV-REQUEST-V1:',
  AGENT_CARD: 'VCAV-AGENT-CARD-V1:',
} as const;

export type DomainPrefix = (typeof DOMAIN_PREFIXES)[keyof typeof DOMAIN_PREFIXES];

// ---------------------------------------------------------------------------
// Core signing operations
// ---------------------------------------------------------------------------

export function stripSignature<T extends Record<string, unknown>>(
  message: T,
): Omit<T, 'signature'> {
  const { signature: _, ...unsigned } = message;
  return unsigned;
}

export function computeDigest(
  domainPrefix: DomainPrefix,
  unsignedPayload: Record<string, unknown>,
): Uint8Array {
  const canonical = canonicalize(unsignedPayload);
  const prefixed = domainPrefix + canonical;
  return sha256(utf8ToBytes(prefixed));
}

export function computeDigestHex(
  domainPrefix: DomainPrefix,
  unsignedPayload: Record<string, unknown>,
): string {
  return bytesToHex(computeDigest(domainPrefix, unsignedPayload));
}

export function sign(
  domainPrefix: DomainPrefix,
  unsignedPayload: Record<string, unknown>,
  seedHex: string,
): string {
  const digest = computeDigest(domainPrefix, unsignedPayload);
  const sig = ed25519.sign(digest, hexToBytes(seedHex));
  return bytesToHex(sig);
}

export function verify(
  domainPrefix: DomainPrefix,
  unsignedPayload: Record<string, unknown>,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  const digest = computeDigest(domainPrefix, unsignedPayload);
  try {
    return ed25519.verify(hexToBytes(signatureHex), digest, hexToBytes(publicKeyHex));
  } catch (err) {
    console.error(
      `verify: ed25519 verification threw (not just returned false): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

export function signMessage<T extends Record<string, unknown>>(
  domainPrefix: DomainPrefix,
  message: T,
  seedHex: string,
): T & { signature: string } {
  const unsigned = stripSignature(message);
  const signature = sign(domainPrefix, unsigned, seedHex);
  return { ...message, signature };
}

export function verifyMessage(
  domainPrefix: DomainPrefix,
  message: Record<string, unknown>,
  publicKeyHex: string,
): boolean {
  const signatureHex = message.signature;
  if (typeof signatureHex !== 'string') {
    console.error(
      `verifyMessage: message has no valid signature field (got ${typeof signatureHex}). Domain: ${domainPrefix}`,
    );
    return false;
  }
  const unsigned = stripSignature(message);
  return verify(domainPrefix, unsigned, signatureHex, publicKeyHex);
}

export function contentHash(object: unknown): string {
  const canonical = canonicalize(object);
  const digest = sha256(utf8ToBytes(canonical));
  return bytesToHex(digest);
}
