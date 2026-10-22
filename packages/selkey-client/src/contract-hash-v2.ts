/**
 * Contract hash v2 (`SHA256_JCS_V2`).
 *
 * ```text
 * contract_hash = hex(SHA-256(JCS_v3(normalise(contract))))
 * ```
 *
 * `normalise` rejects unknown members (including a `contract_hash` member),
 * treats `null` optional members as absent and omits absent optional members.
 * Nothing else is added or dropped.
 *
 * Normative reference: vault-family-core `docs/receipt-v3.md`, section 7.
 */

import {
  type NumberLexemes,
  JcsError,
  canonicalizeV3,
  checkV3Profile,
  isLexicalUnsignedInteger,
  parseJsonStrictWithLexemes,
  sha256Hex,
} from './jcs-v3.js';

export const CONTRACT_HASH_ALG_V2 = 'SHA256_JCS_V2';

export class ContractHashError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_CONTRACT'
      | 'NUMBER_OUT_OF_RANGE'
      | 'DUPLICATE_KEY'
      | 'PARSE_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'ContractHashError';
  }
}

type MemberKind = 'string' | 'string_array' | 'u32' | 'any' | 'enforcement' | 'model_constraints';

// Member tables are Maps so that a lookup never reaches Object.prototype:
// names such as `__proto__` or `constructor` are unknown members, as in the
// Rust implementation (serde `deny_unknown_fields`).
const REQUIRED: ReadonlyMap<string, MemberKind> = new Map([
  ['purpose_code', 'string'],
  ['output_schema_id', 'string'],
  ['output_schema', 'any'],
  ['participants', 'string_array'],
  ['prompt_template_hash', 'string'],
]);

const OPTIONAL: ReadonlyMap<string, MemberKind> = new Map([
  ['entropy_budget_bits', 'u32'],
  ['timing_class', 'string'],
  ['metadata', 'any'],
  ['model_profile_id', 'string'],
  ['model_profile_hash', 'string'],
  ['enforcement_policy_hash', 'string'],
  ['output_schema_hash', 'string'],
  ['model_constraints', 'model_constraints'],
  ['max_completion_tokens', 'u32'],
  ['session_ttl_secs', 'u32'],
  ['invite_ttl_secs', 'u32'],
  ['entropy_enforcement', 'enforcement'],
  ['relay_verifying_key_hex', 'string'],
]);

const MODEL_CONSTRAINTS: ReadonlyMap<string, MemberKind> = new Map([
  ['allowed_providers', 'string_array'],
  ['allowed_models', 'string_array'],
  ['min_tier', 'string'],
]);

const ENFORCEMENT_MODES = new Set(['Advisory', 'Gate', 'Strict']);
const U32_MAX = 0xffffffff;

function invalid(msg: string): never {
  throw new ContractHashError('INVALID_CONTRACT', msg);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkMember(
  name: string,
  kind: MemberKind,
  value: unknown,
  path: string,
  lexemes: NumberLexemes | undefined,
): unknown {
  switch (kind) {
    case 'string':
      if (typeof value !== 'string') invalid(`${name} must be a string`);
      return value;
    case 'string_array':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        invalid(`${name} must be an array of strings`);
      }
      return value;
    case 'u32': {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > U32_MAX ||
        Object.is(value, -0)
      ) {
        invalid(`${name} must be an integer in 0..2^32-1`);
      }
      const lexeme = lexemes?.get(path);
      if (lexeme !== undefined && !isLexicalUnsignedInteger(lexeme)) {
        invalid(`${name} must be written as a plain integer`);
      }
      return value;
    }
    case 'enforcement':
      if (typeof value !== 'string' || !ENFORCEMENT_MODES.has(value)) {
        invalid(`${name} must be one of Advisory, Gate, Strict`);
      }
      return value;
    case 'model_constraints': {
      if (!isPlainObject(value)) invalid(`${name} must be an object`);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const sub = MODEL_CONSTRAINTS.get(k);
        if (sub === undefined) invalid(`unknown member ${name}.${k}`);
        if (v === null) continue;
        out[k] = checkMember(`${name}.${k}`, sub, v, `${path}/${k}`, lexemes);
      }
      return out;
    }
    case 'any':
      return value;
  }
}

function normalise(contract: unknown, lexemes?: NumberLexemes): Record<string, unknown> {
  if (!isPlainObject(contract)) invalid('contract must be a JSON object');
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(contract)) {
    const required = REQUIRED.get(name);
    const optional = OPTIONAL.get(name);
    if (required === undefined && optional === undefined) {
      invalid(`unknown member ${name}`);
    }
    if (value === undefined) continue;
    if (value === null) {
      if (optional !== undefined) continue; // null optional = absent
      if (required !== 'any') invalid(`${name} must not be null`);
    }
    const kind: MemberKind = required ?? optional ?? 'any';
    out[name] = checkMember(name, kind, value, `/${name}`, lexemes);
  }
  for (const name of REQUIRED.keys()) {
    if (!Object.hasOwn(out, name)) invalid(`missing member ${name}`);
  }
  try {
    checkV3Profile(out);
  } catch (e) {
    throw toContractError(e);
  }
  return out;
}

function toContractError(e: unknown): ContractHashError {
  if (e instanceof ContractHashError) return e;
  if (e instanceof JcsError) return new ContractHashError(e.code, e.message);
  return new ContractHashError('INVALID_CONTRACT', e instanceof Error ? e.message : String(e));
}

/**
 * Validate a contract and return the normalised object that contract hash v2
 * hashes (null and absent optional members removed).
 */
export function normalizeContractV2(contract: unknown): Record<string, unknown> {
  return normalise(contract);
}

/** Contract hash v2 (lowercase hex) of an already-parsed contract. */
export function computeContractHashV2(contract: unknown): string {
  const normalised = normalise(contract);
  try {
    return sha256Hex(canonicalizeV3(normalised));
  } catch (e) {
    throw toContractError(e);
  }
}

/**
 * Contract hash v2 of contract JSON text. The text is parsed strictly
 * (repeated member names rejected) and integer members must be written as
 * plain integer literals.
 */
export function computeContractHashV2Str(contractJson: string): string {
  let parsed;
  try {
    parsed = parseJsonStrictWithLexemes(contractJson);
  } catch (e) {
    throw toContractError(e);
  }
  const normalised = normalise(parsed.value, parsed.numberLexemes);
  try {
    return sha256Hex(canonicalizeV3(normalised));
  } catch (e) {
    throw toContractError(e);
  }
}

/**
 * Remove envelope members that callers store next to a contract (currently
 * `contract_hash`) before hashing. Contract hash v2 itself rejects them.
 */
export function stripContractEnvelope(contract: unknown): unknown {
  if (!isPlainObject(contract) || !Object.hasOwn(contract, 'contract_hash')) return contract;
  const { contract_hash: _hash, ...rest } = contract;
  return rest;
}
