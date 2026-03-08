import type { AgentDescriptor } from './direct-afal-transport.js';

export const AGENTVAULT_A2A_EXTENSION_URI = 'urn:agentvault:bounded-disclosure:v1';

export interface AgentVaultA2AExtensionParams {
  relay_url?: string;
  public_key_hex: string;
  supported_purposes: string[];
  afal_endpoint?: string;
  a2a_send_message_url?: string;
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

export function buildAgentCard(params: {
  baseUrl: string;
  descriptor: AgentDescriptor;
  supportedPurposes: string[];
  relayUrl?: string;
  includeAfalEndpoint?: boolean;
}): AgentCard {
  const extensionParams: AgentVaultA2AExtensionParams = {
    public_key_hex: params.descriptor.identity_key.public_key_hex,
    supported_purposes: params.supportedPurposes,
    ...(params.relayUrl ? { relay_url: params.relayUrl } : {}),
    a2a_send_message_url: `${params.baseUrl}/a2a/send-message`,
    ...(params.includeAfalEndpoint === false ? {} : { afal_endpoint: `${params.baseUrl}/afal` }),
  };

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
