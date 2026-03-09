import type { ModelProfileRef } from './model-profiles.js';

export interface NegotiableContractOffer {
  contract_offer_id: string;
  acceptable_model_profiles: ModelProfileRef[];
}

export interface ContractOfferProposal {
  negotiation_id: string;
  acceptable_offers: NegotiableContractOffer[];
  expected_counterparty?: string;
}

export type ContractOfferSelectionState = 'AGREED' | 'NO_COMMON_CONTRACT' | 'REJECTED';

export interface ContractOfferSelection {
  negotiation_id: string;
  state: ContractOfferSelectionState;
  selected_contract_offer_id?: string;
  selected_model_profile?: ModelProfileRef;
}

export interface SupportedContractOffer {
  contract_offer_id: string;
  supported_model_profiles: ModelProfileRef[];
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
    const rawProfiles = (item as Record<string, unknown>)['supported_model_profiles'] as unknown[];
    const profiles: ModelProfileRef[] = [];
    for (const profile of rawProfiles) {
      if (!isModelProfileRef(profile)) return null;
      profiles.push({
        id: profile.id,
        version: profile.version,
        hash: profile.hash,
      });
    }
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
  const acceptableOffers: NegotiableContractOffer[] = [];
  for (const item of raw['acceptable_offers']) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>)['contract_offer_id'] !== 'string' ||
      !Array.isArray((item as Record<string, unknown>)['acceptable_model_profiles'])
    ) {
      return null;
    }
    const rawProfiles = (item as Record<string, unknown>)['acceptable_model_profiles'] as unknown[];
    const profiles: ModelProfileRef[] = [];
    for (const profile of rawProfiles) {
      if (!isModelProfileRef(profile)) return null;
      profiles.push({
        id: profile.id,
        version: profile.version,
        hash: profile.hash,
      });
    }
    acceptableOffers.push({
      contract_offer_id: (item as Record<string, unknown>)['contract_offer_id'] as string,
      acceptable_model_profiles: profiles,
    });
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
    if (
      typeof raw['selected_contract_offer_id'] !== 'string' ||
      !isModelProfileRef(raw['selected_model_profile'])
    ) {
      return null;
    }
    return {
      negotiation_id: raw['negotiation_id'],
      state,
      selected_contract_offer_id: raw['selected_contract_offer_id'],
      selected_model_profile: {
        id: raw['selected_model_profile'].id,
        version: raw['selected_model_profile'].version,
        hash: raw['selected_model_profile'].hash,
      },
    };
  }
  return {
    negotiation_id: raw['negotiation_id'],
    state,
  };
}

export function selectNegotiatedContractOffer(
  proposal: ContractOfferProposal,
  supportedOffers: SupportedContractOffer[],
  localAgentId?: string,
): ContractOfferSelection {
  if (proposal.expected_counterparty && localAgentId && proposal.expected_counterparty !== localAgentId) {
    return {
      negotiation_id: proposal.negotiation_id,
      state: 'REJECTED',
    };
  }

  const supportedById = new Map(
    supportedOffers.map((offer) => [offer.contract_offer_id, offer.supported_model_profiles]),
  );

  for (const acceptableOffer of proposal.acceptable_offers) {
    const supportedProfiles = supportedById.get(acceptableOffer.contract_offer_id);
    if (!supportedProfiles) continue;
    for (const preferredProfile of acceptableOffer.acceptable_model_profiles) {
      const match = supportedProfiles.find(
        (candidate) =>
          candidate.id === preferredProfile.id &&
          candidate.version === preferredProfile.version &&
          candidate.hash === preferredProfile.hash,
      );
      if (match) {
        return {
          negotiation_id: proposal.negotiation_id,
          state: 'AGREED',
          selected_contract_offer_id: acceptableOffer.contract_offer_id,
          selected_model_profile: { ...match },
        };
      }
    }
  }

  return {
    negotiation_id: proposal.negotiation_id,
    state: 'NO_COMMON_CONTRACT',
  };
}
