/**
 * Stable tool registry API for AgentVault MCP tools.
 *
 * This module provides a programmatic API for consuming AgentVault tools
 * outside of the MCP server (e.g. from a demo UI or test harness).
 *
 * Usage:
 *   import { createToolRegistry, getToolDefs } from 'agentvault-mcp-server/tools';
 */

import type { AfalTransport } from './afal-transport.js';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { NormalizedKnownAgent, RelaySignalArgs } from './tools/relaySignal.js';
import type { InboxService, GetIdentityOutput } from './tools/getIdentity.js';
import type { VerifyReceiptArgs, VerifyReceiptOutput } from './tools/verify-receipt.js';
import type { ToolResponse } from './envelope.js';
import { IfcService, type CreateIfcGrantArgs, type IfcKnownAgent, type ReadIfcMessagesArgs, type SendIfcMessageArgs } from './ifc.js';
import { handleGetIdentity } from './tools/getIdentity.js';
import { handleRelaySignal } from './tools/relaySignal.js';
import { handleVerifyReceipt } from './tools/verify-receipt.js';
import { handleCreateIfcGrant } from './tools/create-ifc-grant.js';
import { handleSendIfcMessage } from './tools/send-ifc-message.js';
import { handleReadIfcMessages } from './tools/read-ifc-messages.js';
import { IDENTITY_TOOLS, RELAY_TOOLS, VERIFY_TOOLS, IFC_TOOLS } from './toolDefs.js';

// ── Configuration ────────────────────────────────────────────────────────

export interface ToolRegistryConfig {
  transport: AfalTransport;
  knownAgents: NormalizedKnownAgent[];
  inboxService?: InboxService;
  /**
   * Agent ID passed to tool handlers.
   * Required when running multiple registries in the same process
   * (e.g. demo UI running Alice and Bob concurrently).
   * Falls back to transport.agentId if not provided.
   */
  agentId?: string;
  /**
   * Override the model profile ID in relay contracts built by this registry.
   * When set, overrides the template's default model_profile_id.
   */
  relayProfileId?: string;
  ifcSeedHex?: string;
  ifcService?: IfcService;
}

// ── Tool definition shape ────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

// ── Registry interface ───────────────────────────────────────────────────

export interface ToolRegistry {
  handleGetIdentity(): Promise<ToolResponse<GetIdentityOutput>>;
  handleRelaySignal(args: RelaySignalArgs): Promise<ToolResponse<unknown>>;
  handleVerifyReceipt(args: VerifyReceiptArgs): Promise<ToolResponse<VerifyReceiptOutput>>;
  handleCreateIfcGrant(args: CreateIfcGrantArgs): Promise<ToolResponse<unknown>>;
  handleSendIfcMessage(args: SendIfcMessageArgs): Promise<ToolResponse<unknown>>;
  handleReadIfcMessages(args: ReadIfcMessagesArgs): Promise<ToolResponse<unknown>>;
  dispatch(toolName: string, args: Record<string, unknown>): Promise<ToolResponse<unknown>>;
  toolDefs: ToolDefinition[];
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Create a tool registry with bound configuration.
 *
 * All tool calls go through the provided transport and known agents —
 * callers don't need to pass these on every invocation.
 */
export function createToolRegistry(config: ToolRegistryConfig): ToolRegistry {
  const { transport, knownAgents, inboxService } = config;
  const agentId = config.agentId ?? transport.agentId;
  const ifcService =
    config.ifcService ??
    (config.ifcSeedHex
      ? new IfcService({
          agentId,
          seedHex: config.ifcSeedHex,
          knownAgents: knownAgents as IfcKnownAgent[],
          verifyingKeyHex: bytesToHex(ed25519.getPublicKey(hexToBytes(config.ifcSeedHex))),
        })
      : undefined);
  ifcService?.setKnownAgents(knownAgents as IfcKnownAgent[]);

  const registry: ToolRegistry = {
    handleGetIdentity() {
      return handleGetIdentity(agentId, knownAgents, inboxService ?? transport, ifcService?.pendingCount() ?? 0);
    },

    handleRelaySignal(args: RelaySignalArgs) {
      return handleRelaySignal(args, transport, knownAgents, config.relayProfileId);
    },

    handleVerifyReceipt(args: VerifyReceiptArgs) {
      return handleVerifyReceipt(args);
    },

    handleCreateIfcGrant(args: CreateIfcGrantArgs) {
      return handleCreateIfcGrant(args, ifcService);
    },

    handleSendIfcMessage(args: SendIfcMessageArgs) {
      return handleSendIfcMessage(args, ifcService);
    },

    handleReadIfcMessages(args: ReadIfcMessagesArgs) {
      return handleReadIfcMessages(args, ifcService);
    },

    dispatch(toolName: string, args: Record<string, unknown>) {
      switch (toolName) {
        case 'agentvault.get_identity':
          return registry.handleGetIdentity();
        case 'agentvault.relay_signal':
          return registry.handleRelaySignal(args as RelaySignalArgs);
        case 'agentvault.verify_receipt':
          return registry.handleVerifyReceipt(args as unknown as VerifyReceiptArgs);
        case 'agentvault.create_ifc_grant':
          return registry.handleCreateIfcGrant(args as unknown as CreateIfcGrantArgs);
        case 'agentvault.send_ifc_message':
          return registry.handleSendIfcMessage(args as unknown as SendIfcMessageArgs);
        case 'agentvault.read_ifc_messages':
          return registry.handleReadIfcMessages(args as ReadIfcMessagesArgs);
        default:
          throw new Error(
            `Unknown tool: ${toolName}. Available: agentvault.get_identity, agentvault.relay_signal, agentvault.verify_receipt, agentvault.create_ifc_grant, agentvault.send_ifc_message, agentvault.read_ifc_messages`,
          );
      }
    },

    toolDefs: getToolDefs(),
  };

  return registry;
}

/**
 * Get tool definitions without creating a registry.
 * Useful for registering tools with an LLM provider.
 */
export function getToolDefs(): ToolDefinition[] {
  return [...IDENTITY_TOOLS, ...RELAY_TOOLS, ...VERIFY_TOOLS, ...IFC_TOOLS] as ToolDefinition[];
}

// ── Re-exports for consumer convenience ──────────────────────────────────

export type { AfalTransport } from './afal-transport.js';
export type { AfalInviteMessage, AcceptResult } from './afal-transport.js';
export type { NormalizedKnownAgent, RelaySignalArgs } from './tools/relaySignal.js';
export type { InboxService, GetIdentityOutput } from './tools/getIdentity.js';
export type { VerifyReceiptArgs, VerifyReceiptOutput } from './tools/verify-receipt.js';
export type { ToolResponse, StatusCode, ErrorCode } from './envelope.js';
export type { CreateIfcGrantArgs, ReadIfcMessagesArgs, SendIfcMessageArgs } from './ifc.js';
