/**
 * Invite transport abstraction for relay session coordination.
 *
 * agentvault-mcp-server defines this interface; implementations live in
 * the host application (e.g., vcav-mcp-server provides an OrchestratorClient-backed
 * implementation). When running standalone, a manual/fallback transport prompts
 * the agent to exchange relay URLs directly.
 */

export interface InviteMessage {
  invite_id: string;
  from_agent_id: string;
  payload_type?: string;
  template_id?: string;
  contract_hash?: string;
  payload?: Record<string, unknown>;
}

export interface InviteTransport {
  /** Send a relay session invite to a counterparty. */
  sendInvite(params: {
    to_agent_id: string;
    template_id: string;
    budget_tier: string;
    payload_type: string;
    payload: Record<string, unknown>;
  }): Promise<void>;

  /** Check the inbox for pending invites. */
  checkInbox(): Promise<{ invites: InviteMessage[] }>;

  /** Accept a pending invite by ID (best-effort, non-fatal if it fails). */
  acceptInvite(inviteId: string): Promise<void>;

  /** The local agent's ID (used for contract building and idempotency). */
  readonly agentId: string;
}
