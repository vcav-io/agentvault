/**
 * Tool bridge: routes LLM tool calls through the tool registry.
 */

import type { ToolRegistry } from 'agentvault-mcp-server/tools';
import type { ToolUseContent, ToolResultContent } from './providers/types.js';
import type { EventBus } from './events.js';

// ── Credential redaction ─────────────────────────────────────────────────

const REDACTED_KEYS = new Set([
  'submit_token', 'read_token', 'resume_token',
  'responder_submit_token', 'responder_read_token',
  'initiator_submit_token', 'initiator_read_token',
  'my_input',
]);

/** Deep-clone an object, replacing sensitive fields with '[REDACTED]'. */
function redactSensitive(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactSensitive);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = REDACTED_KEYS.has(key) ? '[REDACTED]' : redactSensitive(value);
  }
  return result;
}

/**
 * Execute a batch of tool calls through the tool registry.
 *
 * Returns tool result content blocks ready to send back to the LLM.
 */
export async function executeToolCalls(
  toolUses: ToolUseContent[],
  registry: ToolRegistry,
  agentName: string,
  events: EventBus,
): Promise<ToolResultContent[]> {
  const results: ToolResultContent[] = [];

  for (const tu of toolUses) {
    events.emitToolCall(agentName, tu.name, redactSensitive(tu.input) as Record<string, unknown>);

    try {
      const result = await registry.dispatch(tu.name, tu.input);
      const resultStr = JSON.stringify(result, null, 2);

      events.emitToolResult(agentName, tu.name, redactSensitive(result));
      emitNegotiationEventIfPresent(agentName, tu.name, result, events);

      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultStr,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      events.emitToolResult(agentName, tu.name, redactSensitive({ error: errorMsg }));

      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify({ error: errorMsg }),
      });
    }
  }

  return results;
}

function emitNegotiationEventIfPresent(
  agentName: string,
  toolName: string,
  result: unknown,
  events: EventBus,
): void {
  if (toolName !== 'agentvault.relay_signal' || !result || typeof result !== 'object') return;
  const data = (result as Record<string, unknown>)['data'];
  if (!data || typeof data !== 'object') return;
  const negotiated = (data as Record<string, unknown>)['negotiated_contract'];
  if (!negotiated || typeof negotiated !== 'object') return;

  const contractOfferId = (negotiated as Record<string, unknown>)['contract_offer_id'];
  const selectedModelProfile = (negotiated as Record<string, unknown>)['selected_model_profile'];
  const profileId =
    selectedModelProfile && typeof selectedModelProfile === 'object'
      ? (selectedModelProfile as Record<string, unknown>)['id']
      : undefined;

  if (typeof contractOfferId !== 'string' || typeof profileId !== 'string') return;

  events.emitSystem(
    `${agentName} negotiated contract offer ${contractOfferId} with model profile ${profileId}`,
  );
}
