/**
 * AFAL transport abstraction and orchestrator inbox adapter.
 *
 * AfalTransport is the interface consumed by relaySignal. It speaks AFAL
 * propose shapes. OrchestratorInboxAdapter bridges InviteTransport (host-provided)
 * to AfalTransport by serializing AfalPropose as an `afal_propose_draft` wrapper
 * inside the existing VCAV_E_INVITE_V1 payload.
 *
 * When DirectAfalTransport ships, it serializes the same AfalPropose with real
 * Ed25519 signatures — no internal type changes needed.
 */

import type { InviteTransport, InviteMessage } from './invite-transport.js';
import type { AfalPropose, RelayInvitePayload } from './afal-types.js';
import { hasAfalDraft, computeProposalId } from './afal-types.js';

// ── AfalTransport Interface ─────────────────────────────────────────────

export interface AfalInviteMessage extends InviteMessage {
  afalPropose?: AfalPropose;
}

/** Returned by acceptInvite when the transport provides session tokens (relay inbox). */
export interface AcceptResult {
  session_id: string;
  submit_token: string;
  read_token: string;
}

/** Type guard for AcceptResult. Existing transports return undefined. */
export function isAcceptResult(value: unknown): value is AcceptResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.session_id === 'string' &&
    typeof v.submit_token === 'string' &&
    typeof v.read_token === 'string'
  );
}

export interface AfalTransport {
  sendPropose(params: {
    propose: AfalPropose;
    relay: RelayInvitePayload;
    templateId: string;
    budgetTier: string;
  }): Promise<void>;

  checkInbox(): Promise<{ invites: AfalInviteMessage[] }>;

  /** Non-destructive inbox check — items remain in queue for checkInbox() to drain. */
  peekInbox(): Promise<{ invites: AfalInviteMessage[] }>;

  acceptInvite(inviteId: string, expectedContractHash?: string): Promise<AcceptResult | undefined>;

  readonly agentId: string;
}

// ── Purpose → Template Mapping ──────────────────────────────────────────

export const PURPOSE_TO_TEMPLATE: Record<string, string> = {
  MEDIATION: 'mediation-demo.v1.standard',
  COMPATIBILITY: 'dating.v1.d2',
};

// ── OrchestratorInboxAdapter ────────────────────────────────────────────

/**
 * Adapts an InviteTransport (host-provided, e.g. OrchestratorClient-backed)
 * into an AfalTransport by embedding AfalPropose as `afal_propose_draft`
 * in the existing VCAV_E_INVITE_V1 payload.
 */
export class OrchestratorInboxAdapter implements AfalTransport {
  private readonly transport: InviteTransport;

  constructor(transport: InviteTransport) {
    this.transport = transport;
  }

  get agentId(): string {
    return this.transport.agentId;
  }

  async sendPropose(params: {
    propose: AfalPropose;
    relay: RelayInvitePayload;
    templateId: string;
    budgetTier: string;
  }): Promise<void> {
    const { propose, relay, templateId, budgetTier } = params;

    const draft: Record<string, unknown> = {
      compliance: 'UNSIGNED',
      proposal_version: propose.proposal_version,
      proposal_id: propose.proposal_id,
      nonce: propose.nonce,
      timestamp: propose.timestamp,
      from: propose.from,
      to: propose.to,
      purpose_code: propose.purpose_code,
      lane_id: propose.lane_id,
      output_schema_id: propose.output_schema_id,
      output_schema_version: propose.output_schema_version,
      requested_budget_tier: propose.requested_budget_tier,
      requested_entropy_bits: propose.requested_entropy_bits,
      model_profile_id: propose.model_profile_id,
      model_profile_version: propose.model_profile_version,
      admission_tier_requested: propose.admission_tier_requested,
    };

    // Include optional fields only if present (absent vs placeholder rule)
    if (propose.descriptor_hash !== undefined) draft['descriptor_hash'] = propose.descriptor_hash;
    if (propose.model_profile_hash !== undefined)
      draft['model_profile_hash'] = propose.model_profile_hash;
    if (propose.prev_receipt_hash !== undefined)
      draft['prev_receipt_hash'] = propose.prev_receipt_hash;
    // signature is always omitted in M2 (compliance: UNSIGNED)

    await this.transport.sendInvite({
      to_agent_id: propose.to,
      template_id: templateId,
      budget_tier: budgetTier,
      payload_type: 'VCAV_E_INVITE_V1',
      payload: {
        session_id: relay.session_id,
        responder_submit_token: relay.responder_submit_token,
        responder_read_token: relay.responder_read_token,
        relay_url: relay.relay_url,
        afal_propose_draft: draft,
      },
    });
  }

