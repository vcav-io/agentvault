/**
 * Tool call dispatch for agentvault-mcp-server.
 *
 * Routes tool names to their handler functions.
 */

import type { AfalTransport } from './afal-transport.js';
import type { NormalizedKnownAgent } from './tools/relaySignal.js';

export async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  transport?: AfalTransport,
  knownAgents: NormalizedKnownAgent[] = [],
): Promise<unknown> {
  switch (toolName) {
    case 'agentvault.get_identity': {
      const { handleGetIdentity } = await import('./tools/getIdentity.js');
      return handleGetIdentity(knownAgents, transport);
    }
    case 'agentvault.relay_signal': {
      const { handleRelaySignal } = await import('./tools/relaySignal.js');
      return handleRelaySignal(
        args as Parameters<typeof handleRelaySignal>[0],
        transport,
        knownAgents,
      );
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
