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
import type { NormalizedKnownAgent, RelaySignalArgs } from './tools/relaySignal.js';
import type { InboxService, GetIdentityOutput } from './tools/getIdentity.js';
import type { VerifyReceiptArgs, VerifyReceiptOutput } from './tools/verify-receipt.js';
import type { ToolResponse } from './envelope.js';
import { handleGetIdentity } from './tools/getIdentity.js';
import { handleRelaySignal } from './tools/relaySignal.js';
import { handleVerifyReceipt } from './tools/verify-receipt.js';
import { IDENTITY_TOOLS, RELAY_TOOLS, VERIFY_TOOLS } from './toolDefs.js';

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

  const registry: ToolRegistry = {
    handleGetIdentity() {
      return handleGetIdentity(agentId, knownAgents, inboxService ?? transport);
    },

    handleRelaySignal(args: RelaySignalArgs) {
      return handleRelaySignal(args, transport, knownAgents);
    },

    handleVerifyReceipt(args: VerifyReceiptArgs) {
      return handleVerifyReceipt(args);
    },

    dispatch(toolName: string, args: Record<string, unknown>) {
      switch (toolName) {
        case 'agentvault.get_identity':
          return registry.handleGetIdentity();
        case 'agentvault.relay_signal':
          return registry.handleRelaySignal(args as RelaySignalArgs);
        case 'agentvault.verify_receipt':
          return registry.handleVerifyReceipt(args as unknown as VerifyReceiptArgs);
        default:
          throw new Error(
            `Unknown tool: ${toolName}. Available: agentvault.get_identity, agentvault.relay_signal, agentvault.verify_receipt`,
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
  return [...IDENTITY_TOOLS, ...RELAY_TOOLS, ...VERIFY_TOOLS] as ToolDefinition[];
}

// ── Re-exports for consumer convenience ──────────────────────────────────

export type { AfalTransport } from './afal-transport.js';
export type { AfalInviteMessage, AcceptResult } from './afal-transport.js';
export type { NormalizedKnownAgent, RelaySignalArgs } from './tools/relaySignal.js';
export type { InboxService, GetIdentityOutput } from './tools/getIdentity.js';
export type { VerifyReceiptArgs, VerifyReceiptOutput } from './tools/verify-receipt.js';
export type { ToolResponse, StatusCode, ErrorCode } from './envelope.js';
