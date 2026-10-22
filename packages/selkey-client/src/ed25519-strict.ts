/**
 * Strict Ed25519 verification for receipt v3.
 *
 * Normative reference: vault-family-core `docs/receipt-v3.md`, section 6.3.
 *
 * `@noble/curves` checks the cofactored equation `[8][s]B = [8]R + [8][k]A`,
 * which accepts signatures whose `R` (or key `A`) carries a small-order
 * component that a cofactorless verifier rejects. Requiring `A` and `R` to be
 * canonical encodings of points of prime order (not small order, torsion
 * free) and `s < L` makes the two equations accept exactly the same
 * signatures, so every conforming verifier agrees.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';

/** Order of the Ed25519 base point. */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/**
 * True if `encoded` is the canonical encoding of an Edwards point of prime
 * order: it decodes (with `y < p`), re-encodes to the same bytes, is not of
 * small order and has no torsion component.
 */
export function isCanonicalPrimeOrderPoint(encoded: Uint8Array): boolean {
  if (encoded.length !== 32) return false;
  try {
    const P = ed25519.ExtendedPoint.fromHex(encoded, false);
    if (bytesToHex(P.toRawBytes()) !== bytesToHex(encoded)) return false;
    return !P.isSmallOrder() && P.isTorsionFree();
  } catch {
    return false;
  }
}

/** True if `publicKey` is usable as a pinned v3 receipt key. */
export function isPrimeOrderKey(publicKey: Uint8Array): boolean {
  return isCanonicalPrimeOrderPoint(publicKey);
}

/**
 * Verify an Ed25519 signature with the v3 strict rules: `s < L`, `R` and the
 * key canonical and of prime order, then RFC 8032 verification
 * (`zip215: false`).
 */
export function verifyEd25519Strict(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  const s = bytesToNumberLE(signature.subarray(32, 64));
  if (s >= L) return false;
  if (!isCanonicalPrimeOrderPoint(signature.subarray(0, 32))) return false;
  if (!isPrimeOrderKey(publicKey)) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
