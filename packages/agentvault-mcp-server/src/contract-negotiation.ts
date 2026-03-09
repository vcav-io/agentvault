import type { ModelProfileRef } from './model-profiles.js';

export interface NegotiableContractOffer {
  kind: 'offer';
  contract_offer_id: string;
  acceptable_model_profiles: ModelProfileRef[];
}

export interface NegotiableBespokeContract {
  kind: 'bespoke';
  purpose_code: string;
  schema_ref: string;
  policy_ref: string;
  program_ref: string;
  acceptable_model_profiles: ModelProfileRef[];
}

export type NegotiableContract = NegotiableContractOffer | NegotiableBespokeContract;

export interface ContractOfferProposal {
  negotiation_id: string;
  acceptable_offers: NegotiableContract[];
  expected_counterparty?: string;
}

export type ContractOfferSelectionState = 'AGREED' | 'NO_COMMON_CONTRACT' | 'REJECTED';

export interface ContractOfferSelection {
  negotiation_id: string;
  state: ContractOfferSelectionState;
  selected_contract_offer_id?: string;
  selected_bespoke_contract?: NegotiableBespokeContract;
  selected_model_profile?: ModelProfileRef;
}

export interface SupportedContractOffer {
  contract_offer_id: string;
  supported_model_profiles: ModelProfileRef[];
}

export interface NegotiationSelectionOptions {
  supportedOffers: SupportedContractOffer[];
  localAgentId?: string;
  supportsBespoke?: boolean;
  supportedModelProfiles?: ModelProfileRef[];
  validateBespokeContract?: (
    contract: NegotiableBespokeContract,
    selectedProfile: ModelProfileRef,
  ) => boolean | Promise<boolean>;
}

function isModelProfileRef(value: unknown): value is ModelProfileRef {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['id'] === 'string' &&
    typeof (value as Record<string, unknown>)['version'] === 'string' &&
    typeof (value as Record<string, unknown>)['hash'] === 'string'
  );
}

function cloneProfile(profile: ModelProfileRef): ModelProfileRef {
  return {
    id: profile.id,
    version: profile.version,
    hash: profile.hash,
  };
}

function isNegotiableOffer(value: unknown): value is NegotiableContractOffer {
  return (
    !!value &&
    typeof value === 'object' &&
    ((value as Record<string, unknown>)['kind'] === 'offer' ||
      typeof (value as Record<string, unknown>)['kind'] === 'undefined') &&
    typeof (value as Record<string, unknown>)['contract_offer_id'] === 'string' &&
    Array.isArray((value as Record<string, unknown>)['acceptable_model_profiles'])
  );
}

function isNegotiableBespoke(value: unknown): value is NegotiableBespokeContract {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)['kind'] === 'bespoke' &&
    typeof (value as Record<string, unknown>)['purpose_code'] === 'string' &&
    typeof (value as Record<string, unknown>)['schema_ref'] === 'string' &&
    typeof (value as Record<string, unknown>)['policy_ref'] === 'string' &&
    typeof (value as Record<string, unknown>)['program_ref'] === 'string' &&
    Array.isArray((value as Record<string, unknown>)['acceptable_model_profiles'])
  );
}

function parseModelProfiles(value: unknown[]): ModelProfileRef[] | null {
  const profiles: ModelProfileRef[] = [];
  for (const profile of value) {
    if (!isModelProfileRef(profile)) return null;
    profiles.push(cloneProfile(profile));
  }
  return profiles;
}

export function parseSupportedContractOffers(value: unknown): SupportedContractOffer[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: SupportedContractOffer[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>)['contract_offer_id'] !== 'string' ||
      !Array.isArray((item as Record<string, unknown>)['supported_model_profiles'])
    ) {
      return null;
    }
    const profiles = parseModelProfiles(
      (item as Record<string, unknown>)['supported_model_profiles'] as unknown[],
    );
    if (!profiles) return null;
    parsed.push({
      contract_offer_id: (item as Record<string, unknown>)['contract_offer_id'] as string,
      supported_model_profiles: profiles,
    });
  }
  return parsed;
}

