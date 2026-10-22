/**
 * Receipt verification for the Selkey client.
 *
 * Supports v3 receipts (receipt_schema_version "3.0.0", the format current
 * relays emit), v2 receipts (receipt_schema_version "2.x.y") and v1 receipts
 * (schema_version "1.0.0"). The receipt is always verified against the
 * caller-supplied (pinned) relay key.
 *
 * When artefacts are provided, the matching commitments are recomputed:
 * the received output, the contract, the output schema, the prompt program
 * and (v2/v3) the caller's own input. A requested check that the receipt
 * cannot support fails rather than being skipped.
 *
 * v3 follows vault-family-core `docs/receipt-v3.md` section 6 (see
 * ./receipt-v3.ts).
 */

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';
import { constantTimeEqual, hashV3, isLowerHex, parseJsonStrict } from './jcs-v3.js';
import { stripContractEnvelope } from './contract-hash-v2.js';
import {
  type ReceiptV3,
  ReceiptV3CheckError,
  checkContractV3,
  checkOwnInputV3,
  checkReceivedOutputV3,
  verifyReceiptV3,
} from './receipt-v3.js';

export {
  generateCommitmentNonce,
  isValidCommitmentNonce,
  computeInputCommitmentV3,
  verifyInputCommitmentV3,
} from './commitment-v3.js';
export { computeContractHashV2, normalizeContractV2 } from './contract-hash-v2.js';
export { verifyReceiptV3 } from './receipt-v3.js';
export type { ReceiptV3, ReceiptV3Result } from './receipt-v3.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The caller's own submission, kept locally by the client. */
export interface OwnInputArtefact {
  /** This party's participant id (its entry in contract.participants). */
  participantId: string;
  /** Exactly the `context` this party submitted. */
  context: unknown;
  /** The commitment nonce sent with the submission (required for v3 receipts). */
  commitmentNonce?: string;
}

export interface VerifyArtefacts {
  /** The session output this party received from the relay. */
  output?: unknown;
  /** The contract this party agreed to (a stored `contract_hash` member is ignored). */
  contract?: unknown;
  /** The output schema the relay enforced. */
  outputSchema?: unknown;
  /** The prompt program whose content hash is `prompt_template_hash`. */
  promptProgram?: unknown;
  /** This party's own input, for the own-input commitment check (v2, v3). */
  ownInput?: OwnInputArtefact;
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
  /** v3 only: informative class of the first rule that rejected the receipt. */
  error_class?: string;
}

// ---------------------------------------------------------------------------
// Base64url decode (v2)
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

