/**
 * Agent loop: persistent heartbeat runtime with cron-style re-prompting.
 *
 * Each agent runs an identical, symmetric runtime — a persistent heartbeat
 * loop that runs from server startup and never stops. The only difference
 * between agents is the content of their initial user message.
 *
 * Two concerns, cleanly separated:
 * 1. runLLMBurst() — runs the LLM tool-use loop until the LLM stops calling
 *    tools. Returns a BurstResult. This is the "agent turn".
 * 2. runHeartbeatLoop() — a while(true) that calls runLLMBurst() with a
 *    heartbeat prompt, then waits HEARTBEAT_INTERVAL_MS. Never resolves.
 */

import type { LLMProvider, Message, ToolDefinition } from './providers/types.js';
import type { ToolRegistry } from 'agentvault-mcp-server/tools';
import type { EventBus } from './events.js';
import { executeToolCalls } from './tool-bridge.js';

// ── Constants ────────────────────────────────────────────────────────────

const MAX_TURNS = 30;
const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env['HEARTBEAT_INTERVAL_MS'] ?? '2000', 10,
);

const HEARTBEAT_PROMPT = '[Heartbeat] Run your agent heartbeat checklist.';

// ── Types ────────────────────────────────────────────────────────────────

export type BurstResult = 'idle' | 'session_completed' | 'max_turns' | 'error';

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error';

export interface AgentState {
  name: string;
  status: AgentStatus;
  messages: Message[];
  turnCount: number;
  started: boolean;
}

// ── Promise queue (single-slot chain per agent) ──────────────────────────

function createQueue() {
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;

  function enqueue(fn: () => Promise<unknown>): Promise<void> {
    pending++;
    queue = queue
      .then(fn, (prevErr) => {
        console.error('Previous queue item failed:', prevErr);
        return fn();
      })
      .then(() => {}, (err) => {
        console.error('Queue item failed:', err);
      })
      .finally(() => {
        pending = Math.max(0, pending - 1);
      });
    return queue;
  }

  function reset(): void {
    queue = Promise.resolve();
    pending = 0;
  }

  function isIdle(): boolean {
    return pending === 0;
  }

  return { enqueue, reset, isIdle };
}

// ── Delay helper with AbortSignal support ────────────────────────────────

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer.unref?.();
  });
}

// ── runLLMBurst ──────────────────────────────────────────────────────────

interface BurstParams {
  name: string;
  provider: LLMProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  events: EventBus;
  state: AgentState;
}

/**
 * Run one LLM tool-use burst.
 *
 * If `ephemeralUserMessage` is provided, it is prepended to the messages sent
 * to the LLM but NOT persisted to state.messages. If the LLM responds with
 * tool calls (real work), the ephemeral message AND the assistant response are
 * then committed to state.messages. If the LLM responds with text only (idle),
 * neither is persisted — the heartbeat was a no-op.
 */
async function runLLMBurst(
  params: BurstParams,
  ephemeralUserMessage?: string,
  signal?: AbortSignal,
): Promise<BurstResult> {
  const { name, provider, registry, systemPrompt, events, state } = params;

  // Guard: if aborted or session already completed, exit immediately.
  if (signal?.aborted) return 'idle';
  if (state.status === 'completed') {
    return 'idle';
  }

  const toolDefs: ToolDefinition[] = registry.toolDefs.map((td) => ({
    name: td.name,
    description: td.description,
    inputSchema: td.inputSchema,
  }));

  state.status = 'running';
  events.emitStatus(name, 'running', ephemeralUserMessage ? 'Heartbeat' : 'Processing');

  let ephemeralCommitted = false;

  // When a tool result signals session completion, we set this flag instead
  // of returning immediately. This lets the loop continue for one more turn
  // so the LLM can react to the result (e.g., summarise the mediation signal).
  let sessionDone = false;

  // Build messages for this burst — ephemeral message appended but not persisted yet
  let messages: Message[] = ephemeralUserMessage
    ? [...state.messages, { role: 'user' as const, content: ephemeralUserMessage }]
    : state.messages;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (signal?.aborted) break;
      state.turnCount++;

      const response = await provider.chat({
        messages,
        tools: toolDefs,
        system: systemPrompt,
      });

      // If no tool calls, burst is done.
      // Check toolUseBlocks.length rather than wantsToolUse to prevent orphaned
      // tool_calls in state.messages — OpenAI rejects histories where an assistant
      // message contains tool_calls without matching tool results.
      if (response.toolUseBlocks.length === 0) {
        const isHeartbeatOk = response.textBlocks.length === 1
          && response.textBlocks[0].text.trim() === 'HEARTBEAT_OK';

        // Emit text to conversation panel only if NOT HEARTBEAT_OK
        if (!isHeartbeatOk) {
          for (const tb of response.textBlocks) {
            events.emitLLMText(name, tb.text);
          }
        }

        if (ephemeralUserMessage && !ephemeralCommitted && !isHeartbeatOk) {
          // LLM had something substantive to say — commit ephemeral + response
          state.messages.push({ role: 'user', content: ephemeralUserMessage });
          state.messages.push({ role: 'assistant', content: response.contentBlocks });
        } else if (!ephemeralUserMessage || ephemeralCommitted) {
          // Normal (non-heartbeat) burst, or ephemeral already committed (had tool calls earlier)
          state.messages.push({ role: 'assistant', content: response.contentBlocks });
        }
        // If HEARTBEAT_OK and not committed: nothing persisted — ephemeral vanishes

        // If the session is done and the LLM just produced its reaction text, exit
        if (sessionDone) {
          state.status = 'completed';
          events.emitStatus(name, 'completed', 'Session completed');
          return 'session_completed';
        }

        state.status = 'idle';
        events.emitStatus(name, 'idle', isHeartbeatOk ? 'HEARTBEAT_OK' : 'Burst complete');
        return 'idle';
      }

      // Tool-use path: emit text blocks normally (these accompany real work)
      for (const tb of response.textBlocks) {
        events.emitLLMText(name, tb.text);
      }

      // Commit ephemeral message on first tool call (if not already committed)
      if (ephemeralUserMessage && !ephemeralCommitted) {
        state.messages.push({ role: 'user', content: ephemeralUserMessage });
        ephemeralCommitted = true;
      }
      state.messages.push({ role: 'assistant', content: response.contentBlocks });

      // Build a map from tool_use_id -> tool name so we can filter completions
      // by tool name in the loop below.
      const toolNameById = new Map<string, string>(
        response.toolUseBlocks.map((tu) => [tu.id, tu.name]),
      );

      // Execute tool calls
      const toolResults = await executeToolCalls(
        response.toolUseBlocks,
        registry,
        name,
        events,
      );

      // Append tool results
      const toolResultMessage = provider.buildToolResultMessage(toolResults);
      state.messages.push(toolResultMessage);

      // Update messages reference for next turn
      messages = state.messages;

      // Check if any relay_signal tool result indicates session completion.
      // Scoped to relay_signal only — other tools returning { state: 'COMPLETED' }
      // should not terminate the agent loop.
      // Don't return immediately — set flag so the LLM gets one more turn to react.
      for (const tr of toolResults) {
        const toolName = toolNameById.get(tr.tool_use_id) ?? '';
        if (!toolName.includes('relay_signal')) continue;
        try {
          const parsed = JSON.parse(tr.content);
          // Tool results use envelope format: { ok, status, data: { state } }
          const state = parsed?.data?.state ?? parsed?.state;
          if (state === 'COMPLETED' || state === 'FAILED') {
            sessionDone = true;
          }
        } catch {
          // Tool results are not always JSON (e.g. plain text responses).
          if (tr.content.trimStart().startsWith('{') || tr.content.trimStart().startsWith('[')) {
            console.warn(`Failed to parse JSON-like tool result: ${tr.content.substring(0, 200)}`);
          }
        }
      }
    }

    // Exhausted turns
    if (sessionDone) {
      state.status = 'completed';
      events.emitStatus(name, 'completed', 'Session completed');
      return 'session_completed';
    }
    state.status = 'idle';
    events.emitStatus(name, 'idle', `Burst reached max turns (${MAX_TURNS})`);
    return 'max_turns';
  } catch (error) {
    state.status = 'error';
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    events.emit({
      ts: new Date().toISOString(),
      type: 'error',
      agent: name,
      payload: { error: errorMsg },
    });
    events.emitStatus(name, 'error', errorMsg);
    return 'error';
  }
}

