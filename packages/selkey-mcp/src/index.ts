#!/usr/bin/env node
/**
 * Selkey MCP Server
 *
 * Minimal MCP server exposing Selkey relay tools under the selkey namespace.
 *
 * Configuration:
 *   SELKEY_RELAY_URL              — relay base URL (required for CREATE/JOIN modes)
 *   SELKEY_RELAY_VERIFYING_KEY_HEX — the relay's verifying key (required outside SELKEY_ENV=dev)
 *   SELKEY_OPERATOR_TOKEN          — operator token of the relay at SELKEY_RELAY_URL, sent when
 *                                    creating sessions (never logged)
 *   SELKEY_ENV                    — "dev" allows relay sessions without a pinned relay key
 *   SELKEY_AGENT_ID               — this agent's ID (used for contract building and idempotency)
 *   SELKEY_RESUME_TOKEN_SECRET    — secret for HMAC-signing resume tokens (optional but recommended)
 *
 * AFAL Direct Transport (opt-in):
 *   SELKEY_AFAL_SEED_HEX          — Ed25519 seed (required for AFAL direct mode)
 *   SELKEY_AFAL_HTTP_PORT          — port for AFAL HTTP server (enables RESPOND mode)
 *   SELKEY_AFAL_BIND_ADDRESS       — bind address (default: 127.0.0.1)
 *   SELKEY_AFAL_TRUSTED_AGENTS     — JSON: [{"agentId":"...","publicKeyHex":"..."}] (pin seeds)
 *   SELKEY_AGENT_PIN_RESEED        — "true" lets configured keys replace differing stored pins that
 *                                    came from configuration; a comma-separated agent_id list
 *                                    replaces those agents' pins whatever their source (CLI, rotation)
 *   SELKEY_AGENT_PIN_MODE          — "preshared" (default) or "tofu" (first contact needs
 *                                    human confirmation via `selkey-mcp pins confirm`)
 *
 * Agent identity pins live in $SELKEY_WORKDIR/.selkey/pins.json (see pin-store.ts),
 * seeded from SELKEY_AFAL_TRUSTED_AGENTS and SELKEY_KNOWN_AGENTS public keys.
 * Manage them with `selkey-mcp pins list|add|remove|confirm|rotate`.
 *   SELKEY_AFAL_ALLOWED_PURPOSES   — comma-separated: "MEDIATION,COMPATIBILITY"
 *   SELKEY_AFAL_PEER_DESCRIPTOR_URL — peer descriptor URL (INITIATE mode)
 *   SELKEY_AFAL_ADVERTISE_AFAL_ENDPOINT — set to "false" to publish an A2A-only Agent Card
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
import { RELAY_TOOLS, IDENTITY_TOOLS, VERIFY_TOOLS, IFC_TOOLS } from './toolDefs.js';
import { dispatch } from './dispatch.js';
import type { InviteTransport } from './invite-transport.js';
import { OrchestratorInboxAdapter } from './afal-transport.js';
import type { AfalTransport } from './afal-transport.js';
import type { NormalizedKnownAgent } from './tools/relaySignal.js';
import { DirectAfalTransport, isAgentDescriptor } from './direct-afal-transport.js';
import type { DirectAfalTransportConfig } from './direct-afal-transport.js';
import { RelayInboxTransport } from './relay-inbox-transport.js';
import {
  configuredRelayKeyHex,
  isDevEnvironment,
  isRelayTransportAllowed,
  RELAY_INSECURE_HTTP_HOSTS_ENV,
} from './relay-trust.js';
import { signMessage, DOMAIN_PREFIXES } from './afal-signing.js';
import type { AdmissionPolicy, TrustedAgent } from './afal-responder.js';
import { listKnownModelProfiles } from './model-profiles.js';
import { listSupportedContractOffers } from './contract-offers.js';
import { advertisesBespokeContractNegotiation } from './bespoke-contracts.js';
import { listSupportedTopicCodes, supportsTopicAlignment } from './topic-codes.js';
import { IfcService, type IfcKnownAgent } from './ifc.js';
import { PinStore, parsePinMode, parsePinReseed, type PinResolver, type PinSeed } from './pin-store.js';
import { processPinsCliIo, runPinsCli } from './pin-cli.js';
import { ed25519 } from '@noble/curves/ed25519';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

/**
 * Create and start an Selkey MCP server.
 *
 * @param inviteTransport - Optional InviteTransport for INITIATE/RESPOND modes.
 *   When omitted, only CREATE and JOIN (legacy token exchange) modes are available.
 *   Wrapped in OrchestratorInboxAdapter to provide AfalTransport.
 * @param knownAgents - Optional list of known agents for alias resolution.
 * @param directTransport - Optional pre-built AfalTransport (e.g. DirectAfalTransport).
 *   Takes precedence over inviteTransport if both are provided.
 */
