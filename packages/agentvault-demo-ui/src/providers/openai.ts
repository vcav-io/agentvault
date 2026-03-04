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

    // Validate tool_call / tool_result pairing to avoid OpenAI 400 errors.
    // OpenAI requires every assistant message with tool_calls to be immediately
    // followed by tool-role messages answering ALL tool_call_ids. Violations
    // happen when a reset races with an in-flight LLM burst, leaving an
    // assistant message with tool_calls but no (or partial) tool results.
    //
    // Strategy: forward scan. For each assistant with tool_calls, collect the
    // tool_call_ids and check that all are answered by immediately following
    // tool messages. If not, strip tool_calls from the assistant (keep text)
    // and drop the orphaned tool messages.
    const validated: OpenAI.ChatCompletionMessageParam[] = [];

    for (let i = 0; i < result.length; i++) {
      const msg = result[i];

      if (msg.role === 'assistant') {
        const aMsg = msg as OpenAI.ChatCompletionAssistantMessageParam;
        if (aMsg.tool_calls && aMsg.tool_calls.length > 0) {
          // Collect tool_call_ids and look ahead for matching tool messages
          const expectedIds = new Set(aMsg.tool_calls.map((tc) => tc.id));
          const toolMsgs: OpenAI.ChatCompletionMessageParam[] = [];
          let j = i + 1;
          while (j < result.length && result[j].role === 'tool') {
            const tMsg = result[j] as OpenAI.ChatCompletionToolMessageParam;
            if (expectedIds.has(tMsg.tool_call_id)) {
              toolMsgs.push(result[j]);
              expectedIds.delete(tMsg.tool_call_id);
            }
            j++;
          }

          if (expectedIds.size === 0) {
            // All tool_calls answered — keep as-is
            validated.push(msg);
            for (const tm of toolMsgs) validated.push(tm);
          } else {
            // Unanswered tool_calls — strip them, keep text content only
            console.warn(
              `Stripping ${expectedIds.size} unanswered tool_calls from assistant message` +
              ` (likely reset race condition)`,
            );
            if (aMsg.content) {
              validated.push({ role: 'assistant', content: aMsg.content });
            }
            // Drop all following tool messages for this assistant
          }
          i = j - 1; // skip past the tool messages we already processed
          continue;
        }
      }

      if (msg.role === 'tool') {
        // Orphaned tool message (no preceding assistant with matching tool_calls)
        const tMsg = msg as OpenAI.ChatCompletionToolMessageParam;
        console.warn(
          `Dropping orphaned tool message (tool_call_id=${tMsg.tool_call_id})`,
        );
        continue;
      }

      validated.push(msg);
    }

    return validated;
  }
}
