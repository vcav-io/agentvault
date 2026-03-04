/**
 * agentvault.get_identity — returns this agent's identity, known agents, and inbox status.
 */

import { buildSuccess, type ToolResponse } from '../envelope.js';
import type { NormalizedKnownAgent } from './relaySignal.js';

export interface InboxInvite {
  invite_id: string;
  from_agent_id?: string;
  afalPropose?: { purpose_code?: string };
}

export interface InboxService {
  checkInbox(): Promise<{ invites: InboxInvite[] }>;
  peekInbox?(): Promise<{ invites: InboxInvite[] }>;
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
  const agentId = process.env['AV_AGENT_ID'];
  const result: GetIdentityOutput = { agent_id: agentId, known_agents: knownAgents };

  if (inboxService) {
    try {
      const inbox = inboxService.peekInbox
        ? await inboxService.peekInbox()
        : await inboxService.checkInbox();
      result.pending_invites = inbox.invites.length;
      if (inbox.invites.length > 0) {
        const respondArgs: Record<string, unknown> = { mode: 'RESPOND' };
        // When exactly one invite, pre-fill from and purpose so the LLM
        // doesn't waste round-trips discovering required parameters.
        if (inbox.invites.length === 1) {
          const invite = inbox.invites[0];
          if (invite.from_agent_id) respondArgs['from'] = invite.from_agent_id;
          if (invite.afalPropose?.purpose_code) respondArgs['expected_purpose'] = invite.afalPropose.purpose_code;
        }
        result.next_action = {
          tool: 'agentvault.relay_signal',
          args: respondArgs,
          reason: 'pending_invite',
        };
        result.inbox_hint =
          `You have ${inbox.invites.length} pending invite(s).`;
      } else {
        result.inbox_hint = 'No pending invites.';
      }
    } catch (err) {
      // Best-effort: omit pending_invites entirely on failure.
      // Do NOT emit 0 — that would falsely indicate empty inbox.
      console.error('getIdentity: inbox check failed:', err instanceof Error ? err.message : String(err));
      result.inbox_hint = 'Warning: inbox check failed — call relay_signal in RESPOND mode to check manually.';
    }
  }

  return buildSuccess('SUCCESS', result);
}
