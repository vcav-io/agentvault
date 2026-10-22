/**
 * Responder-side contract expectations.
 *
 * A responder only accepts a relay contract whose hash equals the hash of a
 * contract it would build itself from local configuration: the bundled
 * purpose templates and the local contract-offer catalogue and model
 * profiles. The counterparty's invite never decides which contracts are
 * acceptable. Pre-contract negotiation does not add to this set: a bespoke
 * contract is accepted only when the caller passes its exact hash as
 * expected_contract_hash.
 */

import {
  buildRelayContract,
  computeRelayContractHash,
  withRelayContractModelProfile,
  type RelayContract,
} from 'selkey/contracts';
import { listContractOffers } from './contract-offers.js';
import { listKnownModelProfiles } from './model-profiles.js';

export const ALLOWED_PURPOSES_ENV = 'SELKEY_AFAL_ALLOWED_PURPOSES';
const DEFAULT_ALLOWED_PURPOSES = ['MEDIATION'];

/** Purposes this agent accepts as a responder when the caller did not name one. */
export function localAllowedPurposes(): string[] {
  const raw = process.env[ALLOWED_PURPOSES_ENV];
  if (!raw) return [...DEFAULT_ALLOWED_PURPOSES];
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : [...DEFAULT_ALLOWED_PURPOSES];
}

// ── Expected contracts ──────────────────────────────────────────────────

function tryBuild(fn: () => RelayContract | undefined): RelayContract | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Build every contract this responder would accept for the given purposes and
 * participants. Returns hash -> the locally built contract, so callers can
 * use the local contract (never a peer-supplied one) for a matching hash.
 *
 * `participants` is [initiator, responder], matching the contract layout.
 */
export async function buildExpectedContractHashes(params: {
  purposes: string[];
  participants: [string, string];
}): Promise<Map<string, RelayContract>> {
  const hashes = new Map<string, RelayContract>();
  const participants = [...params.participants];
  const profiles = listKnownModelProfiles();
  const purposes = new Set(params.purposes);

  const add = (contract: RelayContract | undefined) => {
    if (contract) {
      const hash = computeRelayContractHash(contract);
      if (!hashes.has(hash)) hashes.set(hash, contract);
    }
  };

  for (const purpose of purposes) {
    const base = tryBuild(() => buildRelayContract(purpose, participants));
    add(base);
    for (const profile of profiles) {
      add(tryBuild(() => buildRelayContract(purpose, participants, profile.id)));
      if (base) {
        add(
          withRelayContractModelProfile(base, {
            id: profile.id,
            hash: profile.hash,
            version: profile.version,
          }),
        );
      }
    }
  }

  // Contract-offer catalogue: same templates, bound to an allowed profile.
  for (const offer of listContractOffers()) {
    if (!purposes.has(offer.purpose_code)) continue;
    for (const profile of profiles) {
      if (!offer.allowed_model_profiles.includes(profile.id)) continue;
      const built = tryBuild(() => buildRelayContract(offer.purpose_code, participants, profile.id));
      if (built) {
        add(
          withRelayContractModelProfile(built, {
            id: profile.id,
            hash: profile.hash,
            version: profile.version,
          }),
        );
      }
    }
  }

  return hashes;
}
