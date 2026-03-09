import {
  buildRelayContract,
  withRelayContractModelProfile,
  type RelayContract,
} from 'agentvault-client/contracts';
import { listKnownModelProfiles, type ModelProfileRef } from './model-profiles.js';

export interface ContractOfferDefinition {
  offer_version: string;
  contract_offer_id: string;
  purpose_code: string;
  schema_ref: string;
  policy_ref: string;
  program_ref: string;
  allowed_model_profiles: string[];
  metadata_defaults?: Record<string, unknown>;
}

export interface SupportedContractOffer {
  contract_offer_id: string;
  supported_model_profiles: ModelProfileRef[];
}

const KNOWN_PROFILES = listKnownModelProfiles();

const CONTRACT_OFFERS: readonly ContractOfferDefinition[] = [
  {
    offer_version: '1',
    contract_offer_id: 'agentvault.mediation.v1.standard',
    purpose_code: 'MEDIATION',
    schema_ref: 'vcav_e_mediation_signal_v2',
    policy_ref: 'agentvault.default.policy@active',
    program_ref: 'agentvault.mediation.program@active',
    allowed_model_profiles: KNOWN_PROFILES.map((profile) => profile.id),
    metadata_defaults: { ui: 'agentvault', flow: 'bilateral' },
  },
  {
    offer_version: '1',
    contract_offer_id: 'agentvault.compatibility.v1.standard',
    purpose_code: 'COMPATIBILITY',
    schema_ref: 'vcav_e_compatibility_signal_v2',
    policy_ref: 'agentvault.default.policy@active',
    program_ref: 'agentvault.compatibility.program@active',
    allowed_model_profiles: KNOWN_PROFILES.map((profile) => profile.id),
    metadata_defaults: { ui: 'agentvault', flow: 'bilateral' },
  },
] as const;

function cloneProfile(profile: ModelProfileRef): ModelProfileRef {
  return { ...profile };
}

export function listContractOffers(): ContractOfferDefinition[] {
  return CONTRACT_OFFERS.map((offer) => ({
    ...offer,
    allowed_model_profiles: [...offer.allowed_model_profiles],
    ...(offer.metadata_defaults ? { metadata_defaults: { ...offer.metadata_defaults } } : {}),
  }));
}

export function getContractOffer(contractOfferId: string): ContractOfferDefinition | undefined {
  return listContractOffers().find((offer) => offer.contract_offer_id === contractOfferId);
}

export function listSupportedContractOffers(): SupportedContractOffer[] {
  const profilesById = new Map(KNOWN_PROFILES.map((profile) => [profile.id, profile]));
  return CONTRACT_OFFERS.map((offer) => ({
    contract_offer_id: offer.contract_offer_id,
    supported_model_profiles: offer.allowed_model_profiles
      .map((profileId) => profilesById.get(profileId))
      .filter((profile): profile is ModelProfileRef => profile !== undefined)
      .map(cloneProfile),
  }));
}

export function purposeToContractOfferIds(purpose: string): string[] {
  return CONTRACT_OFFERS.filter((offer) => offer.purpose_code === purpose).map(
    (offer) => offer.contract_offer_id,
  );
}

export function resolveContractOfferToContract(params: {
  contractOfferId: string;
  participants: string[];
  selectedModelProfile: ModelProfileRef;
}): RelayContract {
  const offer = getContractOffer(params.contractOfferId);
  if (!offer) {
    throw new Error(`Unknown contract offer "${params.contractOfferId}"`);
  }

  if (!offer.allowed_model_profiles.includes(params.selectedModelProfile.id)) {
    throw new Error(
      `Model profile "${params.selectedModelProfile.id}" is not allowed for offer "${params.contractOfferId}"`,
    );
  }

  const contract = buildRelayContract(
    offer.purpose_code,
    params.participants,
    params.selectedModelProfile.id,
  );
  if (!contract) {
    throw new Error(`Contract offer "${params.contractOfferId}" resolves to unknown purpose`);
  }

  return withRelayContractModelProfile(contract, {
    id: params.selectedModelProfile.id,
    hash: params.selectedModelProfile.hash,
    version: params.selectedModelProfile.version,
  });
}
