/**
 * OpenAI Chat Completions API adapter.
 */

import OpenAI from 'openai';
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

// OpenAI tool names must match ^[a-zA-Z0-9_-]+$ — no dots allowed.
// Map dots to underscores for the API, and reverse when parsing tool calls.
function sanitizeName(name: string): string {
  return name.replace(/\./g, '_');
}
function unsanitizeName(name: string): string {
  return name.replace(/^(agentvault)_/, '$1.');
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  readonly name = 'openai';

  constructor(apiKey: string, model = 'gpt-4.1-mini') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(params: {
    messages: Message[];
    tools: ToolDefinition[];
    system?: string;
  }): Promise<ProviderResponse> {

    const openaiTools: OpenAI.ChatCompletionTool[] = params.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: sanitizeName(t.name),
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const openaiMessages = this.toOpenAIMessages(params.messages, params.system);

    // gpt-5 family models require max_completion_tokens instead of max_tokens.
    const usesCompletionTokens = this.model.startsWith('gpt-5') || this.model.startsWith('o');
    const response = await this.client.chat.completions.create({
      model: this.model,
      ...(usesCompletionTokens
        ? { max_completion_tokens: 4096 }
        : { max_tokens: 4096 }),
      messages: openaiMessages,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
    });

    const choice = response.choices[0];
    if (!choice) throw new Error('No choices in OpenAI response');

    const textBlocks: TextContent[] = [];
    const toolUseBlocks: ToolUseContent[] = [];
    const contentBlocks: ContentBlock[] = [];

    if (choice.message.content) {
      const tb: TextContent = { type: 'text', text: choice.message.content };
      textBlocks.push(tb);
      contentBlocks.push(tb);
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (tc.type === 'function') {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch (parseErr) {
            console.warn(
              `Failed to parse OpenAI tool arguments for ${tc.function.name}:`,
              tc.function.arguments.substring(0, 200),
              parseErr instanceof Error ? parseErr.message : parseErr,
            );
            input = { _raw: tc.function.arguments };
          }
          const tu: ToolUseContent = {
            type: 'tool_use',
            id: tc.id,
            name: unsanitizeName(tc.function.name),
            input,
          };
          toolUseBlocks.push(tu);
          contentBlocks.push(tu);
        }
      }
    }

    return {
      textBlocks,
      toolUseBlocks,
      wantsToolUse: choice.finish_reason === 'tool_calls',
      contentBlocks,
    };
  }

  buildToolResultMessage(results: ToolResultContent[]): Message {
    // OpenAI uses separate "tool" role messages, but we normalize to our format.
    // The toOpenAIMessages converter handles the actual conversion.
    return {
      role: 'user',
      content: results,
    };
  }

  private toOpenAIMessages(
    messages: Message[],
    system?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (system) {
      result.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
        continue;
      }

      if (msg.role === 'assistant') {
        // Collect text and tool_calls
        const textParts = msg.content.filter((b) => b.type === 'text');
        const toolParts = msg.content.filter((b) => b.type === 'tool_use');

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.map((t) => t.text).join('\n') : null,
        };

        if (toolParts.length > 0) {
          assistantMsg.tool_calls = toolParts.map((t) => ({
            id: t.id,
            type: 'function' as const,
            function: {
              name: sanitizeName(t.name),
              arguments: JSON.stringify(t.input),
            },
          }));
        }

        result.push(assistantMsg);
      } else {
        // User messages — may contain tool_results
        const toolResults = msg.content.filter((b) => b.type === 'tool_result');
        const textParts = msg.content.filter((b) => b.type === 'text');

        // OpenAI tool results are separate "tool" role messages
        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: tr.content,
          });
        }

        if (textParts.length > 0) {
          result.push({
            role: 'user',
            content: textParts.map((t) => t.text).join('\n'),
          });
        }
      }
    }

    // Validate: every 'tool' message must follow an 'assistant' with tool_calls
    // containing the referenced tool_call_id. If not, drop the orphaned tool message
    // to avoid OpenAI 400 errors.
    const validated: OpenAI.ChatCompletionMessageParam[] = [];
    let lastAssistantToolIds: Set<string> | null = null;

    for (const msg of result) {
      if (msg.role === 'assistant') {
        const aMsg = msg as OpenAI.ChatCompletionAssistantMessageParam;
        lastAssistantToolIds = aMsg.tool_calls
          ? new Set(aMsg.tool_calls.map((tc) => tc.id))
          : null;
        validated.push(msg);
      } else if (msg.role === 'tool') {
        const tMsg = msg as OpenAI.ChatCompletionToolMessageParam;
        if (lastAssistantToolIds?.has(tMsg.tool_call_id)) {
          validated.push(msg);
        } else {
          console.warn(
            `Dropping orphaned tool message (tool_call_id=${tMsg.tool_call_id}) — ` +
            'no matching assistant tool_calls found',
          );
        }
      } else {
        lastAssistantToolIds = null;
        validated.push(msg);
      }
    }

    return validated;
  }
}
