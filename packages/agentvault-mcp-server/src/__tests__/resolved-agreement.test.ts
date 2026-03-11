import { describe, expect, it, vi } from 'vitest';

import {
  compileResolvedAgreement,
  mapResolvedAgreementToNegotiatedContract,
  resolvedAgreementFromBespoke,
  resolvedAgreementFromOffer,
} from '../resolved-agreement.js';

vi.mock('agentvault-client/contracts', () => ({
  buildRelayContract: vi.fn().mockImplementation(
    (purpose: string, participants: string[], modelProfileId?: string) => ({
      purpose_code: purpose,
      output_schema_id:
        purpose === 'MEDIATION' ? 'vcav_e_mediation_signal_v2' : 'vcav_e_compatibility_signal_v2',
      participants,
      entropy_budget_bits: 12,
      model_profile_id: modelProfileId ?? 'api-claude-sonnet-v1',
      model_profile_hash: `${modelProfileId ?? 'api-claude-sonnet-v1'}-hash`,
      metadata: { scenario: 'test' },
    }),
  ),
  withRelayContractModelProfile: vi.fn().mockImplementation((contract, profile) => ({
    ...contract,
    model_profile_id: profile.id,
    model_profile_hash: profile.hash,
  })),
}));

vi.mock('../bespoke-contracts.js', () => ({
  resolveBespokeContractToContract: vi.fn().mockImplementation(
    async ({
      contract,
      participants,
      selectedModelProfile,
    }: {
      contract: {
        purpose_code: string;
        schema_ref: string;
        policy_ref: string;
        program_ref: string;
      };
      participants: string[];
      selectedModelProfile: { id: string; hash: string };
    }) => ({
      purpose_code: contract.purpose_code,
      output_schema_id: contract.schema_ref,
      participants,
      entropy_budget_bits: 12,
      model_profile_id: selectedModelProfile.id,
      model_profile_hash: selectedModelProfile.hash,
      metadata: {
        policy_ref: contract.policy_ref,
        program_ref: contract.program_ref,
      },
    }),
  ),
}));

const PROFILE_A = {
  id: 'api-claude-sonnet-v1',
  version: '1',
  hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
};

describe('resolved agreement', () => {
  it('maps a standard offer to a resolved agreement', () => {
    const agreement = resolvedAgreementFromOffer({
      contractOfferId: 'agentvault.mediation.v1.standard',
      selectedModelProfile: PROFILE_A,
      topicCode: 'salary_alignment',
    });

    expect(agreement).toMatchObject({
      topic_code: 'salary_alignment',
      purpose_code: 'MEDIATION',
      schema_ref: 'vcav_e_mediation_signal_v2',
      policy_ref: 'agentvault.default.policy@active',
      program_ref: 'agentvault.mediation.program@active',
      source: {
        kind: 'offer',
        contract_offer_id: 'agentvault.mediation.v1.standard',
      },
      selected_model_profile: PROFILE_A,
    });
  });

  it('maps a bespoke contract to a resolved agreement', () => {
    const agreement = resolvedAgreementFromBespoke({
      contract: {
        purpose_code: 'MEDIATION',
        schema_ref: 'vcav_e_mediation_signal_v2',
        policy_ref: 'agentvault.default.policy@active',
        program_ref: 'agentvault.mediation.program@active',
      },
      selectedModelProfile: PROFILE_A,
    });

    expect(agreement).toMatchObject({
      purpose_code: 'MEDIATION',
      schema_ref: 'vcav_e_mediation_signal_v2',
      policy_ref: 'agentvault.default.policy@active',
      program_ref: 'agentvault.mediation.program@active',
      source: {
        kind: 'bespoke',
      },
      selected_model_profile: PROFILE_A,
    });
  });

  it('compiles the same resolved agreement deterministically', async () => {
    const agreement = resolvedAgreementFromOffer({
      contractOfferId: 'agentvault.mediation.v1.standard',
      selectedModelProfile: PROFILE_A,
    });

    const first = await compileResolvedAgreement({
      agreement,
      participants: ['alice-demo', 'bob-demo'],
    });
    const second = await compileResolvedAgreement({
      agreement,
      participants: ['alice-demo', 'bob-demo'],
    });

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('fails closed when participants are missing', async () => {
    const agreement = resolvedAgreementFromBespoke({
      contract: {
        purpose_code: 'MEDIATION',
        schema_ref: 'vcav_e_mediation_signal_v2',
        policy_ref: 'agentvault.default.policy@active',
        program_ref: 'agentvault.mediation.program@active',
      },
      selectedModelProfile: PROFILE_A,
    });

    await expect(
      compileResolvedAgreement({
        agreement,
        participants: [],
      }),
    ).rejects.toThrow('Resolved agreement compilation requires at least one participant');
  });

  it('maps a resolved agreement back to the legacy negotiated_contract shape', () => {
    const agreement = resolvedAgreementFromBespoke({
      contract: {
        purpose_code: 'MEDIATION',
        schema_ref: 'vcav_e_mediation_signal_v2',
        policy_ref: 'agentvault.default.policy@active',
        program_ref: 'agentvault.mediation.program@active',
      },
      selectedModelProfile: PROFILE_A,
      topicCode: 'salary_alignment',
    });

    expect(mapResolvedAgreementToNegotiatedContract(agreement)).toEqual({
      kind: 'bespoke',
      bespoke_contract: {
        purpose_code: 'MEDIATION',
        schema_ref: 'vcav_e_mediation_signal_v2',
        policy_ref: 'agentvault.default.policy@active',
        program_ref: 'agentvault.mediation.program@active',
      },
      selected_model_profile: PROFILE_A,
    });
  });
});
