/**
 * Receipt verification for the AgentVault client.
 *
 * Supports v1 receipts (schema_version: "1.0.0") and v2 receipts
 * (receipt_schema_version: "2.0.0"). Optionally recomputes commitment
 * hashes when artefacts are provided.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyArtefacts {
  output?: unknown;
  contract?: unknown;
  outputSchema?: unknown;
  promptTemplate?: string;
}

export interface CommitmentCheck {
  field: string;
  expected: string;
  computed: string;
  match: boolean;
}

export interface TeeInfo {
  tee_type: string;
  measurement: string;
  attestation_hash: string;
  receipt_signing_pubkey_hex: string;
  transcript_hash_hex: string;
  note: string;
}

export interface VerifyResult {
  valid: boolean;
  schema_version: string;
  assurance_level?: string;
  operator_id?: string;
  errors: string[];
  warnings: string[];
  commitment_checks?: CommitmentCheck[];
  tee_info?: TeeInfo;
}

// ---------------------------------------------------------------------------
// Base64url decode
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
// Commitment hash computation
// ---------------------------------------------------------------------------

export function computeCommitmentHash(artefact: unknown): string {
  const canonical = canonicalize(artefact);
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

export function computePromptTemplateHash(template: string): string {
  return bytesToHex(sha256(utf8ToBytes(template)));
}

// ---------------------------------------------------------------------------
// Signature verification helpers
// ---------------------------------------------------------------------------

function verifySignatureV1(
  receipt: Record<string, unknown>,
  publicKeyHex: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const sigHex = receipt['signature'];
  if (typeof sigHex !== 'string') {
    errors.push('Missing or non-string signature field');
    return { valid: false, errors };
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
    return { valid: false, errors };
  }
  try {
    pubKeyBytes = hexToBytes(publicKeyHex);
  } catch {
    errors.push('public_key_hex is not valid hex');
    return { valid: false, errors };
  }

  let valid: boolean;
  try {
    valid = ed25519.verify(sigBytes, digest, pubKeyBytes);
  } catch (err) {
    errors.push(`Ed25519 verification threw: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false, errors };
  }

  if (!valid) {
    errors.push('Signature verification failed');
  }

  return { valid, errors };
}

function verifySignatureV2(
  receipt: Record<string, unknown>,
  publicKeyHex: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const sigObj = receipt['signature'];
  if (typeof sigObj !== 'object' || sigObj === null) {
    errors.push('Missing or invalid signature object');
    return { valid: false, errors };
  }

  const sig = sigObj as Record<string, unknown>;
  if (sig['alg'] !== 'Ed25519') {
    errors.push(`Unsupported signature algorithm: ${String(sig['alg'])}`);
    return { valid: false, errors };
  }
  if (typeof sig['value'] !== 'string') {
    errors.push('signature.value must be a string');
    return { valid: false, errors };
  }

  const { signature: _sig, ...unsigned } = receipt;
  const canonical = canonicalize(unsigned);
  const message = 'VCAV-RECEIPT-V2:' + canonical;
  const digest = sha256(utf8ToBytes(message));

  let sigBytes: Uint8Array;
  let pubKeyBytes: Uint8Array;
  try {
    sigBytes = base64urlToBytes(sig['value'] as string);
  } catch {
    errors.push('signature.value is not valid base64url');
    return { valid: false, errors };
  }
  try {
    pubKeyBytes = hexToBytes(publicKeyHex);
  } catch {
    errors.push('public_key_hex is not valid hex');
    return { valid: false, errors };
  }

  let valid: boolean;
  try {
    valid = ed25519.verify(sigBytes, digest, pubKeyBytes);
  } catch (err) {
    errors.push(`Ed25519 verification threw: ${err instanceof Error ? err.message : String(err)}`);
    return { valid: false, errors };
  }

  if (!valid) {
    errors.push('Signature verification failed');
  }

  return { valid, errors };
}

// ---------------------------------------------------------------------------
// Commitment verification
// ---------------------------------------------------------------------------

interface CommitmentMapping {
  artefactKey: keyof VerifyArtefacts;
  receiptField: string;
  isString: boolean;
}

const COMMITMENT_MAPPINGS: CommitmentMapping[] = [
  { artefactKey: 'output', receiptField: 'output_hash', isString: false },
  { artefactKey: 'contract', receiptField: 'contract_hash', isString: false },
  { artefactKey: 'outputSchema', receiptField: 'schema_hash', isString: false },
  { artefactKey: 'promptTemplate', receiptField: 'prompt_template_hash', isString: true },
];

function verifyCommitments(
  receipt: Record<string, unknown>,
  artefacts: VerifyArtefacts,
  isV2: boolean,
): { checks: CommitmentCheck[]; errors: string[] } {
  const checks: CommitmentCheck[] = [];
  const errors: string[] = [];

  // v2: commitments are at receipt.commitments; v1: top-level fields
  const commitments = isV2
    ? (receipt['commitments'] as Record<string, unknown> | undefined) ?? {}
    : receipt;

  for (const mapping of COMMITMENT_MAPPINGS) {
    const artefact = artefacts[mapping.artefactKey];
    if (artefact === undefined) continue;

    const expected = commitments[mapping.receiptField];
    if (typeof expected !== 'string') continue;

    const computed = mapping.isString
      ? computePromptTemplateHash(artefact as string)
      : computeCommitmentHash(artefact);

    const match = computed === expected;
    checks.push({ field: mapping.receiptField, expected, computed, match });

    if (!match) {
      errors.push(
        `Commitment mismatch: ${mapping.receiptField} expected ${expected.slice(0, 16)}... got ${computed.slice(0, 16)}...`,
      );
    }
  }

  return { checks, errors };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function verifyReceipt(
  receipt: Record<string, unknown>,
  publicKeyHex?: string,
  artefacts?: VerifyArtefacts,
): VerifyResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Detect version
  const receiptSchemaVersion = receipt['receipt_schema_version'];
  const schemaVersion = receipt['schema_version'];

  let detectedVersion: string;
  let isV2: boolean;
  if (typeof receiptSchemaVersion === 'string' && receiptSchemaVersion.startsWith('2.')) {
    detectedVersion = receiptSchemaVersion;
    isV2 = true;
  } else if (schemaVersion === '1.0.0') {
    detectedVersion = '1.0.0';
    isV2 = false;
  } else {
    errors.push(
      'Cannot detect receipt version: expected receipt_schema_version "2.x.y" or schema_version "1.0.0"',
    );
    return {
      valid: false,
      schema_version: String(receiptSchemaVersion ?? schemaVersion ?? 'unknown'),
      errors,
      warnings,
    };
  }

  // Resolve the verification key: TEE-attested key takes priority for TEE receipts
  let verifyKey: string | undefined;
  let teeAttestedKey: string | undefined;

  if (isV2 && typeof receipt['tee_attestation'] === 'object' && receipt['tee_attestation'] !== null) {
    const att = receipt['tee_attestation'] as Record<string, unknown>;
    if (typeof att['receipt_signing_pubkey_hex'] === 'string') {
      teeAttestedKey = att['receipt_signing_pubkey_hex'] as string;
    }
  }

  if (teeAttestedKey) {
    // TEE receipt: verify against the TEE-attested key
    verifyKey = teeAttestedKey;

    // If caller also supplied a key, treat as secondary pinning check
    if (publicKeyHex && publicKeyHex !== teeAttestedKey) {
      warnings.push(
        `Caller-supplied publicKeyHex differs from TEE-attested key; verifying against TEE-attested key`,
      );
    }
  } else if (publicKeyHex) {
    // Non-TEE receipt: verify against caller-supplied key
    verifyKey = publicKeyHex;
  } else {
    errors.push('No verification key: neither publicKeyHex supplied nor TEE-attested key present');
    return {
      valid: false,
      schema_version: detectedVersion,
      errors,
      warnings,
    };
  }

  // Verify signature
  const sigResult = isV2
    ? verifySignatureV2(receipt, verifyKey)
    : verifySignatureV1(receipt, verifyKey);

  errors.push(...sigResult.errors);
  let valid = sigResult.valid;

  // Verify commitments if artefacts provided
  let commitment_checks: CommitmentCheck[] | undefined;
  if (artefacts) {
    const commitResult = verifyCommitments(receipt, artefacts, isV2);
    if (commitResult.checks.length > 0) {
      commitment_checks = commitResult.checks;
    }
    if (commitResult.errors.length > 0) {
      errors.push(...commitResult.errors);
      valid = false;
    }

    // Cross-check relay verifying key from contract (#184)
    if (artefacts.contract && typeof artefacts.contract === 'object') {
      const contractObj = artefacts.contract as Record<string, unknown>;
      if (typeof contractObj.relay_verifying_key_hex === 'string') {
        if (contractObj.relay_verifying_key_hex !== verifyKey) {
          errors.push(
            `Contract pins relay key '${contractObj.relay_verifying_key_hex.slice(0, 12)}...' but receipt was signed by '${verifyKey.slice(0, 12)}...'`,
          );
          valid = false;
        }
      }
    }

  }

  // Extract TEE attestation info if present (introspection, not verification)
  let tee_info: TeeInfo | undefined;
  if (isV2 && typeof receipt['tee_attestation'] === 'object' && receipt['tee_attestation'] !== null) {
    const att = receipt['tee_attestation'] as Record<string, unknown>;
    tee_info = {
      tee_type: typeof att['tee_type'] === 'string' ? att['tee_type'] : 'unknown',
      measurement: typeof att['measurement'] === 'string' ? att['measurement'] : '',
      attestation_hash: typeof att['attestation_hash'] === 'string' ? att['attestation_hash'] : '',
      receipt_signing_pubkey_hex: typeof att['receipt_signing_pubkey_hex'] === 'string' ? att['receipt_signing_pubkey_hex'] : '',
      transcript_hash_hex: typeof att['transcript_hash_hex'] === 'string' ? att['transcript_hash_hex'] : '',
      note: 'TEE fields present. Use verifyTeeReceipt() from agentvault-client/tee for transcript + attestation hash verification.',
    };
  }

  return {
    valid,
    schema_version: detectedVersion,
    assurance_level:
      detectedVersion === '2.0.0' && typeof receipt['assurance_level'] === 'string'
        ? (receipt['assurance_level'] as string)
        : undefined,
    operator_id:
      detectedVersion === '2.0.0' &&
      typeof receipt['operator'] === 'object' &&
      receipt['operator'] !== null &&
      typeof (receipt['operator'] as Record<string, unknown>)['operator_id'] === 'string'
        ? ((receipt['operator'] as Record<string, unknown>)['operator_id'] as string)
        : undefined,
    errors,
    warnings,
    commitment_checks,
    tee_info,
  };
}

/** Detect receipt version from the receipt object. */
export function detectReceiptVersion(
  receipt: Record<string, unknown>,
): '1.0.0' | '2.0.0' | null {
  const rsv = receipt['receipt_schema_version'];
  if (typeof rsv === 'string' && rsv.startsWith('2.')) return '2.0.0';
  if (receipt['schema_version'] === '1.0.0') return '1.0.0';
  return null;
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
