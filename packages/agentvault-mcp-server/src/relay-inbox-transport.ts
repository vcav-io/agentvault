/**
 * Relay inbox transport — AfalTransport backed by the relay's async inbox API.
 *
 * Instead of peer-to-peer HTTP (DirectAfalTransport) or orchestrator inbox
 * (OrchestratorInboxAdapter), this transport uses the relay's built-in inbox
 * endpoints to deliver invites asynchronously.
 *
 * Key differences from other transports:
 * - sendPropose is not used (the FSM calls createRelayInvite directly)
 * - checkInbox maps relay inbox invites to AfalInviteMessage format
 * - acceptInvite returns AcceptResult with session tokens (not void)
 */

import { createInvite, pollInbox, getInvite, acceptInvite } from 'agentvault-client/inbox';
import type {
  RelayClientConfig,
  CreateInviteRequest,
  CreateInviteResponse,
  InviteDetailResponse,
} from 'agentvault-client/types';
import type { AfalTransport, AfalInviteMessage, AcceptResult } from './afal-transport.js';
import type { AfalPropose, RelayInvitePayload } from './afal-types.js';

/** Payload type marker for relay inbox invites (distinct from VCAV_E_INVITE_V1). */
export const RELAY_INBOX_PAYLOAD_TYPE = 'VCAV_RELAY_INBOX_V1';

export interface RelayInboxTransportConfig {
  agentId: string;
  inboxToken: string;
  relayUrl: string;
}

export class RelayInboxTransport implements AfalTransport {
  private readonly config: RelayClientConfig;
  private readonly inboxToken: string;
  private readonly _agentId: string;
  readonly relayUrl: string;

  constructor(opts: RelayInboxTransportConfig) {
    this._agentId = opts.agentId;
    this.inboxToken = opts.inboxToken;
    this.relayUrl = opts.relayUrl;
    this.config = { relay_url: opts.relayUrl };
  }

  get agentId(): string {
    return this._agentId;
  }

  /**
   * Not used in relay inbox mode — the FSM calls createRelayInvite directly.
   * Kept for interface compliance.
   */
  async sendPropose(_params: {
    propose: AfalPropose;
    relay: RelayInvitePayload;
    templateId: string;
    budgetTier: string;
  }): Promise<void> {
    throw new Error(
      'RelayInboxTransport does not support sendPropose — use createRelayInvite instead',
    );
  }

  /**
   * Poll relay inbox for pending invites, mapped to AfalInviteMessage format.
   */
  async checkInbox(): Promise<{ invites: AfalInviteMessage[] }> {
    const response = await pollInbox(this.config, this.inboxToken, {
      status: 'PENDING',
    });

    const invites: AfalInviteMessage[] = response.invites.map((summary) => ({
      invite_id: summary.invite_id,
      from_agent_id: summary.from_agent_id,
      contract_hash: summary.contract_hash,
      payload_type: RELAY_INBOX_PAYLOAD_TYPE,
      payload: {},
      afalPropose: {
        proposal_version: '1',
        proposal_id: '',
        nonce: '',
        timestamp: summary.created_at,
        from: summary.from_agent_id,
        to: this._agentId,
        purpose_code: summary.purpose_code,
        lane_id: 'API_MEDIATED',
        output_schema_id: '',
        output_schema_version: '1',
        requested_budget_tier: 'SMALL',
        requested_entropy_bits: 0,
        model_profile_id: '',
        model_profile_version: '1',
        admission_tier_requested: 'DEFAULT',
      },
    }));

    return { invites };
  }

  /**
   * Accept an invite via the relay's accept endpoint.
   * Returns AcceptResult with session tokens (unlike other transports which return undefined).
   */
  async acceptInvite(inviteId: string): Promise<AcceptResult> {
    const response = await acceptInvite(this.config, inviteId, this.inboxToken);
    return {
      session_id: response.session_id,
      submit_token: response.responder_submit_token,
      read_token: response.responder_read_token,
    };
  }

  /**
   * Create an invite via the relay inbox.
   * Used by the FSM's phaseInvite instead of createAndSubmit + sendPropose.
   */
  async createRelayInvite(params: {
    to_agent_id: string;
    contract: object;
    provider: string;
    purpose_code: string;
  }): Promise<CreateInviteResponse> {
    const request: CreateInviteRequest = {
      to_agent_id: params.to_agent_id,
      contract: params.contract,
      provider: params.provider,
      purpose_code: params.purpose_code,
    };
    return createInvite(this.config, request, this.inboxToken);
  }

  /**
   * Get invite detail (for initiator polling after creating invite).
   */
  async getInviteDetail(inviteId: string): Promise<InviteDetailResponse> {
    return getInvite(this.config, inviteId, this.inboxToken);
  }
}
