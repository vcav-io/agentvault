/**
 * Tests for relay contract templates and hashing.
 *
 * Golden hash vectors validate parity with the Rust relay's
 * compute_contract_hash (RFC 8785 JCS + SHA-256).
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  buildRelayContract,
  buildRelayContractWithSchemaRef,
  listRelayPurposes,
  computeRelayContractHash,
  computeOutputSchemaHash,
} from '../relay-contracts.js';

describe('listRelayPurposes', () => {
  it('returns available purpose codes', () => {
    const purposes = listRelayPurposes();
    expect(purposes).toContain('MEDIATION');
    expect(purposes).toContain('COMPATIBILITY');
    expect(purposes.length).toBe(2);
  });
});

describe('buildRelayContract', () => {
  it('builds a MEDIATION contract with correct shape', () => {
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo']);
    expect(contract).toBeDefined();
    expect(contract!.purpose_code).toBe('MEDIATION');
    expect(contract!.output_schema_id).toBe('vcav_e_mediation_signal_v2');
    expect(contract!.participants).toEqual(['alice-demo', 'bob-demo']);
    expect(contract!.prompt_template_hash).toBe(
      'bc4fdec512a08e5fd46f57a5f07d3ea6b2e0cf68f9e8f7cd4ba3d16d10bc36f2',
    );
    expect(contract!.entropy_budget_bits).toBe(12);
    expect(contract!.model_profile_id).toBe('api-claude-sonnet-v1');
    expect(contract!.model_profile_hash).toBe(
      '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
    );
    expect(contract!.timing_class).toBeNull();
    expect(contract!.metadata).toEqual({ scenario: 'cofounder-mediation', version: '3' });
  });

  it('builds a COMPATIBILITY contract with correct shape', () => {
    const contract = buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo']);
    expect(contract).toBeDefined();
    expect(contract!.purpose_code).toBe('COMPATIBILITY');
    expect(contract!.output_schema_id).toBe('vcav_e_compatibility_signal_v2');
    expect(contract!.entropy_budget_bits).toBe(32);
    expect(contract!.output_schema).toHaveProperty('properties.schema_version');
    expect(contract!.output_schema).toHaveProperty('properties.thesis_fit');
    expect(contract!.output_schema).toHaveProperty('properties.size_fit');
    expect(contract!.output_schema).toHaveProperty('properties.stage_fit');
    expect(contract!.output_schema).toHaveProperty('properties.confidence');
    expect(contract!.output_schema).toHaveProperty('properties.primary_reasons');
    expect(contract!.output_schema).toHaveProperty('properties.blocking_reasons');
    expect(contract!.output_schema).toHaveProperty('properties.next_step');
    expect(contract!.output_schema).not.toHaveProperty('properties.overlap_summary');
  });

  it('returns undefined for unknown purpose', () => {
    expect(buildRelayContract('UNKNOWN', ['a', 'b'])).toBeUndefined();
  });

  it('binds the selected model profile hash when overriding the template profile', () => {
    const contract = buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo'], 'api-gpt41mini-v1');
    expect(contract!.model_profile_id).toBe('api-gpt41mini-v1');
    expect(contract!.model_profile_hash).toBe(
      '2d7127751173337c405be23a99219db2179024c3447ff6f05b0de3cfdd741e96',
    );
  });

  it('rejects unknown model profile overrides', () => {
    expect(() =>
      buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo'], 'api-unknown-v1'),
    ).toThrow('Unknown model profile');
  });

  it('rejects empty participant ID', () => {
    expect(() => buildRelayContract('MEDIATION', ['', 'bob'])).toThrow('must not be empty');
  });

  it('rejects non-bilateral participant lists', () => {
    expect(() => buildRelayContract('MEDIATION', ['alice'])).toThrow('exactly 2 participants');
    expect(() => buildRelayContract('MEDIATION', ['alice', 'bob', 'charlie'])).toThrow(
      'exactly 2 participants',
    );
  });

  it('rejects participant ID with whitespace', () => {
    expect(() => buildRelayContract('MEDIATION', ['alice demo', 'bob'])).toThrow('whitespace');
  });

  it('rejects participant ID with tab', () => {
    expect(() => buildRelayContract('MEDIATION', ['alice\tdemo', 'bob'])).toThrow('whitespace');
  });

  it('rejects participant ID with newline', () => {
    expect(() => buildRelayContract('MEDIATION', ['alice\n', 'bob'])).toThrow('whitespace');
  });

  it('does not share state between calls', () => {
    const c1 = buildRelayContract('MEDIATION', ['a', 'b']);
    const c2 = buildRelayContract('MEDIATION', ['x', 'y']);
    expect(c1!.participants).toEqual(['a', 'b']);
    expect(c2!.participants).toEqual(['x', 'y']);
  });
});

describe('computeRelayContractHash', () => {
  it('is deterministic', () => {
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const h1 = computeRelayContractHash(contract);
    const h2 = computeRelayContractHash(contract);
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
  });

  it('produces different hash for different participants', () => {
    const c1 = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const c2 = buildRelayContract('MEDIATION', ['bob-demo', 'alice-demo'])!;
    const h1 = computeRelayContractHash(c1);
    const h2 = computeRelayContractHash(c2);
    expect(h1).not.toBe(h2);
  });

  it('produces different hash for different purposes', () => {
    const c1 = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const c2 = buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo'])!;
    const h1 = computeRelayContractHash(c1);
    const h2 = computeRelayContractHash(c2);
    expect(h1).not.toBe(h2);
  });

  it('produces a valid hex string', () => {
    const contract = buildRelayContract('MEDIATION', ['a', 'b'])!;
    const hash = computeRelayContractHash(contract);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computeOutputSchemaHash', () => {
  it('is deterministic', () => {
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const schema = contract.output_schema;
    const h1 = computeOutputSchemaHash(schema);
    const h2 = computeOutputSchemaHash(schema);
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
  });

  it('different schemas produce different hashes', () => {
    const mediation = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const compatibility = buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo'])!;
    const h1 = computeOutputSchemaHash(mediation.output_schema);
    const h2 = computeOutputSchemaHash(compatibility.output_schema);
    expect(h1).not.toBe(h2);
  });

  it('cross-language parity with Rust relay', () => {
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const hash = computeOutputSchemaHash(contract.output_schema);
    // Verified against Rust compute_output_schema_hash (JCS + SHA-256).
    // If this fails, TS/Rust JCS canonicalization has diverged.
    expect(hash).toBe('0d25ea011d60a30156796b7e510caa804068bd4c01faa2f637def7dd07d5b3f6');
  });
});

/**
 * Golden hash vectors — these fail if JCS canonicalization diverges
 * from the Rust relay. Generate fresh vectors by curling the relay:
 *
 *   curl -X POST http://relay/sessions -d '{"contract": ...}'
 *   → response.contract_hash
 *
 * Or by running the Rust relay tests.
 */
