/**
 * Contract builder for AgentVault.
 *
 * Reads registry indexes, resolves artefact references (by digest, alias,
 * or channel), validates compatibility, and assembles relay contracts.
 *
 * Design: docs/plans/2026-03-07-registries-contract-builder-design.md
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize } from 'json-canonicalize';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { RelayContract } from './relay-contracts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArtefactKind = 'schema' | 'policy' | 'profile' | 'program';

export interface ArtefactEntry {
  id: string;
  version: string;
  description: string;
  status: 'active' | 'experimental' | 'deprecated';
  published_at: string;
  compatibility: {
    safety_class?: 'SAFE' | 'RICH';
  };
}

export interface ResolvedArtefact {
  digest: string;
  entry: ArtefactEntry;
}

export interface CompatibilityResult {
  compatible: boolean;
  reason?: string;
}

export interface RegistryIndex {
  resolve(kind: ArtefactKind, artefactRef: string): ResolvedArtefact;
  listByKind(kind: ArtefactKind): ArtefactEntry[];
  checkCompatibility(schema: string, policy: string): CompatibilityResult;
}

export interface ContractOptions {
  schema: string;
  policy: string;
  profile: string;
  program: string;
  purpose_code: string;
  participants: string[];
  entropy_budget_bits?: number;
  entropy_enforcement?: 'Gate' | 'Advisory';
  allowDeprecated?: boolean;
}

// ---------------------------------------------------------------------------
// Internal index data structures
// ---------------------------------------------------------------------------

interface KindIndex {
  version: string;
  kind: string;
  artefacts: Record<string, ArtefactEntry>;
  aliases: Record<string, string>;
  channels: Record<string, string>;
}

interface RegistryManifest {
  registry_version: string;
  kinds: string[];
  indexes: Record<string, string>;
}

// ---------------------------------------------------------------------------
// RegistryIndex implementation
// ---------------------------------------------------------------------------

class RegistryIndexImpl implements RegistryIndex {
  private readonly indexes: Map<ArtefactKind, KindIndex>;

  constructor(indexes: Map<ArtefactKind, KindIndex>) {
    this.indexes = indexes;
  }

  resolve(kind: ArtefactKind, artefactRef: string): ResolvedArtefact {
    const index = this.indexes.get(kind);
    if (!index) {
      throw new Error(`Unknown artefact kind: ${kind}`);
    }

    // 1. Direct digest match
    if (artefactRef.startsWith('sha256:')) {
      const entry = index.artefacts[artefactRef];
      if (entry) {
        return { digest: artefactRef, entry };
      }
      throw new Error(`Digest not found in ${kind} index: ${artefactRef}`);
    }

    // 2. Alias lookup
    const aliasDigest = index.aliases[artefactRef];
    if (aliasDigest) {
      const entry = index.artefacts[aliasDigest];
      if (entry) {
        return { digest: aliasDigest, entry };
      }
      throw new Error(`Alias "${artefactRef}" resolves to ${aliasDigest} which is missing from ${kind} index`);
    }

    // 3. Channel lookup
    const channelDigest = index.channels[artefactRef];
    if (channelDigest) {
      const entry = index.artefacts[channelDigest];
      if (entry) {
        return { digest: channelDigest, entry };
      }
      throw new Error(
        `Channel "${artefactRef}" resolves to ${channelDigest} which is missing from ${kind} index`,
      );
    }

    throw new Error(`Reference "${artefactRef}" not found in ${kind} index (tried digest, alias, channel)`);
  }

  listByKind(kind: ArtefactKind): ArtefactEntry[] {
    const index = this.indexes.get(kind);
    if (!index) {
      throw new Error(`Unknown artefact kind: ${kind}`);
    }
    return Object.values(index.artefacts);
  }

  checkCompatibility(schemaRef: string, policyRef: string): CompatibilityResult {
    const schema = this.resolve('schema', schemaRef);
    const policy = this.resolve('policy', policyRef);

    const schemaClass = schema.entry.compatibility.safety_class;
    const policyClass = policy.entry.compatibility.safety_class;

    if (!schemaClass || !policyClass) {
      return {
        compatible: true,
        reason: 'Unknown compatibility: one or both artefacts lack safety_class metadata',
      };
    }

    if (schemaClass === 'RICH' && policyClass === 'SAFE') {
      return {
        compatible: false,
        reason: 'RICH schema cannot be governed by a SAFE policy (insufficient entropy controls)',
      };
    }

    return { compatible: true };
  }
}

// ---------------------------------------------------------------------------
// Registry loading
// ---------------------------------------------------------------------------

const VALID_KINDS: ArtefactKind[] = ['schema', 'policy', 'profile', 'program'];

function isValidKind(kind: string): kind is ArtefactKind {
  return (VALID_KINDS as string[]).includes(kind);
}

/**
 * Load registry indexes from a local registry clone.
 *
 * Reads `registry.json` then each kind's `index.json`. Returns a
 * `RegistryIndex` that can resolve references and check compatibility.
 */
