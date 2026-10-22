/**
 * TEE receipt transcript checks for TypeScript consumers.
 *
 * Recomputes the transcript hash (`av-tee-transcript-v1`, `-v2` and `-v3`,
 * byte-for-byte as the Rust `tee-transcript` crate computes them), checks the
 * attestation hash and looks the receipt-claimed measurement up in an
 * allowlist. Transcript version selection follows the Rust `tee-verifier`
 * crate.
 *
 * This module does not parse or verify attestation quotes (no platform
 * signature, certificate chain or TCB checks), so every result here is
 * receipt-level introspection. Use the Rust `tee-verifier` crate to verify
 * the attestation itself.
 */

import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// Transcript hash
// ---------------------------------------------------------------------------

export const TRANSCRIPT_VERSION = 'av-tee-transcript-v1';
export const TRANSCRIPT_VERSION_V2 = 'av-tee-transcript-v2';
export const TRANSCRIPT_VERSION_V3 = 'av-tee-transcript-v3';
export const RELAY_CONFIG_VERSION = 'av-tee-relay-config-v1';

export interface TranscriptInputs {
  contract_hash: string;
  prompt_template_hash: string;
  initiator_submission_hash: string;
  responder_submission_hash: string;
  output_hash: string;
  receipt_signing_pubkey_hex: string;
}

/** V2 inputs: v1 plus the provider-reported model identity (`""` if none). */
export interface TranscriptInputsV2 extends TranscriptInputs {
  model_identity_asserted: string;
}

/** V3 inputs: v2 plus `computeRelayConfigHashHex()` of the relay configuration. */
export interface TranscriptInputsV3 extends TranscriptInputsV2 {
  relay_config_hash: string;
}

/**
 * Compute the v1 transcript hash (SHA-512, 64 bytes). Matches Rust
 * `tee_transcript::compute_transcript_hash`: values are interpolated into a
 * fixed sorted-key JSON template without escaping.
 *
 * Legacy: because values are not escaped, inputs that contain `"` or `,` can
 * produce the same encoding as different inputs. Current receipts use v3
 * (`computeTranscriptHashV3`); this function is kept to check receipts issued
 * before it. `verifyTeeReceipt` counts a v1 match only with
 * `allow_legacy_transcripts`.
 */
export function computeTranscriptHash(inputs: TranscriptInputs): Uint8Array {
  const canonical =
    '{' +
    `"contract_hash":"${inputs.contract_hash}",` +
    `"initiator_submission_hash":"${inputs.initiator_submission_hash}",` +
    `"output_hash":"${inputs.output_hash}",` +
    `"prompt_template_hash":"${inputs.prompt_template_hash}",` +
    `"receipt_signing_pubkey_hex":"${inputs.receipt_signing_pubkey_hex}",` +
    `"responder_submission_hash":"${inputs.responder_submission_hash}",` +
    `"version":"${TRANSCRIPT_VERSION}"` +
    '}';
  return sha512(utf8ToBytes(canonical));
}

/**
 * Compute the v1 transcript hash and return it as a lowercase hex string.
 */
export function computeTranscriptHashHex(inputs: TranscriptInputs): string {
  return bytesToHex(computeTranscriptHash(inputs));
}

/**
 * Compute the v2 transcript hash (SHA-512, 64 bytes). Matches Rust
 * `tee_transcript::compute_transcript_hash_v2`: the v1 template plus
 * `model_identity_asserted`, with `av-tee-transcript-v2`.
 *
 * Legacy: like v1, values are interpolated without escaping, so inputs that
 * contain `"` or `,` can produce the same encoding as different inputs. Kept
 * to check receipts issued before v3. `verifyTeeReceipt` counts a v2 match
 * only with `allow_legacy_transcripts`.
 */
export function computeTranscriptHashV2(inputs: TranscriptInputsV2): Uint8Array {
  const canonical =
    '{' +
    `"contract_hash":"${inputs.contract_hash}",` +
    `"initiator_submission_hash":"${inputs.initiator_submission_hash}",` +
    `"model_identity_asserted":"${inputs.model_identity_asserted}",` +
    `"output_hash":"${inputs.output_hash}",` +
    `"prompt_template_hash":"${inputs.prompt_template_hash}",` +
    `"receipt_signing_pubkey_hex":"${inputs.receipt_signing_pubkey_hex}",` +
    `"responder_submission_hash":"${inputs.responder_submission_hash}",` +
    `"version":"${TRANSCRIPT_VERSION_V2}"` +
    '}';
  return sha512(utf8ToBytes(canonical));
}

