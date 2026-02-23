/**
 * Tool call dispatch for agentvault-mcp-server.
 *
 * Routes tool names to their handler functions.
 */

import type { InviteTransport } from './invite-transport.js';
import type { NormalizedKnownAgent } from './tools/relaySignal.js';

export async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  transport?: InviteTransport,
  knownAgents: NormalizedKnownAgent[] = [],
): Promise<unknown> {
  switch (toolName) {
    case 'agentvault.relay_signal': {
      const { handleRelaySignal } = await import('./tools/relaySignal.js');
      return handleRelaySignal(args as Parameters<typeof handleRelaySignal>[0], transport, knownAgents);
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
