/**
 * Tool call dispatch for agentvault-mcp-server.
 *
 * Routes tool names to their handler functions.
 */

import type { AfalTransport } from './afal-transport.js';
import type { IfcService } from './ifc.js';
import type { NormalizedKnownAgent } from './tools/relaySignal.js';

export async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  transport?: AfalTransport,
  knownAgents: NormalizedKnownAgent[] = [],
  agentId?: string,
  ifcService?: IfcService,
): Promise<unknown> {
  switch (toolName) {
    case 'agentvault.get_identity': {
      const { handleGetIdentity } = await import('./tools/getIdentity.js');
      return handleGetIdentity(agentId, knownAgents, transport, ifcService?.pendingCount() ?? 0);
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
    case 'agentvault.create_ifc_grant': {
      const { handleCreateIfcGrant } = await import('./tools/create-ifc-grant.js');
      return handleCreateIfcGrant(args as unknown as Parameters<typeof handleCreateIfcGrant>[0], ifcService);
    }
    case 'agentvault.send_ifc_message': {
      const { handleSendIfcMessage } = await import('./tools/send-ifc-message.js');
      return handleSendIfcMessage(args as unknown as Parameters<typeof handleSendIfcMessage>[0], ifcService);
    }
    case 'agentvault.read_ifc_messages': {
      const { handleReadIfcMessages } = await import('./tools/read-ifc-messages.js');
      return handleReadIfcMessages(args as Parameters<typeof handleReadIfcMessages>[0], ifcService);
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
