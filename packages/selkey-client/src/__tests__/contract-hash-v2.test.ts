/**
 * Contract hash v2 accepts exactly the contract member set. Names that exist
 * on Object.prototype (`__proto__`, `constructor`, ...) are unknown members
 * like any other, matching the Rust implementation, which rejects every
 * member outside the set. Inside `output_schema` and `metadata` they are
 * ordinary member names and are hashed.
 */

import { describe, expect, it } from 'vitest';
import {
  ContractHashError,
  computeContractHashV2,
  computeContractHashV2Str,
  normalizeContractV2,
} from '../contract-hash-v2.js';
import { canonicalizeV3, parseJsonStrict } from '../jcs-v3.js';

const BASE = {
  purpose_code: 'MEDIATION',
  output_schema_id: 'urn:vcav:schema:mediation.e18.v1',
  output_schema: {},
  participants: ['agent-alice', 'agent-bob'],
  prompt_template_hash: 'a3f2f8f5ed1b68f2ba0c2fb0216f49f23eb2e8285e4a6575d72a4f75f2ef7e3c',
};

/** Contract JSON text with `extra` spliced in as raw members. */
function contractText(extra: string, base: Record<string, unknown> = BASE): string {
  return `${JSON.stringify(base).slice(0, -1)},${extra}}`;
}

const RESERVED_NAMES = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  'valueOf',
  '__defineGetter__',
];

describe('contract hash v2 member names', () => {
  for (const name of RESERVED_NAMES) {
    it(`rejects a top-level ${name} member in contract text`, () => {
      const text = contractText(`${JSON.stringify(name)}:{"x":1}`);
      expect(() => computeContractHashV2Str(text)).toThrow(ContractHashError);
    });

    it(`rejects a top-level ${name} member in a parsed contract`, () => {
      const parsed = JSON.parse(contractText(`${JSON.stringify(name)}:"x"`));
      expect(() => computeContractHashV2(parsed)).toThrow(/unknown member/);
      expect(() => normalizeContractV2(parsed)).toThrow(/unknown member/);
    });

    it(`rejects a ${name} member inside model_constraints`, () => {
      const text = contractText(`"model_constraints":{"allowed_models":[],${JSON.stringify(name)}:[]}`);
      expect(() => computeContractHashV2Str(text)).toThrow(/unknown member model_constraints/);
    });
  }

  it('rejects a top-level __proto__ member whose value is null', () => {
    expect(() => computeContractHashV2Str(contractText('"__proto__":null'))).toThrow(ContractHashError);
  });

  it('hashes __proto__ inside metadata as an ordinary member', () => {
    const withKey = contractText('"metadata":{"__proto__":{"a":1}}');
    const withoutKey = contractText('"metadata":{}');
    expect(computeContractHashV2Str(withKey)).not.toBe(computeContractHashV2Str(withoutKey));
    expect(canonicalizeV3(normalizeContractV2(parseJsonStrict(withKey)))).toContain(
      '"metadata":{"__proto__":{"a":1}}',
    );
  });

  it('still requires every required member', () => {
    const { prompt_template_hash: _omit, ...rest } = BASE;
    expect(() => computeContractHashV2(rest)).toThrow(/missing member prompt_template_hash/);
  });
});
