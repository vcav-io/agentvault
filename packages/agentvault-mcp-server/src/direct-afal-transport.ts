/**
 * DirectAfalTransport — AFAL transport that sends Ed25519-signed messages
 * directly to a peer via HTTP, bypassing the orchestrator inbox.
 *
 * M3 MVP: INITIATE mode only. The transport resolves and verifies the peer's
 * descriptor, signs PROPOSE with the agent's Ed25519 seed, verifies ADMIT/DENY
 * responses, and stores ADMIT tokens for a subsequent COMMIT step.
 */

import type { AfalTransport, AfalInviteMessage } from './afal-transport.js';
import type { AfalPropose, RelayInvitePayload } from './afal-types.js';
import {
  signMessage,
  verifyMessage,
  DOMAIN_PREFIXES,
  contentHash,
} from './afal-signing.js';

// ── AgentDescriptor ────────────────────────────────────────────────────────

export interface AgentDescriptor {
  descriptor_version: string;
  agent_id: string;
  issued_at: string;
  expires_at: string;
  identity_key: {
    algorithm: string;
    public_key_hex: string;
  };
  envelope_key: {
    algorithm: string;
    public_key_hex: string;
  };
  endpoints: {
    propose: string;
    commit: string;
    message?: string;
    receipts?: string;
  };
  capabilities: Record<string, unknown>;
  policy_commitments: Record<string, unknown>;
  signature?: string;
}

// ── DirectAfalTransport ────────────────────────────────────────────────────

export interface DirectAfalTransportConfig {
  agentId: string;
  seedHex: string;
  localDescriptor: AgentDescriptor;
  peerDescriptorUrl?: string;
}

export class DirectAfalTransport implements AfalTransport {
  private readonly config: DirectAfalTransportConfig;
  private peerDescriptor: AgentDescriptor | null = null;
  private storedAdmits = new Map<string, Record<string, unknown>>();

  constructor(config: DirectAfalTransportConfig) {
    this.config = config;
  }

  get agentId(): string {
    return this.config.agentId;
  }

  async sendPropose(params: {
    propose: AfalPropose;
    relay: RelayInvitePayload;
    templateId: string;
    budgetTier: string;
  }): Promise<void> {
    const peer = await this.resolvePeerDescriptor();

    const proposeMessage: Record<string, unknown> = {
      proposal_version: params.propose.proposal_version,
      proposal_id: params.propose.proposal_id,
      nonce: params.propose.nonce,
      timestamp: params.propose.timestamp,
      from: params.propose.from,
      to: params.propose.to,
      descriptor_hash:
        params.propose.descriptor_hash ?? contentHash(this.config.localDescriptor),
      purpose_code: params.propose.purpose_code,
      lane_id: params.propose.lane_id,
      output_schema_id: params.propose.output_schema_id,
      output_schema_version: params.propose.output_schema_version,
      model_profile_id: params.propose.model_profile_id,
      model_profile_version: params.propose.model_profile_version,
      model_profile_hash: params.propose.model_profile_hash ?? '',
      requested_entropy_bits: params.propose.requested_entropy_bits,
      requested_budget_tier: params.propose.requested_budget_tier,
      admission_tier_requested: params.propose.admission_tier_requested,
    };

    if (params.propose.prev_receipt_hash !== undefined) {
      proposeMessage['prev_receipt_hash'] = params.propose.prev_receipt_hash;
    }

    const signed = signMessage(DOMAIN_PREFIXES.PROPOSE, proposeMessage, this.config.seedHex);

    const response = await fetch(peer.endpoints.propose, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`PROPOSE rejected: ${response.status} ${body}`);
    }

    let admitOrDeny: Record<string, unknown>;
    try {
      admitOrDeny = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error(
        `PROPOSE endpoint returned non-JSON response (${response.status})`,
      );
    }
    const outcome = admitOrDeny['outcome'];