/** SHA-256 of the JCS form of a JSON artefact (v1/v2 commitments). */
export function computeCommitmentHash(artefact: unknown): string {
  const canonical = canonicalize(artefact);
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

/**
 * Content hash of a prompt program: SHA-256 of the JCS form of the program
 * object. This is the value receipts and contracts carry as
 * `prompt_template_hash`.
 */
export function computePromptProgramHash(program: unknown): string {
  return computeCommitmentHash(program);
}

/**
 * SHA-256 of raw prompt template text.
 *
 * @deprecated This is not the receipt's `prompt_template_hash` (which is the
 * hash of the JCS-serialised prompt program); use `computePromptProgramHash`.
 */
export function computePromptTemplateHash(template: string): string {
  return bytesToHex(sha256(utf8ToBytes(template)));
}

/** Contract hash as v1/v2 receipts record it: JCS of the contract without envelope members. */
function computeLegacyContractHash(contract: unknown): string {
  return computeCommitmentHash(stripContractEnvelope(contract));
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (!isLowerHex(a, 64) || !isLowerHex(b, 64)) return false;
  return constantTimeEqual(hexToBytes(a), hexToBytes(b));
}

// ---------------------------------------------------------------------------
// Signature verification helpers (v1, v2)
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
// Commitment verification (v1, v2)
// ---------------------------------------------------------------------------

type ReceiptVersion = 'v1' | 'v2' | 'v3';

interface CommitmentOutcome {
  checks: CommitmentCheck[];
  errors: string[];
}

function record(
  out: CommitmentOutcome,
  field: string,
  expected: unknown,
  computed: string,
  equal: (a: string, b: string) => boolean = (a, b) => a === b,
): void {
  if (typeof expected !== 'string') {
    out.errors.push(`Receipt has no ${field} to check the supplied artefact against`);
    return;
  }
  const match = equal(expected, computed);
  out.checks.push({ field, expected, computed, match });
  if (!match) {
    out.errors.push(
      `Commitment mismatch: ${field} expected ${expected.slice(0, 16)}... got ${computed.slice(0, 16)}...`,
    );
  }
}

function tryCompute(out: CommitmentOutcome, field: string, fn: () => string): string | undefined {
  try {
    return fn();
  } catch (err) {
    out.errors.push(`Cannot compute ${field}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * v1 receipts carry `contract_hash`, `output_schema_hash`,
 * `prompt_template_hash` and the inline `output` at the top level; they have
 * no output hash and no input commitments.
 */
function verifyCommitmentsV1(
  receipt: Record<string, unknown>,
  artefacts: VerifyArtefacts,
): CommitmentOutcome {
  const out: CommitmentOutcome = { checks: [], errors: [] };
  if (artefacts.output !== undefined) {
    const computed = tryCompute(out, 'output', () => computeCommitmentHash(artefacts.output));
    if (computed !== undefined) {
      if (receipt['output'] === undefined || receipt['output'] === null) {
        out.errors.push('Receipt has no output to check the supplied output against');
      } else {
        record(out, 'output', computeCommitmentHash(receipt['output']), computed);
      }
    }
  }
  if (artefacts.contract !== undefined) {
    const computed = tryCompute(out, 'contract_hash', () => computeLegacyContractHash(artefacts.contract));
    if (computed !== undefined) record(out, 'contract_hash', receipt['contract_hash'], computed);
  }
  if (artefacts.outputSchema !== undefined) {
    const computed = tryCompute(out, 'output_schema_hash', () => computeCommitmentHash(artefacts.outputSchema));
    if (computed !== undefined) record(out, 'output_schema_hash', receipt['output_schema_hash'], computed);
  }
  if (artefacts.promptProgram !== undefined) {
    const computed = tryCompute(out, 'prompt_template_hash', () => computePromptProgramHash(artefacts.promptProgram));
    if (computed !== undefined) record(out, 'prompt_template_hash', receipt['prompt_template_hash'], computed);
  }
  if (artefacts.ownInput !== undefined) {
    out.errors.push('v1 receipts carry no input commitments; the own-input check cannot run');
  }
  return out;
}

/** v2 receipts carry their commitments under `commitments`. */
function verifyCommitmentsV2(
  receipt: Record<string, unknown>,
  artefacts: VerifyArtefacts,
): CommitmentOutcome {
  const out: CommitmentOutcome = { checks: [], errors: [] };
  const raw = receipt['commitments'];
  const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  if (artefacts.output !== undefined) {
    const computed = tryCompute(out, 'output_hash', () => computeCommitmentHash(artefacts.output));
    if (computed !== undefined) {
      record(out, 'output_hash', c['output_hash'], computed);
      if (c['output'] !== undefined && computeCommitmentHash(c['output']) !== computed) {
        out.errors.push('Inline commitments.output differs from the received output');
      }
    }
  }
  if (artefacts.contract !== undefined) {
    const computed = tryCompute(out, 'contract_hash', () => computeLegacyContractHash(artefacts.contract));
    if (computed !== undefined) record(out, 'contract_hash', c['contract_hash'], computed);
  }
  if (artefacts.outputSchema !== undefined) {
    const computed = tryCompute(out, 'schema_hash', () => computeCommitmentHash(artefacts.outputSchema));
    if (computed !== undefined) record(out, 'schema_hash', c['schema_hash'], computed);
  }
  if (artefacts.promptProgram !== undefined) {
    const computed = tryCompute(out, 'prompt_template_hash', () => computePromptProgramHash(artefacts.promptProgram));
    if (computed !== undefined) record(out, 'prompt_template_hash', c['prompt_template_hash'], computed);
  }
  if (artefacts.ownInput !== undefined) {
    const own = artefacts.ownInput;
    const entries = Array.isArray(c['input_commitments']) ? (c['input_commitments'] as unknown[]) : [];
    const entry = entries.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as Record<string, unknown>)['participant_id'] === own.participantId,
    ) as Record<string, unknown> | undefined;
    if (!entry) {
      out.errors.push(`Receipt has no input commitment for participant "${own.participantId}"`);
    } else {
      const computed = tryCompute(out, 'input_hash', () => computeCommitmentHash(own.context));
      if (computed !== undefined) {
        record(out, 'input_commitments.input_hash', entry['input_hash'], computed, constantTimeHexEqual);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// v3
// ---------------------------------------------------------------------------

function check(out: CommitmentOutcome, field: string, expected: string, run: () => void): void {
  try {
    run();
    out.checks.push({ field, expected, computed: expected, match: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cls = err instanceof ReceiptV3CheckError ? `${err.errorClass}: ` : '';
    out.checks.push({ field, expected, computed: '', match: false });
    out.errors.push(`${field} check failed: ${cls}${msg}`);
  }
}

function verifyCommitmentsV3(receipt: ReceiptV3, artefacts: VerifyArtefacts): CommitmentOutcome {
  const out: CommitmentOutcome = { checks: [], errors: [] };
  const c = receipt.commitments;

  if (artefacts.ownInput !== undefined) {
    const { participantId, context, commitmentNonce } = artefacts.ownInput;
    const entry = c.input_commitments.find((e) => e.participant_id === participantId);
    if (commitmentNonce === undefined) {
      out.errors.push('The own-input check on a v3 receipt needs the commitment nonce sent with the input');
    } else {
      check(out, 'input_commitments.input_commitment', entry?.input_commitment ?? '', () =>
        checkOwnInputV3(receipt, { participantId, context, commitmentNonce }),
      );
    }
  }
  if (artefacts.output !== undefined) {
    check(out, 'output_hash', c.output_hash, () => checkReceivedOutputV3(receipt, artefacts.output));
  }
  if (artefacts.contract !== undefined) {
    const contract = stripContractEnvelope(artefacts.contract);
    check(out, 'contract_hash', c.contract_hash, () => checkContractV3(receipt, contract));
  }
  if (artefacts.outputSchema !== undefined) {
    const computed = tryCompute(out, 'schema_hash', () => hashV3(artefacts.outputSchema));
    if (computed !== undefined) record(out, 'schema_hash', c.schema_hash, computed);
  }
  if (artefacts.promptProgram !== undefined) {
    const computed = tryCompute(out, 'prompt_template_hash', () => hashV3(artefacts.promptProgram));
    if (computed !== undefined) record(out, 'prompt_template_hash', c.prompt_template_hash, computed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function detectVersion(receipt: Record<string, unknown>): { version?: ReceiptVersion; label: string } {
  const rsv = receipt['receipt_schema_version'];
  if (typeof rsv === 'string' && rsv.startsWith('3.')) return { version: 'v3', label: rsv };
  if (typeof rsv === 'string' && rsv.startsWith('2.')) return { version: 'v2', label: rsv };
  if (rsv === undefined && receipt['schema_version'] === '1.0.0') return { version: 'v1', label: '1.0.0' };
  return { label: String(rsv ?? receipt['schema_version'] ?? 'unknown') };
}

function teeInfoOf(receipt: Record<string, unknown>): TeeInfo | undefined {
  const raw = receipt['tee_attestation'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const att = raw as Record<string, unknown>;
  const s = (k: string) => (typeof att[k] === 'string' ? (att[k] as string) : '');
  return {
    tee_type: s('tee_type') || 'unknown',
    measurement: s('measurement'),
    attestation_hash: s('attestation_hash'),
    receipt_signing_pubkey_hex: s('receipt_signing_pubkey_hex'),
    transcript_hash_hex: s('transcript_hash_hex'),
    note: 'TEE fields present. Use verifyTeeReceipt() from selkey/tee for transcript + attestation hash verification.',
  };
}

/**
 * Verify a receipt against the pinned relay key and, optionally, against
 * artefacts the caller holds.
 *
 * Pass v3 receipts as JSON text where possible: text input also gets the
 * repeated-member and integer-literal checks of the v3 profile.
 */
export function verifyReceipt(
  receiptInput: Record<string, unknown> | string,
  publicKeyHex?: string,
  artefacts?: VerifyArtefacts,
): VerifyResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let receipt: Record<string, unknown>;
  if (typeof receiptInput === 'string') {
    try {
      const parsed = parseJsonStrict(receiptInput);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('receipt must be a JSON object');
      }
      receipt = parsed as Record<string, unknown>;
    } catch (err) {
      return {
        valid: false,
        schema_version: 'unknown',
        errors: [`Receipt JSON rejected: ${err instanceof Error ? err.message : String(err)}`],
        warnings,
      };
    }
  } else if (typeof receiptInput === 'object' && receiptInput !== null) {
    receipt = receiptInput;
  } else {
    return { valid: false, schema_version: 'unknown', errors: ['Receipt must be a JSON object'], warnings };
  }

  const { version, label } = detectVersion(receipt);
  if (version === undefined) {
    errors.push(
      'Cannot detect receipt version: expected receipt_schema_version "3.0.0" or "2.x.y", or schema_version "1.0.0"',
    );
    return { valid: false, schema_version: label, errors, warnings };
  }

  // The receipt is always verified against the caller-supplied (pinned)
  // relay key. A key embedded in tee_attestation is receipt-controlled data:
  // this client does not verify TEE quotes, so the embedded key is never used
  // as a verification key on its own. When present, it must equal the pinned
  // key.
  if (typeof publicKeyHex !== 'string' || publicKeyHex.length === 0) {
    errors.push(
      'No verification key: publicKeyHex (the pinned relay verifying key) is required; ' +
        'keys embedded in the receipt are not trusted on their own',
    );
    return { valid: false, schema_version: label, errors, warnings };
  }
  const verifyKey = publicKeyHex.toLowerCase();

  let valid = true;
  let commitments: CommitmentOutcome | undefined;
  let verifiedReceipt: Record<string, unknown> = receipt;

  if (version === 'v3') {
    const v3 = verifyReceiptV3(typeof receiptInput === 'string' ? receiptInput : receipt, verifyKey);
    if (!v3.ok) {
      return {
        valid: false,
        schema_version: label,
        errors: [`Receipt v3 rejected (${v3.errorClass}): ${v3.message}`],
        warnings,
        error_class: v3.errorClass,
      };
    }
    // Everything below reads only the verified, typed receipt.
    verifiedReceipt = v3.receipt as unknown as Record<string, unknown>;
    if (artefacts) commitments = verifyCommitmentsV3(v3.receipt, artefacts);
  } else {
    if (version === 'v2') {
      const att = receipt['tee_attestation'];
      if (typeof att === 'object' && att !== null) {
        const embedded = (att as Record<string, unknown>)['receipt_signing_pubkey_hex'];
        if (embedded !== undefined && String(embedded).toLowerCase() !== verifyKey) {
          errors.push(
            `tee_attestation.receipt_signing_pubkey_hex '${String(embedded).slice(0, 12)}...' does not match the pinned relay key '${verifyKey.slice(0, 12)}...'`,
          );
          valid = false;
        }
      }
    }
    const sigResult =
      version === 'v2' ? verifySignatureV2(receipt, verifyKey) : verifySignatureV1(receipt, verifyKey);
    errors.push(...sigResult.errors);
    if (!sigResult.valid) valid = false;
    if (artefacts) {
      commitments =
        version === 'v2' ? verifyCommitmentsV2(receipt, artefacts) : verifyCommitmentsV1(receipt, artefacts);
    }
  }

  let commitment_checks: CommitmentCheck[] | undefined;
  if (commitments) {
    if (commitments.checks.length > 0) commitment_checks = commitments.checks;
    if (commitments.errors.length > 0) {
      errors.push(...commitments.errors);
      valid = false;
    }
  }

  // Cross-check the relay verifying key pinned in the contract (#184).
  if (artefacts?.contract && typeof artefacts.contract === 'object') {
    const contractObj = artefacts.contract as Record<string, unknown>;
    if (typeof contractObj.relay_verifying_key_hex === 'string') {
      if (contractObj.relay_verifying_key_hex.toLowerCase() !== verifyKey) {
        errors.push(
          `Contract pins relay key '${contractObj.relay_verifying_key_hex.slice(0, 12)}...' but receipt was signed by '${verifyKey.slice(0, 12)}...'`,
        );
        valid = false;
      }
    }
  }

  const hasEnvelope = version !== 'v1';
  const operator = verifiedReceipt['operator'];
  return {
    valid,
    schema_version: label,
    assurance_level:
      hasEnvelope && typeof verifiedReceipt['assurance_level'] === 'string'
        ? (verifiedReceipt['assurance_level'] as string)
        : undefined,
    operator_id:
      hasEnvelope &&
      typeof operator === 'object' &&
      operator !== null &&
      typeof (operator as Record<string, unknown>)['operator_id'] === 'string'
        ? ((operator as Record<string, unknown>)['operator_id'] as string)
        : undefined,
    errors,
    warnings,
    commitment_checks,
    tee_info: hasEnvelope ? teeInfoOf(verifiedReceipt) : undefined,
  };
}

/** Detect receipt version from the receipt object. */
export function detectReceiptVersion(
  receipt: Record<string, unknown>,
): '1.0.0' | `2.${string}` | `3.${string}` | null {
  const rsv = receipt['receipt_schema_version'];
  if (typeof rsv === 'string' && (rsv.startsWith('3.') || rsv.startsWith('2.'))) {
    return rsv as `2.${string}` | `3.${string}`;
  }
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
