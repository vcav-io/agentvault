/**
 * Owner-side disclosure budget ledger.
 *
 * Before this agent submits its own input to a relay session, the session's
 * disclosure is charged against two rolling-window budgets:
 *
 *   - a per-counterparty budget (keyed by the counterparty's agent_id), and
 *   - a global budget across all counterparties, which bounds what many
 *     distinct counterparty identities can extract together.
 *
 * The charge is computed locally from the contract's output schema (an upper
 * bound on the bits the released output can carry), never from a value the
 * counterparty or the relay asserts. The contract's `entropy_budget_bits`, when
 * present and larger, is charged instead. A charge is recorded before the
 * input is submitted, so sessions that later abort or fail still count.
 *
 * State lives in $SELKEY_WORKDIR/.selkey/budget-ledger.json (0600 in a 0700
 * directory). A ledger file that is group- or world-writable, malformed, or
 * otherwise unreadable stops submissions (fail closed).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildRelayContract, computeOutputSchemaHash, listRelayPurposes } from 'selkey/contracts';
import { resolveNegotiationRegistryPath } from './bespoke-contracts.js';
import { readPrivateJson, selkeyStateDir, writePrivateJson } from './secure-fs.js';

export const DEFAULT_PER_COUNTERPARTY_BITS = 128;
export const DEFAULT_GLOBAL_BITS = 512;
export const DEFAULT_WINDOW_SECONDS = 24 * 60 * 60;

const LEDGER_FILE = 'budget-ledger.json';
const LEDGER_VERSION = 1;

export type EntropyLedgerErrorCode = 'ENTROPY_BUDGET_EXCEEDED' | 'ENTROPY_BOUND_UNAVAILABLE';

export class EntropyLedgerError extends Error {
  readonly code: EntropyLedgerErrorCode;
  constructor(code: EntropyLedgerErrorCode, message: string) {
    super(message);
    this.name = 'EntropyLedgerError';
    this.code = code;
  }
}

export interface EntropyLedgerConfig {
  perCounterpartyBits: number;
  globalBits: number;
  windowSeconds: number;
}

export interface LedgerEntry {
  /** Idempotency key: one charge per local session handle. */
  key: string;
  counterparty: string;
  /**
   * Fingerprint of the counterparty's pinned key, when known. Reserved for
   * keying the per-counterparty budget by pinned identity once agent pins are
   * available; budgets are keyed by agent_id today.
   */
  counterparty_key_fpr?: string;
  purpose?: string;
  bits: number;
  charged_at: string;
}

interface LedgerFile {
  version: number;
  entries: LedgerEntry[];
}

export interface BudgetSnapshot {
  limit_bits: number;
  used_bits: number;
  remaining_bits: number;
}

export interface RemainingBudget {
  enforced: boolean;
  window_seconds?: number;
  global?: BudgetSnapshot;
  per_counterparty?: Array<BudgetSnapshot & { agent_id: string }>;
  error?: string;
}

// ── Configuration ─────────────────────────────────────────────────────────

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new EntropyLedgerError(
      'ENTROPY_BUDGET_EXCEEDED',
      `${name} must be a non-negative integer (got "${raw}")`,
    );
  }
  return Number.parseInt(raw.trim(), 10);
}

/** Returns null when the ledger is disabled (SELKEY_ENTROPY_LEDGER=off). */
export function ledgerConfigFromEnv(): EntropyLedgerConfig | null {
  const mode = (process.env['SELKEY_ENTROPY_LEDGER'] ?? 'enforce').trim().toLowerCase();
  if (mode === 'off') return null;
  if (mode !== 'enforce') {
    throw new EntropyLedgerError(
      'ENTROPY_BUDGET_EXCEEDED',
      `SELKEY_ENTROPY_LEDGER must be "enforce" or "off" (got "${mode}")`,
    );
  }
  const windowSeconds = parsePositiveInt(
    'SELKEY_ENTROPY_BUDGET_WINDOW_SECONDS',
    DEFAULT_WINDOW_SECONDS,
  );
  if (windowSeconds < 1) {
    throw new EntropyLedgerError(
      'ENTROPY_BUDGET_EXCEEDED',
      'SELKEY_ENTROPY_BUDGET_WINDOW_SECONDS must be at least 1',
    );
  }
  return {
    perCounterpartyBits: parsePositiveInt(
      'SELKEY_ENTROPY_BUDGET_PER_COUNTERPARTY_BITS',
      DEFAULT_PER_COUNTERPARTY_BITS,
    ),
    globalBits: parsePositiveInt('SELKEY_ENTROPY_BUDGET_GLOBAL_BITS', DEFAULT_GLOBAL_BITS),
    windowSeconds,
  };
}