    if (outcome === 'ADMIT') {
      const verified = verifyMessage(
        DOMAIN_PREFIXES.ADMIT,
        admitOrDeny,
        peer.identity_key.public_key_hex,
      );
      if (!verified) {
        throw new Error('ADMIT signature verification failed');
      }
      if (typeof admitOrDeny['admit_token_id'] !== 'string' || !admitOrDeny['admit_token_id']) {
        throw new Error(
          `ADMIT response missing required admit_token_id for proposal: ${params.propose.proposal_id}`,
        );
      }
      this.storedAdmits.set(params.propose.proposal_id, admitOrDeny);
    } else if (outcome === 'DENY') {
      const verified = verifyMessage(
        DOMAIN_PREFIXES.DENY,
        admitOrDeny,
        peer.identity_key.public_key_hex,
      );
      if (!verified) {
        throw new Error('DENY signature verification failed');
      }
      throw new Error(`Proposal denied: ${params.propose.proposal_id}`);
    } else {
      throw new Error(`Unexpected response outcome: ${String(outcome)}`);
    }
  }

  async checkInbox(): Promise<{ invites: AfalInviteMessage[] }> {
    // INITIATE mode only — no incoming proposals in M3
    return { invites: [] };
  }

  async acceptInvite(inviteId: string): Promise<void> {
    // For INITIATOR: inviteId is the proposal_id — look up stored ADMIT
    const admit = this.storedAdmits.get(inviteId);
    if (!admit) {
      throw new Error(`No stored ADMIT for proposal_id: ${inviteId}`);
    }

    const peer = await this.resolvePeerDescriptor();

    const commitMessage: Record<string, unknown> = {
      commit_version: '1',
      from: this.config.agentId,
      admit_token_id: admit['admit_token_id'] as string,
      encrypted_input_hash: contentHash({}),
      agent_descriptor_hash: contentHash(this.config.localDescriptor),
    };

    const signedCommit = signMessage(DOMAIN_PREFIXES.COMMIT, commitMessage, this.config.seedHex);

    const response = await fetch(peer.endpoints.commit, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedCommit),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`COMMIT rejected: ${response.status} ${body}`);
    }

    this.storedAdmits.delete(inviteId);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async resolvePeerDescriptor(): Promise<AgentDescriptor> {
    if (this.peerDescriptor !== null) {
      const expiresMs = Date.parse(this.peerDescriptor.expires_at);
      if (Number.isNaN(expiresMs)) {
        console.error(
          `resolvePeerDescriptor: cached descriptor has unparseable expires_at: "${this.peerDescriptor.expires_at}". Re-fetching.`,
        );
        this.peerDescriptor = null;
      } else if (expiresMs > Date.now()) {
        return this.peerDescriptor;
      } else {
        this.peerDescriptor = null;
      }
    }

    if (!this.config.peerDescriptorUrl) {
      throw new Error('No peer descriptor URL configured');
    }

    const response = await fetch(this.config.peerDescriptorUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch peer descriptor: ${response.status}`);
    }

    let raw: Record<string, unknown>;
    try {
      raw = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Peer descriptor from ${this.config.peerDescriptorUrl} returned non-JSON`,
      );
    }

    // Validate required nested structure before trusting the cast
    const identityKey = (raw as Record<string, unknown>).identity_key as Record<string, unknown> | undefined;
    if (!identityKey || typeof identityKey !== 'object' || typeof identityKey.public_key_hex !== 'string') {
      throw new Error(
        `Peer descriptor from ${this.config.peerDescriptorUrl} is malformed: missing or invalid identity_key.public_key_hex`,
      );
    }
    const endpoints = (raw as Record<string, unknown>).endpoints as Record<string, unknown> | undefined;
    if (!endpoints || typeof endpoints !== 'object' || typeof endpoints.propose !== 'string' || typeof endpoints.commit !== 'string') {
      throw new Error(
        `Peer descriptor from ${this.config.peerDescriptorUrl} is malformed: missing required endpoints (propose, commit)`,
      );
    }

    const descriptor = raw as unknown as AgentDescriptor;

    const verified = verifyMessage(
      DOMAIN_PREFIXES.DESCRIPTOR,
      raw,
      identityKey.public_key_hex as string,
    );
    if (!verified) {
      throw new Error('Peer descriptor signature verification failed');
    }

    this.peerDescriptor = descriptor;
    return descriptor;
  }

  // ── Test helpers ──────────────────────────────────────────────────────────

  /** Inject a peer descriptor directly (testing only). */
  _setPeerDescriptorForTesting(descriptor: AgentDescriptor): void {
    this.peerDescriptor = descriptor;
  }

  /** Get a stored ADMIT (testing only). */
  _getStoredAdmit(proposalId: string): Record<string, unknown> | undefined {
    return this.storedAdmits.get(proposalId);
  }
}
