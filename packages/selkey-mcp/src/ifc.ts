/**
 * Post-session IFC messages with recipient-issued grants (VCAV-IFC-GRANT-V2).
 *
 * The RECIPIENT R of future messages issues a grant to a sender S (the
 * audience), only for a session receipt R holds in which S was the
 * counterparty. R keeps the authoritative grant state in its own store
 * (.selkey/ifc-grants.json, 0600 in a 0700 directory): expiry, use count,
 * seen message_ids, revocation. Every issue, use, denial, revocation and
 * expiry is appended to .selkey/ifc-audit.jsonl.
 *
 * S sends a message under a grant it RECEIVED from R. R accepts the envelope
 * only if the grant is in R's store and active, the envelope is signed by the
 * audience's pinned key (unchanged since issuance), the class is in scope, the
 * message_id is new and uses < max_uses. V1 grants are rejected.
 *
 * Grant V2 (signed with the AFAL signing rules, domain prefix
 * "VCAV-IFC-GRANT-V2:"; grant_id = hex(SHA-256(JCS(grant without grant_id
 * and signature)))):
 *   version                "VCAV-IFC-GRANT-V2"
 *   grant_id               64 hex
 *   issuer                 recipient agent_id
 *   issuer_public_key_hex  recipient key (informational; verifiers use pins)
 *   audience               sender agent_id
 *   audience_key_fpr       "ed25519:" + hex(SHA-256(audience pinned key))
 *   label_ceiling          "POST_SESSION_BOUND"
 *   scope                  { message_classes[], session_relation: "POST_SESSION" }
 *   permissions            { max_uses }
 *   provenance             { receipt_id, session_id }
 *   issued_at, expires_at  RFC 3339
 *   signature              128 hex
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { contentHash, DOMAIN_PREFIXES, signMessage, verifyMessage } from './afal-signing.js';
import {
  SELKEY_IFC_ENVELOPE_MEDIA_TYPE,
  SELKEY_IFC_GRANT_MEDIA_TYPE,
  SELKEY_IFC_RESULT_MEDIA_TYPE,
  buildA2ASendMessageRequest,
  parseA2ATaskPart,
} from './a2a-messages.js';
import type { NormalizedKnownAgent } from './tools/relaySignal.js';
import {
  PinStore,
  keyFingerprint,
  normalizeAgentId,
  normalizePublicKeyHex,
  resolveAgentHint,
  type PinResolver,
} from './pin-store.js';
import { findHeldReceipt } from './held-receipts.js';
import { appendPrivateLine, readPrivateJson, selkeyStateDir, writePrivateJson } from './secure-fs.js';

export type IfcMessageClass = 'LOGISTICS' | 'CONSENT' | 'REFERENCE' | 'ARTIFACT_TRANSFER';
export type IfcSessionRelation = 'POST_SESSION';
export type IfcDecision = 'ALLOW' | 'HIDE' | 'ESCALATE' | 'BLOCK';

export const IFC_GRANT_VERSION = 'VCAV-IFC-GRANT-V2';

export interface IfcKnownAgent extends NormalizedKnownAgent {
  a2a_send_message_url?: string;
  public_key_hex?: string;
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
  version: typeof IFC_GRANT_VERSION;
  issuer: string;
  issuer_public_key_hex: string;
  audience: string;
  audience_key_fpr: string;
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
  /** Agent allowed to send messages to this agent under the grant. */
  audience: string;
  /** A receipt this agent holds from a session with `audience`. */
  receipt_id: string;
  /** Optional; must match the held receipt's session_id when given. */
  session_id?: string;
  message_classes: IfcMessageClass[];
  max_uses: number;
  expires_in_seconds: number;
}

export interface SendIfcMessageArgs {
  counterparty: string;
  /** A grant received from `counterparty` (or its grant_id). */
  grant?: IfcGrant;
  grant_id?: string;
  message_class: IfcMessageClass;
  payload: string;
  related_receipt_id?: string;
  related_session_id?: string;
}

