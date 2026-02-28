/**
 * Tests for inbox HTTP functions.
 *
 * Uses mock fetch to verify correct endpoints, headers, and wire format.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createInvite,
  pollInbox,
  getInvite,
  acceptInvite,
  declineInvite,
  cancelInvite,
  RelayTimeoutError,
  RelayValidationError,
} from '../inbox.js';
import type { RelayClientConfig } from '../types.js';

const config: RelayClientConfig = { relay_url: 'http://localhost:3100' };
const token = 'test-inbox-token';

// Mock fetch globally
const mockFetch = vi.fn();
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

/** Minimal valid InviteDetailResponse for tests that don't care about fields. */
const validInviteDetail = {
  invite_id: 'inv_abc',
  from_agent_id: 'alice',
  to_agent_id: 'bob',
  status: 'PENDING',
  purpose_code: 'COMPATIBILITY',
  contract_hash: 'hash123',
  provider: 'anthropic',
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
  expires_at: '2026-03-06T00:00:00Z',
};

describe('createInvite', () => {
  it('sends POST /invites with bearer token', async () => {
    const body = {
      invite_id: 'inv_abc',
      contract_hash: 'hash123',
      status: 'PENDING',
      expires_at: '2026-03-06T00:00:00Z',
    };
    mockFetch.mockResolvedValueOnce(mockResponse(body));

    const result = await createInvite(
      config,
      {
        to_agent_id: 'bob',
        contract: { purpose_code: 'COMPATIBILITY' },
        provider: 'anthropic',
        purpose_code: 'COMPATIBILITY',
      },
      token,
    );

    expect(result.invite_id).toBe('inv_abc');
    expect(result.status).toBe('PENDING');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3100/invites');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer test-inbox-token');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });
});

describe('pollInbox', () => {
  it('sends GET /inbox with bearer token', async () => {
    const body = { invites: [], latest_event_id: 0 };
    mockFetch.mockResolvedValueOnce(mockResponse(body));

    const result = await pollInbox(config, token);

    expect(result.invites).toEqual([]);
    expect(result.latest_event_id).toBe(0);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3100/inbox');
    expect(opts.method).toBe('GET');
    expect(opts.headers['Authorization']).toBe('Bearer test-inbox-token');
  });

  it('appends query params', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ invites: [], latest_event_id: 0 }));

    await pollInbox(config, token, {
      status: 'PENDING',
      from_agent_id: 'alice',
      limit: 10,
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('status=PENDING');
    expect(url).toContain('from_agent_id=alice');
    expect(url).toContain('limit=10');
  });
});

describe('getInvite', () => {
  it('sends GET /invites/:id with bearer token', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(validInviteDetail));

    const result = await getInvite(config, 'inv_abc', token);

    expect(result.invite_id).toBe('inv_abc');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3100/invites/inv_abc');
    expect(opts.method).toBe('GET');
  });
});

describe('acceptInvite', () => {
  it('sends POST /invites/:id/accept', async () => {
    const body = {
      invite_id: 'inv_abc',
      session_id: 'sess_123',
      contract_hash: 'hash123',
      responder_submit_token: 'rs_tok',
      responder_read_token: 'rr_tok',
    };
    mockFetch.mockResolvedValueOnce(mockResponse(body));

    const result = await acceptInvite(config, 'inv_abc', token);

    expect(result.session_id).toBe('sess_123');
    expect(result.responder_submit_token).toBe('rs_tok');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3100/invites/inv_abc/accept');
    expect(opts.method).toBe('POST');
  });

  it('sends expected_contract_hash when provided', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        invite_id: 'inv_abc',
        session_id: 'sess_123',
        contract_hash: 'hash123',
        responder_submit_token: 'rs',
        responder_read_token: 'rr',
      }),
    );

    await acceptInvite(config, 'inv_abc', token, 'expected_hash');

    const [, opts] = mockFetch.mock.calls[0];
    const parsed = JSON.parse(opts.body);
    expect(parsed.expected_contract_hash).toBe('expected_hash');
  });
});

describe('declineInvite', () => {
  it('sends POST /invites/:id/decline with reason', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ...validInviteDetail, status: 'DECLINED' }));

    await declineInvite(config, 'inv_abc', token, 'BUSY');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3100/invites/inv_abc/decline');
    const parsed = JSON.parse(opts.body);
    expect(parsed.reason_code).toBe('BUSY');
  });
});

describe('cancelInvite', () => {
  it('sends POST /invites/:id/cancel', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ...validInviteDetail, status: 'CANCELED' }));

    await cancelInvite(config, 'inv_abc', token);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3100/invites/inv_abc/cancel');
    expect(opts.method).toBe('POST');
  });
});

