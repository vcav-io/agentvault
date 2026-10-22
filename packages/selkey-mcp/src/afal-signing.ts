/**
 * AFAL signing utilities — domain-separated Ed25519 signing and verification.
 *
 * Implements the signing protocol from AFAL Binding Specification v1, Section 4:
 *   1. unsigned = message with `signature` field removed
 *   2. canonical = canonicalize(unsigned)        // JCS RFC 8785
 *   3. prefixed = utf8(D + canonical)            // Domain-separated
 *   4. digest = SHA-256(prefixed)                // 32 bytes
 *   5. signature = Ed25519.sign(digest, seed)    // 64 bytes → 128 hex
 *
 * Verification is strict: the signature must be 128 lowercase hex characters,
 * and Ed25519 is checked with `s < L`, a canonical prime-order `R` and key,
 * and RFC 8032 (cofactorless) verification, as the Rust verifiers do.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';
import { verifyEd25519Strict } from 'selkey/ed25519';

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
  AGENT_CARD: 'VCAV-AGENT-CARD-V2:',
  IFC_GRANT: 'VCAV-IFC-GRANT-V2:',
  IFC_ENVELOPE: 'VCAV-IFC-ENVELOPE-V1:',
  KEY_ROTATION: 'VCAV-KEY-ROTATION-V1:',
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

const SIGNATURE_HEX_RE = /^[0-9a-f]{128}$/;
const PUBLIC_KEY_HEX_RE = /^[0-9a-f]{64}$/i;

export function verify(
  domainPrefix: DomainPrefix,
  unsignedPayload: Record<string, unknown>,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  if (typeof signatureHex !== 'string' || !SIGNATURE_HEX_RE.test(signatureHex)) return false;
  if (typeof publicKeyHex !== 'string' || !PUBLIC_KEY_HEX_RE.test(publicKeyHex)) return false;
  const digest = computeDigest(domainPrefix, unsignedPayload);
  return verifyEd25519Strict(hexToBytes(signatureHex), digest, hexToBytes(publicKeyHex.toLowerCase()));
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