describe('golden hash vectors (cross-language parity)', () => {
  // Golden hashes include v2 contract fields (enforcement_policy_hash,
  // entropy_enforcement, output_schema_hash). Must re-verify against live
  // Rust relay after template changes (POST /sessions → contract_hash).
  //
  // To regenerate: POST the contract JSON to the relay's /sessions endpoint,
  // record contract_hash from the response.

  it('mediation contract hash matches Rust relay', () => {
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const hash = computeRelayContractHash(contract);
    expect(hash).toBe('945c35e38865653c9edbb976fb8c55a6d6715e91df9dd3eaf06a29470bb23622');
  });

  it('compatibility contract hash matches Rust relay', () => {
    const contract = buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo'])!;
    const hash = computeRelayContractHash(contract);
    expect(hash).toBe('9b763505b3ce2569b064a05d42abce7242d377be410ad16b57ae3ffc04e9c4fd');
  });
});

describe('bundled profile hashes', () => {
  it('stay in sync with the relay model profile lockfile', () => {
    const mediation = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const compatibility = buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo'])!;
    const lockfilePath = new URL(
      '../../../agentvault-relay/prompt_programs/model_profiles.lock',
      import.meta.url,
    );
    const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8')) as Record<string, string>;

    expect(mediation.model_profile_hash).toBe(lockfile[mediation.model_profile_id!]);
    expect(compatibility.model_profile_hash).toBe(lockfile[compatibility.model_profile_id!]);

    expect(
      buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo'], 'api-gpt5-v1')!
        .model_profile_hash,
    ).toBe(lockfile['api-gpt5-v1']);
    expect(
      buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo'], 'api-gpt41mini-v1')!
        .model_profile_hash,
    ).toBe(lockfile['api-gpt41mini-v1']);
    expect(
      buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'], 'api-gemini3flash-v1')!
        .model_profile_hash,
    ).toBe(lockfile['api-gemini3flash-v1']);
    expect(
      buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'], 'api-gemini3flash-lite-v1')!
        .model_profile_hash,
    ).toBe(lockfile['api-gemini3flash-lite-v1']);
  });
});