// ============================================================================
// Error path tests (C2: relayFetch throws RelayHttpError on non-2xx)
// ============================================================================

describe('error handling', () => {
  it('throws on 401 Unauthorized', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'UNAUTHORIZED' }, 401));

    await expect(pollInbox(config, 'bad-token')).rejects.toThrow('Relay HTTP 401');
  });

  it('throws on 409 Conflict', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ error: 'Invite state conflict: cannot accept' }, 409),
    );

    await expect(acceptInvite(config, 'inv_abc', token)).rejects.toThrow('Relay HTTP 409');
  });

  it('throws on 500 Internal Server Error', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'Internal error' }, 500));

    await expect(
      createInvite(
        config,
        {
          to_agent_id: 'bob',
          contract: { purpose_code: 'COMPATIBILITY' },
          provider: 'anthropic',
          purpose_code: 'COMPATIBILITY',
        },
        token,
      ),
    ).rejects.toThrow('Relay HTTP 500');
  });

  it('error includes response body', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'UNAUTHORIZED' }, 401));

    try {
      await getInvite(config, 'inv_abc', 'bad-token');
      expect.fail('should have thrown');
    } catch (err: unknown) {
      const e = err as { status: number; body: string; name: string };
      expect(e.name).toBe('RelayHttpError');
      expect(e.status).toBe(401);
      expect(e.body).toContain('UNAUTHORIZED');
    }
  });
});

// ============================================================================
// Timeout wrapping (C3: AbortError → RelayTimeoutError)
// ============================================================================

describe('timeout handling', () => {
  it('wraps AbortError into RelayTimeoutError with duration', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    mockFetch.mockRejectedValueOnce(abortErr);

    const shortConfig: RelayClientConfig = { relay_url: 'http://localhost:3100', timeout_ms: 5000 };

    try {
      await pollInbox(shortConfig, token);
      expect.fail('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RelayTimeoutError);
      const te = err as RelayTimeoutError;
      expect(te.timeoutMs).toBe(5000);
      expect(te.message).toContain('5000ms');
      expect(te.name).toBe('RelayTimeoutError');
    }
  });

  it('uses default 30000ms when timeout_ms not set', async () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    mockFetch.mockRejectedValueOnce(abortErr);

    try {
      await pollInbox(config, token);
      expect.fail('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RelayTimeoutError);
      const te = err as RelayTimeoutError;
      expect(te.timeoutMs).toBe(30_000);
      expect(te.message).toContain('30000ms');
    }
  });
});

// ============================================================================
// Runtime validation (C4: malformed responses throw RelayValidationError)
// ============================================================================

describe('runtime validation', () => {
  it('throws RelayValidationError when createInvite response missing invite_id', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ contract_hash: 'h', status: 'PENDING', expires_at: 'x' }),
    );

    await expect(
      createInvite(
        config,
        {
          to_agent_id: 'bob',
          contract: {},
          provider: 'anthropic',
          purpose_code: 'COMPATIBILITY',
        },
        token,
      ),
    ).rejects.toThrow(RelayValidationError);
  });

  it('throws RelayValidationError when pollInbox response missing invites', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ latest_event_id: 0 }));

    await expect(pollInbox(config, token)).rejects.toThrow(RelayValidationError);
  });

  it('throws RelayValidationError when pollInbox invites is not array', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ invites: 'bad', latest_event_id: 0 }));

    await expect(pollInbox(config, token)).rejects.toThrow(RelayValidationError);
  });

  it('throws RelayValidationError when getInvite response missing required fields', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ invite_id: 'inv_abc' }));

    await expect(getInvite(config, 'inv_abc', token)).rejects.toThrow(RelayValidationError);
  });

  it('throws RelayValidationError when acceptInvite response missing session_id', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        invite_id: 'inv_abc',
        contract_hash: 'h',
        responder_submit_token: 'rs',
        responder_read_token: 'rr',
        // session_id missing
      }),
    );

    await expect(acceptInvite(config, 'inv_abc', token)).rejects.toThrow(RelayValidationError);
  });

  it('throws RelayValidationError when response is null', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(null));

    await expect(pollInbox(config, token)).rejects.toThrow(RelayValidationError);
  });

  it('throws RelayValidationError when response is an array', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await expect(pollInbox(config, token)).rejects.toThrow(RelayValidationError);
  });

  it('error message includes field name', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ latest_event_id: 0 }));

    try {
      await pollInbox(config, token);
      expect.fail('should have thrown');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(RelayValidationError);
      const ve = err as RelayValidationError;
      expect(ve.message).toContain('invites');
      expect(ve.name).toBe('RelayValidationError');
    }
  });
});
