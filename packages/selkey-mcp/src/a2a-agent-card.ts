import type { AgentDescriptor } from './direct-afal-transport.js';
import type { SupportedContractOffer } from './contract-negotiation.js';
import { sign, verify, DOMAIN_PREFIXES } from './afal-signing.js';

export const SELKEY_A2A_EXTENSION_URI = 'urn:selkey:bounded-disclosure:v1';

export interface SelkeyA2AExtensionParams {
  relay_url?: string;
  public_key_hex: string;
  supported_purposes: string[];
  afal_endpoint?: string;
  a2a_send_message_url?: string;
  supports_topic_alignment?: boolean;
  supported_topic_codes?: string[];
  supports_precontract_negotiation?: boolean;
  supports_bespoke_contract_negotiation?: boolean;
  supported_contract_offers?: SupportedContractOffer[];
  /** RFC 3339 UTC time the card was signed (signed field). */
  issued_at?: string;
  /** RFC 3339 UTC time after which the card must not be used (signed field). */
  expires_at?: string;
  card_signature?: string;
}

/** Lifetime of the cards this agent signs. Served cards are signed per request. */
export const AGENT_CARD_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Longest card lifetime (expires_at - issued_at) a verifier accepts. */
export const AGENT_CARD_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** How far in the future a card's issued_at may be (clock skew). */
export const AGENT_CARD_MAX_FUTURE_SKEW_MS = 60 * 1000;

const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function parseUtc(value: unknown): number {
  return typeof value === 'string' && RFC3339_UTC_RE.test(value) ? Date.parse(value) : NaN;
}

/**
 * Check a card's validity window: issued_at and expires_at present as RFC
 * 3339 UTC, issued_at not more than AGENT_CARD_MAX_FUTURE_SKEW_MS ahead of
 * `nowMs`, expires_at after issued_at and after `nowMs`, and a lifetime of
 * at most AGENT_CARD_MAX_LIFETIME_MS. Returns the reason it is not valid, or
 * null.
 */
export function agentCardValidityError(
  extensionParams: Pick<SelkeyA2AExtensionParams, 'issued_at' | 'expires_at'>,
  nowMs: number = Date.now(),
): string | null {
  const issued = parseUtc(extensionParams.issued_at);
  const expires = parseUtc(extensionParams.expires_at);
  if (Number.isNaN(issued) || Number.isNaN(expires)) return 'issued_at and expires_at must be RFC 3339 UTC timestamps';
  if (issued > nowMs + AGENT_CARD_MAX_FUTURE_SKEW_MS) return 'issued_at is in the future';
  if (expires <= issued) return 'expires_at must be after issued_at';
  if (expires - issued > AGENT_CARD_MAX_LIFETIME_MS) return 'card lifetime exceeds the maximum';
  if (expires <= nowMs) return 'card has expired';
  return null;
}

export interface AgentCardExtension {
  uri: string;
  description: string;
  required: boolean;
  params: Record<string, unknown>;
}

export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  input_modes: string[];
  output_modes: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  url: string;
  capabilities: {
    extensions: AgentCardExtension[];
  };
  skills: AgentCardSkill[];
}

/**
 * Canonical signed object for agent card verification.
 *
 * Includes all trust-relevant fields that the resolver uses for trust decisions.
 * Fields are sorted alphabetically for deterministic canonicalization.
 */
export interface AgentCardSignedPayload {
  a2a_send_message_url?: string;
  afal_endpoint?: string;
  agent_id: string;
  extension_uri: string;
  extension_version: string;
  public_key_hex: string;
  relay_url?: string;
  supported_contract_offers?: SupportedContractOffer[];
  supported_purposes: string[];
  supported_topic_codes?: string[];
  supports_bespoke_contract_negotiation?: boolean;
  supports_precontract_negotiation?: boolean;
  supports_topic_alignment?: boolean;
  issued_at: string;
  expires_at: string;
}

/**
 * Build the canonical signed object from a card and its extension params.
 *
 * Only includes optional fields when they are present — the verifier must
 * reconstruct the same object from the card it receives.
 */
export function buildCardSignedPayload(
  agentId: string,
  extensionParams: SelkeyA2AExtensionParams,
): AgentCardSignedPayload {
  const payload: AgentCardSignedPayload = {
    issued_at: extensionParams.issued_at ?? '',
    expires_at: extensionParams.expires_at ?? '',
    agent_id: agentId,
    extension_uri: SELKEY_A2A_EXTENSION_URI,
    extension_version: '1',
    public_key_hex: extensionParams.public_key_hex,
    supported_purposes: extensionParams.supported_purposes,
  };

  if (extensionParams.relay_url !== undefined) {
    payload.relay_url = extensionParams.relay_url;
  }
  if (extensionParams.a2a_send_message_url !== undefined) {
    payload.a2a_send_message_url = extensionParams.a2a_send_message_url;
  }
  if (extensionParams.afal_endpoint !== undefined) {
    payload.afal_endpoint = extensionParams.afal_endpoint;
  }
  if (extensionParams.supports_topic_alignment !== undefined) {
    payload.supports_topic_alignment = extensionParams.supports_topic_alignment;
  }
  if (extensionParams.supported_topic_codes !== undefined) {
    payload.supported_topic_codes = extensionParams.supported_topic_codes;
  }
  if (extensionParams.supports_precontract_negotiation !== undefined) {
    payload.supports_precontract_negotiation = extensionParams.supports_precontract_negotiation;
  }
  if (extensionParams.supported_contract_offers !== undefined) {
    payload.supported_contract_offers = extensionParams.supported_contract_offers;
  }
  if (extensionParams.supports_bespoke_contract_negotiation !== undefined) {
    payload.supports_bespoke_contract_negotiation =
      extensionParams.supports_bespoke_contract_negotiation;
  }

  return payload;
}