export async function loadRegistryIndex(registryPath: string): Promise<RegistryIndex> {
  const manifestRaw = await readFile(join(registryPath, 'registry.json'), 'utf-8');
  const manifest: RegistryManifest = JSON.parse(manifestRaw);

  const indexes = new Map<ArtefactKind, KindIndex>();

  for (const kind of manifest.kinds) {
    if (!isValidKind(kind)) continue;

    const indexPath = manifest.indexes[kind];
    if (!indexPath) continue;

    const indexRaw = await readFile(join(registryPath, indexPath), 'utf-8');
    const kindIndex: KindIndex = JSON.parse(indexRaw);
    indexes.set(kind, kindIndex);
  }

  return new RegistryIndexImpl(indexes);
}

/**
 * Create a RegistryIndex from pre-loaded index data.
 * Useful for testing or when indexes are already in memory.
 */
export function createRegistryIndex(
  indexes: Map<ArtefactKind, KindIndex>,
): RegistryIndex {
  return new RegistryIndexImpl(indexes);
}

// ---------------------------------------------------------------------------
// Contract builder
// ---------------------------------------------------------------------------

/**
 * Strip the `sha256:` prefix from a qualified digest, returning bare hex.
 */
function bareDigest(qualifiedDigest: string): string {
  if (qualifiedDigest.startsWith('sha256:')) {
    return qualifiedDigest.slice(7);
  }
  return qualifiedDigest;
}

/**
 * Build a relay contract from registry artefact references.
 *
 * Resolves each reference, validates compatibility, assembles the contract,
 * and computes its content hash.
 */
export function buildContract(
  registry: RegistryIndex,
  options: ContractOptions,
): RelayContract {
  // Resolve all artefact references
  const schema = registry.resolve('schema', options.schema);
  const policy = registry.resolve('policy', options.policy);
  const profile = registry.resolve('profile', options.profile);
  const program = registry.resolve('program', options.program);

  // Validate status
  const resolved = [
    { kind: 'schema', ref: options.schema, artefact: schema },
    { kind: 'policy', ref: options.policy, artefact: policy },
    { kind: 'profile', ref: options.profile, artefact: profile },
    { kind: 'program', ref: options.program, artefact: program },
  ];

  const warnings: string[] = [];

  for (const { kind, ref, artefact } of resolved) {
    if (artefact.entry.status === 'deprecated') {
      if (!options.allowDeprecated) {
        throw new Error(
          `${kind} "${ref}" is deprecated. Use allowDeprecated: true to override.`,
        );
      }
      warnings.push(`${kind} "${ref}" is deprecated`);
    }
  }

  // Validate compatibility
  const compat = registry.checkCompatibility(options.schema, options.policy);
  if (!compat.compatible) {
    throw new Error(`Compatibility error: ${compat.reason}`);
  }
  if (compat.reason) {
    // Warning case (unknown safety_class)
    warnings.push(compat.reason);
  }

  // Log warnings to console (non-blocking)
  for (const w of warnings) {
    console.warn(`[contract-builder] WARNING: ${w}`);
  }

  // Validate participants
  if (options.participants.length !== 2) {
    throw new Error('Contract requires exactly 2 participants (bilateral only)');
  }
  for (const p of options.participants) {
    if (p.length === 0) throw new Error('Participant ID must not be empty');
    if (/\s/.test(p)) throw new Error(`Participant ID "${p}" contains whitespace`);
  }

  // Assemble the contract object.
  // Field order matches RelayContract / existing TEMPLATES for hash parity.
  const contract: Record<string, unknown> = {
    purpose_code: options.purpose_code,
    output_schema_id: schema.entry.id,
    output_schema: {},
    participants: options.participants,
    prompt_template_hash: bareDigest(program.digest),
    entropy_budget_bits: options.entropy_budget_bits ?? null,
    timing_class: null,
    metadata: null,
    model_profile_id: profile.entry.id,
    enforcement_policy_hash: bareDigest(policy.digest),
    output_schema_hash: bareDigest(schema.digest),
  };

  if (options.entropy_enforcement) {
    contract['entropy_enforcement'] = options.entropy_enforcement;
  }

  // Compute contract_hash = SHA-256(JCS(contract))
  const canonical = canonicalize(contract);
  const contractHash = bytesToHex(sha256(canonical));
  contract['contract_hash'] = contractHash;

  return Object.freeze(contract) as unknown as RelayContract;
}
