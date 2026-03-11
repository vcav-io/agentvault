import { randomUUID } from 'node:crypto';

import { contentHash, DOMAIN_PREFIXES, signMessage, verifyMessage } from './afal-signing.js';
import {
  AGENTVAULT_IFC_ENVELOPE_MEDIA_TYPE,
  AGENTVAULT_IFC_RESULT_MEDIA_TYPE,
  buildA2ASendMessageRequest,
  parseA2ATaskPart,
} from './a2a-messages.js';
import type { NormalizedKnownAgent } from './tools/relaySignal.js';

export type IfcMessageClass = 'LOGISTICS' | 'CONSENT' | 'REFERENCE' | 'ARTIFACT_TRANSFER';
export type IfcSessionRelation = 'POST_SESSION';
export type IfcDecision = 'ALLOW' | 'HIDE' | 'ESCALATE' | 'BLOCK';

export interface IfcKnownAgent extends NormalizedKnownAgent {
  a2a_send_message_url?: string;
}

export interface IfcGrantScope {
  message_classes: IfcMessageClass[];
  session_relation: IfcSessionRelation;
}

export interface IfcGrantPermissions {
  max_uses: number;
}

export interface IfcGrantProvenance {
  receipt_id: string;
  session_id: string;
}

export interface IfcGrantUnsigned {
  version: 'AV-IFC-GRANT-V1';
  issuer: string;
  issuer_public_key_hex: string;
  audience: string;
  label_ceiling: 'POST_SESSION_BOUND';
  scope: IfcGrantScope;
  permissions: IfcGrantPermissions;
  provenance: IfcGrantProvenance;
  issued_at: string;
  expires_at: string;
}

export interface IfcGrant extends IfcGrantUnsigned {
  grant_id: string;
  signature: string;
}

export interface IfcEnvelopeUnsigned {
  version: 'AV-IFC-MSG-V1';
  message_id: string;
  created_at: string;
  sender: string;
  recipient: string;
  message_class: IfcMessageClass;
  session_relation: IfcSessionRelation;
  payload: string;
  related_receipt_id: string;
  related_session_id: string;
  grant_id: string;
  ifc_policy_hash: string;
  label_receipt: {
    policy_version: 'POST_SESSION_V1';
    message_class: IfcMessageClass;
    session_relation: IfcSessionRelation;
  };
}

export interface IfcEnvelope extends IfcEnvelopeUnsigned {
  signature: string;
}

export interface IfcEscalationStub {
  recommended_topic_code: 'post_session_follow_up';
  recommended_signal_family: 'session_follow_up';
  recommended_policy_constraints: ['POST_SESSION_ONLY'];
  reason_code: 'REFERENCE_NEEDS_SESSION';
  source_message_id: string;
  grant_context: {
    grant_id: string;
    related_receipt_id: string;
    related_session_id: string;
  };
}

export interface IfcStoredMessage {
  message_id: string;
  sender: string;
  recipient: string;
  message_class: IfcMessageClass;
  decision: IfcDecision;
  related_receipt_id: string;
  related_session_id: string;
  created_at: string;
  payload?: string;
  hidden_variable_id?: string;
  escalation_stub?: IfcEscalationStub;
  read: boolean;
}

export interface CreateIfcGrantArgs {
  audience: string;
  receipt_id: string;
  session_id: string;
  message_classes: IfcMessageClass[];
  max_uses: number;
  expires_in_seconds: number;
}

export interface SendIfcMessageArgs {
  counterparty: string;
  grant: IfcGrant;
  message_class: IfcMessageClass;
  payload: string;
  related_receipt_id: string;
  related_session_id: string;
}

export interface ReadIfcMessagesArgs {
  limit?: number;
}

export interface IfcDeliveryResult {
  decision: IfcDecision;
  message_id: string;
  related_receipt_id: string;
  related_session_id: string;
  hidden_variable_id?: string;
  escalation_stub?: IfcEscalationStub;
  error?: string;
}

interface ReceivedGrantState {
  grant: IfcGrant;
  uses: number;
}