export interface ReadIfcMessagesArgs {
  limit?: number;
}

export interface RevokeIfcGrantArgs {
  grant_id: string;
  reason?: string;
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

/** R's authoritative state for a grant it issued. */
export interface IssuedGrantRecord {
  grant: IfcGrant;
  grant_id: string;
  audience: string;
  audience_key_fpr: string;
  scope: IfcGrantScope;
  max_uses: number;
  uses: number;
  seen_message_ids: string[];
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  expiry_logged: boolean;
  provenance: IfcGrantProvenance;
}

interface GrantStoreFileV1 {
  version: 1;
  agent_id: string;
  issued: Record<string, IssuedGrantRecord>;
  received: Record<string, IfcGrant>;
}

export type IfcGrantState = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'EXHAUSTED';

const POST_SESSION_POLICY_HASH = contentHash({
  policy_version: 'POST_SESSION_V1',
  allowed_classes: ['LOGISTICS', 'CONSENT', 'REFERENCE', 'ARTIFACT_TRANSFER'],
});
const DEFAULT_MAX_GRANT_TTL_SECONDS = 86400;
const MAX_USES_CEILING = 100;
const MAX_PAYLOAD_CHARS = 4096;
const UUID_LOWER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

/** Receipt and session ids are lowercase UUIDs or 64 lowercase hex chars. */
function assertSessionRef(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !(UUID_LOWER_RE.test(value) || HEX64_RE.test(value))) {
    throw new Error(`${field} must be a lowercase UUID or 64 lowercase hex characters`);
  }
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

function pinsFromKnownAgents(knownAgents: IfcKnownAgent[]): PinResolver {
  const seeds = [];
  for (const agent of knownAgents) {
    if (typeof agent.public_key_hex !== 'string') continue;
    try {
      seeds.push({ agentId: agent.agent_id, publicKeyHex: normalizePublicKeyHex(agent.public_key_hex) });
    } catch {
      console.error(`IFC: ignoring known agent ${agent.agent_id} with an invalid public_key_hex`);
    }
  }
  return PinStore.inMemory(seeds);
}

function maxGrantTtlSeconds(): number {
  const raw = process.env['SELKEY_IFC_MAX_GRANT_TTL_SECONDS'];
  const parsed = raw ? Number(raw) : DEFAULT_MAX_GRANT_TTL_SECONDS;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= DEFAULT_MAX_GRANT_TTL_SECONDS
    ? parsed
    : DEFAULT_MAX_GRANT_TTL_SECONDS;
}

/** Structural check of a V2 grant and its grant_id; throws on anything else (incl. V1). */
function assertGrantShape(grant: unknown): asserts grant is IfcGrant {
  if (!grant || typeof grant !== 'object') throw new Error('grant must be an object');
  const g = grant as Record<string, unknown>;
  if (g['version'] !== IFC_GRANT_VERSION) {
    throw new Error(`unsupported grant version: ${String(g['version'])} (expected ${IFC_GRANT_VERSION})`);
  }
  for (const field of ['grant_id', 'issuer', 'issuer_public_key_hex', 'audience', 'audience_key_fpr', 'issued_at', 'expires_at', 'signature']) {
    if (typeof g[field] !== 'string' || !g[field]) throw new Error(`grant is missing ${field}`);
  }
  const scope = g['scope'] as Record<string, unknown> | undefined;
  if (!scope || !Array.isArray(scope['message_classes']) || scope['session_relation'] !== 'POST_SESSION') {
    throw new Error('grant scope is malformed');
  }
  const permissions = g['permissions'] as Record<string, unknown> | undefined;
  if (!permissions || typeof permissions['max_uses'] !== 'number') throw new Error('grant permissions are malformed');
  const provenance = g['provenance'] as Record<string, unknown> | undefined;
  if (!provenance) throw new Error('grant provenance is missing');
  assertSessionRef(provenance['receipt_id'], 'receipt_id');
  assertSessionRef(provenance['session_id'], 'session_id');
  const { signature: _sig, grant_id, ...unsigned } = g;
  if (contentHash(unsigned) !== grant_id) throw new Error('grant_id mismatch');
}

export class IfcService {
  private readonly agentId: string;
  private readonly seedHex: string;
  private readonly verifyingKeyHex: string;
  private knownAgents: IfcKnownAgent[];
  private pins: PinResolver;
  private readonly explicitPins: boolean;
  private readonly stateDir: string;
  private readonly inbox: IfcStoredMessage[] = [];
  private hiddenCounter = 0;