// ── Schema upper bound ────────────────────────────────────────────────────

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result = (result * (n - k + i)) / i;
  }
  return Math.round(result);
}

/**
 * Number of distinct values an output can take under `schema`, or Infinity
 * when the schema does not bound it. Conservative: anything not understood
 * is treated as unbounded. Self-declared `x-vcav-entropy-bits-upper-bound`
 * annotations are ignored.
 */
export function schemaCardinality(schema: unknown): number {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return Infinity;
  const s = schema as Record<string, unknown>;

  if ('const' in s) return 1;
  if (Array.isArray(s['enum'])) {
    const distinct = new Set(s['enum'].map((v) => JSON.stringify(v)));
    return Math.max(distinct.size, 1);
  }
  for (const combinator of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(s[combinator])) {
      return (s[combinator] as unknown[]).reduce<number>(
        (acc, sub) => acc + schemaCardinality(sub),
        0,
      );
    }
  }
  if ('allOf' in s || 'not' in s || '$ref' in s || 'if' in s) return Infinity;

  switch (s['type']) {
    case 'null':
      return 1;
    case 'boolean':
      return 2;
    case 'integer': {
      const min = typeof s['minimum'] === 'number' ? s['minimum'] : undefined;
      const max = typeof s['maximum'] === 'number' ? s['maximum'] : undefined;
      if (min === undefined || max === undefined) return Infinity;
      const lo = Math.ceil(
        typeof s['exclusiveMinimum'] === 'number' ? Math.max(min, s['exclusiveMinimum'] + 1) : min,
      );
      const hi = Math.floor(
        typeof s['exclusiveMaximum'] === 'number' ? Math.min(max, s['exclusiveMaximum'] - 1) : max,
      );
      return hi >= lo ? hi - lo + 1 : 1;
    }
    case 'array': {
      const maxItems = s['maxItems'];
      if (typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems < 0)
        return Infinity;
      if ('prefixItems' in s || 'contains' in s) return Infinity;
      const minItems =
        typeof s['minItems'] === 'number' && Number.isInteger(s['minItems']) ? s['minItems'] : 0;
      const n = schemaCardinality(s['items']);
      if (!Number.isFinite(n)) return maxItems === 0 ? 1 : Infinity;
      let count = 0;
      for (let k = minItems; k <= maxItems; k++) {
        count += s['uniqueItems'] === true ? binomial(n, k) : Math.pow(n, k);
      }
      return Math.max(count, 1);
    }
    case 'object': {
      if (s['additionalProperties'] !== false) return Infinity;
      if ('patternProperties' in s) return Infinity;
      const props = s['properties'];
      if (props === undefined) return 1;
      if (!props || typeof props !== 'object' || Array.isArray(props)) return Infinity;
      const required = new Set(Array.isArray(s['required']) ? (s['required'] as unknown[]) : []);
      let product = 1;
      for (const [name, sub] of Object.entries(props as Record<string, unknown>)) {
        const c = schemaCardinality(sub);
        product *= required.has(name) ? c : c + 1;
      }
      return product;
    }
    default:
      return Infinity;
  }
}

/** Upper bound on the bits an output under `schema` can carry (Infinity if unbounded). */
export function schemaUpperBoundBits(schema: unknown): number {
  const card = schemaCardinality(schema);
  if (!Number.isFinite(card)) return Infinity;
  if (card <= 1) return 0;
  // Small epsilon guards against log2 rounding for exact powers of two.
  return Math.ceil(Math.log2(card) - 1e-9);
}

function hasInlineSchema(schema: unknown): boolean {
  return (
    !!schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    Object.keys(schema as Record<string, unknown>).length > 0
  );
}

function bundledSchemaByHash(hash: string): object | undefined {
  for (const purpose of listRelayPurposes()) {
    const template = buildRelayContract(purpose, ['ledger-a', 'ledger-b']);
    if (template && hasInlineSchema(template.output_schema)) {
      if (computeOutputSchemaHash(template.output_schema) === hash) return template.output_schema;
    }
  }
  return undefined;
}

