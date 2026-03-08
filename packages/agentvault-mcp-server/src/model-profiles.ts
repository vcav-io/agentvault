import { readFileSync } from 'node:fs';

export interface ModelProfileRef {
  id: string;
  version: string;
  hash: string;
}

interface ModelProfileFile {
  profile_version: string;
}

const LOCK_PATH = new URL('../../agentvault-relay/prompt_programs/model_profiles.lock', import.meta.url);
const PROFILE_DIR = new URL('../../agentvault-relay/prompt_programs/', import.meta.url);

let cachedProfiles: ModelProfileRef[] | null = null;

function loadProfiles(): ModelProfileRef[] {
  const rawLock = readFileSync(LOCK_PATH, 'utf-8');
  const lock = JSON.parse(rawLock) as Record<string, string>;

  return Object.entries(lock).map(([id, hash]) => {
    const rawProfile = readFileSync(new URL(`${id}.json`, PROFILE_DIR), 'utf-8');
    const profile = JSON.parse(rawProfile) as ModelProfileFile;
    return {
      id,
      version: profile.profile_version,
      hash,
    };
  });
}

export function listKnownModelProfiles(): ModelProfileRef[] {
  if (cachedProfiles === null) {
    cachedProfiles = loadProfiles();
  }
  return cachedProfiles.map((profile) => ({ ...profile }));
}

export function resolveModelProfileRefs(profileIds: string[]): ModelProfileRef[] {
  const known = new Map(listKnownModelProfiles().map((profile) => [profile.id, profile]));
  return profileIds.map((profileId) => {
    const match = known.get(profileId);
    if (!match) {
      throw new Error(`Unknown model profile "${profileId}"`);
    }
    return { ...match };
  });
}