export function computeTranscriptHashV2Hex(inputs: TranscriptInputsV2): string {
  return bytesToHex(computeTranscriptHashV2(inputs));
}

/**
 * Whether `value` is well-formed UTF-16 (no lone surrogates), so it has an
 * exact UTF-8 encoding. A lone surrogate would otherwise be replaced by
 * U+FFFD, and two different strings could encode to the same bytes.
 * (`String.prototype.isWellFormed` is ES2024; this targets ES2022.)
 */
function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Length-prefixed encoding shared by transcript v3 and the relay config hash:
 * `LP(version) || LP(name_1) || LP(value_1) || ...`, where `LP(x)` is the
 * UTF-8 byte length of `x` as a big-endian u64 followed by those bytes.
 */
function encodeFields(
  version: string,
  fields: ReadonlyArray<readonly [string, string]>,
): Uint8Array {
  const parts: Uint8Array[] = [utf8ToBytes(version)];
  for (const [name, value] of fields) {
    if (typeof value !== 'string' || !isWellFormedUtf16(value)) {
      throw new TypeError(`${name} must be a well-formed string`);
    }
    parts.push(utf8ToBytes(name), utf8ToBytes(value));
  }
  const total = parts.reduce((n, p) => n + 8 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const p of parts) {
    view.setBigUint64(offset, BigInt(p.length), false);
    offset += 8;
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Configuration the relay ran with, bound into transcript v3 through
 * `relay_config_hash` (published at the relay's `GET /tee/info`). It is the
 * relay's own statement; a matching v3 transcript shows which configuration
 * the transcript was computed with, not which code computed it.
 */
export interface RelayConfig {
  provider_id: string;
  provider_base_url: string;
  model_id_requested: string;
  policy_lockfile_hash: string;
  model_profile_allowlist_hash: string;
  relay_git_rev: string;
  echo_mode: boolean;
  simulated: boolean;
  env: string;
}

const RELAY_CONFIG_STRING_FIELDS = [
  'provider_id',
  'provider_base_url',
  'model_id_requested',
  'policy_lockfile_hash',
  'model_profile_allowlist_hash',
  'relay_git_rev',
  'env',
] as const;
const RELAY_CONFIG_BOOL_FIELDS = ['echo_mode', 'simulated'] as const;
const RELAY_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...RELAY_CONFIG_STRING_FIELDS,
  ...RELAY_CONFIG_BOOL_FIELDS,
]);

/**
 * Check that a value has exactly the `RelayConfig` members with the right
 * types: rejects unknown members, wrongly typed values and strings that are
 * not well-formed UTF-16. Throws `TypeError` otherwise. Use it on a
 * configuration parsed from JSON (e.g. `/tee/info`). Duplicate keys cannot
 * be detected once the JSON has been parsed.
 */
export function assertRelayConfig(value: unknown): asserts value is RelayConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('relay_config must be an object');
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!RELAY_CONFIG_KEYS.has(key)) {
      throw new TypeError(`relay_config has unknown member '${key}'`);
    }
  }
  for (const key of RELAY_CONFIG_STRING_FIELDS) {
    const v = obj[key];
    if (typeof v !== 'string') {
      throw new TypeError(`relay_config.${key} must be a string`);
    }
    if (!isWellFormedUtf16(v)) {
      throw new TypeError(`relay_config.${key} must be well-formed UTF-16`);
    }
  }
  for (const key of RELAY_CONFIG_BOOL_FIELDS) {
    if (typeof obj[key] !== 'boolean') {
      throw new TypeError(`relay_config.${key} must be a boolean`);
    }
  }
}

/** The length-prefixed relay configuration encoding (Rust `RelayConfig::encode`). */
export function encodeRelayConfig(config: RelayConfig): Uint8Array {
  assertRelayConfig(config);
  return encodeFields(RELAY_CONFIG_VERSION, [
    ['provider_id', config.provider_id],
    ['provider_base_url', config.provider_base_url],
    ['model_id_requested', config.model_id_requested],
    ['policy_lockfile_hash', config.policy_lockfile_hash],
    ['model_profile_allowlist_hash', config.model_profile_allowlist_hash],
    ['relay_git_rev', config.relay_git_rev],
    ['echo_mode', config.echo_mode ? 'true' : 'false'],
    ['simulated', config.simulated ? 'true' : 'false'],
    ['env', config.env],
  ]);
}

