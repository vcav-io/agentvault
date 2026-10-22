/**
 * Owner-side disclosure budget ledger: schema bounds, per-counterparty and
 * global budgets, rolling window, persistence and file-permission checks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRelayContract, buildRelayContractWithSchemaRef } from 'selkey/contracts';

import {
  EntropyLedgerError,
  chargeLedger,
  chargeOwnDisclosure,
  contractChargeBits,
  ledgerPath,
  remainingBudget,
  schemaUpperBoundBits,
  type EntropyLedgerConfig,
} from '../entropy-ledger.js';
import { handleGetIdentity } from '../tools/getIdentity.js';

const posix = process.platform !== 'win32';
const ENV_KEYS = [
  'SELKEY_WORKDIR',
  'SELKEY_ENTROPY_LEDGER',
  'SELKEY_ENTROPY_BUDGET_PER_COUNTERPARTY_BITS',
  'SELKEY_ENTROPY_BUDGET_GLOBAL_BITS',
  'SELKEY_ENTROPY_BUDGET_WINDOW_SECONDS',
];
let saved: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selkey-ledger-'));
  process.env['SELKEY_WORKDIR'] = tmp;
  process.env['SELKEY_ENTROPY_LEDGER'] = 'enforce';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CONFIG: EntropyLedgerConfig = {
  perCounterpartyBits: 24,
  globalBits: 40,
  windowSeconds: 3600,
};
const T0 = Date.parse('2026-10-22T12:00:00.000Z');

function mediation() {
  return buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
}

describe('schema upper bound', () => {
  it('bounds the bundled MEDIATION and COMPATIBILITY schemas', () => {
    // 5 * 6 * 5 * 3 = 450 values -> 9 bits
    expect(schemaUpperBoundBits(mediation().output_schema)).toBe(9);
    const compat = buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo'])!;
    // Ordered unique arrays: 6 reasons up to 3 -> 1+6+30+120 = 157; 6 up to 2 -> 37.
    // 1 * 4^4 * 3 * 157 * 37 * 4 = 17845248 -> 25 bits
    expect(schemaUpperBoundBits(compat.output_schema)).toBe(25);
  });

  it('counts uniqueItems arrays as ordered selections', () => {
    const reasons = (maxItems: number) => ({
      type: 'array',
      items: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F'] },
      minItems: 0,
      maxItems,
      uniqueItems: true,
    });
    // [A,B] and [B,A] are different released values: 1+6+30+120 = 157 -> 8 bits
    // (unordered counting would give 42 -> 6 bits).
    expect(schemaUpperBoundBits(reasons(3))).toBe(8);
    // 1+6+30 = 37 -> 6 bits (unordered: 22 -> 5 bits).
    expect(schemaUpperBoundBits(reasons(2))).toBe(6);
  });

  it('treats schemas that do not bound the output as unbounded', () => {
    const obj = (props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      type: 'object',
      properties: props,
      required: Object.keys(props),
      additionalProperties: false,
      ...extra,
    });
    expect(schemaUpperBoundBits({})).toBe(Infinity);
    expect(schemaUpperBoundBits(true)).toBe(Infinity);
    expect(schemaUpperBoundBits(obj({ s: { type: 'string' } }))).toBe(Infinity);
    expect(schemaUpperBoundBits(obj({ n: { type: 'number' } }))).toBe(Infinity);
    expect(schemaUpperBoundBits(obj({ e: { enum: ['a'] } }, { additionalProperties: true }))).toBe(
      Infinity,
    );
    expect(schemaUpperBoundBits(obj({ a: { type: 'array', items: { enum: ['x', 'y'] } } }))).toBe(
      Infinity,
    );
    // A self-declared bound annotation is ignored.
    expect(
      schemaUpperBoundBits(obj({ s: { type: 'string', 'x-vcav-entropy-bits-upper-bound': 1 } })),
    ).toBe(Infinity);
  });

  it('counts booleans, bounded integers, consts and optional members', () => {
    expect(
      schemaUpperBoundBits({
        type: 'object',
        properties: {
          b: { type: 'boolean' },
          i: { type: 'integer', minimum: 0, maximum: 7 },
          c: { const: 'x' },
          o: { enum: ['p', 'q', 'r'] },
        },
        required: ['b', 'i', 'c'],
        additionalProperties: false,
      }),
    ).toBe(6); // 2 * 8 * 1 * (3 + 1) = 64
  });
});

describe('contract charge', () => {
  it('charges the larger of the schema bound and the contract budget', () => {
    expect(contractChargeBits(mediation())).toBe(12);
    expect(contractChargeBits({ ...mediation(), entropy_budget_bits: 4 })).toBe(9);
  });

  it('resolves a by-hash contract against the bundled schemas', () => {
    const ref = buildRelayContractWithSchemaRef('MEDIATION', ['alice-demo', 'bob-demo'])!;
    expect(contractChargeBits(ref)).toBe(12);
  });

  it('refuses a contract whose schema cannot be resolved or does not match its hash', () => {
    const ref = buildRelayContractWithSchemaRef('MEDIATION', ['alice-demo', 'bob-demo'], {
      schemaHash: 'f'.repeat(64),
    })!;
    expect(() => contractChargeBits(ref)).toThrow(/could not be resolved/);
    expect(() =>
      contractChargeBits({ ...mediation(), output_schema_hash: 'f'.repeat(64) }),
    ).toThrow(EntropyLedgerError);
    expect(() =>
      contractChargeBits({
        ...mediation(),
        output_schema: { type: 'object', properties: { s: { type: 'string' } } },
        output_schema_hash: undefined,
      }),
    ).toThrow(/does not bound/);
  });
});

describe('ledger budgets', () => {
  const charge = (key: string, counterparty: string, bits: number, now = T0) =>
    chargeLedger({ key, counterparty, bits }, CONFIG, now);

  it('refuses a session that would exceed the per-counterparty budget', () => {
    charge('s1', 'bob', 12);
    charge('s2', 'bob', 12);
    expect(() => charge('s3', 'bob', 12)).toThrow(/counterparty "bob" would be exceeded/);
    try {
      charge('s3', 'bob', 12);
    } catch (err) {
      expect((err as EntropyLedgerError).code).toBe('ENTROPY_BUDGET_EXCEEDED');
    }
  });

  it('caps many distinct counterparties with the global budget', () => {
    charge('s1', 'sybil-1', 12);
    charge('s2', 'sybil-2', 12);
    charge('s3', 'sybil-3', 12);
    expect(() => charge('s4', 'sybil-4', 12)).toThrow(/Global disclosure budget/);
  });

  it('frees budget once charges leave the rolling window', () => {
    charge('s1', 'bob', 12, T0);
    charge('s2', 'bob', 12, T0 + 1000);
    expect(() => charge('s3', 'bob', 12, T0 + 3_599_000)).toThrow();
    // s1 leaves the window after an hour.
    expect(charge('s3', 'bob', 12, T0 + 3_600_500).charged).toBe(true);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    expect(ledger.entries.map((e: { key: string }) => e.key)).toEqual(['s2', 's3']);
  });

  it('charges each session key once', () => {
    expect(charge('s1', 'bob', 12).charged).toBe(true);
    expect(charge('s1', 'bob', 12).charged).toBe(false);
    expect(remainingBudget(['bob'], T0, ledgerPath()).per_counterparty).toBeDefined();
  });

  it('keeps charges across restarts (state is read from the ledger file)', () => {
    process.env['SELKEY_ENTROPY_BUDGET_PER_COUNTERPARTY_BITS'] = '24';
    chargeOwnDisclosure({ key: 'h1', contract: mediation(), counterparty: 'bob-demo' });
    chargeOwnDisclosure({ key: 'h2', contract: mediation(), counterparty: 'bob-demo' });
    // A fresh process sees the same file.
    const raw = JSON.parse(
      fs.readFileSync(path.join(tmp, '.selkey', 'budget-ledger.json'), 'utf8'),
    );
    expect(raw.entries).toHaveLength(2);
    expect(() =>
      chargeOwnDisclosure({ key: 'h3', contract: mediation(), counterparty: 'bob-demo' }),
    ).toThrow(/would be exceeded/);
  });

  it.skipIf(!posix)('writes the ledger 0600 inside a 0700 .selkey directory', () => {
    charge('s1', 'bob', 1);
    expect(fs.statSync(path.join(tmp, '.selkey')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(ledgerPath()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)('refuses to use a group- or world-writable ledger file', () => {
    charge('s1', 'bob', 1);
    fs.chmodSync(ledgerPath(), 0o666);
    expect(() => charge('s2', 'bob', 1)).toThrow(/ledger is unusable/);
    expect(remainingBudget(['bob'], T0, ledgerPath()).error).toMatch(/unusable/);
  });

  it('refuses to use a malformed ledger file', () => {
    charge('s1', 'bob', 1);
    fs.writeFileSync(ledgerPath(), JSON.stringify({ version: 1, entries: [{ key: 1 }] }), {
      mode: 0o600,
    });
    expect(() => charge('s2', 'bob', 1)).toThrow(/ledger is unusable/);
  });

  it('is a no-op when the ledger is turned off', () => {
    process.env['SELKEY_ENTROPY_LEDGER'] = 'off';
    chargeOwnDisclosure({ key: 'h1', contract: {}, counterparty: undefined });
    expect(fs.existsSync(ledgerPath())).toBe(false);
  });

  it('warns in remaining_budget when the ledger is turned off', () => {
    process.env['SELKEY_ENTROPY_LEDGER'] = 'off';
    const budget = remainingBudget([]);
    expect(budget.enforced).toBe(false);
    expect(budget.warning).toMatch(/disabled/);
  });

  it('serialises concurrent charges with a lock file', () => {
    // A lock held by another writer makes a charge wait, then fail closed.
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${ledgerPath()}.lock`, '999999', { mode: 0o600 });
    const started = Date.now();
    expect(() => charge('locked', 'bob', 1)).toThrow(/busy/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
    fs.unlinkSync(`${ledgerPath()}.lock`);
    expect(charge('unlocked', 'bob', 1).charged).toBe(true);
  }, 10_000);
});

describe('get_identity remaining_budget', () => {
  it('reports global and per-counterparty remaining bits for the window', async () => {
    process.env['SELKEY_ENTROPY_BUDGET_PER_COUNTERPARTY_BITS'] = '100';
    process.env['SELKEY_ENTROPY_BUDGET_GLOBAL_BITS'] = '300';
    chargeOwnDisclosure({ key: 'h1', contract: mediation(), counterparty: 'bob-demo' });
    const result = await handleGetIdentity('alice-demo', [
      { agent_id: 'bob-demo', aliases: [] },
      { agent_id: 'carol-demo', aliases: [] },
    ]);
    expect(result.data?.remaining_budget).toEqual({
      enforced: true,
      window_seconds: 86400,
      global: { limit_bits: 300, used_bits: 12, remaining_bits: 288 },
      per_counterparty: [
        { agent_id: 'bob-demo', limit_bits: 100, used_bits: 12, remaining_bits: 88 },
        { agent_id: 'carol-demo', limit_bits: 100, used_bits: 0, remaining_bits: 100 },
      ],
    });
  });

  it('uses the documented defaults', async () => {
    const result = await handleGetIdentity('alice-demo', []);
    expect(result.data?.remaining_budget?.global?.limit_bits).toBe(512);
    expect(result.data?.remaining_budget?.window_seconds).toBe(86400);
  });
});
