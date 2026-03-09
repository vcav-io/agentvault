#!/usr/bin/env node
/**
 * AgentVault MCP Server
 *
 * Minimal MCP server exposing AgentVault relay tools under the agentvault namespace.
 *
 * Configuration:
 *   AV_RELAY_URL              — relay base URL (required for CREATE/JOIN modes)
 *   AV_AGENT_ID               — this agent's ID (used for contract building and idempotency)
 *   AV_RESUME_TOKEN_SECRET    — secret for HMAC-signing resume tokens (optional but recommended)
 *
 * AFAL Direct Transport (opt-in):
 *   AV_AFAL_SEED_HEX          — Ed25519 seed (required for AFAL direct mode)
 *   AV_AFAL_HTTP_PORT          — port for AFAL HTTP server (enables RESPOND mode)
 *   AV_AFAL_BIND_ADDRESS       — bind address (default: 127.0.0.1)
 *   AV_AFAL_TRUSTED_AGENTS     — JSON: [{"agentId":"...","publicKeyHex":"..."}]
 *   AV_AFAL_ALLOWED_PURPOSES   — comma-separated: "MEDIATION,COMPATIBILITY"
 *   AV_AFAL_PEER_DESCRIPTOR_URL — peer descriptor URL (INITIATE mode)
 *   AV_AFAL_ADVERTISE_AFAL_ENDPOINT — set to "false" to publish an A2A-only Agent Card
 *
 * Transport injection:
 *   INITIATE and RESPOND modes require an InviteTransport implementation.
 *   When running standalone (no transport injected), only CREATE and JOIN modes are available.
 *   Host applications (e.g., vcav-mcp-server) inject an OrchestratorClient-backed transport.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { buildError } from './envelope.js';
import { RELAY_TOOLS, IDENTITY_TOOLS, VERIFY_TOOLS } from './toolDefs.js';
import { dispatch } from './dispatch.js';
import type { InviteTransport } from './invite-transport.js';
import { OrchestratorInboxAdapter } from './afal-transport.js';
import type { AfalTransport } from './afal-transport.js';
import type { NormalizedKnownAgent } from './tools/relaySignal.js';
import { DirectAfalTransport, isAgentDescriptor } from './direct-afal-transport.js';
import type { DirectAfalTransportConfig } from './direct-afal-transport.js';
import { RelayInboxTransport } from './relay-inbox-transport.js';
import { signMessage, DOMAIN_PREFIXES } from './afal-signing.js';
import type { AdmissionPolicy, TrustedAgent } from './afal-responder.js';
import { listKnownModelProfiles } from './model-profiles.js';
import { listSupportedContractOffers } from './contract-offers.js';
import { ed25519 } from '@noble/curves/ed25519';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

/**
 * Create and start an AgentVault MCP server.
 *
 * @param inviteTransport - Optional InviteTransport for INITIATE/RESPOND modes.
 *   When omitted, only CREATE and JOIN (legacy token exchange) modes are available.
 *   Wrapped in OrchestratorInboxAdapter to provide AfalTransport.
 * @param knownAgents - Optional list of known agents for alias resolution.
 * @param directTransport - Optional pre-built AfalTransport (e.g. DirectAfalTransport).
 *   Takes precedence over inviteTransport if both are provided.
 */