/** SHA-256 of `encodeRelayConfig(config)` (Rust `compute_relay_config_hash`). */
export function computeRelayConfigHash(config: RelayConfig): Uint8Array {
  return sha256(encodeRelayConfig(config));
}

/** Lowercase hex of `computeRelayConfigHash` (Rust `RelayConfig::hash_hex`). */
export function computeRelayConfigHashHex(config: RelayConfig): string {
  return bytesToHex(computeRelayConfigHash(config));
}

/**
 * The length-prefixed v3 transcript encoding (Rust `TranscriptInputsV3::encode`).
 * Throws `TypeError` if an input is not a well-formed UTF-16 string.
 */
export function encodeTranscriptV3(inputs: TranscriptInputsV3): Uint8Array {
  return encodeFields(TRANSCRIPT_VERSION_V3, [
    ['contract_hash', inputs.contract_hash],
    ['prompt_template_hash', inputs.prompt_template_hash],
    ['initiator_submission_hash', inputs.initiator_submission_hash],
    ['responder_submission_hash', inputs.responder_submission_hash],
    ['output_hash', inputs.output_hash],
    ['receipt_signing_pubkey_hex', inputs.receipt_signing_pubkey_hex],
    ['model_identity_asserted', inputs.model_identity_asserted],
    ['relay_config_hash', inputs.relay_config_hash],
  ]);
}

/**
 * Compute the v3 transcript hash (SHA-512 of the length-prefixed encoding,
 * 64 bytes). Matches Rust `tee_transcript::compute_transcript_hash_v3`.
 */
export function computeTranscriptHashV3(inputs: TranscriptInputsV3): Uint8Array {
  return sha512(encodeTranscriptV3(inputs));
}