// ── runHeartbeatLoop ─────────────────────────────────────────────────────

interface HeartbeatParams extends BurstParams {
  queue: ReturnType<typeof createQueue>;
  heartbeatProvider?: LLMProvider;
}

/**
 * Persistent heartbeat loop. Started at server startup. Never resolves.
 * Killed via AbortSignal when the server shuts down or resets.
 */
export async function runHeartbeatLoop(
  params: HeartbeatParams,
  signal: AbortSignal,
): Promise<void> {
  const { name, events, state, queue, heartbeatProvider } = params;
  let consecutiveErrors = 0;

  // Use cheap model for heartbeats (Haiku / gpt-4o-mini), main model for real work
  const heartbeatParams: BurstParams = heartbeatProvider
    ? { ...params, provider: heartbeatProvider }
    : params;

  while (!signal.aborted) {
    // No-cost local tick after session completion — loop stays alive but
    // no LLM call. Prevents budget models from spinning on post-completion
    // heartbeats (get_identity loops, session restarts).
    if (state.status === 'completed') {
      await delay(HEARTBEAT_INTERVAL_MS, signal);
      continue;
    }

    if (state.started) {
      if (!queue.isIdle() || state.status === 'running') {
        await delay(HEARTBEAT_INTERVAL_MS, signal);
        continue;
      }
      events.emitSystem(`${name}: Heartbeat`);
      await queue.enqueue(() => runLLMBurst(heartbeatParams, HEARTBEAT_PROMPT, signal));

      // Exponential backoff on errors: 2s → 4s → 8s → 16s → 30s cap
      if (state.status === 'error') {
        consecutiveErrors++;
        const backoff = Math.min(HEARTBEAT_INTERVAL_MS * Math.pow(2, consecutiveErrors), 30_000);
        events.emitSystem(`${name}: Error backoff ${Math.round(backoff / 1000)}s (${consecutiveErrors} consecutive)`);
        await delay(backoff, signal);
        continue;
      }
      consecutiveErrors = 0;
    } else {
      events.emitSystem(`${name}: heartbeat tick — runtime alive`);
    }

    await delay(HEARTBEAT_INTERVAL_MS, signal);
  }
}

// ── sendUserMessage ──────────────────────────────────────────────────────

/**
 * Send a user message and trigger an immediate LLM burst.
 * Called when the user clicks Start or sends a mid-run chat message.
 *
 * The message push and burst are both inside the queue to prevent
 * concurrent mutation of state.messages during a running burst.
 */
export async function sendUserMessage(
  params: BurstParams & { queue: ReturnType<typeof createQueue> },
  message: string,
  signal?: AbortSignal,
): Promise<void> {
  const { name, events, state, queue } = params;

  state.started = true;
  events.emitSystem(`${name}: User message received`);

  await queue.enqueue(() => {
    if (signal?.aborted) return Promise.resolve();
    state.messages.push({ role: 'user', content: message });
    return runLLMBurst(params, undefined, signal);
  });
}

export { createQueue };