  constructor(params: {
    agentId: string;
    seedHex: string;
    knownAgents?: IfcKnownAgent[];
    verifyingKeyHex: string;
    /** Agent identity pins; defaults to the public keys in knownAgents. */
    pins?: PinResolver;
    /** Directory for grant store, audit log and held receipts (default $SELKEY_WORKDIR/.selkey). */
    stateDir?: string;
  }) {
    this.agentId = normalizeAgentId(params.agentId);
    this.seedHex = params.seedHex;
    this.knownAgents = params.knownAgents ?? [];
    this.verifyingKeyHex = params.verifyingKeyHex;
    this.explicitPins = params.pins !== undefined;
    this.pins = params.pins ?? pinsFromKnownAgents(this.knownAgents);
    this.stateDir = params.stateDir ?? selkeyStateDir();
  }

  setKnownAgents(knownAgents: IfcKnownAgent[]): void {
    this.knownAgents = knownAgents;
    if (!this.explicitPins) this.pins = pinsFromKnownAgents(knownAgents);
  }

  // ── State ────────────────────────────────────────────────────────────

  private get grantStorePath(): string {
    return path.join(this.stateDir, 'ifc-grants.json');
  }

  private get auditPath(): string {
    return path.join(this.stateDir, 'ifc-audit.jsonl');
  }

  private loadStore(): GrantStoreFileV1 {
    const raw = readPrivateJson(this.grantStorePath) as Partial<GrantStoreFileV1> | undefined;
    if (raw === undefined) return { version: 1, agent_id: this.agentId, issued: {}, received: {} };
    if (raw.version !== 1 || typeof raw.issued !== 'object' || typeof raw.received !== 'object' || !raw.issued || !raw.received) {
      throw new Error(`${this.grantStorePath} is not a valid IFC grant store`);
    }
    if (raw.agent_id !== this.agentId) {
      throw new Error(`${this.grantStorePath} belongs to agent ${String(raw.agent_id)}`);
    }
    return raw as GrantStoreFileV1;
  }

  private saveStore(store: GrantStoreFileV1): void {
    writePrivateJson(this.grantStorePath, store);
  }

  private audit(event: string, fields: Record<string, unknown>): void {
    appendPrivateLine(
      this.auditPath,
      JSON.stringify({ ts: new Date().toISOString(), agent: this.agentId, event, ...fields }),
    );
  }

  private resolveKnownAgent(hint: string): IfcKnownAgent | undefined {
    const agentId = resolveAgentHint(hint, this.knownAgents);
    return agentId === undefined
      ? undefined
      : this.knownAgents.find((agent) => normalizeAgentId(agent.agent_id) === agentId);
  }

  private resolveAgentId(hint: string): string {
    return resolveAgentHint(hint, this.knownAgents) ?? normalizeAgentId(hint);
  }

  private requirePin(agentId: string, role: string): string {
    const key = this.pins.pinnedKeyFor(agentId);
    if (!key) throw new Error(`no pinned key for ${role}: ${agentId}`);
    return key;
  }

  private stateOf(record: IssuedGrantRecord, nowMs: number): IfcGrantState {
    if (record.revoked_at) return 'REVOKED';
    if (Date.parse(record.expires_at) <= nowMs) return 'EXPIRED';
    if (record.uses >= record.max_uses) return 'EXHAUSTED';
    return 'ACTIVE';
  }