export function computeTranscriptHashV3Hex(inputs: TranscriptInputsV3): string {
  return bytesToHex(computeTranscriptHashV3(inputs));
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

/**
 * Which transcript encoding matched.
 *
 * - `V3`: length-prefixed encoding; binds model identity and the relay
 *   configuration hash (relay-asserted, not code-attested).
 * - `V2`: legacy interpolated encoding; binds model identity; relay code and
 *   configuration unbound.
 * - `V1`: legacy interpolated encoding; model identity not bound.
 */
export type TranscriptSchema = 'V1' | 'V2' | 'V3';

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
  // Which transcript encoding matched, or undefined if none did. A V1/V2
  // match is reported here but transcript_hash_valid is false unless
  // allow_legacy_transcripts is set (and no relay config is supplied).
  transcript_schema: TranscriptSchema | undefined;
  // The relay configuration the v3 transcript matched (set only when
  // transcript_schema is 'V3'). Callers apply their own policy to it.
  relay_config: RelayConfig | undefined;
  // The model identity the v2/v3 transcripts were computed with (from
  // options.model_identity_asserted, "" if not supplied). Compare it with the
  // receipt's claims.model_identity_asserted.
  model_identity_asserted_used: string;
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

export interface TeeVerifyOptions {
  /** The receipt's `claims.model_identity_asserted` (bound by v2 and v3). */
  model_identity_asserted?: string;
  /**
   * Relay configuration to check a v3 transcript against (e.g. the
   * `relay_config` published at the relay's `GET /tee/info`). The receipt
   * does not carry `relay_config_hash`, so a v3 transcript can match only
   * when this is supplied. Supplying it also means a v1 or v2 match is
   * reported as invalid, even with `allow_legacy_transcripts`, so a legacy
   * transcript cannot skip the configuration check.
   */
  relay_config?: RelayConfig;
  /**
   * Count a legacy v1 or v2 transcript match as valid (default `false`). The
   * v1 and v2 encodings interpolate values without escaping, so they can be
   * ambiguous for inputs containing `"` or `,`; by default only a v3 match
   * sets `transcript_hash_valid`. A legacy match is still reported in
   * `transcript_schema` either way. Has no effect when `relay_config` is
   * supplied. Same option as the Rust `tee-verifier`.
   */
  allow_legacy_transcripts?: boolean;
  /**
   * @deprecated Requiring v3 is now the default. If set to `true`, it
   * overrides `allow_legacy_transcripts` (v1/v2 matches stay invalid);
   * `false` has no effect.
   */
  require_transcript_v3?: boolean;
}

/**
 * Check the TEE-specific fields of a v2 or v3 receipt at receipt level.
 *
 * This covers transcript hash recomputation (v3, then v2, then v1, with the
 * same selection rules as the Rust `tee-verifier`), attestation hash
 * checking, receipt-claimed measurement lookup, and submission hash
 * presence. Receipt signature verification is handled separately by
 * `verifyReceipt()`.
 *
 * Only a v3 match sets `transcript_hash_valid` by default. A v1 or v2 match
 * is reported in `transcript_schema` and counts as valid only when the
 * caller sets `allow_legacy_transcripts` and supplies no `relay_config`.
 *
 * Quote parsing/platform verification is out of scope for the TS client, so
 * this helper must not claim quote-derived guarantees such as UserData-bound
 * transcript verification or quote-verified measurement allowlist matches.
 */
export function verifyTeeReceipt(
  commitments: ReceiptCommitments,
  teeAttestation: TeeAttestation,
  allowlist: MeasurementEntry[],
  options: TeeVerifyOptions = {},
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

  // 3. Transcript hash recomputation. A field absent from the receipt is
  // encoded as "".
  const v2Inputs: TranscriptInputsV2 = {
    contract_hash: commitments.contract_hash,
    prompt_template_hash: commitments.prompt_template_hash ?? '',
    initiator_submission_hash: commitments.initiator_submission_hash ?? '',
    responder_submission_hash: commitments.responder_submission_hash ?? '',
    output_hash: commitments.output_hash,
    receipt_signing_pubkey_hex: teeAttestation.receipt_signing_pubkey_hex ?? '',
    model_identity_asserted: options.model_identity_asserted ?? '',
  };
  const relayConfig = options.relay_config;
  let v3Hex: string | undefined;
  if (relayConfig !== undefined) {
    // A malformed caller-supplied relay config throws here.
    const relay_config_hash = computeRelayConfigHashHex(relayConfig);
    try {
      v3Hex = computeTranscriptHashV3Hex({ ...v2Inputs, relay_config_hash });
    } catch (e) {
      // Receipt values that are not well-formed strings cannot match v3.
      if (!(e instanceof TypeError)) throw e;
      v3Hex = undefined;
    }
  }
  const v2Hex = computeTranscriptHashV2Hex(v2Inputs);
  const v1Hex = computeTranscriptHashHex(v2Inputs);

  const schemaFor = (target: string): TranscriptSchema | undefined => {
    if (v3Hex !== undefined && v3Hex === target) return 'V3';
    if (v2Hex === target) return 'V2';
    if (v1Hex === target) return 'V1';
    return undefined;
  };

  let transcript_binding: TranscriptBinding;
  let transcript_schema: TranscriptSchema | undefined;

  if (teeAttestation.user_data_hex !== undefined) {
    transcript_binding = 'ReceiptClaimedUserData';
    transcript_schema = schemaFor(teeAttestation.user_data_hex);
  } else if (teeAttestation.transcript_hash_hex !== undefined) {
    transcript_binding = 'TranscriptHashFallback';
    transcript_schema = schemaFor(teeAttestation.transcript_hash_hex);
  } else {
    transcript_binding = 'None';
    transcript_schema = undefined;
  }

  // Only v3 counts unless the caller opts in to legacy transcripts. With a
  // relay config, only v3 counts, so a legacy transcript cannot skip the
  // configuration check.
  const legacyAllowed =
    options.allow_legacy_transcripts === true &&
    options.require_transcript_v3 !== true &&
    relayConfig === undefined;
  const transcript_hash_valid =
    transcript_schema === 'V3' || (transcript_schema !== undefined && legacyAllowed);

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
    transcript_schema,
    relay_config: transcript_schema === 'V3' ? relayConfig : undefined,
    model_identity_asserted_used: v2Inputs.model_identity_asserted,
    quote_field_cross_checked: false,
    submission_hashes_present,
  };
}
