/**
 * Responder-side contract expectations.
 *
 * A responder only accepts a relay contract whose hash equals the hash of a
 * contract it would build itself from local configuration: the bundled
 * purpose templates, the local contract-offer catalogue and model profiles,
 * and any agreements this agent selected during pre-contract negotiation
 * (compiled from its own admitted registry). The counterparty's invite never
 * decides which contracts are acceptable.
 */

import {
  buildRelayContract,
  computeRelayContractHash,
  withRelayContractModelProfile,
  type RelayContract,
} from 'selkey/contracts';
import { listContractOffers } from './contract-offers.js';
import { listKnownModelProfiles } from './model-profiles.js';
import { compileResolvedAgreement, type ResolvedAgreement } from './resolved-agreement.js';

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

// ── Locally selected negotiation agreements ─────────────────────────────

const AGREEMENT_TTL_MS = 30 * 60 * 1000;
const MAX_AGREEMENTS = 256;

interface RecordedAgreement {
  agreement: ResolvedAgreement;
  expiresAt: number;
}

const recordedAgreements: RecordedAgreement[] = [];

function agreementKey(agreement: ResolvedAgreement): string {
  return JSON.stringify([
    agreement.source.kind,
    agreement.source.kind === 'offer' ? agreement.source.contract_offer_id : null,
    agreement.purpose_code,
    agreement.schema_ref,
    agreement.policy_ref,
    agreement.program_ref,
    agreement.selected_model_profile.id,
    agreement.selected_model_profile.version,
    agreement.selected_model_profile.hash,
  ]);
}

function gcAgreements(now: number): void {
  for (let i = recordedAgreements.length - 1; i >= 0; i--) {
    if (recordedAgreements[i].expiresAt <= now) recordedAgreements.splice(i, 1);
  }
}

/**
 * Record an agreement that this agent selected while answering a
 * pre-contract negotiation, so the responder will accept the compiled
 * contract later.
 */
export function recordLocallySelectedAgreement(agreement: ResolvedAgreement): void {
  const now = Date.now();
  gcAgreements(now);
  const key = agreementKey(agreement);
  const existing = recordedAgreements.find((entry) => agreementKey(entry.agreement) === key);
  if (existing) {
    existing.expiresAt = now + AGREEMENT_TTL_MS;
    return;
  }
  recordedAgreements.push({ agreement, expiresAt: now + AGREEMENT_TTL_MS });
  while (recordedAgreements.length > MAX_AGREEMENTS) recordedAgreements.shift();
}

export function _resetRecordedAgreementsForTesting(): void {
  recordedAgreements.length = 0;
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
 * participants, and return their hashes.
 *
 * `participants` is [initiator, responder], matching the contract layout.
 */
export async function buildExpectedContractHashes(params: {
  purposes: string[];
  participants: [string, string];
}): Promise<Set<string>> {
  const hashes = new Set<string>();
  const participants = [...params.participants];
  const profiles = listKnownModelProfiles();
  const purposes = new Set(params.purposes);

  const add = (contract: RelayContract | undefined) => {
    if (contract) hashes.add(computeRelayContractHash(contract));
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

  // Agreements this agent selected during pre-contract negotiation.
  const now = Date.now();
  gcAgreements(now);
  for (const { agreement } of recordedAgreements) {
    if (!purposes.has(agreement.purpose_code)) continue;
    try {
      add(await compileResolvedAgreement({ agreement, participants }));
    } catch {
      // Registry unavailable or agreement no longer resolvable: not acceptable.
    }
  }

  return hashes;
}
