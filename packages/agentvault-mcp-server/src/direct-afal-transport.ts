/**
 * DirectAfalTransport — AFAL transport that sends Ed25519-signed messages
 * directly to a peer via HTTP, bypassing the orchestrator inbox.
 *
 * M3: INITIATE mode — resolves peer descriptor, signs PROPOSE, verifies
 * ADMIT/DENY, stores tokens for COMMIT.
 *
 * M4: RESPOND mode (opt-in) — runs an HTTP server that receives PROPOSE/COMMIT,
 * evaluates admission policy, and enqueues admitted proposals for checkInbox().
 */

import type { AfalTransport, AfalInviteMessage, AcceptResult } from './afal-transport.js';
import type { AfalPropose, RelayInvitePayload } from './afal-types.js';
import { signMessage, verifyMessage, DOMAIN_PREFIXES, contentHash } from './afal-signing.js';
import { AfalResponder } from './afal-responder.js';
import type { AdmissionPolicy } from './afal-responder.js';
import { AfalHttpServer } from './afal-http-server.js';

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

export function isAgentDescriptor(value: unknown): value is AgentDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.descriptor_version === 'string' &&
    typeof v.agent_id === 'string' &&
    typeof v.issued_at === 'string' &&
    typeof v.expires_at === 'string' &&
    typeof v.identity_key === 'object' &&
    v.identity_key !== null &&
    typeof v.envelope_key === 'object' &&
    v.envelope_key !== null &&
    typeof v.endpoints === 'object' &&
    v.endpoints !== null &&
    typeof v.capabilities === 'object' &&
    v.capabilities !== null &&
    typeof v.policy_commitments === 'object' &&
    v.policy_commitments !== null
  );
}

// ── DirectAfalTransport ────────────────────────────────────────────────────

export interface DirectAfalTransportConfig {
  agentId: string;
  seedHex: string;
  localDescriptor: AgentDescriptor;
  peerDescriptorUrl?: string;
  respondMode?: {
    httpPort: number;
    bindAddress?: string;
    policy: AdmissionPolicy;
  };
}

export class DirectAfalTransport implements AfalTransport {
  private readonly config: DirectAfalTransportConfig;
  private peerDescriptor: AgentDescriptor | null = null;
  private storedAdmits = new Map<string, Record<string, unknown>>();
  private readonly responder: AfalResponder | null;
  private readonly httpServer: AfalHttpServer | null;

  constructor(config: DirectAfalTransportConfig) {
    this.config = config;

    if (config.respondMode) {
      this.responder = new AfalResponder({
        agentId: config.agentId,
        seedHex: config.seedHex,
        policy: config.respondMode.policy,
      });

      // Fill in descriptor endpoints based on HTTP server config and re-sign.
      // The descriptor signature covers endpoints, so any modification
      // requires re-signing with the agent's seed.
      const bindAddr = config.respondMode.bindAddress ?? '127.0.0.1';
      const base = `http://${bindAddr}:${config.respondMode.httpPort}`;
      const { signature: _, ...unsignedDescriptor } = config.localDescriptor as AgentDescriptor & {
        signature?: string;
      };
      const descriptorWithEndpoints = {
        ...unsignedDescriptor,
        endpoints: {
          ...unsignedDescriptor.endpoints,
          propose: `${base}/afal/propose`,
          commit: `${base}/afal/commit`,
        },
      };
      const signedDescriptorRaw = signMessage(
        DOMAIN_PREFIXES.DESCRIPTOR,
        descriptorWithEndpoints as unknown as Record<string, unknown>,
        config.seedHex,
      );
      if (!isAgentDescriptor(signedDescriptorRaw)) {
        throw new Error('signMessage produced invalid AgentDescriptor in constructor');
      }
      const signedDescriptor = signedDescriptorRaw;

      this.httpServer = new AfalHttpServer({
        port: config.respondMode.httpPort,
        bindAddress: config.respondMode.bindAddress,
        responder: this.responder,
        localDescriptor: signedDescriptor,
      });
    } else {
      this.responder = null;
      this.httpServer = null;
    }
  }

  get agentId(): string {
    return this.config.agentId;
  }

