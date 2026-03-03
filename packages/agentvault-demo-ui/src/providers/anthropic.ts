/**
 * Anthropic Messages API adapter.
 *
 * Anthropic tool names must match ^[a-zA-Z0-9_-]{1,128}$ (no dots).
 * Our tools use dots (agentvault.get_identity). This adapter translates
 * dots to double-underscores on the wire and back on receipt.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  Message,
  ToolDefinition,
  ProviderResponse,
  ContentBlock,
  TextContent,
  ToolUseContent,
  ToolResultContent,
} from './types.js';

/** Encode tool name for Anthropic API: dots → double underscores */
function encodeToolName(name: string): string {
  return name.replace(/\./g, '__');
}

/** Decode tool name from Anthropic API: double underscores → dots */
function decodeToolName(name: string): string {
  return name.replace(/__/g, '.');
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  readonly name = 'anthropic';

  constructor(apiKey: string, model = 'claude-sonnet-4-20250514') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(params: {
    messages: Message[];
    tools: ToolDefinition[];
    system?: string;
  }): Promise<ProviderResponse> {
    const anthropicTools: Anthropic.Tool[] = params.tools.map((t) => ({
      name: encodeToolName(t.name),
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    const anthropicMessages = params.messages.map((m) => this.toAnthropicMessage(m));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: params.system,
      messages: anthropicMessages,
      tools: anthropicTools,
    });

    const textBlocks: TextContent[] = [];
    const toolUseBlocks: ToolUseContent[] = [];
    const contentBlocks: ContentBlock[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        const tb: TextContent = { type: 'text', text: block.text };
        textBlocks.push(tb);
        contentBlocks.push(tb);
      } else if (block.type === 'tool_use') {
        const tu: ToolUseContent = {
          type: 'tool_use',
          id: block.id,
          name: decodeToolName(block.name),
          input: block.input as Record<string, unknown>,
        };
        toolUseBlocks.push(tu);
        contentBlocks.push(tu);
      }
    }

    return {
      textBlocks,
      toolUseBlocks,
      wantsToolUse: response.stop_reason === 'tool_use',
      contentBlocks,
    };
  }

  buildToolResultMessage(results: ToolResultContent[]): Message {
    return {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
      })),
    };
  }

  private toAnthropicMessage(msg: Message): Anthropic.MessageParam {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }

    const blocks: Anthropic.ContentBlockParam[] = msg.content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: encodeToolName(block.name),
          input: block.input,
        };
      } else {
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
        };
      }
    });

    return { role: msg.role, content: blocks };
  }
}
