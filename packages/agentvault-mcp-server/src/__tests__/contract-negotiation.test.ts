import { describe, expect, it } from 'vitest';
import {
  parseContractOfferProposal,
  selectNegotiatedContractOffer,
  type ContractOfferProposal,
  type SupportedContractOffer,
} from '../contract-negotiation.js';

const PROFILE_A = {
  id: 'api-claude-sonnet-v1',
  version: '1',
  hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
};

const PROFILE_B = {
  id: 'api-gemini-2.5-flash-v1',
  version: '1',
  hash: '1111111111111111111111111111111111111111111111111111111111111111',
};

describe('contract negotiation', () => {
  it('selects the first initiator-preferred offer/profile match', async () => {
    const proposal: ContractOfferProposal = {
      negotiation_id: 'neg-123',
      acceptable_offers: [
        {
          kind: 'offer',
          contract_offer_id: 'agentvault.mediation.v1.standard',
          acceptable_model_profiles: [PROFILE_A, PROFILE_B],
        },
        {
          kind: 'offer',
          contract_offer_id: 'agentvault.compatibility.v1.standard',
          acceptable_model_profiles: [PROFILE_B],
        },
      ],
    };
    const supported: SupportedContractOffer[] = [
      {
        contract_offer_id: 'agentvault.mediation.v1.standard',
        supported_model_profiles: [PROFILE_B, PROFILE_A],
      },
      {
        contract_offer_id: 'agentvault.compatibility.v1.standard',
        supported_model_profiles: [PROFILE_B],
      },
    ];

    await expect(
      selectNegotiatedContractOffer(proposal, { supportedOffers: supported }),
    ).resolves.toEqual({
      negotiation_id: 'neg-123',
      state: 'AGREED',
      selected_contract_offer_id: 'agentvault.mediation.v1.standard',
      selected_model_profile: PROFILE_A,
    });
  });

  it('returns NO_COMMON_CONTRACT when offers overlap but profiles do not', async () => {
    const proposal: ContractOfferProposal = {
      negotiation_id: 'neg-123',
      acceptable_offers: [
        {
          kind: 'offer',
          contract_offer_id: 'agentvault.mediation.v1.standard',
          acceptable_model_profiles: [PROFILE_A],
        },
      ],
    };
    const supported: SupportedContractOffer[] = [
      {
        contract_offer_id: 'agentvault.mediation.v1.standard',
        supported_model_profiles: [PROFILE_B],
      },
    ];

    await expect(
      selectNegotiatedContractOffer(proposal, { supportedOffers: supported }),
    ).resolves.toEqual({
      negotiation_id: 'neg-123',
      state: 'NO_COMMON_CONTRACT',
    });
  });

  it('returns REJECTED when expected_counterparty does not match the local agent id', async () => {
    const proposal: ContractOfferProposal = {
      negotiation_id: 'neg-123',
      acceptable_offers: [
        {
          kind: 'offer',
          contract_offer_id: 'agentvault.mediation.v1.standard',
          acceptable_model_profiles: [PROFILE_A],
        },
      ],
      expected_counterparty: 'bob-demo',
    };

    await expect(
      selectNegotiatedContractOffer(proposal, { supportedOffers: [], localAgentId: 'alice-demo' }),
    ).resolves.toEqual({
      negotiation_id: 'neg-123',
      state: 'REJECTED',
    });
  });

  it('selects a bespoke contract when locally validated', async () => {
    const proposal: ContractOfferProposal = {
      negotiation_id: 'neg-123',
      acceptable_offers: [
        {
          kind: 'bespoke',
          purpose_code: 'MEDIATION',
          schema_ref: 'vcav_e_mediation_signal_v2',
          policy_ref: 'agentvault.default.policy@active',
          program_ref: 'agentvault.mediation.program@active',
          acceptable_model_profiles: [PROFILE_A],
        },
      ],
    };

    await expect(
      selectNegotiatedContractOffer(proposal, {
        supportedOffers: [],
        supportsBespoke: true,
        supportedModelProfiles: [PROFILE_A],
        validateBespokeContract: async () => true,
      }),
    ).resolves.toEqual({
      negotiation_id: 'neg-123',
      state: 'AGREED',
      selected_bespoke_contract: {
        kind: 'bespoke',
        purpose_code: 'MEDIATION',
        schema_ref: 'vcav_e_mediation_signal_v2',
        policy_ref: 'agentvault.default.policy@active',
        program_ref: 'agentvault.mediation.program@active',
        acceptable_model_profiles: [],
      },
      selected_model_profile: PROFILE_A,
    });
  });

  it('rejects malformed offer-scoped proposals', () => {
    expect(
      parseContractOfferProposal({
        negotiation_id: 'neg-123',
        acceptable_offers: [
          {
            kind: 'offer',
            contract_offer_id: 'agentvault.mediation.v1.standard',
            acceptable_model_profiles: ['bad'],
          },
        ],
      }),
    ).toBeNull();
  });
});
