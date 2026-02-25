/**
 * agentvault.get_identity — returns this agent's identity and known agents.
 */

import { buildSuccess, type ToolResponse } from '../envelope.js';
import type { NormalizedKnownAgent } from './relaySignal.js';

export interface GetIdentityOutput {
  agent_id: string | undefined;
  known_agents: NormalizedKnownAgent[];
}

export function handleGetIdentity(
  knownAgents: NormalizedKnownAgent[],
): ToolResponse<GetIdentityOutput> {
  return buildSuccess('SUCCESS', {
    agent_id: process.env['VCAV_AGENT_ID'],
    known_agents: knownAgents,
  });
}
