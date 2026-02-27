/**
 * agentvault.get_identity — returns this agent's identity, known agents, and inbox status.
 */

import { buildSuccess, type ToolResponse } from '../envelope.js';
import type { NormalizedKnownAgent } from './relaySignal.js';

export interface InboxService {
  checkInbox(): Promise<{ invites: { invite_id: string }[] }>;
}

export interface NextAction {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface GetIdentityOutput {
  agent_id: string | undefined;
  known_agents: NormalizedKnownAgent[];
  pending_invites?: number;
  next_action?: NextAction;
  inbox_hint?: string;
}

export async function handleGetIdentity(
  knownAgents: NormalizedKnownAgent[],
  inboxService?: InboxService,
): Promise<ToolResponse<GetIdentityOutput>> {
  const agentId = process.env['VCAV_AGENT_ID'];
  const result: GetIdentityOutput = { agent_id: agentId, known_agents: knownAgents };

  if (inboxService) {
    try {
      const inbox = await inboxService.checkInbox();
      result.pending_invites = inbox.invites.length;
      if (inbox.invites.length > 0) {
        result.next_action = {
          tool: 'agentvault.relay_signal',
          args: { mode: 'RESPOND' },
          reason: 'pending_invite',
        };
        result.inbox_hint =
          `You have ${inbox.invites.length} pending invite(s). ` +
          'Use agentvault.relay_signal in RESPOND mode to review.';
      }
    } catch {
      // Best-effort: omit pending_invites entirely on failure.
      // Do NOT emit 0 — that would falsely indicate empty inbox.
    }
  }

  return buildSuccess('SUCCESS', result);
}
