import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRelayHandle,
  findExistingRelayHandle,
  pruneRelayHandles,
  encodeRelayToken,
  decodeRelayToken,
  computeRelayIdempotencyKey,
  _resetHandlesForTesting,
} from '../tools/relayHandles.js';

beforeEach(() => {
  _resetHandlesForTesting();
});

describe('createRelayHandle', () => {
  it('creates a handle with generated id and timestamps', () => {
    const handle = createRelayHandle({
      agentId: 'agent-1',
      role: 'INITIATOR',
      phase: 'INVITE',
      counterparty: 'agent-2',
      idempotencyKey: 'key-1',
      timeoutMs: 60_000,
    });

    expect(handle.id).toBeTruthy();
    expect(handle.agentId).toBe('agent-1');
    expect(handle.role).toBe('INITIATOR');
    expect(handle.phase).toBe('INVITE');
    expect(handle.counterparty).toBe('agent-2');
    expect(handle.createdAt).toBeGreaterThan(0);
    expect(handle.timeoutDeadline).toBe(handle.createdAt + 60_000);
  });
});

describe('findExistingRelayHandle', () => {
  it('finds a non-terminal handle by agentId, role, and idempotencyKey', () => {
    const handle = createRelayHandle({
      agentId: 'agent-1',
      role: 'INITIATOR',
      phase: 'POLL_RELAY',
      counterparty: 'agent-2',
      idempotencyKey: 'key-1',
      timeoutMs: 60_000,
    });

    const found = findExistingRelayHandle('agent-1', 'INITIATOR', 'key-1');
    expect(found).toBe(handle);
  });

  it('does not find terminal handles', () => {
    const handle = createRelayHandle({
      agentId: 'agent-1',
      role: 'INITIATOR',
      phase: 'COMPLETED',
      counterparty: 'agent-2',
      idempotencyKey: 'key-1',
      timeoutMs: 60_000,
    });

    const found = findExistingRelayHandle('agent-1', 'INITIATOR', 'key-1');
    expect(found).toBeNull();
  });

  it('does not match wrong role', () => {
    createRelayHandle({
      agentId: 'agent-1',
      role: 'INITIATOR',
      phase: 'POLL_RELAY',
      counterparty: 'agent-2',
      idempotencyKey: 'key-1',
      timeoutMs: 60_000,
    });

    const found = findExistingRelayHandle('agent-1', 'RESPONDER', 'key-1');
    expect(found).toBeNull();
  });
});

describe('pruneRelayHandles', () => {
  it('removes handles expired past grace period', () => {
    const handle = createRelayHandle({
      agentId: 'agent-1',
      role: 'INITIATOR',
      phase: 'POLL_RELAY',
      counterparty: 'agent-2',
      idempotencyKey: 'key-1',
      timeoutMs: 1, // 1ms timeout
    });

    // Force expiry past grace period (10 min)
    handle.timeoutDeadline = Date.now() - 11 * 60 * 1000;

    pruneRelayHandles();

    const found = findExistingRelayHandle('agent-1', 'INITIATOR', 'key-1');
    expect(found).toBeNull();
  });

  it('keeps handles within grace period', () => {
    createRelayHandle({
      agentId: 'agent-1',
      role: 'INITIATOR',
      phase: 'POLL_RELAY',
      counterparty: 'agent-2',
      idempotencyKey: 'key-1',
      timeoutMs: 60_000,
    });

    pruneRelayHandles();

    const found = findExistingRelayHandle('agent-1', 'INITIATOR', 'key-1');
    expect(found).not.toBeNull();
  });
});

describe('encodeRelayToken / decodeRelayToken', () => {
  it('round-trips without secret', () => {
    const handle = createRelayHandle({
      agentId: 'agent-1',
      role: 'INITIATOR',
      phase: 'POLL_RELAY',
      counterparty: 'agent-2',
      idempotencyKey: 'key-1',
      timeoutMs: 60_000,
    });

    const token = encodeRelayToken(handle, null);
    const decoded = decodeRelayToken(token, 'agent-1', null);
    expect(decoded).toBe(handle);
  });

  it('round-trips with secret', () => {
    const handle = createRelayHandle({
      agentId: 'agent-1',
      role: 'INITIATOR',
      phase: 'POLL_RELAY',
      counterparty: 'agent-2',
      idempotencyKey: 'key-1',
      timeoutMs: 60_000,
    });

    const secret = 'test-secret-key';
    const token = encodeRelayToken(handle, secret);
    expect(token).toContain('.'); // has signature
    const decoded = decodeRelayToken(token, 'agent-1', secret);
    expect(decoded).toBe(handle);
  });

  it('rejects token with wrong secret', () => {
    const handle = createRelayHandle({
      agentId: 'agent-1',
      role: 'INITIATOR',
      phase: 'POLL_RELAY',
      counterparty: 'agent-2',
      idempotencyKey: 'key-1',
      timeoutMs: 60_000,
    });

    const token = encodeRelayToken(handle, 'secret-a');
    const decoded = decodeRelayToken(token, 'agent-1', 'secret-b');
    expect(decoded).toBeNull();
  });

  it('rejects token with wrong agentId', () => {
    const handle = createRelayHandle({
      agentId: 'agent-1',
      role: 'INITIATOR',
      phase: 'POLL_RELAY',
      counterparty: 'agent-2',
      idempotencyKey: 'key-1',
      timeoutMs: 60_000,
    });

    const token = encodeRelayToken(handle, null);
    const decoded = decodeRelayToken(token, 'agent-wrong', null);
    expect(decoded).toBeNull();
  });

  it('rejects garbage token', () => {
    const decoded = decodeRelayToken('not-a-valid-token', 'agent-1', null);
    expect(decoded).toBeNull();
  });
});

describe('computeRelayIdempotencyKey', () => {
  it('produces deterministic output', () => {
    const a = computeRelayIdempotencyKey('agent-1', ['hash', 'peer', 'input']);
    const b = computeRelayIdempotencyKey('agent-1', ['hash', 'peer', 'input']);
    expect(a).toBe(b);
  });

  it('differs with different inputs', () => {
    const a = computeRelayIdempotencyKey('agent-1', ['hash-a', 'peer', 'input']);
    const b = computeRelayIdempotencyKey('agent-1', ['hash-b', 'peer', 'input']);
    expect(a).not.toBe(b);
  });
});
