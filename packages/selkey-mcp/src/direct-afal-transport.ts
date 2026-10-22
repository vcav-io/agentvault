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
import type { AfalAdmit, AfalPropose, RelayInvitePayload, RelaySessionBinding } from './afal-types.js';
import { signMessage, verifyMessage, DOMAIN_PREFIXES, contentHash } from './afal-signing.js';
import { AfalResponder } from './afal-responder.js';
import type { AdmissionPolicy, AdmittedProposal } from './afal-responder.js';
import { AfalHttpServer } from './afal-http-server.js';
import { SELKEY_A2A_EXTENSION_URI, verifyAgentCardSignature } from './a2a-agent-card.js';
import type { SelkeyA2AExtensionParams } from './a2a-agent-card.js';
import type { ModelProfileRef } from './model-profiles.js';
import type { IfcService } from './ifc.js';
import {
  A2A_SEND_MESSAGE_PATH,
  SELKEY_ADMIT_MEDIA_TYPE,
  SELKEY_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
  SELKEY_CONTRACT_OFFER_SELECTION_MEDIA_TYPE,
  SELKEY_DENY_MEDIA_TYPE,
  SELKEY_PROPOSE_MEDIA_TYPE,
  SELKEY_SESSION_TOKENS_MEDIA_TYPE,
  SELKEY_TOPIC_ALIGNMENT_PROPOSAL_MEDIA_TYPE,
  SELKEY_TOPIC_ALIGNMENT_SELECTION_MEDIA_TYPE,
  buildA2ASendMessageRequest,
  parseA2ATaskPart,
} from './a2a-messages.js';
import type { ContractOfferProposal, ContractOfferSelection, SupportedContractOffer } from './contract-negotiation.js';
import { parseContractOfferSelection, parseSupportedContractOffers } from './contract-negotiation.js';
import type { TopicAlignmentProposal, TopicAlignmentSelection } from './topic-alignment.js';
import { parseTopicAlignmentSelection } from './topic-alignment.js';
import { PinError, PinStore } from './pin-store.js';
import { signNegotiationRequest } from './negotiation-auth.js';
import { assertSelectionWithinProposal } from './contract-negotiation.js';
import { assertTopicSelectionWithinProposal } from './topic-alignment.js';

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
    negotiate?: string;
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

interface AgentCard {
  name?: string;
  url?: string;
  capabilities?: {
    extensions?: Array<{
      uri?: string;
      params?: Record<string, unknown>;
    }>;
  };
}

export interface SelkeyPeerDiscovery {
  relayUrl?: string;
  supportedPurposes: string[];
  afalEndpoint?: string;
  a2aSendMessageUrl?: string;
  supportsTopicAlignment?: boolean;
  supportedTopicCodes?: string[];
  supportsPrecontractNegotiation?: boolean;
  supportsBespokeContractNegotiation?: boolean;
  supportedContractOffers?: SupportedContractOffer[];
}

interface PeerTransportTarget {
  proposeUrl: string;
  commitUrl: string;
  useA2ANative: boolean;
}

interface PeerNegotiationTarget {
  negotiateUrl: string;
  useA2ANative: boolean;
}

// ── DirectAfalTransport ────────────────────────────────────────────────────

export interface DirectAfalTransportConfig {
  agentId: string;
  seedHex: string;
  localDescriptor: AgentDescriptor;
  relayUrl?: string;
  peerDescriptorUrl?: string;
  /** @deprecated Unsigned agent cards are never used; this option has no effect. */
  requireSignedCards?: boolean;
  /**
   * Agent identity pins. Every peer signature is verified against the pinned
   * key for the peer's agent_id. Defaults to an in-memory store seeded from
   * respondMode.policy.trustedAgents.
   */
  pinStore?: PinStore;
  respondMode?: {
    httpPort: number;
    bindAddress?: string;
    policy: AdmissionPolicy;
    advertiseAfalEndpoint?: boolean;
  };
}

export class DirectAfalTransport implements AfalTransport {
  private readonly config: DirectAfalTransportConfig;
  private peerDescriptor: AgentDescriptor | null = null;
  private peerDiscovery: SelkeyPeerDiscovery | null = null;
  private storedAdmits = new Map<string, AfalAdmit>();
  private storedAdmitPeers = new Map<string, string>();
  private readonly responder: AfalResponder | null;
  private readonly httpServer: AfalHttpServer | null;
  readonly pinStore: PinStore;

  constructor(config: DirectAfalTransportConfig) {
    this.config = config;
    this.pinStore =
      config.pinStore ??
      PinStore.inMemory(
        (config.respondMode?.policy.trustedAgents ?? []).map((a) => ({
          agentId: a.agentId,
          publicKeyHex: a.publicKeyHex,
        })),
      );

    if (config.respondMode) {
      this.responder = new AfalResponder({
        agentId: config.agentId,
        seedHex: config.seedHex,
        policy: config.respondMode.policy,
        supportedModelProfiles: parseSupportedModelProfiles(config.localDescriptor),
        pins: this.pinStore,
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
          negotiate: `${base}/afal/negotiate`,
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
        relayUrl: config.relayUrl,
        supportedPurposes: config.respondMode.policy.allowedPurposeCodes,
        advertiseAfalEndpoint: config.respondMode.advertiseAfalEndpoint,
        seedHex: config.seedHex,
      });
    } else {
      this.responder = null;
      this.httpServer = null;
    }
  }

