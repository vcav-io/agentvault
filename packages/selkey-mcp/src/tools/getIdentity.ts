/**
 * selkey.get_identity — returns this agent's identity, known agents, and inbox status.
 */

import { buildSuccess, type ToolResponse } from '../envelope.js';
import type { NormalizedKnownAgent } from './relaySignal.js';
import { remainingBudget, type RemainingBudget } from '../entropy-ledger.js';

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
  pending_ifc_messages?: number;
  next_action?: NextAction;
  inbox_hint?: string;
  /** Owner-side disclosure budget left in the current window (global and per counterparty). */
  remaining_budget?: RemainingBudget;
}

export async function handleGetIdentity(
  agentId: string | undefined,
  knownAgents: NormalizedKnownAgent[],
  inboxService?: InboxService,
  ifcPendingCount = 0,
): Promise<ToolResponse<GetIdentityOutput>> {
  const result: GetIdentityOutput = { agent_id: agentId, known_agents: knownAgents };

  if (inboxService) {
    try {
      const inbox = inboxService.peekInbox
        ? await inboxService.peekInbox()
        : await inboxService.checkInbox();
      result.pending_invites = inbox.invites.length;
      if (inbox.invites.length > 0) {
        // Do not pre-fill from/expected_purpose from the invite: the responder
        // decides who it expects and which contracts it accepts.
        const respondArgs: Record<string, unknown> = { mode: 'RESPOND' };
        result.next_action = {
          tool: 'selkey.relay_signal',
          args: respondArgs,
          reason: 'pending_invite',
        };
        result.inbox_hint =
          `You have ${inbox.invites.length} pending invite(s). ` +
          'Call relay_signal RESPOND with from set to the agent you expect to hear from.';
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

  result.pending_ifc_messages = ifcPendingCount;
  result.remaining_budget = remainingBudget(knownAgents.map((agent) => agent.agent_id));
  if ((!result.pending_invites || result.pending_invites === 0) && ifcPendingCount > 0) {
    result.next_action = {
      tool: 'selkey.read_ifc_messages',
      args: {},
      reason: 'pending_ifc_messages',
    };
    result.inbox_hint = `You have ${ifcPendingCount} pending IFC message(s).`;
  }

  return buildSuccess('SUCCESS', result);
}