function registrySchemaByHash(hash: string): object | undefined {
  const registryPath = resolveNegotiationRegistryPath();
  if (!registryPath) return undefined;
  const file = path.join(registryPath, 'schemas', `sha256-${hash}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  // Only trust the file if it is the schema the hash names.
  return computeOutputSchemaHash(parsed as object) === hash ? (parsed as object) : undefined;
}

/**
 * Locally resolve the contract's output schema: inline, or by
 * `output_schema_hash` from the bundled templates or the local registry.
 */
export function resolveContractOutputSchema(contract: unknown): object | undefined {
  if (!contract || typeof contract !== 'object') return undefined;
  const c = contract as Record<string, unknown>;
  const declaredHash =
    typeof c['output_schema_hash'] === 'string' ? c['output_schema_hash'] : undefined;
  if (hasInlineSchema(c['output_schema'])) {
    const inline = c['output_schema'] as object;
    if (declaredHash && computeOutputSchemaHash(inline) !== declaredHash) return undefined;
    return inline;
  }
  if (!declaredHash || !/^[0-9a-f]{64}$/.test(declaredHash)) return undefined;
  return bundledSchemaByHash(declaredHash) ?? registrySchemaByHash(declaredHash);
}

/**
 * Bits charged for a session under `contract`: the schema upper bound, or the
 * contract's entropy_budget_bits if that is larger. Throws when the schema
 * cannot be resolved locally or does not bound the output.
 */
export function contractChargeBits(contract: unknown): number {
  let schema: object | undefined;
  try {
    schema = resolveContractOutputSchema(contract);
  } catch {
    schema = undefined;
  }
  if (!schema) {
    throw new EntropyLedgerError(
      'ENTROPY_BOUND_UNAVAILABLE',
      'Cannot compute a disclosure bound for this contract: its output schema could not be resolved locally. Input was not submitted.',
    );
  }
  const bits = schemaUpperBoundBits(schema);
  if (!Number.isFinite(bits)) {
    throw new EntropyLedgerError(
      'ENTROPY_BOUND_UNAVAILABLE',
      'The contract output schema does not bound the released output (needs enums, bounded integers, maxItems and additionalProperties: false). Input was not submitted.',
    );
  }
  const declared = (contract as Record<string, unknown>)['entropy_budget_bits'];
  return typeof declared === 'number' && Number.isFinite(declared) && declared > bits
    ? Math.ceil(declared)
    : bits;
}

// ── Ledger ────────────────────────────────────────────────────────────────

export function ledgerPath(): string {
  return path.join(selkeyStateDir(), LEDGER_FILE);
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['key'] === 'string' &&
    typeof e['counterparty'] === 'string' &&
    typeof e['bits'] === 'number' &&
    Number.isFinite(e['bits']) &&
    e['bits'] >= 0 &&
    typeof e['charged_at'] === 'string' &&
    !Number.isNaN(Date.parse(e['charged_at'])) &&
    (e['counterparty_key_fpr'] === undefined || typeof e['counterparty_key_fpr'] === 'string') &&
    (e['purpose'] === undefined || typeof e['purpose'] === 'string')
  );
}

function loadLedger(filePath: string): LedgerFile {
  const raw = readPrivateJson(filePath);
  if (raw === undefined) return { version: LEDGER_VERSION, entries: [] };
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as Record<string, unknown>)['version'] !== LEDGER_VERSION ||
    !Array.isArray((raw as Record<string, unknown>)['entries']) ||
    !((raw as Record<string, unknown>)['entries'] as unknown[]).every(isLedgerEntry)
  ) {
    throw new Error(`${filePath} is malformed`);
  }
  return raw as LedgerFile;
}

function inWindow(entries: LedgerEntry[], nowMs: number, windowSeconds: number): LedgerEntry[] {
  const cutoff = nowMs - windowSeconds * 1000;
  return entries.filter((e) => Date.parse(e.charged_at) > cutoff);
}

function sumBits(entries: LedgerEntry[]): number {
  return entries.reduce((acc, e) => acc + e.bits, 0);
}

function snapshot(limit: number, used: number): BudgetSnapshot {
  return { limit_bits: limit, used_bits: used, remaining_bits: Math.max(limit - used, 0) };
}

export interface ChargeParams {
  key: string;
  counterparty: string;
  counterpartyKeyFpr?: string;
  purpose?: string;
  bits: number;
}

/**
 * Record a charge, or throw if it would exceed either budget. Idempotent per
 * `key`: a key already charged in the current window is not charged again.
 */
export function chargeLedger(
  params: ChargeParams,
  config: EntropyLedgerConfig,
  nowMs: number = Date.now(),
  filePath: string = ledgerPath(),
): { charged: boolean; entry: LedgerEntry } {
  let ledger: LedgerFile;
  try {
    ledger = loadLedger(filePath);
  } catch (err) {
    throw new EntropyLedgerError(
      'ENTROPY_BUDGET_EXCEEDED',
      `Disclosure budget ledger is unusable (${err instanceof Error ? err.message : String(err)}). Input was not submitted.`,
    );
  }
  const live = inWindow(ledger.entries, nowMs, config.windowSeconds);
  const existing = live.find((e) => e.key === params.key);
  if (existing) return { charged: false, entry: existing };

  const globalUsed = sumBits(live);
  const counterpartyUsed = sumBits(live.filter((e) => e.counterparty === params.counterparty));
  if (counterpartyUsed + params.bits > config.perCounterpartyBits) {
    throw new EntropyLedgerError(
      'ENTROPY_BUDGET_EXCEEDED',
      `Disclosure budget for counterparty "${params.counterparty}" would be exceeded: ` +
        `${counterpartyUsed} of ${config.perCounterpartyBits} bits used in the current window, this session needs ${params.bits}. Input was not submitted.`,
    );
  }
  if (globalUsed + params.bits > config.globalBits) {
    throw new EntropyLedgerError(
      'ENTROPY_BUDGET_EXCEEDED',
      `Global disclosure budget would be exceeded: ${globalUsed} of ${config.globalBits} bits used in the current window, ` +
        `this session needs ${params.bits}. Input was not submitted.`,
    );
  }

  const entry: LedgerEntry = {
    key: params.key,
    counterparty: params.counterparty,
    ...(params.counterpartyKeyFpr ? { counterparty_key_fpr: params.counterpartyKeyFpr } : {}),
    ...(params.purpose ? { purpose: params.purpose } : {}),
    bits: params.bits,
    charged_at: new Date(nowMs).toISOString(),
  };
  writePrivateJson(filePath, { version: LEDGER_VERSION, entries: [...live, entry] });
  return { charged: true, entry };
}

/**
 * Charge this agent's disclosure for one session before its input is
 * submitted. No-op when the ledger is disabled. Throws EntropyLedgerError
 * (fail closed) otherwise.
 */
export function chargeOwnDisclosure(params: {
  key: string;
  contract: unknown;
  counterparty: string | undefined;
  counterpartyKeyFpr?: string;
  purpose?: string;
}): void {
  const config = ledgerConfigFromEnv();
  if (!config) return;
  if (!params.counterparty) {
    throw new EntropyLedgerError(
      'ENTROPY_BOUND_UNAVAILABLE',
      'Cannot determine the counterparty to charge the disclosure budget to. Input was not submitted.',
    );
  }
  const bits = contractChargeBits(params.contract);
  chargeLedger(
    {
      key: params.key,
      counterparty: params.counterparty,
      counterpartyKeyFpr: params.counterpartyKeyFpr,
      purpose: params.purpose,
      bits,
    },
    config,
  );
}

/** Remaining budgets for get_identity. Never throws. */
export function remainingBudget(
  counterparties: string[],
  nowMs: number = Date.now(),
  filePath: string = ledgerPath(),
): RemainingBudget {
  let config: EntropyLedgerConfig | null;
  try {
    config = ledgerConfigFromEnv();
  } catch (err) {
    return { enforced: true, error: err instanceof Error ? err.message : String(err) };
  }
  if (!config) return { enforced: false };
  let ledger: LedgerFile;
  try {
    ledger = loadLedger(filePath);
  } catch (err) {
    return {
      enforced: true,
      window_seconds: config.windowSeconds,
      error: `Disclosure budget ledger is unusable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const live = inWindow(ledger.entries, nowMs, config.windowSeconds);
  const names = [...new Set([...counterparties, ...live.map((e) => e.counterparty)])].sort();
  return {
    enforced: true,
    window_seconds: config.windowSeconds,
    global: snapshot(config.globalBits, sumBits(live)),
    per_counterparty: names.map((agent_id) => ({
      agent_id,
      ...snapshot(
        config.perCounterpartyBits,
        sumBits(live.filter((e) => e.counterparty === agent_id)),
      ),
    })),
  };
}