/**
 * Sign the canonical agent card payload, returning the hex signature.
 */
export function signAgentCard(
  agentId: string,
  extensionParams: SelkeyA2AExtensionParams,
  seedHex: string,
): string {
  if (agentCardValidityError(extensionParams, parseUtc(extensionParams.issued_at)) !== null) {
    throw new Error('agent card needs a valid issued_at and expires_at to be signed');
  }
  const payload = buildCardSignedPayload(agentId, extensionParams);
  return sign(
    DOMAIN_PREFIXES.AGENT_CARD,
    payload as unknown as Record<string, unknown>,
    seedHex,
  );
}

/**
 * Verify an agent card: its validity window (see agentCardValidityError) at
 * `nowMs`, then the signature over the canonical payload (domain
 * VCAV-AGENT-CARD-V2:). Returns true only if both hold.
 */
export function verifyAgentCardSignature(
  agentId: string,
  extensionParams: SelkeyA2AExtensionParams,
  signatureHex: string,
  publicKeyHex: string,
  nowMs: number = Date.now(),
): boolean {
  if (agentCardValidityError(extensionParams, nowMs) !== null) return false;
  const payload = buildCardSignedPayload(agentId, extensionParams);
  return verify(
    DOMAIN_PREFIXES.AGENT_CARD,
    payload as unknown as Record<string, unknown>,
    signatureHex,
    publicKeyHex,
  );
}

export function buildAgentCard(params: {
  baseUrl: string;
  descriptor: AgentDescriptor;
  supportedPurposes: string[];
  relayUrl?: string;
  includeAfalEndpoint?: boolean;
  supportedTopicCodes?: string[];
  supportedContractOffers?: SupportedContractOffer[];
  seedHex?: string;
  supportsBespokeContractNegotiation?: boolean;
  /** Signing time (defaults to now); the card expires AGENT_CARD_LIFETIME_MS later. */
  nowMs?: number;
}): AgentCard {
  const nowMs = params.nowMs ?? Date.now();
  const extensionParams: SelkeyA2AExtensionParams = {
    public_key_hex: params.descriptor.identity_key.public_key_hex,
    supported_purposes: params.supportedPurposes,
    ...(params.relayUrl ? { relay_url: params.relayUrl } : {}),
    a2a_send_message_url: `${params.baseUrl}/a2a/send-message`,
    ...(params.includeAfalEndpoint === false ? {} : { afal_endpoint: `${params.baseUrl}/afal` }),
    ...(params.supportedTopicCodes?.length
      ? {
          supports_topic_alignment: true,
          supported_topic_codes: params.supportedTopicCodes,
        }
      : {}),
    ...(params.supportedContractOffers?.length
      ? {
          supports_precontract_negotiation: true,
          supported_contract_offers: params.supportedContractOffers,
        }
      : {}),
    ...(params.supportsBespokeContractNegotiation
      ? {
          supports_bespoke_contract_negotiation: true,
        }
      : {}),
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + AGENT_CARD_LIFETIME_MS).toISOString(),
  };

  if (params.seedHex) {
    extensionParams.card_signature = signAgentCard(
      params.descriptor.agent_id,
      extensionParams,
      params.seedHex,
    );
  }

  return {
    name: params.descriptor.agent_id,
    description: 'Supports Selkey bounded-disclosure coordination sessions',
    version: '1.0.0',
    url: params.baseUrl,
    capabilities: {
      extensions: [
        {
          uri: SELKEY_A2A_EXTENSION_URI,
          description: 'Supports Selkey bounded-disclosure coordination sessions',
          required: false,
          params: extensionParams as unknown as Record<string, unknown>,
        },
      ],
    },
    skills: params.supportedPurposes.map((purpose) => buildPurposeSkill(purpose)),
  };
}

function buildPurposeSkill(purpose: string): AgentCardSkill {
  if (purpose === 'COMPATIBILITY') {
    return {
      id: 'selkey-compatibility',
      name: 'Bounded Compatibility Assessment',
      description: 'Schema-bounded compatibility signal via Selkey relay',
      tags: ['selkey', 'bounded-disclosure', 'compatibility'],
      input_modes: ['application/vnd.selkey.propose+json'],
      output_modes: ['application/vnd.selkey.session-tokens+json'],
    };
  }

  if (purpose === 'MEDIATION') {
    return {
      id: 'selkey-mediation',
      name: 'Bounded Mediation Signal',
      description: 'Schema-bounded mediation signal via Selkey relay',
      tags: ['selkey', 'bounded-disclosure', 'mediation'],
      input_modes: ['application/vnd.selkey.propose+json'],
      output_modes: ['application/vnd.selkey.session-tokens+json'],
    };
  }

  return {
    id: `selkey-${purpose.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: `Bounded ${purpose} Session`,
    description: `Schema-bounded ${purpose} signal via Selkey relay`,
    tags: ['selkey', 'bounded-disclosure', purpose.toLowerCase()],
    input_modes: ['application/vnd.selkey.propose+json'],
    output_modes: ['application/vnd.selkey.session-tokens+json'],
  };
}
