import type { AgentDescriptor } from './direct-afal-transport.js';
import type { SupportedContractOffer } from './contract-negotiation.js';
import { sign, verify, DOMAIN_PREFIXES } from './afal-signing.js';

export const AGENTVAULT_A2A_EXTENSION_URI = 'urn:agentvault:bounded-disclosure:v1';

export interface AgentVaultA2AExtensionParams {
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
  card_signature?: string;
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
}

/**
 * Build the canonical signed object from a card and its extension params.
 *
 * Only includes optional fields when they are present — the verifier must
 * reconstruct the same object from the card it receives.
 */
export function buildCardSignedPayload(
  agentId: string,
  extensionParams: AgentVaultA2AExtensionParams,
): AgentCardSignedPayload {
  const payload: AgentCardSignedPayload = {
    agent_id: agentId,
    extension_uri: AGENTVAULT_A2A_EXTENSION_URI,
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
  extensionParams: AgentVaultA2AExtensionParams,
  seedHex: string,
): string {
  const payload = buildCardSignedPayload(agentId, extensionParams);
  return sign(
    DOMAIN_PREFIXES.AGENT_CARD,
    payload as unknown as Record<string, unknown>,
    seedHex,
  );
}

/**
 * Verify an agent card signature.
 *
 * Returns true if the signature is valid for the given canonical payload.
 */
export function verifyAgentCardSignature(
  agentId: string,
  extensionParams: AgentVaultA2AExtensionParams,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
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
}): AgentCard {
  const extensionParams: AgentVaultA2AExtensionParams = {
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
    description: 'Supports AgentVault bounded-disclosure coordination sessions',
    version: '1.0.0',
    url: params.baseUrl,
    capabilities: {
      extensions: [
        {
          uri: AGENTVAULT_A2A_EXTENSION_URI,
          description: 'Supports AgentVault bounded-disclosure coordination sessions',
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
      id: 'agentvault-compatibility',
      name: 'Bounded Compatibility Assessment',
      description: 'Schema-bounded compatibility signal via AgentVault relay',
      tags: ['agentvault', 'bounded-disclosure', 'compatibility'],
      input_modes: ['application/vnd.agentvault.propose+json'],
      output_modes: ['application/vnd.agentvault.session-tokens+json'],
    };
  }

  if (purpose === 'MEDIATION') {
    return {
      id: 'agentvault-mediation',
      name: 'Bounded Mediation Signal',
      description: 'Schema-bounded mediation signal via AgentVault relay',
      tags: ['agentvault', 'bounded-disclosure', 'mediation'],
      input_modes: ['application/vnd.agentvault.propose+json'],
      output_modes: ['application/vnd.agentvault.session-tokens+json'],
    };
  }

  return {
    id: `agentvault-${purpose.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: `Bounded ${purpose} Session`,
    description: `Schema-bounded ${purpose} signal via AgentVault relay`,
    tags: ['agentvault', 'bounded-disclosure', purpose.toLowerCase()],
    input_modes: ['application/vnd.agentvault.propose+json'],
    output_modes: ['application/vnd.agentvault.session-tokens+json'],
  };
}
