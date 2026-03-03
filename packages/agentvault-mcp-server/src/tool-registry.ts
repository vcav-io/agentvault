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
import type { ToolResponse } from './envelope.js';
import { handleGetIdentity } from './tools/getIdentity.js';
import { handleRelaySignal } from './tools/relaySignal.js';
import { IDENTITY_TOOLS, RELAY_TOOLS } from './toolDefs.js';

// ── Configuration ────────────────────────────────────────────────────────

export interface ToolRegistryConfig {
  transport: AfalTransport;
  knownAgents: NormalizedKnownAgent[];
  inboxService?: InboxService;
  /**
   * Agent ID to set in process.env before each tool call.
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

  /**
   * Set VCAV_AGENT_ID before each handler call.
   *
   * SAFETY NOTE: This is safe only because handleRelaySignal captures agentId
   * from transport.agentId at function entry (before any await). The env var is
   * a fallback for code paths that don't have access to the transport. Long-lived
   * awaits (e.g. bounded poll in phaseDiscover) must NOT re-read this env var —
   * they use handle.agentId instead.
   */
  function setAgentEnv(): void {
    if (agentId) {
      process.env['VCAV_AGENT_ID'] = agentId;
    }
  }

  const registry: ToolRegistry = {
    handleGetIdentity() {
      setAgentEnv();
      return handleGetIdentity(knownAgents, inboxService ?? transport);
    },

    handleRelaySignal(args: RelaySignalArgs) {
      setAgentEnv();
      return handleRelaySignal(args, transport, knownAgents);
    },

    dispatch(toolName: string, args: Record<string, unknown>) {
      switch (toolName) {
        case 'agentvault.get_identity':
          return registry.handleGetIdentity();
        case 'agentvault.relay_signal':
          return registry.handleRelaySignal(args as RelaySignalArgs);
        default:
          throw new Error(`Unknown tool: ${toolName}. Available: agentvault.get_identity, agentvault.relay_signal`);
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
  return [...IDENTITY_TOOLS, ...RELAY_TOOLS] as ToolDefinition[];
}

// ── Re-exports for consumer convenience ──────────────────────────────────

export type { AfalTransport } from './afal-transport.js';
export type { AfalInviteMessage, AcceptResult } from './afal-transport.js';
export type { NormalizedKnownAgent, RelaySignalArgs } from './tools/relaySignal.js';
export type { InboxService, GetIdentityOutput } from './tools/getIdentity.js';
export type { ToolResponse, StatusCode, ErrorCode } from './envelope.js';