describe('buildRelayContractWithSchemaRef', () => {
  it('produces contract with output_schema_hash set', () => {
    const contract = buildRelayContractWithSchemaRef('MEDIATION', ['alice', 'bob']);
    expect(contract).toBeDefined();
    expect(contract!.output_schema_hash).toBeDefined();
    expect(contract!.output_schema_hash!.length).toBe(64);
  });

  it('output_schema has no properties key (stub)', () => {
    const contract = buildRelayContractWithSchemaRef('MEDIATION', ['alice', 'bob']);
    expect(contract).toBeDefined();
    expect(contract!.output_schema).toEqual({});
    expect(contract!.output_schema).not.toHaveProperty('properties');
  });

  it('hash matches the full schema content hash', () => {
    const fullContract = buildRelayContract('MEDIATION', ['alice', 'bob'])!;
    const refContract = buildRelayContractWithSchemaRef('MEDIATION', ['alice', 'bob'])!;
    const fullSchemaHash = computeOutputSchemaHash(fullContract.output_schema);
    expect(refContract.output_schema_hash).toBe(fullSchemaHash);
  });

  it('returns undefined for unknown purpose', () => {
    expect(buildRelayContractWithSchemaRef('UNKNOWN', ['a', 'b'])).toBeUndefined();
  });

  it('accepts custom schemaHash override', () => {
    const customHash = 'f'.repeat(64);
    const contract = buildRelayContractWithSchemaRef('MEDIATION', ['a', 'b'], {
      schemaHash: customHash,
    });
    expect(contract!.output_schema_hash).toBe(customHash);
  });

  it('accepts custom policyHash override', () => {
    const customPolicy = 'e'.repeat(64);
    const contract = buildRelayContractWithSchemaRef('MEDIATION', ['a', 'b'], {
      policyHash: customPolicy,
    });
    expect(contract!.enforcement_policy_hash).toBe(customPolicy);
  });

  it('preserves template enforcement_policy_hash when no policyHash override', () => {
    const fullContract = buildRelayContract('MEDIATION', ['a', 'b'])!;
    const refContract = buildRelayContractWithSchemaRef('MEDIATION', ['a', 'b'])!;
    expect(refContract.enforcement_policy_hash).toBe(fullContract.enforcement_policy_hash);
  });

  it('rejects non-bilateral participant lists', () => {
    expect(() => buildRelayContractWithSchemaRef('MEDIATION', ['alice'])).toThrow(
      'exactly 2 participants',
    );
  });
});

describe('RelayContract type surface', () => {
  it('accepts min_tier and relay_verifying_key_hex fields', () => {
    const contract = buildRelayContract('MEDIATION', ['alice', 'bob'])!;
    contract.model_constraints = {
      allowed_providers: ['anthropic'],
      allowed_models: ['claude-sonnet-*'],
      min_tier: 'mid',
    };
    contract.relay_verifying_key_hex = 'ab'.repeat(32);

    expect(contract.model_constraints.min_tier).toBe('mid');
    expect(contract.relay_verifying_key_hex).toBe('ab'.repeat(32));
  });
});
