import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildContract,
  loadRegistryIndex,
  type RegistryIndex,
} from 'agentvault-client/contract-builder';
import type { RelayContract } from 'agentvault-client/contracts';
import type { ModelProfileRef } from './model-profiles.js';
import type { NegotiableBespokeContract } from './contract-negotiation.js';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY_PATH = resolve(PACKAGE_DIR, '../../../agentvault-registry');

let registryPromise: Promise<RegistryIndex | null> | null = null;

export function resolveNegotiationRegistryPath(): string | null {
  const configured = process.env['AV_REGISTRY_PATH'];
  if (configured) {
    return existsSync(resolve(configured, 'registry.json')) ? configured : null;
  }
  return existsSync(resolve(DEFAULT_REGISTRY_PATH, 'registry.json')) ? DEFAULT_REGISTRY_PATH : null;
}

export function supportsBespokePrecontractNegotiation(): boolean {
  return resolveNegotiationRegistryPath() !== null;
}

async function loadNegotiationRegistry(): Promise<RegistryIndex | null> {
  if (!registryPromise) {
    const registryPath = resolveNegotiationRegistryPath();
    registryPromise = registryPath ? loadRegistryIndex(registryPath) : Promise.resolve(null);
  }
  return registryPromise;
}

function profileDigest(profile: ModelProfileRef): string {
  return profile.hash.startsWith('sha256:') ? profile.hash : `sha256:${profile.hash}`;
}

export async function validateBespokeContractSelection(
  contract: NegotiableBespokeContract,
  selectedProfile: ModelProfileRef,
): Promise<boolean> {
  const registry = await loadNegotiationRegistry();
  if (!registry) return false;
  try {
    registry.resolve('schema', contract.schema_ref);
    registry.resolve('policy', contract.policy_ref);
    registry.resolve('program', contract.program_ref);
    registry.resolve('profile', profileDigest(selectedProfile));
    const compatibility = registry.checkCompatibility(contract.schema_ref, contract.policy_ref);
    return compatibility.compatible;
  } catch {
    return false;
  }
}

export async function resolveBespokeContractToContract(params: {
  contract: NegotiableBespokeContract;
  participants: string[];
  selectedModelProfile: ModelProfileRef;
}): Promise<RelayContract> {
  const registry = await loadNegotiationRegistry();
  if (!registry) {
    throw new Error('Bespoke contract negotiation requires an admitted registry (AV_REGISTRY_PATH).');
  }
  return buildContract(registry, {
    schema: params.contract.schema_ref,
    policy: params.contract.policy_ref,
    profile: profileDigest(params.selectedModelProfile),
    program: params.contract.program_ref,
    purpose_code: params.contract.purpose_code,
    participants: params.participants,
  });
}
