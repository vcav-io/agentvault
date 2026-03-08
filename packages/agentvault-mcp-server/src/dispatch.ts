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
  agentId?: string,
): Promise<unknown> {
  switch (toolName) {
    case 'agentvault.get_identity': {
      const { handleGetIdentity } = await import('./tools/getIdentity.js');
      return handleGetIdentity(agentId, knownAgents, transport);
    }
    case 'agentvault.relay_signal': {
      const { handleRelaySignal } = await import('./tools/relaySignal.js');
      return handleRelaySignal(
        args as Parameters<typeof handleRelaySignal>[0],
        transport,
        knownAgents,
      );
    }
    case 'agentvault.verify_receipt': {
      const { handleVerifyReceipt } = await import('./tools/verify-receipt.js');
      return handleVerifyReceipt(args as unknown as Parameters<typeof handleVerifyReceipt>[0]);
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
