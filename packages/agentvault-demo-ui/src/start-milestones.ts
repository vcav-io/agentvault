import { buildRelayContract, computeOutputSchemaHash } from 'agentvault-client/contracts';

import type { DemoEvent } from './events.js';

export function buildStartMilestoneEvents(
  relayHealth: Record<string, unknown>,
  relayProfileId?: string,
  now: () => string = () => new Date().toISOString(),
  onWarn: (message: string, error: unknown) => void = () => {},
): DemoEvent[] {
  const events: DemoEvent[] = [];
  const policySummary = relayHealth['policy_summary'] as Record<string, unknown> | undefined;

  try {
    const mediationContract = buildRelayContract('MEDIATION', ['alice', 'bob'], relayProfileId);
    if (mediationContract) {
      const schemaHash = computeOutputSchemaHash(
        mediationContract.output_schema as Record<string, unknown>,
      );
      events.push({
        ts: now(),
        type: 'system',
        agent: 'contract_enforcement',
        payload: {
          purpose_code: mediationContract.purpose_code,
          output_schema_id: mediationContract.output_schema_id,
          output_schema_hash: schemaHash,
          enforcement_policy_hash: mediationContract.enforcement_policy_hash ?? null,
          entropy_budget_bits: mediationContract.entropy_budget_bits ?? null,
          model_profile_id: mediationContract.model_profile_id ?? null,
        },
      });
    }
  } catch (err) {
    onWarn('Failed to emit contract parameters', err);
  }

  events.push({
    ts: now(),
    type: 'system',
    agent: 'relay_policy',
    payload: {
      policy_id: policySummary?.['policy_id'] ?? 'unknown',
      policy_hash: policySummary?.['policy_hash'] ?? 'unknown',
      model_profile_allowlist: policySummary?.['model_profile_allowlist'] ?? [],
      provider_allowlist: policySummary?.['provider_allowlist'] ?? [],
      enforcement_rules: policySummary?.['enforcement_rules'] ?? [],
      entropy_constraints: policySummary?.['entropy_constraints'] ?? null,
      verifying_key_hex: relayHealth['verifying_key_hex'] ?? 'unknown',
      model_id: relayHealth['model_id'] ?? 'unknown',
    },
  });

  return events;
}