export function createSelkeyServer(
  inviteTransport?: InviteTransport,
  knownAgents: NormalizedKnownAgent[] = [],
  directTransport?: AfalTransport,
  pins?: PinResolver,
): Server {
  const afalTransport: AfalTransport | undefined =
    directTransport ??
    (inviteTransport ? new OrchestratorInboxAdapter(inviteTransport) : undefined);
  const agentId = afalTransport?.agentId ?? process.env['SELKEY_AGENT_ID'];
  const ifcSeedHex =
    directTransport instanceof DirectAfalTransport
      ? directTransport.ifcSeedHex
      : process.env['SELKEY_AFAL_SEED_HEX'];
  const ifcService =
    agentId && ifcSeedHex
      ? new IfcService({
          agentId,
          seedHex: ifcSeedHex,
          knownAgents: knownAgents as IfcKnownAgent[],
          verifyingKeyHex: bytesToHex(ed25519.getPublicKey(hexToBytes(ifcSeedHex))),
          pins: directTransport instanceof DirectAfalTransport ? directTransport.pinStore : pins,
        })
      : undefined;
  if (directTransport instanceof DirectAfalTransport && ifcService) {
    directTransport.setIfcService(ifcService);
  }

  const server = new Server(
    {
      name: 'selkey-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [...IDENTITY_TOOLS, ...RELAY_TOOLS, ...VERIFY_TOOLS, ...IFC_TOOLS] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await dispatch(
        name,
        args as Record<string, unknown>,
        afalTransport,
        knownAgents,
        agentId,
        ifcService,
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
 * Build a DirectAfalTransport from SELKEY_AFAL_* environment variables.
 * Returns null if SELKEY_AFAL_SEED_HEX is not set.
 */
function buildDirectTransportFromEnv(pinStore: PinStore): DirectAfalTransport | null {
  const seedHex = process.env['SELKEY_AFAL_SEED_HEX'];
  if (!seedHex) return null;

  const agentId = process.env['SELKEY_AGENT_ID'];
  if (!agentId) {
    console.error('SELKEY_AGENT_ID is required when SELKEY_AFAL_SEED_HEX is set');
    return null;
  }
  const httpPort = process.env['SELKEY_AFAL_HTTP_PORT'];
  const bindAddress = process.env['SELKEY_AFAL_BIND_ADDRESS'] ?? '127.0.0.1';
  const peerDescriptorUrl = process.env['SELKEY_AFAL_PEER_DESCRIPTOR_URL'];
  const advertiseAfalEndpoint = process.env['SELKEY_AFAL_ADVERTISE_AFAL_ENDPOINT'] !== 'false';

  let pubKeyHex: string;
  try {
    pubKeyHex = bytesToHex(ed25519.getPublicKey(hexToBytes(seedHex)));
  } catch (err) {
    console.error(
      `SELKEY_AFAL_SEED_HEX is not a valid 32-byte hex seed: ${err instanceof Error ? err.message : String(err)}`,
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
      supported_topic_codes: listSupportedTopicCodes(),
      supports_topic_alignment: supportsTopicAlignment(),
      supported_contract_offers: listSupportedContractOffers(),
      supports_bespoke_contract_negotiation: advertisesBespokeContractNegotiation(),
    },
    policy_commitments: {},
  };
  const localDescriptorRaw = signMessage(DOMAIN_PREFIXES.DESCRIPTOR, descriptorUnsigned, seedHex);
  if (!isAgentDescriptor(localDescriptorRaw)) {
    throw new Error('signMessage produced invalid AgentDescriptor');
  }
  const localDescriptor = localDescriptorRaw;

  const requireSignedCards = process.env['SELKEY_AFAL_REQUIRE_SIGNED_CARDS'] === 'true';

  const config: DirectAfalTransportConfig = {
    agentId,
    seedHex,
    localDescriptor,
    relayUrl: process.env['SELKEY_RELAY_URL'],
    peerDescriptorUrl,
    requireSignedCards,
    pinStore,
  };

  // RESPOND mode if HTTP port is configured
  if (httpPort) {
    const port = parseInt(httpPort, 10);
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      console.error(`SELKEY_AFAL_HTTP_PORT is not a valid port: ${httpPort}`);
      return null;
    }

    let trustedAgents: TrustedAgent[] = [];
    const trustedJson = process.env['SELKEY_AFAL_TRUSTED_AGENTS'];
    if (trustedJson) {
      try {
        const parsed: unknown = JSON.parse(trustedJson);
        if (!Array.isArray(parsed)) {
          console.error('SELKEY_AFAL_TRUSTED_AGENTS must be a JSON array');
          return null;
        }
        for (const entry of parsed) {
          if (typeof entry?.agentId !== 'string' || typeof entry?.publicKeyHex !== 'string') {
            console.error(
              'SELKEY_AFAL_TRUSTED_AGENTS entries must have string agentId and publicKeyHex',
            );
            return null;
          }
        }
        trustedAgents = parsed as TrustedAgent[];
      } catch {
        console.error(`SELKEY_AFAL_TRUSTED_AGENTS is not valid JSON: ${trustedJson}`);
        return null;
      }
    }

    const allowedPurposes = (process.env['SELKEY_AFAL_ALLOWED_PURPOSES'] ?? 'MEDIATION')
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
 * Pin seeds from SELKEY_AFAL_TRUSTED_AGENTS and SELKEY_KNOWN_AGENTS.
 * Malformed entries are fatal: a pin store must not start from a partial config.
 */
function pinSeedsFromEnv(knownAgents: NormalizedKnownAgent[]): PinSeed[] {
  const seeds: PinSeed[] = [];
  const trustedJson = process.env['SELKEY_AFAL_TRUSTED_AGENTS'];
  if (trustedJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trustedJson);
    } catch {
      throw new Error('SELKEY_AFAL_TRUSTED_AGENTS is not valid JSON');
    }
    if (!Array.isArray(parsed)) throw new Error('SELKEY_AFAL_TRUSTED_AGENTS must be a JSON array');
    for (const entry of parsed) {
      if (typeof entry?.agentId !== 'string' || typeof entry?.publicKeyHex !== 'string') {
        throw new Error('SELKEY_AFAL_TRUSTED_AGENTS entries must have string agentId and publicKeyHex');
      }
      seeds.push({ agentId: entry.agentId, publicKeyHex: entry.publicKeyHex });
    }
  }
  for (const agent of knownAgents) {
    seeds.push({ agentId: agent.agent_id, publicKeyHex: agent.public_key_hex, aliases: agent.aliases });
  }
  return seeds;
}

function openPinStoreFromEnv(knownAgents: NormalizedKnownAgent[]): PinStore {
  return PinStore.open({
    seeds: pinSeedsFromEnv(knownAgents),
    mode: parsePinMode(process.env['SELKEY_AGENT_PIN_MODE']),
    reseed: parsePinReseed(process.env['SELKEY_AGENT_PIN_RESEED']),
  });
}

/**
 * Parse SELKEY_KNOWN_AGENTS environment variable.
 * Expected format: JSON array of
 * {agent_id: string, aliases: string[], public_key_hex?: string, a2a_send_message_url?: string}.
 */
function parseKnownAgentsFromEnv(): NormalizedKnownAgent[] {
  const raw = process.env['SELKEY_KNOWN_AGENTS'];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error('SELKEY_KNOWN_AGENTS must be a JSON array');
      return [];
    }
    for (const entry of parsed) {
      if (
        typeof entry?.agent_id !== 'string' ||
        !Array.isArray(entry?.aliases) ||
        (entry?.public_key_hex !== undefined && typeof entry?.public_key_hex !== 'string') ||
        (entry?.a2a_send_message_url !== undefined && typeof entry?.a2a_send_message_url !== 'string')
      ) {
        console.error(
          'SELKEY_KNOWN_AGENTS entries must have string agent_id, aliases array, and optional string public_key_hex/a2a_send_message_url',
        );
        return [];
      }
    }
    return parsed as NormalizedKnownAgent[];
  } catch {
    console.error(`SELKEY_KNOWN_AGENTS is not valid JSON: ${raw}`);
    return [];
  }
}

