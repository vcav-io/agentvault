/**
 * Receipt v3 parsing and verification.
 *
 * Normative reference: vault-family-core `docs/receipt-v3.md`, section 6.
 * The verifier applies the rules in order and rejects at the first failure:
 *
 * - 6.1/6.2: strict parse, number limit, exact shape (no unknown fields, no
 *   `null` for defined fields, known enum values, hex64 formats, `issued_at`
 *   format, integer fields written as plain integer literals);
 * - 6.3: signature format, pinned key of prime order, operator key
 *   fingerprint, embedded TEE key equal to the pinned key, strict Ed25519;
 * - 6.4: inline output hash, effective config hash, SESSION budget scope.
 *
 * Participant checks (6.5 own input, 6.6 received output, 6.7 contract) run
 * on the verified receipt via {@link runReceiptV3Checks}.
 */

import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import {
  CANONICALIZATION_V3,
  JcsError,
  type NumberLexemes,
  canonicalizeV3,
  checkV3Profile,
  hashV3,
  isLexicalUnsignedInteger,
  isLowerHex,
  parseJsonStrictWithLexemes,
  sha256Hex,
} from './jcs-v3.js';
import { INPUT_COMMITMENT_SCHEME_V3, verifyInputCommitmentV3 } from './commitment-v3.js';
import {
  CONTRACT_HASH_ALG_V2,
  computeContractHashV2,
  normalizeContractV2,
} from './contract-hash-v2.js';
import { isPrimeOrderKey, verifyEd25519Strict } from './ed25519-strict.js';

export const SCHEMA_VERSION_V3 = '3.0.0';
export const DOMAIN_PREFIX_V3 = 'VCAV-RECEIPT-V3:';
export const SIGNED_FIELDS_ALL_EXCEPT_SIGNATURE = 'ALL_EXCEPT_SIGNATURE';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InputCommitmentV3 {
  participant_id: string;
  input_commitment: string;
  scheme: typeof INPUT_COMMITMENT_SCHEME_V3;
}

export interface CommitmentsV3 {
  contract_hash: string;
  contract_hash_alg: typeof CONTRACT_HASH_ALG_V2;
  schema_hash: string;
  output_hash: string;
  input_commitments: InputCommitmentV3[];
  assembled_prompt_hash: string;
  prompt_assembly_version: string;
  output?: unknown;
  prompt_template_hash?: string;
  effective_config_hash?: string;
  preflight_bundle?: {
    policy_hash: string;
    prompt_template_hash: string;
    model_profile_hash: string;
    schema_hash: string;
    enforcement_parameters: unknown;
  };
  output_retrieval_uri?: string;
  output_media_type?: string;
  preflight_bundle_uri?: string;
  rejected_output_hash?: string;
  initiator_submission_hash?: string;
  responder_submission_hash?: string;
}

export interface BudgetUsageV3 {
  scope: 'SESSION';
  bits_used_before: number;
  bits_used_after: number;
  budget_limit: number;
}

export interface ClaimsV3 {
  model_identity_asserted?: string;
  model_identity_attested?: string;
  model_profile_hash_asserted?: string;
  runtime_hash_asserted?: string;
  runtime_hash_attested?: string;
  budget_enforcement_mode?: 'enforced' | 'advisory' | 'disabled';
  provider_latency_ms?: number;
  token_usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  relay_software_version?: string;
  status?: 'success' | 'rejected' | 'aborted' | 'error';
  signal_class?: string;
  execution_lane?: 'standard' | 'tee';
  channel_capacity_bits_upper_bound?: number;
  channel_capacity_measurement_version?: string;
  entropy_budget_bits?: number;
  schema_entropy_ceiling_bits?: number;
  budget_usage?: BudgetUsageV3;
}

