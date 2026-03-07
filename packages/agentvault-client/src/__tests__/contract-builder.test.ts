/**
 * Tests for the contract builder module.
 *
 * Covers registry index loading (via mocked data), reference resolution,
 * compatibility validation, deprecated artefact handling, contract hash
 * computation, and error cases.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createRegistryIndex,
  buildContract,
} from '../contract-builder.js';
import type {
  ArtefactKind,
  ArtefactEntry,
  ContractOptions,
} from '../contract-builder.js';
import { computeRelayContractHash } from '../relay-contracts.js';

// ---------------------------------------------------------------------------
// Helpers: build an in-memory registry index for testing
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ArtefactEntry> = {}): ArtefactEntry {
  return {
    id: 'test-artefact-v1',
    version: '1.0.0',
    description: 'Test artefact',
    status: 'active',
    published_at: '2026-03-07',
    compatibility: { safety_class: 'SAFE' },
    ...overrides,
  };
}

function buildTestIndexes(overrides?: {
  schemaEntry?: Partial<ArtefactEntry>;
  policyEntry?: Partial<ArtefactEntry>;
  profileEntry?: Partial<ArtefactEntry>;
  programEntry?: Partial<ArtefactEntry>;
  schemaSafetyClass?: 'SAFE' | 'RICH';
  policySafetyClass?: 'SAFE' | 'RICH';
  extraSchemaArtefacts?: Record<string, ArtefactEntry>;
  extraSchemaAliases?: Record<string, string>;
  extraSchemaChannels?: Record<string, string>;
}) {
  const schemaDigest = 'sha256:' + '0d25ea01'.padEnd(64, '0');
  const policyDigest = 'sha256:' + 'b977379e'.padEnd(64, '0');
  const profileDigest = 'sha256:' + '0892ed75'.padEnd(64, '0');
  const programDigest = 'sha256:' + 'bc4fdec5'.padEnd(64, '0');

  const indexes = new Map<ArtefactKind, {
    version: string;
    kind: string;
    artefacts: Record<string, ArtefactEntry>;
    aliases: Record<string, string>;
    channels: Record<string, string>;
  }>();

  indexes.set('schema', {
    version: '1.0.0',
    kind: 'schema',
    artefacts: {
      [schemaDigest]: makeEntry({
        id: 'vcav_e_mediation_signal_v2',
        description: 'Mediation signal schema',
        compatibility: {
          safety_class: overrides?.schemaSafetyClass ?? overrides?.schemaEntry?.compatibility?.safety_class ?? 'SAFE',
        },
        ...overrides?.schemaEntry,
      }),
      ...overrides?.extraSchemaArtefacts,
    },
    aliases: {
      'vcav_e_mediation_signal_v2': schemaDigest,
      ...overrides?.extraSchemaAliases,
    },
    channels: {
      'vcav_e_mediation_signal@latest': schemaDigest,
      ...overrides?.extraSchemaChannels,
    },
  });

  indexes.set('policy', {
    version: '1.0.0',
    kind: 'policy',
    artefacts: {
      [policyDigest]: makeEntry({
        id: 'compatibility_safe_v1',
        description: 'Default safe enforcement policy',
        compatibility: {
          safety_class: overrides?.policySafetyClass ?? overrides?.policyEntry?.compatibility?.safety_class ?? 'SAFE',
        },
        ...overrides?.policyEntry,
      }),
    },
    aliases: { 'compatibility_safe_v1': policyDigest },
    channels: { 'default_policy@latest': policyDigest },
  });

  indexes.set('profile', {
    version: '1.0.0',
    kind: 'profile',
    artefacts: {
      [profileDigest]: makeEntry({
        id: 'api-claude-sonnet-v1',
        description: 'Claude Sonnet profile',
        ...overrides?.profileEntry,
      }),
    },
    aliases: { 'api-claude-sonnet-v1': profileDigest },
    channels: {},
  });

  indexes.set('program', {
    version: '1.0.0',
    kind: 'program',
    artefacts: {
      [programDigest]: makeEntry({
        id: 'mediation_system_v1',
        description: 'Mediation prompt program',
        ...overrides?.programEntry,
      }),
    },
    aliases: { 'mediation_system_v1': programDigest },
    channels: {},
  });

  return { indexes, schemaDigest, policyDigest, profileDigest, programDigest };
}

function buildTestRegistry(overrides?: Parameters<typeof buildTestIndexes>[0]) {
  const { indexes, ...digests } = buildTestIndexes(overrides);
  return { registry: createRegistryIndex(indexes), ...digests };
}

function defaultOptions(overrides: Partial<ContractOptions> = {}): ContractOptions {
  return {
    schema: 'vcav_e_mediation_signal_v2',
    policy: 'compatibility_safe_v1',
    profile: 'api-claude-sonnet-v1',
    program: 'mediation_system_v1',
    purpose_code: 'MEDIATION',
    participants: ['alice', 'bob'],
    entropy_budget_bits: 12,
    entropy_enforcement: 'Advisory',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RegistryIndex.resolve', () => {
  it('resolves by direct digest', () => {
    const { registry, schemaDigest } = buildTestRegistry();
    const result = registry.resolve('schema', schemaDigest);
    expect(result.digest).toBe(schemaDigest);
    expect(result.entry.id).toBe('vcav_e_mediation_signal_v2');
  });

  it('resolves by alias', () => {
    const { registry, schemaDigest } = buildTestRegistry();
    const result = registry.resolve('schema', 'vcav_e_mediation_signal_v2');
    expect(result.digest).toBe(schemaDigest);
    expect(result.entry.id).toBe('vcav_e_mediation_signal_v2');
  });

  it('resolves by channel', () => {
    const { registry, schemaDigest } = buildTestRegistry();
    const result = registry.resolve('schema', 'vcav_e_mediation_signal@latest');
    expect(result.digest).toBe(schemaDigest);
  });

  it('throws for unknown digest', () => {
    const { registry } = buildTestRegistry();
    expect(() => registry.resolve('schema', 'sha256:' + 'f'.repeat(64))).toThrow(
      'Digest not found',
    );
  });

  it('throws for unknown alias', () => {
    const { registry } = buildTestRegistry();
    expect(() => registry.resolve('schema', 'nonexistent_alias')).toThrow(
      'not found in schema index',
    );
  });

  it('throws for unknown kind', () => {
    const { registry } = buildTestRegistry();
    expect(() => registry.resolve('widget' as ArtefactKind, 'anything')).toThrow(
      'Unknown artefact kind',
    );
  });
});

describe('RegistryIndex.listByKind', () => {
  it('lists all artefacts of a kind', () => {
    const { registry } = buildTestRegistry();
    const schemas = registry.listByKind('schema');
    expect(schemas.length).toBe(1);
    expect(schemas[0].id).toBe('vcav_e_mediation_signal_v2');
  });

  it('throws for unknown kind', () => {
    const { registry } = buildTestRegistry();
    expect(() => registry.listByKind('widget' as ArtefactKind)).toThrow(
      'Unknown artefact kind',
    );
  });
});

describe('RegistryIndex.checkCompatibility', () => {
  it('SAFE schema + SAFE policy = compatible', () => {
    const { registry } = buildTestRegistry({
      schemaSafetyClass: 'SAFE',
      policySafetyClass: 'SAFE',
    });
    const result = registry.checkCompatibility(
      'vcav_e_mediation_signal_v2',
      'compatibility_safe_v1',
    );
    expect(result.compatible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('SAFE schema + RICH policy = compatible', () => {
    const { registry } = buildTestRegistry({
      schemaSafetyClass: 'SAFE',
      policySafetyClass: 'RICH',
    });
    const result = registry.checkCompatibility(
      'vcav_e_mediation_signal_v2',
      'compatibility_safe_v1',
    );
    expect(result.compatible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('RICH schema + RICH policy = compatible', () => {
    const { registry } = buildTestRegistry({
      schemaSafetyClass: 'RICH',
      policySafetyClass: 'RICH',
    });
    const result = registry.checkCompatibility(
      'vcav_e_mediation_signal_v2',
      'compatibility_safe_v1',
    );
    expect(result.compatible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('RICH schema + SAFE policy = incompatible', () => {
    const { registry } = buildTestRegistry({
      schemaSafetyClass: 'RICH',
      policySafetyClass: 'SAFE',
    });
    const result = registry.checkCompatibility(
      'vcav_e_mediation_signal_v2',
      'compatibility_safe_v1',
    );
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain('RICH schema');
    expect(result.reason).toContain('SAFE policy');
  });

  it('missing safety_class = compatible with warning', () => {
    const { registry } = buildTestRegistry({
      schemaEntry: { compatibility: {} },
    });
    const result = registry.checkCompatibility(
      'vcav_e_mediation_signal_v2',
      'compatibility_safe_v1',
    );
    expect(result.compatible).toBe(true);
    expect(result.reason).toContain('lack safety_class');
  });
});

describe('buildContract', () => {
  it('produces a contract with correct fields', () => {
    const { registry, schemaDigest, policyDigest, programDigest } = buildTestRegistry();
    const contract = buildContract(registry, defaultOptions()) as Record<string, unknown>;

    expect(contract['purpose_code']).toBe('MEDIATION');
    expect(contract['output_schema_id']).toBe('vcav_e_mediation_signal_v2');
    expect(contract['output_schema']).toEqual({});
    expect(contract['participants']).toEqual(['alice', 'bob']);
    expect(contract['prompt_template_hash']).toBe(programDigest.slice(7));
    expect(contract['enforcement_policy_hash']).toBe(policyDigest.slice(7));
    expect(contract['output_schema_hash']).toBe(schemaDigest.slice(7));
    expect(contract['model_profile_id']).toBe('api-claude-sonnet-v1');
    expect(contract['entropy_budget_bits']).toBe(12);
    expect(contract['entropy_enforcement']).toBe('Advisory');
    expect(contract['timing_class']).toBeNull();
    expect(contract['metadata']).toBeNull();
  });

  it('computes a deterministic contract_hash', () => {
    const { registry } = buildTestRegistry();
    const c1 = buildContract(registry, defaultOptions()) as Record<string, unknown>;
    const c2 = buildContract(registry, defaultOptions()) as Record<string, unknown>;
    expect(c1['contract_hash']).toBe(c2['contract_hash']);
    expect(typeof c1['contract_hash']).toBe('string');
    expect((c1['contract_hash'] as string).length).toBe(64);
    expect(c1['contract_hash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('contract_hash changes with different participants', () => {
    const { registry } = buildTestRegistry();
    const c1 = buildContract(registry, defaultOptions({ participants: ['alice', 'bob'] }));
    const c2 = buildContract(registry, defaultOptions({ participants: ['bob', 'alice'] }));
    expect((c1 as Record<string, unknown>)['contract_hash']).not.toBe(
      (c2 as Record<string, unknown>)['contract_hash'],
    );
  });

  it('contract_hash is computed excluding contract_hash field', () => {
    const { registry } = buildTestRegistry();
    const contract = buildContract(registry, defaultOptions()) as Record<string, unknown>;
    const hash = contract['contract_hash'] as string;

    // Manually verify: remove contract_hash, JCS, SHA-256
    const { contract_hash: _, ...rest } = contract as Record<string, unknown>;
    const manualHash = computeRelayContractHash(rest);
    expect(hash).toBe(manualHash);
  });

  it('returns a frozen object', () => {
    const { registry } = buildTestRegistry();
    const contract = buildContract(registry, defaultOptions());
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it('omits entropy_enforcement when not provided', () => {
    const { registry } = buildTestRegistry();
    const contract = buildContract(
      registry,
      defaultOptions({ entropy_enforcement: undefined }),
    ) as Record<string, unknown>;
    expect(contract).not.toHaveProperty('entropy_enforcement');
  });

  it('sets entropy_budget_bits to null when not provided', () => {
    const { registry } = buildTestRegistry();
    const contract = buildContract(
      registry,
      defaultOptions({ entropy_budget_bits: undefined }),
    ) as Record<string, unknown>;
    expect(contract['entropy_budget_bits']).toBeNull();
  });
});

describe('buildContract — deprecated artefact handling', () => {
  it('throws for deprecated artefact by default', () => {
    const { registry } = buildTestRegistry({
      schemaEntry: { status: 'deprecated' },
    });
    expect(() => buildContract(registry, defaultOptions())).toThrow('deprecated');
  });

  it('allows deprecated with allowDeprecated: true', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registry } = buildTestRegistry({
      schemaEntry: { status: 'deprecated' },
    });
    const contract = buildContract(
      registry,
      defaultOptions({ allowDeprecated: true }),
    );
    expect(contract).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('deprecated'),
    );
    warnSpy.mockRestore();
  });

  it('allows experimental artefacts without flag', () => {
    const { registry } = buildTestRegistry({
      schemaEntry: { status: 'experimental' },
    });
    const contract = buildContract(registry, defaultOptions());
    expect(contract).toBeDefined();
  });
});

describe('buildContract — compatibility validation', () => {
  it('throws for RICH schema + SAFE policy', () => {
    const { registry } = buildTestRegistry({
      schemaSafetyClass: 'RICH',
      policySafetyClass: 'SAFE',
    });
    expect(() => buildContract(registry, defaultOptions())).toThrow(
      'Compatibility error',
    );
  });

  it('allows SAFE schema + RICH policy', () => {
    const { registry } = buildTestRegistry({
      schemaSafetyClass: 'SAFE',
      policySafetyClass: 'RICH',
    });
    const contract = buildContract(registry, defaultOptions());
    expect(contract).toBeDefined();
  });

  it('warns when safety_class is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registry } = buildTestRegistry({
      schemaEntry: { compatibility: {} },
    });
    const contract = buildContract(registry, defaultOptions());
    expect(contract).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('safety_class'),
    );
    warnSpy.mockRestore();
  });
});

describe('buildContract — error cases', () => {
  it('throws for unknown schema reference', () => {
    const { registry } = buildTestRegistry();
    expect(() =>
      buildContract(registry, defaultOptions({ schema: 'nonexistent' })),
    ).toThrow('not found');
  });

  it('throws for unknown policy reference', () => {
    const { registry } = buildTestRegistry();
    expect(() =>
      buildContract(registry, defaultOptions({ policy: 'nonexistent' })),
    ).toThrow('not found');
  });

  it('throws for unknown profile reference', () => {
    const { registry } = buildTestRegistry();
    expect(() =>
      buildContract(registry, defaultOptions({ profile: 'nonexistent' })),
    ).toThrow('not found');
  });

  it('throws for unknown program reference', () => {
    const { registry } = buildTestRegistry();
    expect(() =>
      buildContract(registry, defaultOptions({ program: 'nonexistent' })),
    ).toThrow('not found');
  });

  it('throws for empty participant ID', () => {
    const { registry } = buildTestRegistry();
    expect(() =>
      buildContract(registry, defaultOptions({ participants: ['', 'bob'] })),
    ).toThrow('must not be empty');
  });

  it('throws for participant ID with whitespace', () => {
    const { registry } = buildTestRegistry();
    expect(() =>
      buildContract(registry, defaultOptions({ participants: ['alice demo', 'bob'] })),
    ).toThrow('whitespace');
  });
});

describe('createRegistryIndex', () => {
  it('creates a working index from in-memory data', () => {
    const { indexes } = buildTestIndexes();
    const registry = createRegistryIndex(indexes);

    const schemas = registry.listByKind('schema');
    expect(schemas.length).toBe(1);
    expect(schemas[0].id).toBe('vcav_e_mediation_signal_v2');
  });
});

describe('resolution order', () => {
  it('digest takes priority over alias with same name', () => {
    // This is a degenerate case — a ref starting with sha256: is always
    // treated as a digest, never as an alias. Verify the behavior.
    const { registry, schemaDigest } = buildTestRegistry();
    const result = registry.resolve('schema', schemaDigest);
    expect(result.digest).toBe(schemaDigest);
  });

  it('alias takes priority over channel', () => {
    // If an alias and a channel have the same name, the alias wins
    // because aliases are checked first.
    const extraDigest = 'sha256:' + 'aa'.repeat(32);
    const { registry } = buildTestRegistry({
      extraSchemaArtefacts: {
        [extraDigest]: makeEntry({ id: 'channel-target' }),
      },
      extraSchemaAliases: { 'shared_name': 'sha256:' + '0d25ea01'.padEnd(64, '0') },
      extraSchemaChannels: { 'shared_name': extraDigest },
    });

    const result = registry.resolve('schema', 'shared_name');
    // Should resolve to alias target, not channel target
    expect(result.entry.id).toBe('vcav_e_mediation_signal_v2');
  });
});