  /** Log EXPIRE once for each grant that has expired. Returns true if anything changed. */
  private noteExpiries(store: GrantStoreFileV1, nowMs: number): boolean {
    let changed = false;
    for (const record of Object.values(store.issued)) {
      if (!record.expiry_logged && !record.revoked_at && Date.parse(record.expires_at) <= nowMs) {
        record.expiry_logged = true;
        this.audit('EXPIRE', { grant_id: record.grant_id, audience: record.audience });
        changed = true;
      }
    }
    return changed;
  }

  pendingCount(): number {
    return this.inbox.filter((m) => !m.read).length;
  }

  // ── Issuance (recipient side) ────────────────────────────────────────

  /**
   * Issue a grant allowing `audience` to send this agent post-session
   * messages. Requires a receipt this agent holds in which `audience` was the
   * counterparty, and a pinned key for `audience`.
   */
  createGrant(args: CreateIfcGrantArgs): {
    grant: IfcGrant;
    grant_id: string;
    expires_at: string;
    scope: IfcGrantScope;
  } {
    if (!Number.isInteger(args.max_uses) || args.max_uses < 1 || args.max_uses > MAX_USES_CEILING) {
      throw new Error(`max_uses must be an integer between 1 and ${MAX_USES_CEILING}`);
    }
    const ttlCeiling = maxGrantTtlSeconds();
    if (!Number.isInteger(args.expires_in_seconds) || args.expires_in_seconds < 1 || args.expires_in_seconds > ttlCeiling) {
      throw new Error(`expires_in_seconds must be an integer between 1 and ${ttlCeiling}`);
    }
    if (!Array.isArray(args.message_classes) || args.message_classes.length < 1) {
      throw new Error('message_classes must contain at least one value');
    }
    const classes = [...new Set(args.message_classes)];
    classes.forEach((value) => assertMessageClass(value));
    assertSessionRef(args.receipt_id, 'receipt_id');

    const audience = this.resolveAgentId(args.audience);
    const held = findHeldReceipt(this.agentId, args.receipt_id, this.stateDir);
    if (!held) {
      throw new Error('no held receipt with this receipt_id: grants are issued only for sessions this agent completed');
    }
    if (normalizeAgentId(held.counterparty) !== audience) {
      throw new Error('grant audience was not the counterparty in the referenced session');
    }
    if (args.session_id !== undefined && args.session_id !== held.session_id) {
      throw new Error('session_id does not match the held receipt');
    }
    const audienceKey = this.requirePin(audience, 'audience');

    const now = new Date();
    const unsigned: IfcGrantUnsigned = {
      version: IFC_GRANT_VERSION,
      issuer: this.agentId,
      issuer_public_key_hex: this.verifyingKeyHex,
      audience,
      audience_key_fpr: keyFingerprint(audienceKey),
      label_ceiling: 'POST_SESSION_BOUND',
      scope: { message_classes: classes, session_relation: 'POST_SESSION' },
      permissions: { max_uses: args.max_uses },
      provenance: { receipt_id: held.receipt_id, session_id: held.session_id },
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + args.expires_in_seconds * 1000).toISOString(),
    };
    const grant_id = contentHash(unsigned);
    const grant = signMessage(DOMAIN_PREFIXES.IFC_GRANT, { ...unsigned, grant_id }, this.seedHex) as IfcGrant;

    const store = this.loadStore();
    store.issued[grant_id] = {
      grant,
      grant_id,
      audience,
      audience_key_fpr: grant.audience_key_fpr,
      scope: grant.scope,
      max_uses: args.max_uses,
      uses: 0,
      seen_message_ids: [],
      issued_at: grant.issued_at,
      expires_at: grant.expires_at,
      revoked_at: null,
      expiry_logged: false,
      provenance: grant.provenance,
    };
    this.saveStore(store);
    this.audit('ISSUE', {
      grant_id,
      audience,
      message_classes: classes,
      max_uses: args.max_uses,
      expires_at: grant.expires_at,
      receipt_id: held.receipt_id,
    });
    return { grant, grant_id, expires_at: grant.expires_at, scope: grant.scope };
  }

