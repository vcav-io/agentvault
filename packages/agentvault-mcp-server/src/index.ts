#!/usr/bin/env node
/**
 * AgentVault MCP Server
 *
 * Minimal MCP server exposing AgentVault relay tools under the agentvault namespace.
 *
 * Configuration:
 *   VCAV_RELAY_URL      — relay base URL (required for CREATE/JOIN modes)
 *   VCAV_AGENT_ID       — this agent's ID (used for contract building and idempotency)
 *   VCAV_RESUME_TOKEN_SECRET — secret for HMAC-signing resume tokens (optional but recommended)
 *
 * Transport injection:
 *   INITIATE and RESPOND modes require an InviteTransport implementation.
 *   When running standalone (no transport injected), only CREATE and JOIN modes are available.
 *   Host applications (e.g., vcav-mcp-server) inject an OrchestratorClient-backed transport.
 */

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
import type { NormalizedKnownAgent } from './tools/relaySignal.js';

// --print-config: emit a ready-to-paste MCP configuration block and exit
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

/**
 * Create and start an AgentVault MCP server.
 *
 * @param transport - Optional InviteTransport for INITIATE/RESPOND modes.
 *   When omitted, only CREATE and JOIN (legacy token exchange) modes are available.
 * @param knownAgents - Optional list of known agents for alias resolution.
 */
export function createAgentVaultServer(
  inviteTransport?: InviteTransport,
  knownAgents: NormalizedKnownAgent[] = [],
): Server {
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
        inviteTransport,
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

// Standalone entry point — runs without an InviteTransport
// (CREATE/JOIN modes only unless the host injects one)
async function main() {
  const server = createAgentVaultServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AgentVault MCP Server running on stdio');
  console.error('Note: INITIATE/RESPOND modes require an InviteTransport. Only CREATE/JOIN modes available in standalone mode.');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});

export type { InviteTransport } from './invite-transport.js';
export type { NormalizedKnownAgent } from './tools/relaySignal.js';