  get agentId(): string {
    return this.config.agentId;
  }

  /** Relay URL from this agent's own configuration (never peer-supplied). */
  get localRelayUrl(): string | undefined {
    return this.config.relayUrl;
  }

  /** Purpose codes this agent admits as a responder, if RESPOND mode is configured. */
  get respondPurposeCodes(): string[] | undefined {
    return this.config.respondMode
      ? [...this.config.respondMode.policy.allowedPurposeCodes]
      : undefined;
  }

  get ifcSeedHex(): string {
    return this.config.seedHex;
  }

  get a2aSendMessageUrl(): string | null {
    return this.httpServer ? `${this.httpServer.baseUrl}${A2A_SEND_MESSAGE_PATH}` : null;
  }

  setIfcService(ifcService: IfcService): void {
    this.httpServer?.setIfcService(ifcService);
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
          negotiate: `${base}/afal/negotiate`,
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
    relay?: RelayInvitePayload;
    templateId: string;
    budgetTier: string;
  }): Promise<{ selectedModelProfile?: ModelProfileRef } | undefined> {
    const peer = await this.resolvePeerDescriptor(params.propose.to);
    // ADMIT/DENY are verified under pins[propose.to], never a key the peer presented.
    const peerKeyHex = this.pinStore.requirePinnedKey(params.propose.to);
    // Tool-level callers can preflight supported purposes earlier for better
    // user-facing errors, but keep the transport-level check as a fail-closed
    // backstop for direct callers and future reuse outside relay_signal.
    if (
      this.peerDiscovery?.supportedPurposes.length &&
      !this.peerDiscovery.supportedPurposes.includes(params.propose.purpose_code)
    ) {
      throw new Error(
        `Peer agent card does not advertise support for purpose_code "${params.propose.purpose_code}"`,
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
    // acceptable_model_profiles is covered by proposal_id, so it must be sent
    // whenever it was hashed.
    if (params.propose.acceptable_model_profiles !== undefined) {
      proposeMessage['acceptable_model_profiles'] = params.propose.acceptable_model_profiles;
    }

    if (params.propose.prev_receipt_hash !== undefined) {
      proposeMessage['prev_receipt_hash'] = params.propose.prev_receipt_hash;
    }

    // Bind the relay payload to the signed PROPOSE envelope so the receiver
    // can verify the relay tokens haven't been tampered with in transit.
    if (params.relay) {
      const relayBindingHash = contentHash(params.relay);
      proposeMessage['relay_binding_hash'] = relayBindingHash;
    }

    const signed = signMessage(DOMAIN_PREFIXES.PROPOSE, proposeMessage, this.config.seedHex);
    const transportTarget = this.resolvePeerTransportTarget(peer);
    // Wrapped direct AFAL requests can negotiate before a relay session exists.
    const wrappedBody = params.relay ? { propose: signed, relay: params.relay } : { propose: signed };

    const proposeTaskId = `task-propose-${params.propose.proposal_id}`;
    let response: Response;
    if (transportTarget.useA2ANative) {
      if (params.relay) {
        throw new Error(
          'A2A-native direct transport does not accept inline relay payloads; send session tokens via commitAdmit() after ADMIT',
        );
      }
      response = await fetch(transportTarget.proposeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildA2ASendMessageRequest({
            mediaType: SELKEY_PROPOSE_MEDIA_TYPE,
            data: signed,
            acceptedOutputModes: [SELKEY_ADMIT_MEDIA_TYPE, SELKEY_DENY_MEDIA_TYPE],
            taskId: proposeTaskId,
          }),
        ),
      });
    } else {
      response = await fetch(peer.endpoints.propose, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wrappedBody),
      });
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`PROPOSE rejected: ${response.status} ${body}`);
    }

    let admitOrDeny: Record<string, unknown>;
    try {
      const payload = (await response.json()) as unknown;
      if (transportTarget.useA2ANative) {
        const parsed = parseA2ATaskPart(payload, [
          SELKEY_ADMIT_MEDIA_TYPE,
          SELKEY_DENY_MEDIA_TYPE,
        ]);
        if (!parsed || !parsed.data || typeof parsed.data !== 'object') {
          throw new Error('A2A SendMessage response did not contain an Selkey admit/deny part');
        }
        if (parsed.taskId !== undefined && parsed.taskId !== proposeTaskId) {
          throw new Error(
            `A2A task ID mismatch in propose response: expected=${proposeTaskId} got=${parsed.taskId}`,
          );
        }
        // Validate task state when present
        if (parsed.taskState !== undefined) {
          if (parsed.mediaType === SELKEY_ADMIT_MEDIA_TYPE) {
            // ADMIT → expect 'working' (stateful) or 'completed' (old server / no task_id)
            if (parsed.taskState !== 'working' && parsed.taskState !== 'completed') {
              throw new Error(
                `Unexpected task state for ADMIT response: expected working or completed, got ${parsed.taskState}`,
              );
            }
          } else if (parsed.mediaType === SELKEY_DENY_MEDIA_TYPE) {
            if (parsed.taskState !== 'failed' && parsed.taskState !== 'completed') {
              throw new Error(
                `Unexpected task state for DENY response: expected failed or completed, got ${parsed.taskState}`,
              );
            }
          }
        }
        admitOrDeny = parsed.data as Record<string, unknown>;
      } else {
        admitOrDeny = payload as Record<string, unknown>;
      }
    } catch (parseErr) {
      throw new Error(
        `PROPOSE endpoint returned non-JSON response (${response.status}): ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`,
      );
    }
    const outcome = admitOrDeny['outcome'];

    if (outcome === 'ADMIT') {
      const verified = verifyMessage(DOMAIN_PREFIXES.ADMIT, admitOrDeny, peerKeyHex);
      if (!verified) {
        throw new Error('ADMIT signature verification failed');
      }
      if (typeof admitOrDeny['admit_token_id'] !== 'string' || !admitOrDeny['admit_token_id']) {
        throw new Error(
          `ADMIT response missing required admit_token_id for proposal: ${params.propose.proposal_id}`,
        );
      }
      checkAdmitBinding(admitOrDeny, params.propose);
      const admit = admitOrDeny as unknown as AfalAdmit;
      this.storedAdmits.set(params.propose.proposal_id, admit);
      this.storedAdmitPeers.set(params.propose.proposal_id, params.propose.to);
      return { selectedModelProfile: admit.selected_model_profile };
    } else if (outcome === 'DENY') {
      const verified = verifyMessage(DOMAIN_PREFIXES.DENY, admitOrDeny, peerKeyHex);
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

  private mapAdmitted(
    admitted: AdmittedProposal[],
  ): AfalInviteMessage[] {
    return admitted
      .filter((item): item is AdmittedProposal & { relay: RelaySessionBinding } => item.relay !== undefined)
      .map((item) => ({
      invite_id: item.propose.proposal_id,
      from_agent_id: item.proposerAgentId,
      contract_hash: item.relay.contract_hash,
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

  async acceptInvite(
    inviteId: string,
    _expectedContractHash?: string,
  ): Promise<AcceptResult | undefined> {
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

    throw new Error(
      'DirectAfalTransport requires commitAdmit() after relay session creation; acceptInvite() is responder-only in direct mode',
    );
  }

  async commitAdmit(inviteId: string, relaySession: RelaySessionBinding): Promise<void> {
    const admit = this.storedAdmits.get(inviteId);
    if (!admit) {
      throw new Error(`No stored ADMIT for proposal_id: ${inviteId}`);
    }

    // Apply relay preference arbitration:
    // - REQUIRED: use responder's relay or abort
    // - PREFERRED: use responder's relay unless initiator has explicit override
    // - Absent: initiator-chooses (backward compat)
    let chosenRelayUrl = relaySession.relay_url;
    const relayPref = admit.relay_preference;
    if (relayPref) {
      if (relayPref.policy === 'REQUIRED') {
        chosenRelayUrl = relayPref.relay_url;
      } else if (relayPref.policy === 'PREFERRED') {
        // Use responder's relay unless the initiator has an explicit override
        if (!this.config.relayUrl || this.config.relayUrl === relayPref.relay_url) {
          chosenRelayUrl = relayPref.relay_url;
        }
        // else: initiator's explicit relayUrl overrides PREFERRED
      }
    }

    const peer = await this.resolvePeerDescriptor(this.storedAdmitPeers.get(inviteId));

    // Ensure the relay_session uses the arbitrated relay URL so the
    // committed session actually routes through the selected relay.
    const committedRelaySession =
      relaySession.relay_url === chosenRelayUrl
        ? relaySession
        : { ...relaySession, relay_url: chosenRelayUrl };

    const commitMessage: Record<string, unknown> = {
      commit_version: '1',
      proposal_id: inviteId,
      from: this.config.agentId,
      admit_token_id: admit.admit_token_id,
      encrypted_input_hash: contentHash({}),
      agent_descriptor_hash: contentHash(this.config.localDescriptor),
      relay_session: committedRelaySession,
      chosen_relay_url: chosenRelayUrl,
    };

    const signedCommit = signMessage(DOMAIN_PREFIXES.COMMIT, commitMessage, this.config.seedHex);
    const transportTarget = this.resolvePeerTransportTarget(peer);

    let response: Response;
    const commitTaskId = `task-propose-${inviteId}`;
    if (transportTarget.useA2ANative) {
      response = await fetch(transportTarget.commitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildA2ASendMessageRequest({
            mediaType: SELKEY_SESSION_TOKENS_MEDIA_TYPE,
            data: signedCommit,
            acceptedOutputModes: [SELKEY_SESSION_TOKENS_MEDIA_TYPE],
            taskId: commitTaskId,
          }),
        ),
      });
    } else {
      response = await fetch(peer.endpoints.commit, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signedCommit),
      });
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`COMMIT rejected: ${response.status} ${body}`);
    }

    if (transportTarget.useA2ANative) {
      const payload = (await response.json()) as unknown;
      const parsed = parseA2ATaskPart(payload, [SELKEY_SESSION_TOKENS_MEDIA_TYPE]);
      if (
        !parsed ||
        !parsed.data ||
        typeof parsed.data !== 'object' ||
        (parsed.data as Record<string, unknown>)['ok'] !== true
      ) {
        throw new Error('A2A SendMessage session-token response did not acknowledge success');
      }
      // Validate task state: session-tokens completes the lifecycle
      if (parsed.taskState !== undefined && parsed.taskState !== 'completed') {
        throw new Error(
          `Unexpected task state for session-tokens response: expected completed, got ${parsed.taskState}`,
        );
      }
    }

    this.storedAdmits.delete(inviteId);
    this.storedAdmitPeers.delete(inviteId);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  async discoverPeerAgentCard(
    expectedPeerAgentId?: string,
  ): Promise<SelkeyPeerDiscovery | null> {
    if (this.peerDescriptor !== null && this.peerDiscovery !== null) {
      const expiresMs = Date.parse(this.peerDescriptor.expires_at);
      if (
        !Number.isNaN(expiresMs) &&
        expiresMs > Date.now() &&
        (expectedPeerAgentId === undefined || this.peerDescriptor.agent_id === expectedPeerAgentId)
      ) {
        return { ...this.peerDiscovery, supportedPurposes: [...this.peerDiscovery.supportedPurposes] };
      }
    }

    if (!this.config.peerDescriptorUrl) {
      return null;
    }

    const a2aDescriptor = await this.tryResolvePeerViaAgentCard(
      this.config.peerDescriptorUrl,
      expectedPeerAgentId,
    );
    if (a2aDescriptor) {
      this.acceptPeerKey(a2aDescriptor.descriptor);
      this.peerDescriptor = a2aDescriptor.descriptor;
      this.peerDiscovery = a2aDescriptor.discovery;
      return {
        ...a2aDescriptor.discovery,
        supportedPurposes: [...a2aDescriptor.discovery.supportedPurposes],
      };
    }

    try {
      const descriptor = await this.fetchSignedPeerDescriptor(
        this.config.peerDescriptorUrl,
        expectedPeerAgentId,
      );
      this.acceptPeerKey(descriptor);
      const discovery = parseDescriptorPeerDiscovery(descriptor);
      this.peerDescriptor = descriptor;
      this.peerDiscovery = discovery;
      return discovery
        ? {
            ...discovery,
            supportedPurposes: [...discovery.supportedPurposes],
          }
        : null;
    } catch (err) {
      if (err instanceof PinError) throw err;
      return null;
    }
  }

  /**
   * A key presented by the peer (card or descriptor) must equal its pin.
   * Unpinned peers are rejected, or recorded for human confirmation in TOFU mode.
   */
  private acceptPeerKey(descriptor: AgentDescriptor): void {
    this.pinStore.checkPresentedKey(descriptor.agent_id, descriptor.identity_key.public_key_hex);
  }

  private resolvePeerTransportTarget(peer: AgentDescriptor): PeerTransportTarget {
    const a2aSendMessageUrl = this.peerDiscovery?.a2aSendMessageUrl;
    const afalEndpoint = this.peerDiscovery?.afalEndpoint;
    if (a2aSendMessageUrl && !afalEndpoint) {
      return {
        proposeUrl: a2aSendMessageUrl,
        commitUrl: a2aSendMessageUrl,
        useA2ANative: true,
      };
    }
    return {
      proposeUrl: peer.endpoints.propose,
      commitUrl: peer.endpoints.commit,
      useA2ANative: false,
    };
  }

  private resolvePeerNegotiationTarget(peer: AgentDescriptor): PeerNegotiationTarget | null {
    const a2aSendMessageUrl = this.peerDiscovery?.a2aSendMessageUrl;
    const afalEndpoint = this.peerDiscovery?.afalEndpoint;
    if (a2aSendMessageUrl) {
      return {
        negotiateUrl: a2aSendMessageUrl,
        useA2ANative: true,
      };
    }

    if (typeof peer.endpoints.negotiate === 'string' && peer.endpoints.negotiate) {
      return {
        negotiateUrl: peer.endpoints.negotiate,
        useA2ANative: false,
      };
    }

    if (afalEndpoint) {
      return {
        negotiateUrl: `${afalEndpoint}/negotiate`,
        useA2ANative: false,
      };
    }

    if (peer.endpoints.propose.endsWith('/propose')) {
      return {
        negotiateUrl: `${peer.endpoints.propose.slice(0, -'/propose'.length)}/negotiate`,
        useA2ANative: false,
      };
    }

    return null;
  }

  private async resolvePeerDescriptor(expectedPeerAgentId?: string): Promise<AgentDescriptor> {
    if (this.peerDescriptor !== null) {
      const expiresMs = Date.parse(this.peerDescriptor.expires_at);
      if (Number.isNaN(expiresMs)) {
        console.error(
          `resolvePeerDescriptor: cached descriptor has unparseable expires_at: "${this.peerDescriptor.expires_at}". Re-fetching.`,
        );
        this.peerDescriptor = null;
        this.peerDiscovery = null;
      } else if (expiresMs > Date.now()) {
        if (
          expectedPeerAgentId !== undefined &&
          this.peerDescriptor.agent_id !== expectedPeerAgentId
        ) {
          this.peerDescriptor = null;
          this.peerDiscovery = null;
        } else {
          return this.peerDescriptor;
        }
      } else {
        this.peerDescriptor = null;
        this.peerDiscovery = null;
      }
    }

    if (!this.config.peerDescriptorUrl) {
      throw new Error(
        'Cannot initiate: no peer connection configured. ' +
        'Check your inbox for pending invites (call get_identity) and use RESPOND mode instead.',
      );
    }

    const a2aDescriptor = await this.tryResolvePeerViaAgentCard(
      this.config.peerDescriptorUrl,
      expectedPeerAgentId,
    );
    if (a2aDescriptor) {
      this.acceptPeerKey(a2aDescriptor.descriptor);
      this.peerDescriptor = a2aDescriptor.descriptor;
      this.peerDiscovery = a2aDescriptor.discovery;
      return a2aDescriptor.descriptor;
    }

    const descriptor = await this.fetchSignedPeerDescriptor(
      this.config.peerDescriptorUrl,
      expectedPeerAgentId,
    );
    this.acceptPeerKey(descriptor);
    this.peerDescriptor = descriptor;
    this.peerDiscovery = parseDescriptorPeerDiscovery(descriptor);
    return descriptor;
  }

  private async tryResolvePeerViaAgentCard(
    peerUrl: string,
    expectedPeerAgentId?: string,
  ): Promise<{ descriptor: AgentDescriptor; discovery: SelkeyPeerDiscovery } | null> {
    const agentCardUrl = deriveAgentCardUrl(peerUrl);
    if (!agentCardUrl) return null;

    let response: Response;
    try {
      response = await fetch(agentCardUrl);
    } catch {
      return null;
    }
    if (!response.ok) {
      return null;
    }

    let card: AgentCard;
    try {
      card = (await response.json()) as AgentCard;
    } catch {
      return null;
    }

    const extension = card.capabilities?.extensions?.find(
      (item) => item.uri === SELKEY_A2A_EXTENSION_URI,
    );
    const params = extension?.params;
    if (!params) return null;

    const publicKeyHex = params['public_key_hex'];
    const afalEndpoint =
      typeof params['afal_endpoint'] === 'string' ? params['afal_endpoint'] : undefined;
    const cardSignature =
      typeof params['card_signature'] === 'string' ? params['card_signature'] : undefined;

    // A card is used only if it carries a valid card_signature. The signature
    // covers every field taken from the card (endpoints, relay hint,
    // capabilities), and the signing key must equal the peer's pin
    // (acceptPeerKey). An unsigned card is never used; discovery falls back
    // to the signed AFAL descriptor.
    if (!cardSignature) {
      console.warn('Peer agent card is unsigned — ignoring it and using the signed descriptor');
      return null;
    }
    {
      // Reconstruct the extension params for verification (without card_signature itself)
      const verifyParams: SelkeyA2AExtensionParams = {
        public_key_hex: publicKeyHex as string,
        supported_purposes: Array.isArray(params['supported_purposes'])
          ? params['supported_purposes'].filter((item): item is string => typeof item === 'string')
          : [],
      };
      if (typeof params['relay_url'] === 'string') {
        verifyParams.relay_url = params['relay_url'];
      }
      if (typeof params['a2a_send_message_url'] === 'string') {
        verifyParams.a2a_send_message_url = params['a2a_send_message_url'];
      }
      if (typeof params['afal_endpoint'] === 'string') {
        verifyParams.afal_endpoint = params['afal_endpoint'];
      }
      if (params['supports_topic_alignment'] === true) {
        verifyParams.supports_topic_alignment = true;
      }
      if (Array.isArray(params['supported_topic_codes'])) {
        verifyParams.supported_topic_codes = params['supported_topic_codes'].filter(
          (item): item is string => typeof item === 'string',
        );
      }
      if (params['supports_precontract_negotiation'] === true) {
        verifyParams.supports_precontract_negotiation = true;
      }
      const verifySupportedContractOffers = parseSupportedContractOffers(params['supported_contract_offers']);
      if (verifySupportedContractOffers) {
        verifyParams.supported_contract_offers = verifySupportedContractOffers;
      }
      if (params['supports_bespoke_contract_negotiation'] === true) {
        verifyParams.supports_bespoke_contract_negotiation = true;
      }

      // Use the agent_id from the signed payload reconstruction (card.name)
      const cardAgentId = typeof card.name === 'string' ? card.name : undefined;
      if (!cardAgentId) {
        // No agent identity — fall back to AFAL descriptor resolution
        console.warn('Signed agent card has no agent identity (card.name missing) — falling back to descriptor');
        return null;
      }

      const valid = verifyAgentCardSignature(
        cardAgentId,
        verifyParams,
        cardSignature,
        publicKeyHex as string,
      );
      if (!valid) {
        // Invalid signature — fall back to AFAL descriptor resolution rather
        // than making a dual-stack peer unreachable due to a stale card.
        console.warn('Agent card signature verification failed — falling back to descriptor resolution');
        return null;
      }

      // agent_id verification: the signed payload's agent_id must equal card.name
      // (This is inherently true since we use card.name as the agent_id for verification,
      // but if expectedPeerAgentId differs, that's caught below.)
    }

    // a2a_send_message_url must be explicit in the signed payload; it is
    // never derived from the unsigned card.url.
    const a2aSendMessageUrl =
      typeof params['a2a_send_message_url'] === 'string' ? params['a2a_send_message_url'] : null;
    if (typeof publicKeyHex !== 'string' || (!afalEndpoint && !a2aSendMessageUrl)) {
      return null;
    }
    const relayUrl = typeof params['relay_url'] === 'string' ? params['relay_url'] : undefined;
    const supportedPurposes = Array.isArray(params['supported_purposes'])
      ? params['supported_purposes'].filter((item): item is string => typeof item === 'string')
      : [];
    const supportedTopicCodes = Array.isArray(params['supported_topic_codes'])
      ? params['supported_topic_codes'].filter((item): item is string => typeof item === 'string')
      : [];
    const supportedContractOffers = parseSupportedContractOffers(params['supported_contract_offers']);
    const supportsTopicAlignment =
      params['supports_topic_alignment'] === true && supportedTopicCodes.length > 0;
    const supportsPrecontractNegotiation =
      params['supports_precontract_negotiation'] === true && supportedContractOffers !== null;
    const supportsBespokeContractNegotiation =
      params['supports_bespoke_contract_negotiation'] === true;

    const agentId = typeof card.name === 'string' ? card.name : expectedPeerAgentId;
    if (!agentId) return null;
    if (expectedPeerAgentId !== undefined && agentId !== expectedPeerAgentId) {
      throw new Error(
        `Peer agent card identity mismatch: expected ${expectedPeerAgentId} but got ${peerText(agentId)}`,
      );
    }

    // Agent Card discovery synthesizes a short-lived unsigned descriptor.
    // When signed, the trust anchor is the Ed25519 card_signature. When unsigned,
    // the trust anchor is the fetched A2A document itself.
    return {
      descriptor: {
        descriptor_version: '1',
        agent_id: agentId,
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        identity_key: {
          algorithm: 'ed25519',
          public_key_hex: publicKeyHex,
        },
        envelope_key: {
          algorithm: 'ed25519',
          public_key_hex: publicKeyHex,
        },
        endpoints: {
          propose: afalEndpoint ? `${afalEndpoint}/propose` : '',
          commit: afalEndpoint ? `${afalEndpoint}/commit` : '',
          ...(afalEndpoint ? { negotiate: `${afalEndpoint}/negotiate` } : {}),
          ...(a2aSendMessageUrl ? { message: a2aSendMessageUrl } : {}),
        },
        capabilities: {},
        policy_commitments: {},
      },
      discovery: {
        ...(relayUrl ? { relayUrl } : {}),
        ...(afalEndpoint ? { afalEndpoint } : {}),
        ...(a2aSendMessageUrl ? { a2aSendMessageUrl } : {}),
        supportedPurposes,
        ...(supportsTopicAlignment
          ? {
              supportsTopicAlignment: true,
              supportedTopicCodes,
            }
          : {}),
        ...(supportsPrecontractNegotiation
          ? {
              supportsPrecontractNegotiation: true,
              supportedContractOffers: supportedContractOffers ?? [],
            }
          : {}),
        ...(supportsBespokeContractNegotiation
          ? {
              supportsBespokeContractNegotiation: true,
            }
          : {}),
      },
    };
  }

  async negotiateContractOffer(
    proposal: ContractOfferProposal,
  ): Promise<ContractOfferSelection | null> {
    const peer = await this.resolvePeerDescriptor(proposal.expected_counterparty);
    if (
      !this.peerDiscovery?.supportsPrecontractNegotiation &&
      !this.peerDiscovery?.supportsBespokeContractNegotiation
    ) {
      return null;
    }
    const target = this.resolvePeerNegotiationTarget(peer);
    if (!target) return null;
    const signedProposal = signNegotiationRequest(
      'CONTRACT_OFFER_PROPOSAL',
      { ...proposal, expected_counterparty: proposal.expected_counterparty ?? peer.agent_id },
      this.config.agentId,
      this.config.seedHex,
    );

    const negotiateTaskId = `task-negotiate-${proposal.negotiation_id}`;
    const response = await fetch(
      target.negotiateUrl,
      target.useA2ANative
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              buildA2ASendMessageRequest({
                mediaType: SELKEY_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
                data: signedProposal,
                acceptedOutputModes: [SELKEY_CONTRACT_OFFER_SELECTION_MEDIA_TYPE],
                taskId: negotiateTaskId,
              }),
            ),
          }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signedProposal),
          },
    );

    if (!response.ok) {
      throw new Error(`Contract negotiation request failed: ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    let selection: ContractOfferSelection | null;
    if (target.useA2ANative) {
      const parsed = parseA2ATaskPart(payload, [SELKEY_CONTRACT_OFFER_SELECTION_MEDIA_TYPE]);
      if (!parsed) {
        throw new Error('A2A negotiation response did not contain a contract-offer selection part');
      }
      if (parsed.taskId !== undefined && parsed.taskId !== negotiateTaskId) {
        throw new Error(
          `A2A task ID mismatch in negotiation response: expected=${negotiateTaskId} got=${parsed.taskId}`,
        );
      }
      selection = parseContractOfferSelection(parsed.data);
    } else {
      selection = parseContractOfferSelection(payload);
    }
    if (!selection) {
      throw new Error('Contract negotiation response carried an invalid selection body');
    }
    if (selection.negotiation_id !== proposal.negotiation_id) {
      throw new Error(
        `Contract negotiation response carried mismatched negotiation_id: ` +
          `expected=${proposal.negotiation_id} got=${selection.negotiation_id}`,
      );
    }
    assertSelectionWithinProposal(proposal, selection);
    return selection;
  }

  async alignTopic(proposal: TopicAlignmentProposal): Promise<TopicAlignmentSelection | null> {
    const peer = await this.resolvePeerDescriptor(proposal.expected_counterparty);
    if (!this.peerDiscovery?.supportsTopicAlignment || !this.peerDiscovery.supportedTopicCodes?.length) {
      return null;
    }
    const target = this.resolvePeerNegotiationTarget(peer);
    if (!target) return null;
    const signedProposal = signNegotiationRequest(
      'TOPIC_ALIGNMENT_PROPOSAL',
      { ...proposal, expected_counterparty: proposal.expected_counterparty ?? peer.agent_id },
      this.config.agentId,
      this.config.seedHex,
    );

    const response = await fetch(
      target.negotiateUrl,
      target.useA2ANative
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              buildA2ASendMessageRequest({
                mediaType: SELKEY_TOPIC_ALIGNMENT_PROPOSAL_MEDIA_TYPE,
                data: signedProposal,
                acceptedOutputModes: [SELKEY_TOPIC_ALIGNMENT_SELECTION_MEDIA_TYPE],
              }),
            ),
          }
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(signedProposal),
          },
    );

    if (!response.ok) {
      throw new Error(`Topic alignment request failed: ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    let selection: TopicAlignmentSelection | null;
    if (target.useA2ANative) {
      const parsed = parseA2ATaskPart(payload, [SELKEY_TOPIC_ALIGNMENT_SELECTION_MEDIA_TYPE]);
      if (!parsed) {
        throw new Error('A2A topic alignment response did not contain a topic-alignment selection part');
      }
      selection = parseTopicAlignmentSelection(parsed.data);
    } else {
      selection = parseTopicAlignmentSelection(payload);
    }
    if (!selection) {
      throw new Error('Topic alignment response carried an invalid selection body');
    }
    if (selection.alignment_id !== proposal.alignment_id) {
      throw new Error(
        `Topic alignment response carried mismatched alignment_id: ` +
          `expected=${proposal.alignment_id} got=${selection.alignment_id}`,
      );
    }
    assertTopicSelectionWithinProposal(proposal, selection);
    return selection;
  }

  private async fetchSignedPeerDescriptor(
    descriptorUrl: string,
    expectedPeerAgentId?: string,
  ): Promise<AgentDescriptor> {
    const response = await fetch(descriptorUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch peer descriptor: ${response.status}`);
    }

    let raw: Record<string, unknown>;
    try {
      raw = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`Peer descriptor from ${descriptorUrl} returned non-JSON`);
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
        `Peer descriptor from ${descriptorUrl} is malformed: missing or invalid identity_key.public_key_hex`,
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
        `Peer descriptor from ${descriptorUrl} is malformed: missing required endpoints (propose, commit)`,
      );
    }

    if (!isAgentDescriptor(raw)) {
      throw new Error(
        `Peer descriptor from ${descriptorUrl} is malformed: failed structural validation`,
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
    if (expectedPeerAgentId !== undefined && descriptor.agent_id !== expectedPeerAgentId) {
      throw new Error(
        `Peer descriptor identity mismatch: expected ${expectedPeerAgentId} but got ${peerText(descriptor.agent_id)}`,
      );
    }

    const expiresMs = Date.parse(descriptor.expires_at);
    if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
      throw new Error(`Fetched peer descriptor expired or invalid expires_at: "${descriptor.expires_at}"`);
    }

    return descriptor;
  }

  // ── Test helpers ──────────────────────────────────────────────────────────

  /** Inject a peer descriptor directly (testing only). */
  _setPeerDescriptorForTesting(descriptor: AgentDescriptor): void {
    this.peerDescriptor = descriptor;
  }

  /** Get a stored ADMIT (testing only). */
  _getStoredAdmit(proposalId: string): AfalAdmit | undefined {
    return this.storedAdmits.get(proposalId);
  }

  /** Inject a stored ADMIT directly (testing only). */
  _setStoredAdmitForTesting(proposalId: string, admit: AfalAdmit): void {
    this.storedAdmits.set(proposalId, admit);
  }
}

function deriveAgentCardUrl(peerUrl: string): string | null {
  try {
    const url = new URL(peerUrl);
    if (url.pathname === '/.well-known/agent-card.json') {
      return url.toString();
    }
    return `${url.origin}/.well-known/agent-card.json`;
  } catch {
    return null;
  }
}

function parseSupportedModelProfiles(descriptor: AgentDescriptor): ModelProfileRef[] {
  const raw = descriptor.capabilities['supported_model_profiles'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>)['id'] === 'string' &&
      typeof (item as Record<string, unknown>)['version'] === 'string' &&
      typeof (item as Record<string, unknown>)['hash'] === 'string'
    ) {
      return [
        {
          id: (item as Record<string, unknown>)['id'] as string,
          version: (item as Record<string, unknown>)['version'] as string,
          hash: (item as Record<string, unknown>)['hash'] as string,
        },
      ];
    }
    return [];
  });
}

function parseDescriptorPeerDiscovery(descriptor: AgentDescriptor): SelkeyPeerDiscovery | null {
  const supportedContractOffers = parseSupportedContractOffers(
    descriptor.capabilities['supported_contract_offers'],
  );
  const supportedPurposes = Array.isArray(descriptor.capabilities['supported_purposes'])
    ? descriptor.capabilities['supported_purposes'].filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const supportedTopicCodes = Array.isArray(descriptor.capabilities['supported_topic_codes'])
    ? descriptor.capabilities['supported_topic_codes'].filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const afalEndpoint = descriptor.endpoints.propose.endsWith('/propose')
    ? descriptor.endpoints.propose.slice(0, -'/propose'.length)
    : undefined;
  const a2aSendMessageUrl =
    typeof descriptor.endpoints.message === 'string' ? descriptor.endpoints.message : undefined;

  if (
    !supportedContractOffers &&
    supportedTopicCodes.length === 0 &&
    supportedPurposes.length === 0 &&
    !afalEndpoint &&
    !a2aSendMessageUrl
  ) {
    return null;
  }

  return {
    ...(afalEndpoint ? { afalEndpoint } : {}),
    ...(a2aSendMessageUrl ? { a2aSendMessageUrl } : {}),
    supportedPurposes,
    ...(supportedTopicCodes.length
      ? {
          supportsTopicAlignment: descriptor.capabilities['supports_topic_alignment'] === true,
          supportedTopicCodes,
        }
      : {}),
    supportsPrecontractNegotiation: supportedContractOffers !== null,
    supportsBespokeContractNegotiation:
      descriptor.capabilities['supports_bespoke_contract_negotiation'] === true,
    ...(supportedContractOffers ? { supportedContractOffers } : {}),
  };
}

/**
 * Quote a peer-supplied string for inclusion in an error: JSON-quoted,
 * truncated, and marked as coming from the peer (not an instruction).
 */
export function peerText(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  const clipped = text.length > 64 ? `${text.slice(0, 64)}…` : text;
  return `${JSON.stringify(clipped)} (peer-supplied text)`;
}

/** An ADMIT may be valid for at most 10 minutes. */
export const ADMIT_MAX_TTL_MS = 10 * 60 * 1000;
/** Tolerated clock difference between the two agents when checking expiry. */
const ADMIT_CLOCK_SKEW_MS = 60 * 1000;

function sameProfile(a: ModelProfileRef, b: ModelProfileRef): boolean {
  return a.id === b.id && a.version === b.version && a.hash === b.hash;
}

/**
 * Bind a verified ADMIT to the PROPOSE it answers:
 * - it echoes the proposal_id that was sent;
 * - it has not expired and expires at most 10 minutes from now;
 * - any selected_model_profile is one of the profiles the PROPOSE offered
 *   (acceptable_model_profiles, or the single proposed profile).
 */
export function checkAdmitBinding(
  admit: Record<string, unknown>,
  propose: AfalPropose,
  nowMs: number = Date.now(),
): void {
  if (admit['proposal_id'] !== propose.proposal_id) {
    throw new Error(
      `ADMIT proposal_id does not match the PROPOSE: expected=${propose.proposal_id} got=${String(admit['proposal_id'])}`,
    );
  }
  const expiresMs = typeof admit['expires_at'] === 'string' ? Date.parse(admit['expires_at']) : NaN;
  if (Number.isNaN(expiresMs)) {
    throw new Error('ADMIT expires_at is missing or invalid');
  }
  if (expiresMs <= nowMs) {
    throw new Error('ADMIT has expired');
  }
  if (expiresMs > nowMs + ADMIT_MAX_TTL_MS + ADMIT_CLOCK_SKEW_MS) {
    throw new Error('ADMIT expires_at is more than 10 minutes in the future');
  }
  const selected = admit['selected_model_profile'];
  if (selected === undefined) return;
  if (
    !selected ||
    typeof selected !== 'object' ||
    typeof (selected as Record<string, unknown>)['id'] !== 'string' ||
    typeof (selected as Record<string, unknown>)['version'] !== 'string' ||
    typeof (selected as Record<string, unknown>)['hash'] !== 'string'
  ) {
    throw new Error('ADMIT selected_model_profile is malformed');
  }
  const offered: ModelProfileRef[] = propose.acceptable_model_profiles?.length
    ? propose.acceptable_model_profiles
    : propose.model_profile_hash
      ? [
          {
            id: propose.model_profile_id,
            version: propose.model_profile_version,
            hash: propose.model_profile_hash,
          },
        ]
      : [];
  if (!offered.some((profile) => sameProfile(profile, selected as ModelProfileRef))) {
    throw new Error('ADMIT selected_model_profile was not among the profiles offered in the PROPOSE');
  }
}