function isHex(value: string, len: number): boolean {
  return value.length === len && /^[0-9a-f]+$/.test(value);
}

function assertUuidLower(value: string, field: string): void {
  const parts = value.split('-');
  if (
    parts.length !== 5 ||
    parts[0].length !== 8 ||
    parts[1].length !== 4 ||
    parts[2].length !== 4 ||
    parts[3].length !== 4 ||
    parts[4].length !== 12 ||
    !parts.every((p) => /^[0-9a-f]+$/.test(p))
  ) {
    throw new Error(`${field} must be a lowercase UUID`);
  }
}

function assertReceiptId(value: string): void {
  if (!isHex(value, 64)) throw new Error('receipt_id must be 64 lowercase hex characters');
}

function assertMessageClass(value: string): asserts value is IfcMessageClass {
  if (!['LOGISTICS', 'CONSENT', 'REFERENCE', 'ARTIFACT_TRANSFER'].includes(value)) {
    throw new Error(`unsupported message_class: ${value}`);
  }
}

function classifyDecision(messageClass: IfcMessageClass): Exclude<IfcDecision, 'BLOCK'> {
  switch (messageClass) {
    case 'LOGISTICS':
    case 'CONSENT':
      return 'ALLOW';
    case 'ARTIFACT_TRANSFER':
      return 'HIDE';
    case 'REFERENCE':
      return 'ESCALATE';
  }
}

function aliasesContain(agent: IfcKnownAgent, hint: string): boolean {
  const lowered = hint.toLowerCase();
  return agent.agent_id.toLowerCase() === lowered || agent.aliases.some((a) => a.toLowerCase() === lowered);
}

export class IfcService {
  private readonly agentId: string;
  private readonly seedHex: string;
  private readonly verifyingKeyHex: string;
  private knownAgents: IfcKnownAgent[];
  private readonly receivedGrantUses = new Map<string, ReceivedGrantState>();
  private readonly inbox: IfcStoredMessage[] = [];
  private hiddenCounter = 0;

  constructor(params: {
    agentId: string;
    seedHex: string;
    knownAgents?: IfcKnownAgent[];
    verifyingKeyHex: string;
  }) {
    this.agentId = params.agentId;
    this.seedHex = params.seedHex;
    this.knownAgents = params.knownAgents ?? [];
    this.verifyingKeyHex = params.verifyingKeyHex;
  }

  setKnownAgents(knownAgents: IfcKnownAgent[]): void {
    this.knownAgents = knownAgents;
  }

  pendingCount(): number {
    return this.inbox.filter((m) => !m.read).length;
  }