/**
 * Build a RelayInboxTransport from SELKEY_INBOX_* environment variables.
 * Returns null if SELKEY_INBOX_TOKEN is not set or SELKEY_INBOX_TRANSPORT !== 'relay'.
 */
export function buildRelayInboxTransportFromEnv(): RelayInboxTransport | null {
  if (process.env['SELKEY_INBOX_TRANSPORT'] !== 'relay') return null;
  // Fail-closed: when relay mode is explicitly requested, missing env vars are fatal.
  const inboxToken = process.env['SELKEY_INBOX_TOKEN'];
  if (!inboxToken) {
    throw new Error(
      'SELKEY_INBOX_TOKEN is required when SELKEY_INBOX_TRANSPORT=relay. ' +
        'Set the inbox token or remove SELKEY_INBOX_TRANSPORT to use a different mode.',
    );
  }
  const agentId = process.env['SELKEY_AGENT_ID'];
  if (!agentId) {
    throw new Error('SELKEY_AGENT_ID is required when SELKEY_INBOX_TRANSPORT=relay.');
  }
  const relayUrl = process.env['SELKEY_RELAY_URL'];
  if (!relayUrl) {
    throw new Error('SELKEY_RELAY_URL is required when SELKEY_INBOX_TRANSPORT=relay.');
  }
  // The inbox token and contracts travel to this relay: plain http only on
  // loopback or explicitly listed private hosts.
  if (!isRelayTransportAllowed(relayUrl)) {
    throw new Error(
      `SELKEY_RELAY_URL "${relayUrl}" uses plain http on a non-loopback host. Use https, or add its ` +
        `host name to ${RELAY_INSECURE_HTTP_HOSTS_ENV} for a private network.`,
    );
  }
  return new RelayInboxTransport({ agentId, inboxToken, relayUrl });
}

