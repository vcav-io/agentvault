/**
 * Google Gemini generateContent API adapter.
 *
 * Uses the REST API directly (no SDK dependency) to keep deps minimal.
 */

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

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

// Gemini tool names must match ^[a-zA-Z0-9_]+$ — no dots or hyphens.
// Returns the sanitized name and records the mapping in the provided map for round-trip fidelity.
function sanitizeName(name: string, nameMap?: Map<string, string>): string {
  const sanitized = name.replace(/[.\-]/g, '_');
  if (nameMap && sanitized !== name) {
    nameMap.set(sanitized, name);
  }
  return sanitized;
}
function unsanitizeName(sanitized: string, nameMap: Map<string, string>): string {
  return nameMap.get(sanitized) ?? sanitized;
}

// Gemini doesn't support these JSON Schema keywords.
const UNSUPPORTED_KEYWORDS = new Set([
  'minimum', 'maximum', 'minItems', 'maxItems',
  'uniqueItems', 'additionalProperties',
]);

function stripUnsupported(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripUnsupported);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYWORDS.has(k) || k.startsWith('x-')) continue;
      result[k] = stripUnsupported(v);
    }
    return result;
  }
  return obj;
}

export class GeminiProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  /** Bijective map: sanitized Gemini name → original MCP tool name. */
  private readonly nameMap = new Map<string, string>();

  readonly name = 'gemini';

  constructor(apiKey: string, model = 'gemini-3-flash-preview', baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
  }

  async chat(params: {
    messages: Message[];
    tools: ToolDefinition[];
    system?: string;
  }): Promise<ProviderResponse> {
    const contents = this.toGeminiContents(params.messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 0,
      },
    };

    if (params.system) {
      body.systemInstruction = { parts: [{ text: params.system }] };
    }

    if (params.tools.length > 0) {
      body.tools = [{
        functionDeclarations: params.tools.map((t) => ({
          name: sanitizeName(t.name, this.nameMap),
          description: t.description,
          parameters: stripUnsupported(t.inputSchema),
        })),
      }];
    }

    const url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errorText.substring(0, 500)}`);
    }

    const json = await response.json() as GeminiResponse;

    const candidate = json.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
      throw new Error(`Gemini blocked response: ${finishReason}`);
    }
    if (!candidate?.content?.parts) {
      throw new Error(`Gemini response missing candidate parts (finishReason: ${finishReason ?? 'unknown'})`);
    }

    const textBlocks: TextContent[] = [];
    const toolUseBlocks: ToolUseContent[] = [];
    const contentBlocks: ContentBlock[] = [];
    let callIndex = 0;

    for (const part of candidate.content.parts) {
      if (part.text !== undefined) {
        const tb: TextContent = { type: 'text', text: part.text };
        textBlocks.push(tb);
        contentBlocks.push(tb);
      }
      if (part.functionCall) {
        const tu: ToolUseContent = {
          type: 'tool_use',
          id: `gemini_call_${callIndex++}`,
          name: unsanitizeName(part.functionCall.name, this.nameMap),
          input: (part.functionCall.args ?? {}) as Record<string, unknown>,
        };
        // Preserve thoughtSignature for round-trip (required by Gemini 3+ models)
        if (part.thoughtSignature) {
          tu._providerMeta = { thoughtSignature: part.thoughtSignature };
        }
        toolUseBlocks.push(tu);
        contentBlocks.push(tu);
      }
    }

    return {
      textBlocks,
      toolUseBlocks,
      wantsToolUse: toolUseBlocks.length > 0,
      contentBlocks,
    };
  }

  buildToolResultMessage(results: ToolResultContent[]): Message {
    return {
      role: 'user',
      content: results,
    };
  }

  private toGeminiContents(messages: Message[]): GeminiContent[] {
    const result: GeminiContent[] = [];

    // Build a map from tool_use_id → sanitized function name across all messages.
    const idToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          idToName.set(block.id, sanitizeName(block.name, this.nameMap));
        }
      }
    }

    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';

      if (typeof msg.content === 'string') {
        result.push({ role, parts: [{ text: msg.content }] });
        continue;
      }

      if (msg.role === 'assistant') {
        const parts: GeminiPart[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_use') {
            const part: GeminiPart = {
              functionCall: {
                name: sanitizeName(block.name, this.nameMap),
                args: block.input,
              },
            };
            // Replay thoughtSignature if present (required by Gemini 3+ models)
            const sig = block._providerMeta?.thoughtSignature as string | undefined;
            if (sig) {
              part.thoughtSignature = sig;
            }
            parts.push(part);
          }
        }
        if (parts.length > 0) result.push({ role: 'model', parts });
      } else {
        // User message — may contain tool_results and text
        const toolResults = msg.content.filter((b) => b.type === 'tool_result');
        const textParts = msg.content.filter((b) => b.type === 'text');

        if (toolResults.length > 0) {
          const parts: GeminiPart[] = toolResults.map((tr) => {
            const fnName = idToName.get(tr.tool_use_id);
            if (!fnName) {
              throw new Error(
                `Cannot map tool_use_id "${tr.tool_use_id}" to a function name — ` +
                `no matching tool_use block found in conversation history`,
              );
            }
            return {
              functionResponse: {
                name: fnName,
                response: { content: tr.content },
              },
            };
          });
          result.push({ role: 'user', parts });
        }

        if (textParts.length > 0) {
          result.push({
            role: 'user',
            parts: textParts.map((t) => ({ text: t.text })),
          });
        }
      }
    }

    return result;
  }
}

// ── Gemini API types (minimal) ──────────────────────────────────────────

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
  thoughtSignature?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts: GeminiPart[] };
    finishReason?: string;
  }>;
  modelVersion?: string;
}