  createGrant(args: CreateIfcGrantArgs): { grant: IfcGrant; grant_id: string; expires_at: string; scope: IfcGrantScope } {
    assertReceiptId(args.receipt_id);
    assertUuidLower(args.session_id, 'session_id');
    if (args.max_uses < 1 || args.max_uses > 100) {
      throw new Error('max_uses must be between 1 and 100');
    }
    if (args.expires_in_seconds < 1 || args.expires_in_seconds > 86400) {
      throw new Error('expires_in_seconds must be between 1 and 86400');
    }
    if (args.message_classes.length < 1) {
      throw new Error('message_classes must contain at least one value');
    }
    const deduped = [...new Set(args.message_classes)];
    deduped.forEach((value) => assertMessageClass(value));

    const now = new Date();
    const unsigned: IfcGrantUnsigned = {
      version: 'AV-IFC-GRANT-V1',
      issuer: this.agentId,
      issuer_public_key_hex: this.verifyingKeyHex,
      audience: args.audience,
      label_ceiling: 'POST_SESSION_BOUND',
      scope: {
        message_classes: deduped,
        session_relation: 'POST_SESSION',
      },
      permissions: {
        max_uses: args.max_uses,
      },
      provenance: {
        receipt_id: args.receipt_id,
        session_id: args.session_id,
      },
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + args.expires_in_seconds * 1000).toISOString(),
    };
    const grant_id = contentHash(unsigned);
    const signed = signMessage(
      DOMAIN_PREFIXES.IFC_GRANT,
      { ...unsigned, grant_id },
      this.seedHex,
    ) as IfcGrant;
    return {
      grant: signed,
      grant_id,
      expires_at: signed.expires_at,
      scope: signed.scope,
    };
  }

  verifyGrant(grant: IfcGrant): void {
    assertReceiptId(grant.provenance.receipt_id);
    assertUuidLower(grant.provenance.session_id, 'session_id');
    const { signature: _sig, grant_id, ...unsigned } = grant;
    const recomputed = contentHash(unsigned);
    if (recomputed !== grant_id) throw new Error('grant_id mismatch');
    if (!verifyMessage(DOMAIN_PREFIXES.IFC_GRANT, grant as unknown as Record<string, unknown>, grant.issuer_public_key_hex)) {
      throw new Error('grant signature verification failed');
    }
    if (new Date(grant.expires_at).getTime() < Date.now()) throw new Error('grant expired');
  }

  async sendMessage(args: SendIfcMessageArgs): Promise<IfcDeliveryResult> {
    assertMessageClass(args.message_class);
    assertReceiptId(args.related_receipt_id);
    assertUuidLower(args.related_session_id, 'related_session_id');
    this.verifyGrant(args.grant);
    if (args.grant.audience !== args.counterparty && !this.knownAgents.find((a) => aliasesContain(a, args.counterparty) && a.agent_id === args.grant.audience)) {
      throw new Error('grant audience does not match counterparty');
    }
    if (args.grant.provenance.receipt_id !== args.related_receipt_id) {
      throw new Error('grant receipt provenance mismatch');
    }
    if (args.grant.provenance.session_id !== args.related_session_id) {
      throw new Error('grant session provenance mismatch');
    }
    if (!args.grant.scope.message_classes.includes(args.message_class)) {
      throw new Error('grant does not allow this message_class');
    }

    const peer = this.knownAgents.find((agent) => aliasesContain(agent, args.counterparty));
    if (!peer?.a2a_send_message_url) {
      throw new Error('counterparty has no a2a_send_message_url');
    }

    const unsigned: IfcEnvelopeUnsigned = {
      version: 'AV-IFC-MSG-V1',
      message_id: randomUUID(),
      created_at: new Date().toISOString(),
      sender: this.agentId,
      recipient: args.grant.audience,
      message_class: args.message_class,
      session_relation: 'POST_SESSION',
      payload: args.payload,
      related_receipt_id: args.related_receipt_id,
      related_session_id: args.related_session_id,
      grant_id: args.grant.grant_id,
      ifc_policy_hash: contentHash({
        policy_version: 'POST_SESSION_V1',
        allowed_classes: ['LOGISTICS', 'CONSENT', 'REFERENCE', 'ARTIFACT_TRANSFER'],
      }),
      label_receipt: {
        policy_version: 'POST_SESSION_V1',
        message_class: args.message_class,
        session_relation: 'POST_SESSION',
      },
    };

    const envelope = signMessage(
      DOMAIN_PREFIXES.IFC_ENVELOPE,
      unsigned as unknown as Record<string, unknown>,
      this.seedHex,
    ) as unknown as IfcEnvelope;

    const response = await fetch(peer.a2a_send_message_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildA2ASendMessageRequest({
          mediaType: AGENTVAULT_IFC_ENVELOPE_MEDIA_TYPE,
          data: { envelope, grant: args.grant },
          acceptedOutputModes: [AGENTVAULT_IFC_RESULT_MEDIA_TYPE],
        }),
      ),
    });
    const payload = await response.json();
    const parsed = parseA2ATaskPart(payload, [AGENTVAULT_IFC_RESULT_MEDIA_TYPE]);
    if (!parsed) {
      throw new Error('A2A SendMessage response did not contain an IFC result part');
    }
    return parsed.data as IfcDeliveryResult;
  }

  receiveEnvelope(input: { envelope: IfcEnvelope; grant: IfcGrant }): IfcDeliveryResult {
    const { envelope, grant } = input;
    try {
      this.verifyGrant(grant);
      if (grant.audience !== this.agentId) throw new Error('grant audience mismatch');
      if (grant.grant_id !== envelope.grant_id) throw new Error('grant_id mismatch');
      if (grant.provenance.receipt_id !== envelope.related_receipt_id) throw new Error('receipt provenance mismatch');
      if (grant.provenance.session_id !== envelope.related_session_id) throw new Error('session provenance mismatch');
      if (!grant.scope.message_classes.includes(envelope.message_class)) {
        throw new Error('grant scope mismatch');
      }
      if (envelope.recipient !== this.agentId) throw new Error('recipient mismatch');
      if (envelope.session_relation !== 'POST_SESSION') throw new Error('unsupported session_relation');
      if (!verifyMessage(DOMAIN_PREFIXES.IFC_ENVELOPE, envelope as unknown as Record<string, unknown>, grant.issuer_public_key_hex)) {
        throw new Error('envelope signature verification failed');
      }

      const grantState = this.receivedGrantUses.get(grant.grant_id) ?? { grant, uses: 0 };
      if (grantState.uses >= grant.permissions.max_uses) {
        throw new Error('grant use limit exceeded');
      }
      grantState.uses += 1;
      this.receivedGrantUses.set(grant.grant_id, grantState);

      const decision = classifyDecision(envelope.message_class);
      const stored: IfcStoredMessage = {
        message_id: envelope.message_id,
        sender: envelope.sender,
        recipient: envelope.recipient,
        message_class: envelope.message_class,
        decision,
        related_receipt_id: envelope.related_receipt_id,
        related_session_id: envelope.related_session_id,
        created_at: envelope.created_at,
        read: false,
      };
      if (decision === 'ALLOW') {
        stored.payload = envelope.payload;
      } else if (decision === 'HIDE') {
        this.hiddenCounter += 1;
        stored.hidden_variable_id = `ifc_var_${this.hiddenCounter}`;
      } else if (decision === 'ESCALATE') {
        stored.escalation_stub = {
          recommended_topic_code: 'post_session_follow_up',
          recommended_signal_family: 'session_follow_up',
          recommended_policy_constraints: ['POST_SESSION_ONLY'],
          reason_code: 'REFERENCE_NEEDS_SESSION',
          source_message_id: envelope.message_id,
          grant_context: {
            grant_id: grant.grant_id,
            related_receipt_id: envelope.related_receipt_id,
            related_session_id: envelope.related_session_id,
          },
        };
      }
      this.inbox.push(stored);

      return {
        decision,
        message_id: envelope.message_id,
        related_receipt_id: envelope.related_receipt_id,
        related_session_id: envelope.related_session_id,
        ...(stored.hidden_variable_id ? { hidden_variable_id: stored.hidden_variable_id } : {}),
        ...(stored.escalation_stub ? { escalation_stub: stored.escalation_stub } : {}),
      };
    } catch (error) {
      return {
        decision: 'BLOCK',
        message_id: input.envelope.message_id,
        related_receipt_id: input.envelope.related_receipt_id,
        related_session_id: input.envelope.related_session_id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  readMessages(args: ReadIfcMessagesArgs = {}): { pending_count: number; messages: Array<Record<string, unknown>> } {
    const unread = this.inbox.filter((m) => !m.read);
    const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : unread.length;
    const selected = unread.slice(0, limit);
    for (const item of selected) item.read = true;
    return {
      pending_count: this.pendingCount(),
      messages: selected.map((item) => ({
        message_id: item.message_id,
        sender: item.sender,
        message_class: item.message_class,
        decision: item.decision,
        related_receipt_id: item.related_receipt_id,
        related_session_id: item.related_session_id,
        created_at: item.created_at,
        ...(item.decision === 'ALLOW' ? { payload: item.payload } : {}),
        ...(item.decision === 'HIDE' ? { hidden_variable_id: item.hidden_variable_id } : {}),
        ...(item.decision === 'ESCALATE' ? { escalation_stub: item.escalation_stub } : {}),
      })),
    };
  }
}