export function parseContractOfferProposal(value: unknown): ContractOfferProposal | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['negotiation_id'] !== 'string' || !Array.isArray(raw['acceptable_offers'])) {
    return null;
  }

  const acceptableOffers: NegotiableContract[] = [];
  for (const item of raw['acceptable_offers']) {
    if (isNegotiableOffer(item)) {
      const profiles = parseModelProfiles(item.acceptable_model_profiles);
      if (!profiles) return null;
      acceptableOffers.push({
        kind: 'offer',
        contract_offer_id: item.contract_offer_id,
        acceptable_model_profiles: profiles,
      });
      continue;
    }
    if (isNegotiableBespoke(item)) {
      const profiles = parseModelProfiles(item.acceptable_model_profiles);
      if (!profiles) return null;
      acceptableOffers.push({
        kind: 'bespoke',
        purpose_code: item.purpose_code,
        schema_ref: item.schema_ref,
        policy_ref: item.policy_ref,
        program_ref: item.program_ref,
        acceptable_model_profiles: profiles,
      });
      continue;
    }
    return null;
  }

  if (acceptableOffers.length === 0) return null;
  return {
    negotiation_id: raw['negotiation_id'],
    acceptable_offers: acceptableOffers,
    ...(typeof raw['expected_counterparty'] === 'string'
      ? { expected_counterparty: raw['expected_counterparty'] }
      : {}),
  };
}

export function parseContractOfferSelection(value: unknown): ContractOfferSelection | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const state = raw['state'];
  if (
    typeof raw['negotiation_id'] !== 'string' ||
    (state !== 'AGREED' && state !== 'NO_COMMON_CONTRACT' && state !== 'REJECTED')
  ) {
    return null;
  }

  if (state === 'AGREED') {
    if (!isModelProfileRef(raw['selected_model_profile'])) return null;

    if (typeof raw['selected_contract_offer_id'] === 'string') {
      return {
        negotiation_id: raw['negotiation_id'],
        state,
        selected_contract_offer_id: raw['selected_contract_offer_id'],
        selected_model_profile: cloneProfile(raw['selected_model_profile']),
      };
    }

    if (isNegotiableBespoke(raw['selected_bespoke_contract'])) {
      const bespoke = raw['selected_bespoke_contract'];
      const profiles = parseModelProfiles(bespoke.acceptable_model_profiles);
      if (!profiles) return null;
      return {
        negotiation_id: raw['negotiation_id'],
        state,
        selected_bespoke_contract: {
          kind: 'bespoke',
          purpose_code: bespoke.purpose_code,
          schema_ref: bespoke.schema_ref,
          policy_ref: bespoke.policy_ref,
          program_ref: bespoke.program_ref,
          acceptable_model_profiles: profiles,
        },
        selected_model_profile: cloneProfile(raw['selected_model_profile']),
      };
    }
    return null;
  }

  return {
    negotiation_id: raw['negotiation_id'],
    state,
  };
}

function profilesMatch(candidate: ModelProfileRef, preferred: ModelProfileRef): boolean {
  return (
    candidate.id === preferred.id &&
    candidate.version === preferred.version &&
    candidate.hash === preferred.hash
  );
}

export async function selectNegotiatedContractOffer(
  proposal: ContractOfferProposal,
  options: NegotiationSelectionOptions,
): Promise<ContractOfferSelection> {
  if (
    proposal.expected_counterparty &&
    options.localAgentId &&
    proposal.expected_counterparty !== options.localAgentId
  ) {
    return {
      negotiation_id: proposal.negotiation_id,
      state: 'REJECTED',
    };
  }

  const supportedById = new Map(
    options.supportedOffers.map((offer) => [offer.contract_offer_id, offer.supported_model_profiles]),
  );
  const localSupportedProfiles = options.supportedModelProfiles ?? [];

  for (const acceptable of proposal.acceptable_offers) {
    if (acceptable.kind === 'offer') {
      const supportedProfiles = supportedById.get(acceptable.contract_offer_id);
      if (!supportedProfiles) continue;
      for (const preferredProfile of acceptable.acceptable_model_profiles) {
        const match = supportedProfiles.find((candidate) => profilesMatch(candidate, preferredProfile));
        if (match) {
          return {
            negotiation_id: proposal.negotiation_id,
            state: 'AGREED',
            selected_contract_offer_id: acceptable.contract_offer_id,
            selected_model_profile: cloneProfile(match),
          };
        }
      }
      continue;
    }

    if (!options.supportsBespoke || !options.validateBespokeContract) continue;
    for (const preferredProfile of acceptable.acceptable_model_profiles) {
      const match = localSupportedProfiles.find((candidate) => profilesMatch(candidate, preferredProfile));
      if (!match) continue;
      if (!(await options.validateBespokeContract(acceptable, match))) continue;
      return {
        negotiation_id: proposal.negotiation_id,
        state: 'AGREED',
        selected_bespoke_contract: {
          kind: 'bespoke',
          purpose_code: acceptable.purpose_code,
          schema_ref: acceptable.schema_ref,
          policy_ref: acceptable.policy_ref,
          program_ref: acceptable.program_ref,
          acceptable_model_profiles: [],
        },
        selected_model_profile: cloneProfile(match),
      };
    }
  }

  return {
    negotiation_id: proposal.negotiation_id,
    state: 'NO_COMMON_CONTRACT',
  };
}
