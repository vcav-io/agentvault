/**
 * TEE receipt verification for TypeScript consumers.
 *
 * Provides transcript hash recomputation, attestation hash checking,
 * and measurement allowlist verification — matching the Rust
 * `tee-verifier` crate's logic. Quote parsing (the full QuoteVerified
 * path) is out of scope; this module covers transcript + attestation
 * hash + allowlist.
 */

import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// Transcript hash
// ---------------------------------------------------------------------------

const TRANSCRIPT_VERSION = 'av-tee-transcript-v1';

export interface TranscriptInputs {
  contract_hash: string;
  prompt_template_hash: string;
  initiator_submission_hash: string;
  responder_submission_hash: string;
  output_hash: string;
  receipt_signing_pubkey_hex: string;
}

/**
 * Compute the transcript hash (SHA-512) from canonical JSON with
 * alphabetically sorted keys. Matches the Rust `tee-transcript` crate.
 */
export function computeTranscriptHash(inputs: TranscriptInputs): Uint8Array {
  // Keys must be alphabetically sorted — matches Rust implementation
  const canonical = JSON.stringify({
    contract_hash: inputs.contract_hash,
    initiator_submission_hash: inputs.initiator_submission_hash,
    output_hash: inputs.output_hash,
    prompt_template_hash: inputs.prompt_template_hash,
    receipt_signing_pubkey_hex: inputs.receipt_signing_pubkey_hex,
    responder_submission_hash: inputs.responder_submission_hash,
    version: TRANSCRIPT_VERSION,
  });
  return sha512(utf8ToBytes(canonical));
}

/**
 * Compute the transcript hash and return it as a lowercase hex string.
 */
export function computeTranscriptHashHex(inputs: TranscriptInputs): string {
  return bytesToHex(computeTranscriptHash(inputs));
}

// ---------------------------------------------------------------------------
// Attestation hash
// ---------------------------------------------------------------------------

export type AttestationHashStatus = 'Valid' | 'Mismatch' | 'MissingFields' | 'DecodeFailed';

/**
 * Verify the attestation hash: SHA-256 of the raw quote bytes (base64-decoded)
 * compared against the expected hex hash.
 */
export function verifyAttestationHash(
  quoteBase64: string | undefined,
  expectedHashHex: string | undefined,
): AttestationHashStatus {
  if (quoteBase64 === undefined || expectedHashHex === undefined) {
    return 'MissingFields';
  }
  let quoteBytes: Uint8Array;
  try {
    const binary = atob(quoteBase64);
    quoteBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      quoteBytes[i] = binary.charCodeAt(i);
    }
  } catch {
    return 'DecodeFailed';
  }
  const computed = bytesToHex(sha256(quoteBytes));
  return computed === expectedHashHex ? 'Valid' : 'Mismatch';
}

// ---------------------------------------------------------------------------
// Measurement allowlist
// ---------------------------------------------------------------------------

export interface MeasurementEntry {
  measurement: string;
  build_id: string;
  git_rev: string;
  oci_digest?: string;
  artifact_hash?: string;
  toolchain?: string;
  timestamp?: string;
}

/**
 * Check a measurement against an allowlist. Returns the matching entry
 * or undefined if no match.
 */
export function checkMeasurementAllowlist(
  measurement: string,
  allowlist: MeasurementEntry[],
): MeasurementEntry | undefined {
  return allowlist.find((entry) => entry.measurement === measurement);
}

// ---------------------------------------------------------------------------
// Transcript binding
// ---------------------------------------------------------------------------

export type TranscriptBinding = 'ReceiptClaimedUserData' | 'TranscriptHashFallback' | 'None';

// ---------------------------------------------------------------------------
// Full TEE verification result
// ---------------------------------------------------------------------------

export interface TeeVerificationResult {
  // Only set when the verifier has extracted and cross-checked quote fields.
  // The TypeScript helper does not parse quotes today, so this remains unset.
  measurement_match: MeasurementEntry | undefined;
  // Receipt-level lookup only; not quote-verified.
  receipt_claimed_measurement_match: MeasurementEntry | undefined;
  attestation_hash_status: AttestationHashStatus;
  transcript_hash_valid: boolean;
  transcript_binding: TranscriptBinding;
  // False until the verifier can parse the quote and cross-check transcript-
  // binding fields against the quote contents.
  quote_field_cross_checked: boolean;
  submission_hashes_present: boolean;
}

export interface TeeAttestation {
  tee_type?: string;
  measurement?: string;
  quote?: string;
  attestation_hash?: string;
  receipt_signing_pubkey_hex?: string;
  transcript_hash_hex?: string;
  user_data_hex?: string;
}

export interface ReceiptCommitments {
  contract_hash: string;
  prompt_template_hash?: string;
  output_hash: string;
  initiator_submission_hash?: string;
  responder_submission_hash?: string;
}

/**
 * Verify TEE-specific fields of a v2 receipt.
 *
 * This covers transcript hash recomputation, attestation hash checking,
 * receipt-claimed measurement lookup, and submission hash presence. Receipt
 * signature verification is handled separately by `verifyReceipt()`.
 *
 * Quote parsing/platform verification is out of scope for the TS client, so
 * this helper must not claim quote-derived guarantees such as UserData-bound
 * transcript verification or quote-verified measurement allowlist matches.
 */
export function verifyTeeReceipt(
  commitments: ReceiptCommitments,
  teeAttestation: TeeAttestation,
  allowlist: MeasurementEntry[],
): TeeVerificationResult {
  // 1. Attestation hash: SHA-256(base64_decode(quote)) == attestation_hash
  const attestation_hash_status = verifyAttestationHash(
    teeAttestation.quote,
    teeAttestation.attestation_hash,
  );

  // 2. Measurement allowlist
  const receipt_claimed_measurement_match = teeAttestation.measurement
    ? checkMeasurementAllowlist(teeAttestation.measurement, allowlist)
    : undefined;

  // 3. Transcript hash recomputation
  const inputs: TranscriptInputs = {
    contract_hash: commitments.contract_hash,
    prompt_template_hash: commitments.prompt_template_hash ?? '',
    initiator_submission_hash: commitments.initiator_submission_hash ?? '',
    responder_submission_hash: commitments.responder_submission_hash ?? '',
    output_hash: commitments.output_hash,
    receipt_signing_pubkey_hex: teeAttestation.receipt_signing_pubkey_hex ?? '',
  };
  const computedHex = computeTranscriptHashHex(inputs);

  let transcript_hash_valid: boolean;
  let transcript_binding: TranscriptBinding;

  if (teeAttestation.user_data_hex !== undefined) {
    transcript_hash_valid = computedHex === teeAttestation.user_data_hex;
    transcript_binding = 'ReceiptClaimedUserData';
  } else if (teeAttestation.transcript_hash_hex !== undefined) {
    transcript_hash_valid = computedHex === teeAttestation.transcript_hash_hex;
    transcript_binding = 'TranscriptHashFallback';
  } else {
    transcript_hash_valid = false;
    transcript_binding = 'None';
  }

  // 4. Submission hashes present
  const submission_hashes_present =
    commitments.initiator_submission_hash !== undefined &&
    commitments.responder_submission_hash !== undefined;

  return {
    measurement_match: undefined,
    receipt_claimed_measurement_match,
    attestation_hash_status,
    transcript_hash_valid,
    transcript_binding,
    quote_field_cross_checked: false,
    submission_hashes_present,
  };
}
