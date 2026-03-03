/**
 * Tool bridge: routes LLM tool calls through the tool registry.
 */

import type { ToolRegistry } from 'agentvault-mcp-server/tools';
import type { ToolUseContent, ToolResultContent } from './providers/types.js';
import type { EventBus } from './events.js';

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
    events.emitToolCall(agentName, tu.name, tu.input);

    try {
      const result = await registry.dispatch(tu.name, tu.input);
      const resultStr = JSON.stringify(result, null, 2);

      events.emitToolResult(agentName, tu.name, result);

      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultStr,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      events.emitToolResult(agentName, tu.name, { error: errorMsg });

      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify({ error: errorMsg }),
      });
    }
  }

  return results;
}