  async checkInbox(): Promise<{ invites: AfalInviteMessage[] }> {
    const response = await this.transport.checkInbox();
    const invites: AfalInviteMessage[] = (response.invites ?? []).map(
      (invite: InviteMessage): AfalInviteMessage => {
        if (!invite.payload || !hasAfalDraft(invite.payload)) {
          return invite;
        }

        const draft = invite.payload['afal_propose_draft'] as Record<string, unknown>;

        // Validate compliance field — M2 only supports UNSIGNED
        const compliance = draft['compliance'];
        if (typeof compliance === 'string' && compliance !== 'UNSIGNED') {
          console.error(
            `checkInbox: invite ${invite.invite_id} has unsupported compliance: ${compliance}. Treating as legacy.`,
          );
          return invite;
        }

        // Validate all required string fields are present and correctly typed
        const requiredStrings = [
          'proposal_version',
          'proposal_id',
          'nonce',
          'timestamp',
          'from',
          'to',
          'purpose_code',
          'lane_id',
          'output_schema_id',
          'output_schema_version',
          'requested_budget_tier',
          'model_profile_id',
          'model_profile_version',
          'admission_tier_requested',
        ] as const;

        const missingField = requiredStrings.find((f) => typeof draft[f] !== 'string' || !draft[f]);
        if (missingField || typeof draft['requested_entropy_bits'] !== 'number') {
          console.error(
            `checkInbox: malformed afal_propose_draft in invite ${invite.invite_id}, ` +
              `invalid field: ${missingField ?? 'requested_entropy_bits'}. Treating as legacy.`,
          );
          return invite;
        }

        const afalPropose: AfalPropose = {
          proposal_version: draft['proposal_version'] as string,
          proposal_id: draft['proposal_id'] as string,
          nonce: draft['nonce'] as string,
          timestamp: draft['timestamp'] as string,
          from: draft['from'] as string,
          to: draft['to'] as string,
          purpose_code: draft['purpose_code'] as string,
          lane_id: draft['lane_id'] as string,
          output_schema_id: draft['output_schema_id'] as string,
          output_schema_version: draft['output_schema_version'] as string,
          requested_budget_tier: draft['requested_budget_tier'] as string,
          requested_entropy_bits: draft['requested_entropy_bits'] as number,
          model_profile_id: draft['model_profile_id'] as string,
          model_profile_version: draft['model_profile_version'] as string,
          admission_tier_requested: draft['admission_tier_requested'] as string,
          // Optional fields — only set if present and correctly typed
          ...(typeof draft['descriptor_hash'] === 'string' && {
            descriptor_hash: draft['descriptor_hash'],
          }),
          ...(typeof draft['model_profile_hash'] === 'string' && {
            model_profile_hash: draft['model_profile_hash'],
          }),
          ...(typeof draft['prev_receipt_hash'] === 'string' && {
            prev_receipt_hash: draft['prev_receipt_hash'],
          }),
          ...(typeof draft['signature'] === 'string' && { signature: draft['signature'] }),
        };

        // Verify proposal_id integrity — recompute and check
        const { proposal_id: claimed, ...hashableFields } = afalPropose;
        const expected = computeProposalId(hashableFields);
        if (claimed !== expected) {
          console.error(
            `checkInbox: proposal_id mismatch in invite ${invite.invite_id}: ` +
              `claimed=${claimed.slice(0, 16)}… expected=${expected.slice(0, 16)}…. Treating as legacy.`,
          );
          return invite;
        }

        return { ...invite, afalPropose };
      },
    );

    return { invites };
  }

  async peekInbox(): Promise<{ invites: AfalInviteMessage[] }> {
    // OrchestratorInboxAdapter delegates to the same checkInbox — the orchestrator
    // endpoint is stateless (peek semantics, not drain). Items remain available.
    return this.checkInbox();
  }

  async acceptInvite(inviteId: string, _expectedContractHash?: string): Promise<AcceptResult | undefined> {
    await this.transport.acceptInvite(inviteId);
    return undefined;
  }
}