  async start(): Promise<void> {
    if (!this.httpServer) return;

    await this.httpServer.start();

    // If port was 0 (random), re-sign descriptor with actual port
    if (this.config.respondMode?.httpPort === 0) {
      const bindAddr = this.config.respondMode.bindAddress ?? '127.0.0.1';
      const base = `http://${bindAddr}:${this.httpServer.port}`;
      const { signature: _s, ...unsigned } = this.httpServer.localDescriptor as AgentDescriptor & {
        signature?: string;
      };
      const updated = {
        ...unsigned,
        endpoints: {
          ...unsigned.endpoints,
          propose: `${base}/afal/propose`,
          commit: `${base}/afal/commit`,
        },
      };
      const reSignedRaw = signMessage(
        DOMAIN_PREFIXES.DESCRIPTOR,
        updated as unknown as Record<string, unknown>,
        this.config.seedHex,
      );
      if (!isAgentDescriptor(reSignedRaw)) {
        throw new Error('signMessage produced invalid AgentDescriptor in start()');
      }
      this.httpServer.setDescriptor(reSignedRaw);
    }
  }

  async stop(): Promise<void> {
    if (this.httpServer) await this.httpServer.stop();
  }

  // No transport-level retries — the relay_signal FSM handles retries via
  // PROPOSE_RETRY phase with CALL_AGAIN cycling (up to 120s overall timeout).
  async sendPropose(params: {
    propose: AfalPropose;
    relay: RelayInvitePayload;
    templateId: string;
    budgetTier: string;
  }): Promise<void> {
    const peer = await this.resolvePeerDescriptor();

    // Verify the resolved peer descriptor matches the intended recipient
    if (peer.agent_id !== params.propose.to) {
      throw new Error(
        `Peer descriptor agent_id "${peer.agent_id}" does not match propose.to "${params.propose.to}"`,
      );
    }

    // Never inject hashable fields post-hoc — they must be set before
    // computeProposalId or proposal_id integrity will fail on the receiver.
    const proposeMessage: Record<string, unknown> = {
      proposal_version: params.propose.proposal_version,
      proposal_id: params.propose.proposal_id,
      nonce: params.propose.nonce,
      timestamp: params.propose.timestamp,
      from: params.propose.from,
      to: params.propose.to,
      purpose_code: params.propose.purpose_code,
      lane_id: params.propose.lane_id,
      output_schema_id: params.propose.output_schema_id,
      output_schema_version: params.propose.output_schema_version,
      model_profile_id: params.propose.model_profile_id,
      model_profile_version: params.propose.model_profile_version,
      requested_entropy_bits: params.propose.requested_entropy_bits,
      requested_budget_tier: params.propose.requested_budget_tier,
      admission_tier_requested: params.propose.admission_tier_requested,
    };

    if (params.propose.descriptor_hash !== undefined) {
      proposeMessage['descriptor_hash'] = params.propose.descriptor_hash;
    }
    if (params.propose.model_profile_hash !== undefined) {
      proposeMessage['model_profile_hash'] = params.propose.model_profile_hash;
    }

    if (params.propose.prev_receipt_hash !== undefined) {
      proposeMessage['prev_receipt_hash'] = params.propose.prev_receipt_hash;
    }

    // Bind the relay payload to the signed PROPOSE envelope so the receiver
    // can verify the relay tokens haven't been tampered with in transit.
    const relayBindingHash = contentHash(params.relay);
    proposeMessage['relay_binding_hash'] = relayBindingHash;

    const signed = signMessage(DOMAIN_PREFIXES.PROPOSE, proposeMessage, this.config.seedHex);

    // M4: wrapped body with relay tokens alongside the signed PROPOSE
    const wrappedBody = { propose: signed, relay: params.relay };

    const response = await fetch(peer.endpoints.propose, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wrappedBody),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`PROPOSE rejected: ${response.status} ${body}`);
    }

    let admitOrDeny: Record<string, unknown>;
    try {
      admitOrDeny = (await response.json()) as Record<string, unknown>;
    } catch (parseErr) {
      throw new Error(
        `PROPOSE endpoint returned non-JSON response (${response.status}): ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`,
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
      const denyCode = admitOrDeny['deny_code'] ?? 'UNKNOWN';
      throw new Error(
        `Proposal denied (deny_code=${denyCode}): proposal=${params.propose.proposal_id}, from=${params.propose.from}, to=${params.propose.to}, purpose=${params.propose.purpose_code}`,
      );
    } else {
      throw new Error(`Unexpected response outcome: ${String(outcome)}`);
    }
  }

  async checkInbox(): Promise<{ invites: AfalInviteMessage[] }> {
    if (!this.responder) {
      // INITIATE mode only — no incoming proposals
      return { invites: [] };
    }

    // RESPOND mode — drain admitted proposals from the responder queue
    const admitted = this.responder.drainQueue();
    return { invites: this.mapAdmitted(admitted) };
  }

  async peekInbox(): Promise<{ invites: AfalInviteMessage[] }> {
    if (!this.responder) {
      return { invites: [] };
    }

    // Non-destructive — items remain in queue for checkInbox() to drain later
    const admitted = this.responder.peekQueue();
    return { invites: this.mapAdmitted(admitted) };
  }

  private mapAdmitted(admitted: { propose: AfalPropose; relay: { session_id: string; responder_submit_token: string; responder_read_token: string; relay_url: string }; proposerAgentId: string }[]): AfalInviteMessage[] {
    return admitted.map((item) => ({
      invite_id: item.propose.proposal_id,
      from_agent_id: item.proposerAgentId,
      payload_type: 'VCAV_E_INVITE_V1',
      payload: {
        session_id: item.relay.session_id,
        responder_submit_token: item.relay.responder_submit_token,
        responder_read_token: item.relay.responder_read_token,
        relay_url: item.relay.relay_url,
      },
      afalPropose: item.propose,
    }));
  }

  async acceptInvite(inviteId: string): Promise<AcceptResult | undefined> {
    // RESPOND mode: remove the consumed invite from the queue so subsequent
    // peekInbox() calls don't rediscover stale invites pointing to dead sessions.
    if (this.responder) {
      this.responder.removeFromQueue(inviteId);
      return;
    }

    // INITIATE mode: inviteId is the proposal_id — look up stored ADMIT
    const admit = this.storedAdmits.get(inviteId);
    if (!admit) {
      throw new Error(`No stored ADMIT for proposal_id: ${inviteId}`);
    }

    const peer = await this.resolvePeerDescriptor();

    const commitMessage: Record<string, unknown> = {
      commit_version: '1',
      proposal_id: inviteId,
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
      throw new Error(
        'Cannot initiate: no peer connection configured. ' +
        'Check your inbox for pending invites (call get_identity) and use RESPOND mode instead.',
      );
    }

    const response = await fetch(this.config.peerDescriptorUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch peer descriptor: ${response.status}`);
    }

    let raw: Record<string, unknown>;
    try {
      raw = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`Peer descriptor from ${this.config.peerDescriptorUrl} returned non-JSON`);
    }

    // Validate required nested structure before trusting the cast
    const identityKey = (raw as Record<string, unknown>).identity_key as
      | Record<string, unknown>
      | undefined;
    if (
      !identityKey ||
      typeof identityKey !== 'object' ||
      typeof identityKey.public_key_hex !== 'string'
    ) {
      throw new Error(
        `Peer descriptor from ${this.config.peerDescriptorUrl} is malformed: missing or invalid identity_key.public_key_hex`,
      );
    }
    const endpoints = (raw as Record<string, unknown>).endpoints as
      | Record<string, unknown>
      | undefined;
    if (
      !endpoints ||
      typeof endpoints !== 'object' ||
      typeof endpoints.propose !== 'string' ||
      typeof endpoints.commit !== 'string'
    ) {
      throw new Error(
        `Peer descriptor from ${this.config.peerDescriptorUrl} is malformed: missing required endpoints (propose, commit)`,
      );
    }

    if (!isAgentDescriptor(raw)) {
      throw new Error(
        `Peer descriptor from ${this.config.peerDescriptorUrl} is malformed: failed structural validation`,
      );
    }
    const descriptor = raw;

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