  /**
   * Deliver an issued grant to its audience's A2A endpoint (known agents
   * only). Returns whether the audience accepted it.
   */
  async deliverGrant(grant: IfcGrant): Promise<{ delivered: boolean; error?: string }> {
    const peer = this.resolveKnownAgent(grant.audience);
    if (!peer?.a2a_send_message_url) {
      return { delivered: false, error: 'audience has no a2a_send_message_url; pass the grant to it out of band' };
    }
    try {
      const response = await fetch(peer.a2a_send_message_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildA2ASendMessageRequest({
            mediaType: SELKEY_IFC_GRANT_MEDIA_TYPE,
            data: { grant },
            acceptedOutputModes: [SELKEY_IFC_RESULT_MEDIA_TYPE],
          }),
        ),
      });
      const parsed = parseA2ATaskPart(await response.json(), [SELKEY_IFC_RESULT_MEDIA_TYPE]);
      const data = parsed?.data as { accepted?: boolean; error?: string } | undefined;
      return data?.accepted === true
        ? { delivered: true }
        : { delivered: false, error: data?.error ?? `delivery failed (${response.status})` };
    } catch (err) {
      return { delivered: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  revokeGrant(args: RevokeIfcGrantArgs): { grant_id: string; revoked_at: string } {
    const store = this.loadStore();
    const record = store.issued[args.grant_id];
    if (!record) throw new Error('unknown grant_id');
    if (!record.revoked_at) {
      record.revoked_at = new Date().toISOString();
      this.saveStore(store);
      this.audit('REVOKE', { grant_id: args.grant_id, audience: record.audience, reason: args.reason ?? null });
    }
    return { grant_id: args.grant_id, revoked_at: record.revoked_at };
  }

  listGrants(): {
    issued: Array<Record<string, unknown>>;
    received: Array<Record<string, unknown>>;
  } {
    const nowMs = Date.now();
    const store = this.loadStore();
    if (this.noteExpiries(store, nowMs)) this.saveStore(store);
    return {
      issued: Object.values(store.issued).map((r) => ({
        grant_id: r.grant_id,
        audience: r.audience,
        state: this.stateOf(r, nowMs),
        message_classes: r.scope.message_classes,
        uses: r.uses,
        max_uses: r.max_uses,
        issued_at: r.issued_at,
        expires_at: r.expires_at,
        revoked_at: r.revoked_at,
        provenance: r.provenance,
      })),
      received: Object.values(store.received).map((g) => ({
        grant_id: g.grant_id,
        issuer: g.issuer,
        message_classes: g.scope.message_classes,
        max_uses: g.permissions.max_uses,
        expires_at: g.expires_at,
        expired: Date.parse(g.expires_at) <= nowMs,
        provenance: g.provenance,
      })),
    };
  }

  // ── Sender side ──────────────────────────────────────────────────────

  /**
   * Verify a grant issued TO this agent: V2, audience is this agent, issuer
   * pinned and the signature verifies under that pin, not expired.
   */
  verifyReceivedGrant(grant: unknown, nowMs: number = Date.now()): IfcGrant {
    assertGrantShape(grant);
    if (normalizeAgentId(grant.audience) !== this.agentId) throw new Error('grant audience is not this agent');
    const issuerKey = this.requirePin(grant.issuer, 'grant issuer');
    if (!verifyMessage(DOMAIN_PREFIXES.IFC_GRANT, grant as unknown as Record<string, unknown>, issuerKey)) {
      throw new Error('grant signature does not verify under the issuer pin');
    }
    if (Date.parse(grant.expires_at) <= nowMs) throw new Error('grant expired');
    return grant;
  }

  /** Store a grant delivered by its issuer (A2A ifc-grant part). */
  receiveGrant(input: { grant: unknown }): { accepted: boolean; grant_id?: string; error?: string } {
    try {
      const grant = this.verifyReceivedGrant(input.grant);
      const store = this.loadStore();
      store.received[grant.grant_id] = grant;
      this.saveStore(store);
      this.audit('RECEIVE_GRANT', { grant_id: grant.grant_id, issuer: grant.issuer });
      return { accepted: true, grant_id: grant.grant_id };
    } catch (error) {
      return { accepted: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendMessage(args: SendIfcMessageArgs): Promise<IfcDeliveryResult> {
    assertMessageClass(args.message_class);
    if (typeof args.payload !== 'string' || args.payload.length > MAX_PAYLOAD_CHARS) {
      throw new Error(`payload must be a string of at most ${MAX_PAYLOAD_CHARS} characters`);
    }
    let grantInput: unknown = args.grant;
    if (grantInput === undefined) {
      if (!args.grant_id) throw new Error('grant or grant_id is required');
      grantInput = this.loadStore().received[args.grant_id];
      if (!grantInput) throw new Error('no received grant with this grant_id');
    }
    const grant = this.verifyReceivedGrant(grantInput);
    const counterparty = this.resolveAgentId(args.counterparty);
    if (normalizeAgentId(grant.issuer) !== counterparty) {
      throw new Error('grant was not issued by the counterparty');
    }
    if (args.related_receipt_id !== undefined && args.related_receipt_id !== grant.provenance.receipt_id) {
      throw new Error('grant receipt provenance mismatch');
    }
    if (args.related_session_id !== undefined && args.related_session_id !== grant.provenance.session_id) {
      throw new Error('grant session provenance mismatch');
    }
    if (!grant.scope.message_classes.includes(args.message_class)) {
      throw new Error('grant does not allow this message_class');
    }

    const peer = this.resolveKnownAgent(counterparty);
    if (!peer?.a2a_send_message_url) {
      throw new Error('counterparty has no a2a_send_message_url');
    }

    const unsigned: IfcEnvelopeUnsigned = {
      version: 'AV-IFC-MSG-V1',
      message_id: randomUUID(),
      created_at: new Date().toISOString(),
      sender: this.agentId,
      recipient: grant.issuer,
      message_class: args.message_class,
      session_relation: 'POST_SESSION',
      payload: args.payload,
      related_receipt_id: grant.provenance.receipt_id,
      related_session_id: grant.provenance.session_id,
      grant_id: grant.grant_id,
      ifc_policy_hash: POST_SESSION_POLICY_HASH,
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
          mediaType: SELKEY_IFC_ENVELOPE_MEDIA_TYPE,
          data: { envelope },
          acceptedOutputModes: [SELKEY_IFC_RESULT_MEDIA_TYPE],
        }),
      ),
    });
    const payload = await response.json();
    const parsed = parseA2ATaskPart(payload, [SELKEY_IFC_RESULT_MEDIA_TYPE]);
    if (!parsed) {
      throw new Error('A2A SendMessage response did not contain an IFC result part');
    }
    return parsed.data as IfcDeliveryResult;
  }

  // ── Recipient side ───────────────────────────────────────────────────

  /**
   * Accept an envelope only under a grant this agent issued and still holds
   * as active. The envelope must be signed by the grant audience's pinned key.
   */
  receiveEnvelope(input: { envelope: IfcEnvelope; grant?: unknown }): IfcDeliveryResult {
    const envelope = input.envelope;
    const blocked = (reason: string): IfcDeliveryResult => {
      try {
        this.audit('DENY', {
          grant_id: typeof envelope?.grant_id === 'string' ? envelope.grant_id : null,
          message_id: typeof envelope?.message_id === 'string' ? envelope.message_id : null,
          sender: typeof envelope?.sender === 'string' ? envelope.sender : null,
          reason,
        });
      } catch (err) {
        console.error(`IFC audit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return {
        decision: 'BLOCK',
        message_id: envelope?.message_id,
        related_receipt_id: envelope?.related_receipt_id,
        related_session_id: envelope?.related_session_id,
        error: reason,
      };
    };
    try {
      if (!envelope || typeof envelope !== 'object') return blocked('envelope must be an object');
      if (input.grant !== undefined) {
        // Senders reference grants by id; a grant object in the message is
        // never authoritative. Reject anything that is not a V2 grant.
        const version = (input.grant as Record<string, unknown> | null)?.['version'];
        if (version !== IFC_GRANT_VERSION) return blocked(`unsupported grant version: ${String(version)}`);
      }
      if (envelope.version !== 'AV-IFC-MSG-V1') return blocked('unsupported envelope version');
      if (typeof envelope.message_id !== 'string' || !UUID_LOWER_RE.test(envelope.message_id)) {
        return blocked('message_id must be a lowercase UUID');
      }
      if (normalizeAgentId(String(envelope.recipient)) !== this.agentId) return blocked('recipient mismatch');

      const nowMs = Date.now();
      const store = this.loadStore();
      const expiriesChanged = this.noteExpiries(store, nowMs);
      const record = store.issued[envelope.grant_id];
      if (!record) {
        if (expiriesChanged) this.saveStore(store);
        return blocked('unknown grant_id');
      }
      // The stored grant must still be ours (file integrity).
      if (!verifyMessage(DOMAIN_PREFIXES.IFC_GRANT, record.grant as unknown as Record<string, unknown>, this.verifyingKeyHex)) {
        return blocked('stored grant does not verify under this agent key');
      }
      const deny = (reason: string): IfcDeliveryResult => {
        if (expiriesChanged) this.saveStore(store);
        return blocked(reason);
      };
      const state = this.stateOf(record, nowMs);
      if (state !== 'ACTIVE') return deny(`grant ${state.toLowerCase()}`);
      if (normalizeAgentId(String(envelope.sender)) !== record.audience) return deny('sender is not the grant audience');
      const senderKey = this.pins.pinnedKeyFor(record.audience);
      if (!senderKey) return deny('grant audience is not pinned');
      if (keyFingerprint(senderKey) !== record.audience_key_fpr) {
        return deny('grant audience key changed since issuance');
      }
      if (!verifyMessage(DOMAIN_PREFIXES.IFC_ENVELOPE, envelope as unknown as Record<string, unknown>, senderKey)) {
        return deny('envelope signature does not verify under the audience pin');
      }
      if (!record.scope.message_classes.includes(envelope.message_class)) return deny('grant scope mismatch');
      if (envelope.session_relation !== 'POST_SESSION') return deny('unsupported session_relation');
      if (envelope.ifc_policy_hash !== POST_SESSION_POLICY_HASH) return deny('ifc_policy_hash mismatch');
      if (envelope.related_receipt_id !== record.provenance.receipt_id) return deny('receipt provenance mismatch');
      if (envelope.related_session_id !== record.provenance.session_id) return deny('session provenance mismatch');
      if (typeof envelope.payload !== 'string' || envelope.payload.length > MAX_PAYLOAD_CHARS) {
        return deny('payload too large');
      }
      if (Object.values(store.issued).some((r) => r.seen_message_ids.includes(envelope.message_id))) {
        return deny('duplicate message_id');
      }

      // Count the use durably before accepting the message.
      record.uses += 1;
      record.seen_message_ids.push(envelope.message_id);
      this.saveStore(store);
      this.audit('USE', {
        grant_id: record.grant_id,
        message_id: envelope.message_id,
        sender: record.audience,
        message_class: envelope.message_class,
        uses: record.uses,
        max_uses: record.max_uses,
      });

      const decision = classifyDecision(envelope.message_class);
      const stored: IfcStoredMessage = {
        message_id: envelope.message_id,
        sender: record.audience,
        recipient: this.agentId,
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
            grant_id: record.grant_id,
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
      return blocked(error instanceof Error ? error.message : String(error));
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