// Standalone entry point — runs without an InviteTransport
// (CREATE/JOIN modes only unless the host injects one).
// If SELKEY_AFAL_SEED_HEX is set, also starts DirectAfalTransport.
// If SELKEY_INBOX_TRANSPORT=relay, uses RelayInboxTransport.
async function main() {
  if (!isDevEnvironment() && !configuredRelayKeyHex()) {
    console.error(
      'selkey-mcp: SELKEY_RELAY_VERIFYING_KEY_HEX is not set; relay sessions will be refused until it is ' +
        '(only SELKEY_ENV=dev runs without a pinned relay key).',
    );
  }
  const knownAgents = parseKnownAgentsFromEnv();
  // Fails closed if pins.json is group/world-writable or malformed.
  const pinStore = openPinStoreFromEnv(knownAgents);
  const directTransport = buildDirectTransportFromEnv(pinStore);
  const relayInboxTransport = buildRelayInboxTransportFromEnv();

  // Priority: relay inbox > direct AFAL > none
  const chosenTransport = relayInboxTransport ?? directTransport ?? undefined;

  const server = chosenTransport
    ? createSelkeyServer(undefined, knownAgents, chosenTransport, pinStore)
    : createSelkeyServer(undefined, knownAgents, undefined, pinStore);

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
  console.error('Selkey MCP Server running on stdio');

  if (!chosenTransport) {
    console.error(
      'Note: INITIATE/RESPOND modes require a transport. Set SELKEY_INBOX_TRANSPORT=relay + SELKEY_INBOX_TOKEN, or SELKEY_AFAL_SEED_HEX. Only CREATE/JOIN modes available in standalone mode.',
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
// When imported as a library, createSelkeyServer is the API.
// realpathSync resolves npm bin symlinks so the check works after `npm install -g`.
const currentFile = fileURLToPath(import.meta.url);
const isDirectExecution = process.argv[1] && realpathSync(process.argv[1]) === currentFile;
if (isDirectExecution) {
  if (process.argv[2] === 'pins') {
    let exitCode = 1;
    try {
      // The CLI works on the stored pins only; configuration seeds are
      // applied when the server starts.
      const store = PinStore.open({ mode: parsePinMode(process.env['SELKEY_AGENT_PIN_MODE']) });
      exitCode = await runPinsCli(process.argv.slice(3), store, processPinsCliIo());
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(exitCode);
  }
  if (process.argv.includes('--print-config')) {
    const config = {
      mcpServers: {
        selkey: {
          command: 'npx',
          args: ['-y', 'selkey-mcp'],
          env: {
            SELKEY_RELAY_URL: 'http://localhost:8080',
            SELKEY_AGENT_ID: 'your-agent-id',
            SELKEY_RESUME_TOKEN_SECRET: 'your-secret-here',
            SELKEY_RELAY_VERIFYING_KEY_HEX: 'relay-verifying-key-64-hex-from-the-relay-operator',
            SELKEY_OPERATOR_TOKEN: 'relay-operator-token-if-the-relay-requires-one',
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
export { PinStore, PinError, keyFingerprint, resolveAgentHint } from './pin-store.js';
export type { AgentPin, PinMode, PinResolver, PinSeed, KeyRotationStatement } from './pin-store.js';
export { isAgentDescriptor } from './direct-afal-transport.js';
export { listKnownModelProfiles, resolveModelProfileRefs } from './model-profiles.js';
export type { ModelProfileRef } from './model-profiles.js';
export { listSupportedTopicCodes, supportsTopicAlignment } from './topic-codes.js';
export { listSupportedContractOffers } from './contract-offers.js';
export { buildAgentCard, buildCardSignedPayload, signAgentCard, verifyAgentCardSignature, SELKEY_A2A_EXTENSION_URI } from './a2a-agent-card.js';
export type { AgentCard, AgentCardSignedPayload, SelkeyA2AExtensionParams } from './a2a-agent-card.js';
export {
  advertisesBespokeContractNegotiation,
  supportsBespokePrecontractNegotiation,
} from './bespoke-contracts.js';
