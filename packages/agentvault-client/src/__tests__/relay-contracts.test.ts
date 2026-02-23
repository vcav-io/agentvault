/**
 * Tests for relay contract templates and hashing.
 *
 * Golden hash vectors validate parity with the Rust relay's
 * compute_contract_hash (RFC 8785 JCS + SHA-256).
 */

import { describe, it, expect } from 'vitest';
import {
  buildRelayContract,
  listRelayPurposes,
  computeRelayContractHash,
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
    expect(contract!.timing_class).toBeNull();
    expect(contract!.metadata).toEqual({ scenario: 'cofounder-mediation', version: '3' });
  });

  it('builds a COMPATIBILITY contract with correct shape', () => {
    const contract = buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo']);
    expect(contract).toBeDefined();
    expect(contract!.purpose_code).toBe('COMPATIBILITY');
    expect(contract!.output_schema_id).toBe('vcav_e_compatibility_signal_v1');
    expect(contract!.entropy_budget_bits).toBe(8);
  });

  it('returns undefined for unknown purpose', () => {
    expect(buildRelayContract('UNKNOWN', ['a', 'b'])).toBeUndefined();
  });

  it('rejects empty participant ID', () => {
    expect(() => buildRelayContract('MEDIATION', ['', 'bob'])).toThrow('must not be empty');
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
  // Verified against live Rust relay (POST /sessions → contract_hash).
  // If these fail, TypeScript JCS canonicalization has diverged from Rust.
  //
  // To regenerate: POST the contract JSON to the relay's /sessions endpoint,
  // record contract_hash from the response.

  it('mediation contract hash matches Rust relay', () => {
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const hash = computeRelayContractHash(contract);
    expect(hash).toBe('4389e049a6ffd803cd8ac607a1e8ad3b0b98ae6291da904593e8cc46e0565b52');
  });

  it('compatibility contract hash matches Rust relay', () => {
    const contract = buildRelayContract('COMPATIBILITY', ['alice-demo', 'bob-demo'])!;
    const hash = computeRelayContractHash(contract);
    expect(hash).toBe('4714b94c6cb1d9c8f4358c7376d248eed5dc88b78de87c3b1980ad70e7a7347d');
  });
});
