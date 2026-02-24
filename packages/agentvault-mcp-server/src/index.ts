#!/usr/bin/env node
/**
 * AgentVault MCP Server
 *
 * Minimal MCP server exposing AgentVault relay tools under the agentvault namespace.
 *
 * Configuration:
 *   VCAV_RELAY_URL              — relay base URL (required for CREATE/JOIN modes)
 *   VCAV_AGENT_ID               — this agent's ID (used for contract building and idempotency)
 *   VCAV_RESUME_TOKEN_SECRET    — secret for HMAC-signing resume tokens (optional but recommended)
 *
 * AFAL Direct Transport (opt-in):
 *   VCAV_AFAL_SEED_HEX          — Ed25519 seed (required for AFAL direct mode)
 *   VCAV_AFAL_HTTP_PORT          — port for AFAL HTTP server (enables RESPOND mode)
 *   VCAV_AFAL_BIND_ADDRESS       — bind address (default: 127.0.0.1)
 *   VCAV_AFAL_TRUSTED_AGENTS     — JSON: [{"agentId":"...","publicKeyHex":"..."}]
 *   VCAV_AFAL_ALLOWED_PURPOSES   — comma-separated: "MEDIATION,COMPATIBILITY"
 *   VCAV_AFAL_PEER_DESCRIPTOR_URL — peer descriptor URL (INITIATE mode)
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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { buildError } from './envelope.js';
import { RELAY_TOOLS } from './toolDefs.js';
import { dispatch } from './dispatch.js';
import type { InviteTransport } from './invite-transport.js';
import { OrchestratorInboxAdapter } from './afal-transport.js';
import type { AfalTransport } from './afal-transport.js';
import type { NormalizedKnownAgent } from './tools/relaySignal.js';
import { DirectAfalTransport } from './direct-afal-transport.js';
import type { DirectAfalTransportConfig, AgentDescriptor } from './direct-afal-transport.js';
import { signMessage, DOMAIN_PREFIXES } from './afal-signing.js';
import type { AdmissionPolicy, TrustedAgent } from './afal-responder.js';
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
  const afalTransport: AfalTransport | undefined = directTransport
    ?? (inviteTransport ? new OrchestratorInboxAdapter(inviteTransport) : undefined);

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
    return { tools: RELAY_TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await dispatch(
        name,
        args as Record<string, unknown>,
        afalTransport,
        knownAgents,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: JSON.stringify(buildError('UNKNOWN_ERROR', errorMessage), null, 2) }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Build a DirectAfalTransport from VCAV_AFAL_* environment variables.
 * Returns null if VCAV_AFAL_SEED_HEX is not set.
 */
function buildDirectTransportFromEnv(): DirectAfalTransport | null {
  const seedHex = process.env['VCAV_AFAL_SEED_HEX'];
  if (!seedHex) return null;

  const agentId = process.env['VCAV_AGENT_ID'] ?? 'unknown';
  const httpPort = process.env['VCAV_AFAL_HTTP_PORT'];
  const bindAddress = process.env['VCAV_AFAL_BIND_ADDRESS'] ?? '127.0.0.1';
  const peerDescriptorUrl = process.env['VCAV_AFAL_PEER_DESCRIPTOR_URL'];

  const pubKeyHex = bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)));

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
    capabilities: { supported_body_formats: ['wrapped_v1'], supports_commit: true },
    policy_commitments: {},
  };
  const localDescriptor = signMessage(
    DOMAIN_PREFIXES.DESCRIPTOR,
    descriptorUnsigned,
    seedHex,
  ) as unknown as AgentDescriptor;

  const config: DirectAfalTransportConfig = {
    agentId,
    seedHex,
    localDescriptor,
    peerDescriptorUrl,
  };

  // RESPOND mode if HTTP port is configured
  if (httpPort) {
    const port = parseInt(httpPort, 10);
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      console.error(`VCAV_AFAL_HTTP_PORT is not a valid port: ${httpPort}`);
      return null;
    }

    let trustedAgents: TrustedAgent[] = [];
    const trustedJson = process.env['VCAV_AFAL_TRUSTED_AGENTS'];
    if (trustedJson) {
      try {
        trustedAgents = JSON.parse(trustedJson) as TrustedAgent[];
      } catch {
        console.error(`VCAV_AFAL_TRUSTED_AGENTS is not valid JSON: ${trustedJson}`);
        return null;
      }
    }

    const allowedPurposes = (process.env['VCAV_AFAL_ALLOWED_PURPOSES'] ?? 'MEDIATION')
      .split(',').map((s) => s.trim()).filter(Boolean);

    const policy: AdmissionPolicy = {
      trustedAgents,
      allowedPurposeCodes: allowedPurposes,
      allowedLaneIds: ['API_MEDIATED'],
      maxEntropyBits: 256,
      defaultTier: 'DENY',
    };

    config.respondMode = { httpPort: port, bindAddress, policy };
  }

  return new DirectAfalTransport(config);
}

// Standalone entry point — runs without an InviteTransport
// (CREATE/JOIN modes only unless the host injects one).
// If VCAV_AFAL_SEED_HEX is set, also starts DirectAfalTransport.
async function main() {
  const directTransport = buildDirectTransportFromEnv();

  const server = directTransport
    ? createAgentVaultServer(undefined, [], directTransport)
    : createAgentVaultServer();

  if (directTransport) {
    await directTransport.start();
    console.error(`AFAL Direct Transport active (agent: ${directTransport.agentId})`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AgentVault MCP Server running on stdio');

  if (!directTransport) {
    console.error('Note: INITIATE/RESPOND modes require an InviteTransport or VCAV_AFAL_SEED_HEX. Only CREATE/JOIN modes available in standalone mode.');
  }

  // Graceful shutdown
  const shutdown = async () => {
    if (directTransport) await directTransport.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only run when executed directly (npx / bin entry point).
// When imported as a library, createAgentVaultServer is the API.
// realpathSync resolves npm bin symlinks so the check works after `npm install -g`.
const currentFile = fileURLToPath(import.meta.url);
const isDirectExecution = process.argv[1] &&
  realpathSync(process.argv[1]) === currentFile;
if (isDirectExecution) {
  if (process.argv.includes('--print-config')) {
    const config = {
      mcpServers: {
        agentvault: {
          command: 'npx',
          args: ['-y', 'agentvault-mcp-server'],
          env: {
            VCAV_RELAY_URL: 'http://localhost:8080',
            VCAV_AGENT_ID: 'your-agent-id',
            VCAV_RESUME_TOKEN_SECRET: 'your-secret-here',
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
export type { AfalTransport, AfalInviteMessage } from './afal-transport.js';
export { OrchestratorInboxAdapter } from './afal-transport.js';
export type { AfalPropose, RelayInvitePayload } from './afal-types.js';
export type { NormalizedKnownAgent } from './tools/relaySignal.js';
export { DirectAfalTransport } from './direct-afal-transport.js';
export type { DirectAfalTransportConfig, AgentDescriptor } from './direct-afal-transport.js';
export { AfalResponder } from './afal-responder.js';
export type { AdmissionPolicy, TrustedAgent, DenyCode } from './afal-responder.js';
export { AfalHttpServer } from './afal-http-server.js';
