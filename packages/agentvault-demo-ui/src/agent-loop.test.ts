/**
 * Regression tests for heartbeat convergence after one-sided failure (#361).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isTerminal,
  runHeartbeatLoop,
  createQueue,
  type AgentState,
} from './agent-loop.js';
import type { EventBus } from './events.js';
import type { LLMProvider } from './providers/types.js';
import type { ToolRegistry } from 'agentvault-mcp-server/tools';

// ── Helpers ────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    name: 'test',
    status: 'idle',
    messages: [],
    turnCount: 0,
    started: false,
    generation: 0,
    ...overrides,
  };
}

function makeEvents(): EventBus {
  return {
    emitStatus: vi.fn(),
    emitSystem: vi.fn(),
    emit: vi.fn(),
  } as unknown as EventBus;
}

function makeProvider(): LLMProvider {
  return { chat: vi.fn() } as unknown as LLMProvider;
}

function makeRegistry(): ToolRegistry {
  return { toolDefs: [] } as unknown as ToolRegistry;
}

// ── isTerminal ─────────────────────────────────────────────────────────

describe('isTerminal', () => {
  it('returns true for completed, failed', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
  });

  it('returns false for idle, running, error', () => {
    expect(isTerminal('idle')).toBe(false);
    expect(isTerminal('running')).toBe(false);
    // error is retryable (exponential backoff), not terminal
    expect(isTerminal('error')).toBe(false);
  });
});

// ── Peer failure propagation ───────────────────────────────────────────

describe('runHeartbeatLoop peer convergence', () => {
  let events: EventBus;

  beforeEach(() => {
    events = makeEvents();
    // Speed up tests — override HEARTBEAT_INTERVAL_MS via short abort
    vi.useFakeTimers();
  });

  it('propagates peer failed to running agent', async () => {
    const alice = makeState({ name: 'alice', started: true });
    const bob = makeState({ name: 'bob', status: 'failed', started: true });
    const ac = new AbortController();

    const loopPromise = runHeartbeatLoop(
      {
        name: 'alice',
        provider: makeProvider(),
        registry: makeRegistry(),
        systemPrompt: '',
        events,
        state: alice,
        queue: createQueue(),
        peerState: bob,
      },
      ac.signal,
    );

    // Advance past one heartbeat tick
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await loopPromise;

    expect(alice.status).toBe('failed');
    expect(events.emitStatus).toHaveBeenCalledWith('alice', 'failed', 'Peer agent failed');
  });

  it('does not propagate peer error (error is retryable)', async () => {
    const alice = makeState({ name: 'alice', started: true });
    const bob = makeState({ name: 'bob', status: 'error', started: true });
    const ac = new AbortController();

    const provider = makeProvider();
    (provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      role: 'assistant',
      content: 'No work to do.',
    });

    const loopPromise = runHeartbeatLoop(
      {
        name: 'alice',
        provider,
        registry: makeRegistry(),
        systemPrompt: '',
        events,
        state: alice,
        queue: createQueue(),
        peerState: bob,
      },
      ac.signal,
    );

    await vi.advanceTimersByTimeAsync(2500);
    ac.abort();
    await loopPromise;

    // Peer error is retryable — alice should keep running, not force-fail
    expect(alice.status).not.toBe('failed');
  });

  it('does not force-fail when peer completed normally', async () => {
    const alice = makeState({ name: 'alice', started: true });
    const bob = makeState({ name: 'bob', status: 'completed', started: true });
    const ac = new AbortController();

    const provider = makeProvider();
    // Provider will be called for heartbeat burst — return idle text response
    (provider.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
      role: 'assistant',
      content: 'No work to do.',
    });

    const loopPromise = runHeartbeatLoop(
      {
        name: 'alice',
        provider,
        registry: makeRegistry(),
        systemPrompt: '',
        events,
        state: alice,
        queue: createQueue(),
        peerState: bob,
      },
      ac.signal,
    );

    // Advance enough for one heartbeat cycle
    await vi.advanceTimersByTimeAsync(2500);
    ac.abort();
    await loopPromise;

    // Alice should NOT have been forced to failed
    expect(alice.status).not.toBe('failed');
  });

  it('self-terminal agent stays in no-cost tick regardless of peer', async () => {
    const alice = makeState({ name: 'alice', status: 'completed', started: true });
    const bob = makeState({ name: 'bob', status: 'failed', started: true });
    const ac = new AbortController();

    const loopPromise = runHeartbeatLoop(
      {
        name: 'alice',
        provider: makeProvider(),
        registry: makeRegistry(),
        systemPrompt: '',
        events,
        state: alice,
        queue: createQueue(),
        peerState: bob,
      },
      ac.signal,
    );

    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await loopPromise;

    // Alice stays completed — peer failure doesn't override
    expect(alice.status).toBe('completed');
    expect(events.emitStatus).not.toHaveBeenCalled();
  });
});
