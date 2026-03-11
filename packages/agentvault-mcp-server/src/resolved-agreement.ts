import type { ModelProfileRef } from './model-profiles.js';
import { getContractOffer, resolveContractOfferToContract } from './contract-offers.js';
import { resolveBespokeContractToContract } from './bespoke-contracts.js';
import type { RelayContract } from 'agentvault-client/contracts';
import type { NegotiableBespokeContract } from './contract-negotiation.js';

export interface ResolvedAgreement {
  topic_code?: string;
  purpose_code: string;
  schema_ref: string;
  policy_ref: string;
  program_ref: string;
  selected_model_profile: ModelProfileRef;
  source:
    | {
        kind: 'offer';
        contract_offer_id: string;
      }
    | {
        kind: 'bespoke';
      };
}

export function resolvedAgreementFromOffer(params: {
  contractOfferId: string;
  selectedModelProfile: ModelProfileRef;
  topicCode?: string;
}): ResolvedAgreement {
  const offer = getContractOffer(params.contractOfferId);
  if (!offer) {
    throw new Error(`Unknown contract offer "${params.contractOfferId}"`);
  }
  return {
    ...(params.topicCode ? { topic_code: params.topicCode } : {}),
    purpose_code: offer.purpose_code,
    schema_ref: offer.schema_ref,
    policy_ref: offer.policy_ref,
    program_ref: offer.program_ref,
    selected_model_profile: { ...params.selectedModelProfile },
    source: {
      kind: 'offer',
      contract_offer_id: params.contractOfferId,
    },
  };
}

export function resolvedAgreementFromBespoke(params: {
  contract: Pick<NegotiableBespokeContract, 'purpose_code' | 'schema_ref' | 'policy_ref' | 'program_ref'>;
  selectedModelProfile: ModelProfileRef;
  topicCode?: string;
}): ResolvedAgreement {
  return {
    ...(params.topicCode ? { topic_code: params.topicCode } : {}),
    purpose_code: params.contract.purpose_code,
    schema_ref: params.contract.schema_ref,
    policy_ref: params.contract.policy_ref,
    program_ref: params.contract.program_ref,
    selected_model_profile: { ...params.selectedModelProfile },
    source: {
      kind: 'bespoke',
    },
  };
}

export async function compileResolvedAgreement(params: {
  agreement: ResolvedAgreement;
  participants: string[];
}): Promise<RelayContract> {
  const orderedParticipants = [...params.participants];
  if (orderedParticipants.length === 0) {
    throw new Error('Resolved agreement compilation requires at least one participant');
  }
  if (params.agreement.source.kind === 'offer') {
    return resolveContractOfferToContract({
      contractOfferId: params.agreement.source.contract_offer_id,
      participants: orderedParticipants,
      selectedModelProfile: params.agreement.selected_model_profile,
    });
  }

  return resolveBespokeContractToContract({
    contract: {
      kind: 'bespoke',
      purpose_code: params.agreement.purpose_code,
      schema_ref: params.agreement.schema_ref,
      policy_ref: params.agreement.policy_ref,
      program_ref: params.agreement.program_ref,
      acceptable_model_profiles: [params.agreement.selected_model_profile],
    },
    participants: orderedParticipants,
    selectedModelProfile: params.agreement.selected_model_profile,
  });
}

export function mapResolvedAgreementToNegotiatedContract(
  agreement: ResolvedAgreement | undefined,
): {
  kind: 'offer' | 'bespoke';
  contract_offer_id?: string;
  bespoke_contract?: {
    purpose_code: string;
    schema_ref: string;
    policy_ref: string;
    program_ref: string;
  };
  selected_model_profile: ModelProfileRef;
} | undefined {
  if (!agreement) return undefined;
  return {
    kind: agreement.source.kind,
    ...(agreement.source.kind === 'offer'
      ? { contract_offer_id: agreement.source.contract_offer_id }
      : {
          bespoke_contract: {
            purpose_code: agreement.purpose_code,
            schema_ref: agreement.schema_ref,
            policy_ref: agreement.policy_ref,
            program_ref: agreement.program_ref,
          },
        }),
    selected_model_profile: agreement.selected_model_profile,
  };
}