export interface ReceiptV3 {
  receipt_schema_version: typeof SCHEMA_VERSION_V3;
  receipt_canonicalization: typeof CANONICALIZATION_V3;
  receipt_id: string;
  session_id: string;
  issued_at: string;
  assurance_level: 'SELF_ASSERTED' | 'OPERATOR_AUDITED' | 'PROVIDER_ATTESTED' | 'TEE_ATTESTED';
  operator: {
    operator_id: string;
    operator_key_fingerprint: string;
    operator_key_discovery?: string;
  };
  commitments: CommitmentsV3;
  claims: ClaimsV3;
  provider_attestation?: {
    provider_attestation_blob: string;
    provider_attestation_type: string;
    provider_key_id: string;
    provider_key_discovery_uri?: string;
  };
  tee_attestation?: {
    tee_type?: 'SGX' | 'TDX' | 'SEV-SNP' | 'TrustZone' | 'Simulated';
    measurement?: string;
    quote?: string;
    attestation_hash?: string;
    receipt_signing_pubkey_hex?: string;
    transcript_hash_hex?: string;
    user_data_hex?: string;
    snp_vcek_cert?: string;
  };
  signature: {
    alg: 'Ed25519';
    value: string;
    signed_fields: typeof SIGNED_FIELDS_ALL_EXCEPT_SIGNATURE;
  };
}

export type ReceiptV3ErrorClass =
  | 'PARSE_ERROR'
  | 'DUPLICATE_KEY'
  | 'NUMBER_OUT_OF_RANGE'
  | 'UNSUPPORTED_VERSION'
  | 'SCHEMA_VIOLATION'
  | 'NON_CANONICAL_ENCODING'
  | 'INVALID_FIELD'
  | 'SIGNATURE_FORMAT'
  | 'KEY_MISMATCH'
  | 'INVALID_KEY'
  | 'SIGNATURE_INVALID'
  | 'OUTPUT_HASH_MISMATCH'
  | 'CONFIG_HASH_MISMATCH'
  | 'BUDGET_SCOPE_VIOLATION';

export class ReceiptV3Error extends Error {
  constructor(
    public readonly errorClass: ReceiptV3ErrorClass,
    message: string,
  ) {
    super(message);
    this.name = 'ReceiptV3Error';
  }
}

export type ReceiptV3Result =
  | { ok: true; receipt: ReceiptV3 }
  | { ok: false; errorClass: ReceiptV3ErrorClass; message: string };

// ---------------------------------------------------------------------------
// Shape validation (section 6.2)
// ---------------------------------------------------------------------------

type Ctx = { lexemes?: NumberLexemes };

function schema(msg: string): never {
  throw new ReceiptV3Error('SCHEMA_VIOLATION', msg);
}

