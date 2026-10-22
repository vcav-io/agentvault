/**
 * Provider abstraction for LLM tool-use loops.
 *
 * Normalizes Anthropic Messages API and OpenAI Chat Completions API
 * into a common interface consumed by the agent loop.
 */

// ── Normalized message types ─────────────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Opaque provider metadata that must survive the round-trip (e.g. Gemini thoughtSignature). */
  _providerMeta?: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

// ── Provider response ────────────────────────────────────────────────────

export interface ProviderResponse {
  /** Text blocks from the response */
  textBlocks: TextContent[];
  /** Tool use requests from the response */
  toolUseBlocks: ToolUseContent[];
  /** Whether the model wants to use tools (vs. finished responding) */
  wantsToolUse: boolean;
  /** Raw content blocks for appending to message history */
  contentBlocks: ContentBlock[];
}

// ── Provider interface ───────────────────────────────────────────────────

export interface LLMProvider {
  /**
   * Send messages and get a response, potentially requesting tool use.
   */
  chat(params: {
    messages: Message[];
    tools: ToolDefinition[];
    system?: string;
  }): Promise<ProviderResponse>;

  /**
   * Build a message array entry for tool results to send back.
   */
  buildToolResultMessage(results: ToolResultContent[]): Message;

  /** Provider name for logging */
  readonly name: string;
}