export function createAgentVaultServer(
  inviteTransport?: InviteTransport,
  knownAgents: NormalizedKnownAgent[] = [],
  directTransport?: AfalTransport,
): Server {
  const afalTransport: AfalTransport | undefined =
    directTransport ??
    (inviteTransport ? new OrchestratorInboxAdapter(inviteTransport) : undefined);

  const server = new Server(
    {
      name: 'agentvault-mcp-server',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [...IDENTITY_TOOLS, ...RELAY_TOOLS, ...VERIFY_TOOLS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Resolve agent identity from the transport when available;
      // fall back to env only for standalone (no-transport) mode.
      const agentId = afalTransport?.agentId ?? process.env['AV_AGENT_ID'];
      const result = await dispatch(
        name,
        args as Record<string, unknown>,
        afalTransport,
        knownAgents,
        agentId,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(buildError('UNKNOWN_ERROR', errorMessage), null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Build a DirectAfalTransport from AV_AFAL_* environment variables.
 * Returns null if AV_AFAL_SEED_HEX is not set.
 */
function buildDirectTransportFromEnv(): DirectAfalTransport | null {
  const seedHex = process.env['AV_AFAL_SEED_HEX'];
  if (!seedHex) return null;

  const agentId = process.env['AV_AGENT_ID'];
  if (!agentId) {
    console.error('AV_AGENT_ID is required when AV_AFAL_SEED_HEX is set');
    return null;
  }
  const httpPort = process.env['AV_AFAL_HTTP_PORT'];
  const bindAddress = process.env['AV_AFAL_BIND_ADDRESS'] ?? '127.0.0.1';
  const peerDescriptorUrl = process.env['AV_AFAL_PEER_DESCRIPTOR_URL'];
  const advertiseAfalEndpoint = process.env['AV_AFAL_ADVERTISE_AFAL_ENDPOINT'] !== 'false';

  let pubKeyHex: string;
  try {
    pubKeyHex = bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)));
  } catch (err) {
    console.error(
      `AV_AFAL_SEED_HEX is not a valid 32-byte hex seed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const base = httpPort ? `http://${bindAddress}:${httpPort}` : '';

  const descriptorUnsigned: Record<string, unknown> = {
    descriptor_version: '1',
    agent_id: agentId,
    issued_at: now,
    expires_at: expiresAt,
    identity_key: { algorithm: 'ed25519', public_key_hex: pubKeyHex },
    envelope_key: { algorithm: 'ed25519', public_key_hex: pubKeyHex },
    endpoints: {
      propose: base ? `${base}/afal/propose` : '',
      commit: base ? `${base}/afal/commit` : '',
    },
    capabilities: {
      supported_body_formats: ['wrapped_v1'],
      supports_commit: true,
      supported_model_profiles: listKnownModelProfiles(),
      supported_contract_offers: listSupportedContractOffers(),
    },
    policy_commitments: {},
  };
  const localDescriptorRaw = signMessage(DOMAIN_PREFIXES.DESCRIPTOR, descriptorUnsigned, seedHex);
  if (!isAgentDescriptor(localDescriptorRaw)) {
    throw new Error('signMessage produced invalid AgentDescriptor');
  }
  const localDescriptor = localDescriptorRaw;

  const config: DirectAfalTransportConfig = {
    agentId,
    seedHex,
    localDescriptor,
    relayUrl: process.env['AV_RELAY_URL'],
    peerDescriptorUrl,
  };

  // RESPOND mode if HTTP port is configured
  if (httpPort) {
    const port = parseInt(httpPort, 10);
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      console.error(`AV_AFAL_HTTP_PORT is not a valid port: ${httpPort}`);
      return null;
    }

    let trustedAgents: TrustedAgent[] = [];
    const trustedJson = process.env['AV_AFAL_TRUSTED_AGENTS'];
    if (trustedJson) {
      try {
        const parsed: unknown = JSON.parse(trustedJson);
        if (!Array.isArray(parsed)) {
          console.error('AV_AFAL_TRUSTED_AGENTS must be a JSON array');
          return null;
        }
        for (const entry of parsed) {
          if (typeof entry?.agentId !== 'string' || typeof entry?.publicKeyHex !== 'string') {
            console.error(
              'AV_AFAL_TRUSTED_AGENTS entries must have string agentId and publicKeyHex',
            );
            return null;
          }
        }
        trustedAgents = parsed as TrustedAgent[];
      } catch {
        console.error(`AV_AFAL_TRUSTED_AGENTS is not valid JSON: ${trustedJson}`);
        return null;
      }
    }

    const allowedPurposes = (process.env['AV_AFAL_ALLOWED_PURPOSES'] ?? 'MEDIATION')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const policy: AdmissionPolicy = {
      trustedAgents,
      allowedPurposeCodes: allowedPurposes,
      allowedLaneIds: ['API_MEDIATED'],
      maxEntropyBits: 256,
      defaultTier: 'DENY',
    };

    config.respondMode = { httpPort: port, bindAddress, policy, advertiseAfalEndpoint };
  }

  return new DirectAfalTransport(config);
}

/**
 * Parse AV_KNOWN_AGENTS environment variable.
 * Expected format: JSON array of {agent_id: string, aliases: string[]}.
 */
function parseKnownAgentsFromEnv(): NormalizedKnownAgent[] {
  const raw = process.env['AV_KNOWN_AGENTS'];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error('AV_KNOWN_AGENTS must be a JSON array');
      return [];
    }
    for (const entry of parsed) {
      if (typeof entry?.agent_id !== 'string' || !Array.isArray(entry?.aliases)) {
        console.error('AV_KNOWN_AGENTS entries must have string agent_id and aliases array');
        return [];
      }
    }
    return parsed as NormalizedKnownAgent[];
  } catch {
    console.error(`AV_KNOWN_AGENTS is not valid JSON: ${raw}`);
    return [];
  }
}

/**
 * Build a RelayInboxTransport from AV_INBOX_* environment variables.
 * Returns null if AV_INBOX_TOKEN is not set or AV_INBOX_TRANSPORT !== 'relay'.
 */
function buildRelayInboxTransportFromEnv(): RelayInboxTransport | null {
  if (process.env['AV_INBOX_TRANSPORT'] !== 'relay') return null;
  // Fail-closed: when relay mode is explicitly requested, missing env vars are fatal.
  const inboxToken = process.env['AV_INBOX_TOKEN'];
  if (!inboxToken) {
    throw new Error(
      'AV_INBOX_TOKEN is required when AV_INBOX_TRANSPORT=relay. ' +
        'Set the inbox token or remove AV_INBOX_TRANSPORT to use a different mode.',
    );
  }
  const agentId = process.env['AV_AGENT_ID'];
  if (!agentId) {
    throw new Error('AV_AGENT_ID is required when AV_INBOX_TRANSPORT=relay.');
  }
  const relayUrl = process.env['AV_RELAY_URL'];
  if (!relayUrl) {
    throw new Error('AV_RELAY_URL is required when AV_INBOX_TRANSPORT=relay.');
  }
  return new RelayInboxTransport({ agentId, inboxToken, relayUrl });
}

// Standalone entry point — runs without an InviteTransport
// (CREATE/JOIN modes only unless the host injects one).
// If AV_AFAL_SEED_HEX is set, also starts DirectAfalTransport.
// If AV_INBOX_TRANSPORT=relay, uses RelayInboxTransport.
async function main() {
  const directTransport = buildDirectTransportFromEnv();
  const relayInboxTransport = buildRelayInboxTransportFromEnv();
  const knownAgents = parseKnownAgentsFromEnv();

  // Priority: relay inbox > direct AFAL > none
  const chosenTransport = relayInboxTransport ?? directTransport ?? undefined;

  const server = chosenTransport
    ? createAgentVaultServer(undefined, knownAgents, chosenTransport)
    : createAgentVaultServer(undefined, knownAgents);

  if (directTransport && !relayInboxTransport) {
    await directTransport.start();
    console.error(`AFAL Direct Transport active (agent: ${directTransport.agentId})`);
  }

  if (relayInboxTransport) {
    console.error(
      `Relay Inbox Transport active (agent: ${relayInboxTransport.agentId}, relay: ${relayInboxTransport.relayUrl})`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AgentVault MCP Server running on stdio');

  if (!chosenTransport) {
    console.error(
      'Note: INITIATE/RESPOND modes require a transport. Set AV_INBOX_TRANSPORT=relay + AV_INBOX_TOKEN, or AV_AFAL_SEED_HEX. Only CREATE/JOIN modes available in standalone mode.',
    );
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (directTransport) await directTransport.stop();
    } catch (err) {
      console.error('Error during transport shutdown:', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only run when executed directly (npx / bin entry point).
// When imported as a library, createAgentVaultServer is the API.
// realpathSync resolves npm bin symlinks so the check works after `npm install -g`.
const currentFile = fileURLToPath(import.meta.url);
const isDirectExecution = process.argv[1] && realpathSync(process.argv[1]) === currentFile;
if (isDirectExecution) {
  if (process.argv.includes('--print-config')) {
    const config = {
      mcpServers: {
        agentvault: {
          command: 'npx',
          args: ['-y', 'agentvault-mcp-server'],
          env: {
            AV_RELAY_URL: 'http://localhost:8080',
            AV_AGENT_ID: 'your-agent-id',
            AV_RESUME_TOKEN_SECRET: 'your-secret-here',
          },
        },
      },
    };
    process.stdout.write(JSON.stringify(config, null, 2) + '\n');
    process.exit(0);
  }

  main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}

export type { InviteTransport } from './invite-transport.js';
export type { AfalTransport, AfalInviteMessage, AcceptResult } from './afal-transport.js';
export { OrchestratorInboxAdapter, isAcceptResult } from './afal-transport.js';
export { RelayInboxTransport } from './relay-inbox-transport.js';
export type { RelayInboxTransportConfig } from './relay-inbox-transport.js';
export type { AfalPropose, RelayInvitePayload } from './afal-types.js';
export type { NormalizedKnownAgent } from './tools/relaySignal.js';
export { DirectAfalTransport } from './direct-afal-transport.js';
export type { DirectAfalTransportConfig, AgentDescriptor } from './direct-afal-transport.js';
export { AfalResponder } from './afal-responder.js';
export type { AdmissionPolicy, TrustedAgent, DenyCode } from './afal-responder.js';
export { AfalHttpServer } from './afal-http-server.js';
export { signMessage, DOMAIN_PREFIXES } from './afal-signing.js';
export { isAgentDescriptor } from './direct-afal-transport.js';
export { listKnownModelProfiles, resolveModelProfileRefs } from './model-profiles.js';
export type { ModelProfileRef } from './model-profiles.js';
export { listSupportedContractOffers } from './contract-offers.js';
export { buildAgentCard, buildCardSignedPayload, signAgentCard, verifyAgentCardSignature, AGENTVAULT_A2A_EXTENSION_URI } from './a2a-agent-card.js';
export type { AgentCard, AgentCardSignedPayload, AgentVaultA2AExtensionParams } from './a2a-agent-card.js';