function fieldErr(msg: string): never {
  throw new ReceiptV3Error('INVALID_FIELD', msg);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read an object, rejecting unknown members and `null` member values. */
function readObject(
  v: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (!isObj(v)) schema(`${path} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const [k, val] of Object.entries(v)) {
    if (!allowed.has(k)) schema(`unknown field ${path}.${k}`);
    if (val === null) {
      throw new ReceiptV3Error('NON_CANONICAL_ENCODING', `${path}.${k} must not be null`);
    }
  }
  for (const k of required) {
    if (!(k in v)) schema(`missing field ${path}.${k}`);
  }
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string') schema(`${path} must be a string`);
  return v;
}

function nonEmpty(v: unknown, path: string): string {
  const s = str(v, path);
  if (s.length === 0) fieldErr(`${path} must not be empty`);
  return s;
}

function hex64(v: unknown, path: string): string {
  const s = str(v, path);
  if (!isLowerHex(s, 64)) fieldErr(`${path} must be 64 lowercase hex characters`);
  return s;
}

function oneOf<T extends string>(v: unknown, path: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    schema(`${path} must be one of ${values.join(', ')}`);
  }
  return v as T;
}

function integer(v: unknown, jsonPath: string, path: string, max: number, ctx: Ctx): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max || Object.is(v, -0)) {
    schema(`${path} must be an integer in 0..${max}`);
  }
  const lexeme = ctx.lexemes?.get(jsonPath);
  if (lexeme !== undefined && !isLexicalUnsignedInteger(lexeme)) {
    schema(`${path} must be written as a plain integer`);
  }
  return v;
}

const U32 = 0xffffffff;
const U64 = Number.MAX_SAFE_INTEGER;

function optional<T>(
  obj: Record<string, unknown>,
  key: string,
  read: (v: unknown) => T,
  out: Record<string, unknown>,
): void {
  if (key in obj) out[key] = read(obj[key]);
}

const ISSUED_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** Whether `s` is a valid v3 `issued_at` (`YYYY-MM-DDTHH:MM:SSZ`, real calendar date). */
export function isValidIssuedAtV3(s: string): boolean {
  const m = ISSUED_AT_RE.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= days;
}

function readCommitments(v: unknown, ctx: Ctx): CommitmentsV3 {
  const p = 'commitments';
  const o = readObject(
    v,
    p,
    [
      'contract_hash',
      'contract_hash_alg',
      'schema_hash',
      'output_hash',
      'input_commitments',
      'assembled_prompt_hash',
      'prompt_assembly_version',
    ],
    [
      'output',
      'prompt_template_hash',
      'effective_config_hash',
      'preflight_bundle',
      'output_retrieval_uri',
      'output_media_type',
      'preflight_bundle_uri',
      'rejected_output_hash',
      'initiator_submission_hash',
      'responder_submission_hash',
    ],
  );
  const out: Record<string, unknown> = {
    contract_hash: hex64(o.contract_hash, `${p}.contract_hash`),
    contract_hash_alg: oneOf(o.contract_hash_alg, `${p}.contract_hash_alg`, [CONTRACT_HASH_ALG_V2]),
    schema_hash: hex64(o.schema_hash, `${p}.schema_hash`),
    output_hash: hex64(o.output_hash, `${p}.output_hash`),
    assembled_prompt_hash: hex64(o.assembled_prompt_hash, `${p}.assembled_prompt_hash`),
    prompt_assembly_version: str(o.prompt_assembly_version, `${p}.prompt_assembly_version`),
  };

  if (!Array.isArray(o.input_commitments)) schema(`${p}.input_commitments must be an array`);
  const seen = new Set<string>();
  out.input_commitments = o.input_commitments.map((e, i) => {
    const ep = `${p}.input_commitments[${i}]`;
    const eo = readObject(e, ep, ['participant_id', 'input_commitment', 'scheme'], []);
    const entry: InputCommitmentV3 = {
      participant_id: nonEmpty(eo.participant_id, `${ep}.participant_id`),
      input_commitment: hex64(eo.input_commitment, `${ep}.input_commitment`),
      scheme: oneOf(eo.scheme, `${ep}.scheme`, [INPUT_COMMITMENT_SCHEME_V3]),
    };
    if (seen.has(entry.participant_id)) {
      fieldErr(`duplicate participant_id ${JSON.stringify(entry.participant_id)}`);
    }
    seen.add(entry.participant_id);
    return entry;
  });
  if ((out.input_commitments as unknown[]).length === 0) {
    fieldErr(`${p}.input_commitments must not be empty`);
  }

  optional(o, 'output', (x) => x, out);
  for (const k of [
    'prompt_template_hash',
    'effective_config_hash',
    'rejected_output_hash',
    'initiator_submission_hash',
    'responder_submission_hash',
  ]) {
    optional(o, k, (x) => hex64(x, `${p}.${k}`), out);
  }
  for (const k of ['output_retrieval_uri', 'output_media_type', 'preflight_bundle_uri']) {
    optional(o, k, (x) => str(x, `${p}.${k}`), out);
  }
  optional(
    o,
    'preflight_bundle',
    (x) => {
      const bp = `${p}.preflight_bundle`;
      if (!isObj(x)) schema(`${bp} must be an object`);
      const allowed = [
        'policy_hash',
        'prompt_template_hash',
        'model_profile_hash',
        'schema_hash',
        'enforcement_parameters',
      ];
      for (const [k, val] of Object.entries(x)) {
        if (!allowed.includes(k)) {
          throw new ReceiptV3Error('NON_CANONICAL_ENCODING', `unknown field ${bp}.${k}`);
        }
        // enforcement_parameters is free-form and may be null.
        if (val === null && k !== 'enforcement_parameters') {
          schema(`${bp}.${k} must not be null`);
        }
      }
      for (const k of allowed) if (!(k in x)) schema(`missing field ${bp}.${k}`);
      return {
        policy_hash: str(x.policy_hash, `${bp}.policy_hash`),
        prompt_template_hash: str(x.prompt_template_hash, `${bp}.prompt_template_hash`),
        model_profile_hash: str(x.model_profile_hash, `${bp}.model_profile_hash`),
        schema_hash: str(x.schema_hash, `${bp}.schema_hash`),
        enforcement_parameters: x.enforcement_parameters,
      };
    },
    out,
  );
  void ctx;
  return out as unknown as CommitmentsV3;
}

function readClaims(v: unknown, ctx: Ctx): ClaimsV3 {
  const p = 'claims';
  const o = readObject(
    v,
    p,
    [],
    [
      'model_identity_asserted',
      'model_identity_attested',
      'model_profile_hash_asserted',
      'runtime_hash_asserted',
      'runtime_hash_attested',
      'budget_enforcement_mode',
      'provider_latency_ms',
      'token_usage',
      'relay_software_version',
      'status',
      'signal_class',
      'execution_lane',
      'channel_capacity_bits_upper_bound',
      'channel_capacity_measurement_version',
      'entropy_budget_bits',
      'schema_entropy_ceiling_bits',
      'budget_usage',
    ],
  );
  const out: Record<string, unknown> = {};
  for (const k of [
    'model_identity_asserted',
    'model_identity_attested',
    'model_profile_hash_asserted',
    'runtime_hash_asserted',
    'runtime_hash_attested',
    'relay_software_version',
    'signal_class',
    'channel_capacity_measurement_version',
  ]) {
    optional(o, k, (x) => str(x, `${p}.${k}`), out);
  }
  optional(
    o,
    'budget_enforcement_mode',
    (x) => oneOf(x, `${p}.budget_enforcement_mode`, ['enforced', 'advisory', 'disabled'] as const),
    out,
  );
  optional(
    o,
    'status',
    (x) => oneOf(x, `${p}.status`, ['success', 'rejected', 'aborted', 'error'] as const),
    out,
  );
  optional(
    o,
    'execution_lane',
    (x) => oneOf(x, `${p}.execution_lane`, ['standard', 'tee'] as const),
    out,
  );
  optional(
    o,
    'provider_latency_ms',
    (x) => integer(x, '/claims/provider_latency_ms', `${p}.provider_latency_ms`, U64, ctx),
    out,
  );
  for (const k of [
    'channel_capacity_bits_upper_bound',
    'entropy_budget_bits',
    'schema_entropy_ceiling_bits',
  ]) {
    optional(o, k, (x) => integer(x, `/claims/${k}`, `${p}.${k}`, U32, ctx), out);
  }
  optional(
    o,
    'token_usage',
    (x) => {
      const keys = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
      const tp = `${p}.token_usage`;
      if (!isObj(x)) schema(`${tp} must be an object`);
      for (const k of Object.keys(x)) {
        if (!keys.includes(k)) {
          throw new ReceiptV3Error('NON_CANONICAL_ENCODING', `unknown field ${tp}.${k}`);
        }
      }
      const t: Record<string, number> = {};
      for (const k of keys) {
        if (!(k in x)) schema(`missing field ${tp}.${k}`);
        t[k] = integer(x[k], `/claims/token_usage/${k}`, `${tp}.${k}`, U64, ctx);
      }
      return t;
    },
    out,
  );
  optional(
    o,
    'budget_usage',
    (x) => {
      const bp = `${p}.budget_usage`;
      const b = readObject(
        x,
        bp,
        ['scope', 'bits_used_before', 'bits_used_after', 'budget_limit'],
        [],
      );
      return {
        scope: oneOf(b.scope, `${bp}.scope`, ['SESSION'] as const),
        bits_used_before: integer(
          b.bits_used_before,
          '/claims/budget_usage/bits_used_before',
          `${bp}.bits_used_before`,
          U32,
          ctx,
        ),
        bits_used_after: integer(
          b.bits_used_after,
          '/claims/budget_usage/bits_used_after',
          `${bp}.bits_used_after`,
          U32,
          ctx,
        ),
        budget_limit: integer(
          b.budget_limit,
          '/claims/budget_usage/budget_limit',
          `${bp}.budget_limit`,
          U32,
          ctx,
        ),
      };
    },
    out,
  );
  return out as ClaimsV3;
}

function readTeeAttestation(v: unknown): NonNullable<ReceiptV3['tee_attestation']> {
  const p = 'tee_attestation';
  const keys = [
    'tee_type',
    'measurement',
    'quote',
    'attestation_hash',
    'receipt_signing_pubkey_hex',
    'transcript_hash_hex',
    'user_data_hex',
    'snp_vcek_cert',
  ];
  if (!isObj(v)) schema(`${p} must be an object`);
  for (const [k, val] of Object.entries(v)) {
    if (!keys.includes(k))
      throw new ReceiptV3Error('NON_CANONICAL_ENCODING', `unknown field ${p}.${k}`);
    if (val === null)
      throw new ReceiptV3Error('NON_CANONICAL_ENCODING', `${p}.${k} must not be null`);
  }
  const out: Record<string, unknown> = {};
  optional(
    v,
    'tee_type',
    (x) => oneOf(x, `${p}.tee_type`, ['SGX', 'TDX', 'SEV-SNP', 'TrustZone', 'Simulated'] as const),
    out,
  );
  for (const k of keys.slice(1)) optional(v, k, (x) => str(x, `${p}.${k}`), out);
  return out;
}

function readProviderAttestation(v: unknown): NonNullable<ReceiptV3['provider_attestation']> {
  const p = 'provider_attestation';
  const keys = ['provider_attestation_blob', 'provider_attestation_type', 'provider_key_id'];
  if (!isObj(v)) schema(`${p} must be an object`);
  for (const [k, val] of Object.entries(v)) {
    if (![...keys, 'provider_key_discovery_uri'].includes(k)) {
      throw new ReceiptV3Error('NON_CANONICAL_ENCODING', `unknown field ${p}.${k}`);
    }
    if (val === null)
      throw new ReceiptV3Error('NON_CANONICAL_ENCODING', `${p}.${k} must not be null`);
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!(k in v)) schema(`missing field ${p}.${k}`);
    out[k] = str(v[k], `${p}.${k}`);
  }
  optional(v, 'provider_key_discovery_uri', (x) => str(x, `${p}.provider_key_discovery_uri`), out);
  return out as NonNullable<ReceiptV3['provider_attestation']>;
}

/**
 * Validate a parsed receipt against the v3 format (section 3) and return a
 * typed copy containing only the defined fields.
 */
export function readReceiptV3(value: unknown, lexemes?: NumberLexemes): ReceiptV3 {
  const ctx: Ctx = { lexemes };
  try {
    checkV3Profile(value);
  } catch (e) {
    if (e instanceof JcsError) throw new ReceiptV3Error(e.code, e.message);
    throw e;
  }
  if (!isObj(value)) schema('receipt must be a JSON object');
  const version = value.receipt_schema_version;
  if (version === undefined) schema('missing receipt_schema_version');
  if (version !== SCHEMA_VERSION_V3) {
    throw new ReceiptV3Error(
      'UNSUPPORTED_VERSION',
      `unsupported receipt_schema_version ${JSON.stringify(version)}`,
    );
  }
  const o = readObject(
    value,
    'receipt',
    [
      'receipt_schema_version',
      'receipt_canonicalization',
      'receipt_id',
      'session_id',
      'issued_at',
      'assurance_level',
      'operator',
      'commitments',
      'claims',
      'signature',
    ],
    ['provider_attestation', 'tee_attestation'],
  );

  if (o.receipt_canonicalization !== CANONICALIZATION_V3) {
    fieldErr(`receipt_canonicalization must be ${CANONICALIZATION_V3}`);
  }
  const issuedAt = str(o.issued_at, 'issued_at');
  if (!isValidIssuedAtV3(issuedAt)) fieldErr('issued_at must be YYYY-MM-DDTHH:MM:SSZ');

  const op = readObject(
    o.operator,
    'operator',
    ['operator_id', 'operator_key_fingerprint'],
    ['operator_key_discovery'],
  );
  const operator: ReceiptV3['operator'] = {
    operator_id: nonEmpty(op.operator_id, 'operator.operator_id'),
    operator_key_fingerprint: hex64(
      op.operator_key_fingerprint,
      'operator.operator_key_fingerprint',
    ),
  };
  if ('operator_key_discovery' in op) {
    operator.operator_key_discovery = str(
      op.operator_key_discovery,
      'operator.operator_key_discovery',
    );
  }

  const sig = readObject(o.signature, 'signature', ['alg', 'value', 'signed_fields'], []);
  const signature = {
    alg: str(sig.alg, 'signature.alg'),
    value: str(sig.value, 'signature.value'),
    signed_fields: str(sig.signed_fields, 'signature.signed_fields'),
  };

  const receipt: Record<string, unknown> = {
    receipt_schema_version: SCHEMA_VERSION_V3,
    receipt_canonicalization: CANONICALIZATION_V3,
    receipt_id: nonEmpty(o.receipt_id, 'receipt_id'),
    session_id: nonEmpty(o.session_id, 'session_id'),
    issued_at: issuedAt,
    assurance_level: oneOf(o.assurance_level, 'assurance_level', [
      'SELF_ASSERTED',
      'OPERATOR_AUDITED',
      'PROVIDER_ATTESTED',
      'TEE_ATTESTED',
    ] as const),
    operator,
    commitments: readCommitments(o.commitments, ctx),
    claims: readClaims(o.claims, ctx),
  };
  if ('provider_attestation' in o)
    receipt.provider_attestation = readProviderAttestation(o.provider_attestation);
  if ('tee_attestation' in o) receipt.tee_attestation = readTeeAttestation(o.tee_attestation);
  receipt.signature = signature;
  return receipt as unknown as ReceiptV3;
}

// ---------------------------------------------------------------------------
// Internal consistency (section 6.4)
// ---------------------------------------------------------------------------

function checkConsistency(r: ReceiptV3): void {
  const c = r.commitments;
  if (c.output !== undefined && hashV3(c.output) !== c.output_hash) {
    throw new ReceiptV3Error(
      'OUTPUT_HASH_MISMATCH',
      'output_hash does not match the inline output',
    );
  }
  if (c.preflight_bundle !== undefined && c.effective_config_hash !== undefined) {
    if (hashV3(c.preflight_bundle) !== c.effective_config_hash) {
      throw new ReceiptV3Error(
        'CONFIG_HASH_MISMATCH',
        'effective_config_hash does not match the preflight bundle',
      );
    }
  }
  const usage = r.claims.budget_usage;
  if (usage !== undefined && usage.scope === 'SESSION' && usage.bits_used_before !== 0) {
    throw new ReceiptV3Error(
      'BUDGET_SCOPE_VIOLATION',
      'bits_used_before must be 0 for SESSION scope',
    );
  }
}

// ---------------------------------------------------------------------------
// Signature (section 6.3)
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64urlEncodeNoPad(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64URL_ALPHABET[(n >> 18) & 63] + B64URL_ALPHABET[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64URL_ALPHABET[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64URL_ALPHABET[n & 63];
  }
  return out;
}

/** Decode canonical base64url without padding; null on any other encoding. */
export function decodeBase64urlCanonical(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((s.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (const ch of s) {
    acc = (acc << 6) | B64URL_ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[j++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  // Non-zero trailing bits make the encoding non-canonical.
  if (base64urlEncodeNoPad(bytes) !== s) return null;
  return bytes;
}

/** The unsigned receipt body (everything except `signature`). */
function unsignedBody(r: ReceiptV3): Record<string, unknown> {
  const { signature: _sig, ...unsigned } = r;
  return unsigned;
}

/** `SHA-256("VCAV-RECEIPT-V3:" || JCS(unsigned))`. */
export function signingDigestV3(r: ReceiptV3): Uint8Array {
  return sha256(utf8ToBytes(DOMAIN_PREFIX_V3 + canonicalizeV3(unsignedBody(r))));
}

/** `hex(SHA-256(public key bytes))`, the expected `operator_key_fingerprint`. */
export function operatorKeyFingerprint(publicKeyHex: string): string {
  return sha256Hex(hexToBytes(publicKeyHex.toLowerCase()));
}

function checkSignature(r: ReceiptV3, pinnedKeyHex: string): void {
  if (r.signature.alg !== 'Ed25519') {
    throw new ReceiptV3Error('SIGNATURE_FORMAT', 'signature.alg must be Ed25519');
  }
  if (r.signature.signed_fields !== SIGNED_FIELDS_ALL_EXCEPT_SIGNATURE) {
    throw new ReceiptV3Error(
      'SIGNATURE_FORMAT',
      `signature.signed_fields must be ${SIGNED_FIELDS_ALL_EXCEPT_SIGNATURE}`,
    );
  }
  const sig = decodeBase64urlCanonical(r.signature.value);
  if (sig === null || sig.length !== 64) {
    throw new ReceiptV3Error(
      'SIGNATURE_FORMAT',
      'signature.value must be 64 bytes of canonical unpadded base64url',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(pinnedKeyHex)) {
    throw new ReceiptV3Error('INVALID_KEY', 'pinned relay key must be 64 hex characters');
  }
  const keyHex = pinnedKeyHex.toLowerCase();
  const key = hexToBytes(keyHex);
  if (!isPrimeOrderKey(key)) {
    throw new ReceiptV3Error('INVALID_KEY', 'pinned key is not a valid prime-order Ed25519 point');
  }
  if (r.operator.operator_key_fingerprint !== sha256Hex(key)) {
    throw new ReceiptV3Error(
      'KEY_MISMATCH',
      'operator_key_fingerprint does not match the pinned key',
    );
  }
  const embedded = r.tee_attestation?.receipt_signing_pubkey_hex;
  if (embedded !== undefined && embedded !== keyHex) {
    throw new ReceiptV3Error(
      'KEY_MISMATCH',
      'tee_attestation.receipt_signing_pubkey_hex does not match the pinned key',
    );
  }
  if (!verifyEd25519Strict(sig, signingDigestV3(r), key)) {
    throw new ReceiptV3Error('SIGNATURE_INVALID', 'signature verification failed');
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Parse and verify a v3 receipt (sections 6.1 to 6.4) against the pinned
 * relay key. Pass the receipt as JSON text where possible: text input also
 * gets repeated-member and integer-literal checks that a parsed object can no
 * longer show.
 *
 * On success the returned receipt contains exactly the signed content.
 */
export function verifyReceiptV3(
  receipt: string | Record<string, unknown>,
  pinnedKeyHex: string,
): ReceiptV3Result {
  try {
    let value: unknown = receipt;
    let lexemes: NumberLexemes | undefined;
    if (typeof receipt === 'string') {
      const parsed = parseJsonStrictWithLexemes(receipt);
      value = parsed.value;
      lexemes = parsed.numberLexemes;
    }
    const typed = readReceiptV3(value, lexemes);
    // Section order: 6.3 (signature) before 6.4 (internal consistency).
    checkSignature(typed, pinnedKeyHex);
    checkConsistency(typed);
    return { ok: true, receipt: typed };
  } catch (e) {
    if (e instanceof ReceiptV3Error)
      return { ok: false, errorClass: e.errorClass, message: e.message };
    if (e instanceof JcsError) return { ok: false, errorClass: e.code, message: e.message };
    return {
      ok: false,
      errorClass: 'PARSE_ERROR',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Participant checks (sections 6.5 to 6.7)
// ---------------------------------------------------------------------------

export type ReceiptV3CheckErrorClass =
  | 'OWN_INPUT_MISSING'
  | 'OWN_INPUT_MISMATCH'
  | 'INVALID_OWN_INPUT'
  | 'OUTPUT_MISMATCH'
  | 'INLINE_OUTPUT_MISMATCH'
  | 'INVALID_OUTPUT'
  | 'INVALID_CONTRACT'
  | 'CONTRACT_HASH_MISMATCH'
  | 'SCHEMA_HASH_MISMATCH'
  | 'PARTICIPANTS_MISMATCH'
  | 'PROMPT_TEMPLATE_MISMATCH'
  | 'ENTROPY_BUDGET_MISMATCH';

export class ReceiptV3CheckError extends Error {
  constructor(
    public readonly errorClass: ReceiptV3CheckErrorClass,
    message: string,
  ) {
    super(message);
    this.name = 'ReceiptV3CheckError';
  }
}

/** The verifying participant's own submission, kept locally by the client. */
export interface OwnInputV3 {
  participantId: string;
  context: unknown;
  /** The 64-hex commitment nonce sent with this participant's submission. */
  commitmentNonce: string;
}

/**
 * 6.5: the commitment entry for `own.participantId` opens to `own.context`
 * under `own.commitmentNonce` (constant-time comparison).
 */
export function checkOwnInputV3(receipt: ReceiptV3, own: OwnInputV3): void {
  const entry = receipt.commitments.input_commitments.find(
    (e) => e.participant_id === own.participantId,
  );
  if (!entry) {
    throw new ReceiptV3CheckError(
      'OWN_INPUT_MISSING',
      `no input commitment for participant ${JSON.stringify(own.participantId)}`,
    );
  }
  let match: boolean;
  try {
    match = verifyInputCommitmentV3(own.commitmentNonce, own.context, entry.input_commitment);
  } catch (e) {
    throw new ReceiptV3CheckError('INVALID_OWN_INPUT', e instanceof Error ? e.message : String(e));
  }
  if (!match) {
    throw new ReceiptV3CheckError(
      'OWN_INPUT_MISMATCH',
      "input commitment does not match this participant's input and nonce",
    );
  }
}

/** 6.6: `output_hash` commits to the received output; an inline output equals it. */
export function checkReceivedOutputV3(receipt: ReceiptV3, receivedOutput: unknown): void {
  let canonical: string;
  try {
    canonical = canonicalizeV3(receivedOutput);
  } catch (e) {
    throw new ReceiptV3CheckError('INVALID_OUTPUT', e instanceof Error ? e.message : String(e));
  }
  if (sha256Hex(canonical) !== receipt.commitments.output_hash) {
    throw new ReceiptV3CheckError(
      'OUTPUT_MISMATCH',
      'output_hash does not match the received output',
    );
  }
  if (receipt.commitments.output !== undefined) {
    if (canonicalizeV3(receipt.commitments.output) !== canonical) {
      throw new ReceiptV3CheckError(
        'INLINE_OUTPUT_MISMATCH',
        'inline output differs from the received output',
      );
    }
  }
}

/**
 * 6.7: contract hash v2, schema hash, participants, prompt template hash
 * and entropy budget all agree with `contract`.
 */
export function checkContractV3(receipt: ReceiptV3, contract: unknown): void {
  let normalised: Record<string, unknown>;
  let contractHash: string;
  try {
    normalised = normalizeContractV2(contract);
    contractHash = computeContractHashV2(contract);
  } catch (e) {
    throw new ReceiptV3CheckError('INVALID_CONTRACT', e instanceof Error ? e.message : String(e));
  }
  const c = receipt.commitments;
  if (contractHash !== c.contract_hash) {
    throw new ReceiptV3CheckError(
      'CONTRACT_HASH_MISMATCH',
      'contract_hash does not match the contract',
    );
  }
  let expectedSchemaHash: string;
  if (typeof normalised.output_schema_hash === 'string') {
    expectedSchemaHash = normalised.output_schema_hash;
  } else {
    try {
      expectedSchemaHash = hashV3(normalised.output_schema);
    } catch (e) {
      throw new ReceiptV3CheckError('INVALID_CONTRACT', e instanceof Error ? e.message : String(e));
    }
  }
  if (expectedSchemaHash !== c.schema_hash) {
    throw new ReceiptV3CheckError(
      'SCHEMA_HASH_MISMATCH',
      'schema_hash does not match the contract',
    );
  }
  const committed = c.input_commitments.map((e) => e.participant_id);
  const contracted = normalised.participants as string[];
  if (committed.length !== contracted.length || committed.some((p, i) => p !== contracted[i])) {
    throw new ReceiptV3CheckError(
      'PARTICIPANTS_MISMATCH',
      'input commitment participants do not match contract participants',
    );
  }
  if (
    c.prompt_template_hash !== undefined &&
    c.prompt_template_hash !== normalised.prompt_template_hash
  ) {
    throw new ReceiptV3CheckError(
      'PROMPT_TEMPLATE_MISMATCH',
      'prompt_template_hash does not match the contract',
    );
  }
  const r = receipt.claims.entropy_budget_bits;
  const k = normalised.entropy_budget_bits;
  if (r !== undefined && typeof k === 'number' && r !== k) {
    throw new ReceiptV3CheckError(
      'ENTROPY_BUDGET_MISMATCH',
      'entropy_budget_bits does not match the contract',
    );
  }
}

/** Caller-held data for the v3 participant checks. Each runs only when provided. */
export interface ReceiptV3Checks {
  ownInput?: OwnInputV3;
  receivedOutput?: unknown;
  contract?: unknown;
}

/** Run the requested participant checks on a verified receipt. */
export function runReceiptV3Checks(receipt: ReceiptV3, checks: ReceiptV3Checks): void {
  if (checks.ownInput !== undefined) checkOwnInputV3(receipt, checks.ownInput);
  if (checks.receivedOutput !== undefined) checkReceivedOutputV3(receipt, checks.receivedOutput);
  if (checks.contract !== undefined) checkContractV3(receipt, checks.contract);
}
