/**
 * Tests for RelayInboxTransport.
 *
 * Uses mock fetch to verify correct endpoints, headers, and AfalInviteMessage mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayInboxTransport, RELAY_INBOX_PAYLOAD_TYPE } from '../relay-inbox-transport.js';
import { isAcceptResult } from '../afal-transport.js';

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

function createTransport() {
  return new RelayInboxTransport({
    agentId: 'bob',
    inboxToken: 'bob-inbox-token',
    relayUrl: 'http://localhost:3100',
  });
}

describe('RelayInboxTransport', () => {
  it('exposes agentId and relayUrl', () => {
    const transport = createTransport();
    expect(transport.agentId).toBe('bob');
    expect(transport.relayUrl).toBe('http://localhost:3100');
  });

  it('sendPropose throws (not supported)', async () => {
    const transport = createTransport();
    await expect(
      transport.sendPropose({} as Parameters<typeof transport.sendPropose>[0]),
    ).rejects.toThrow(/createRelayInvite/);
  });

  describe('checkInbox', () => {
    it('polls GET /inbox?status=PENDING and maps to AfalInviteMessage', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          invites: [
            {
              invite_id: 'inv_abc',
              from_agent_id: 'alice',
              status: 'PENDING',
              purpose_code: 'COMPATIBILITY',
              contract_hash: 'hash123',
              created_at: '2026-02-27T00:00:00Z',
              expires_at: '2026-03-06T00:00:00Z',
            },
          ],
          latest_event_id: 1,
        }),
      );

      const transport = createTransport();
      const result = await transport.checkInbox();

      expect(result.invites).toHaveLength(1);
      const invite = result.invites[0];
      expect(invite.invite_id).toBe('inv_abc');
      expect(invite.from_agent_id).toBe('alice');
      expect(invite.contract_hash).toBe('hash123');
      expect(invite.payload_type).toBe(RELAY_INBOX_PAYLOAD_TYPE);
      expect(invite.afalPropose?.purpose_code).toBe('COMPATIBILITY');
      expect(invite.afalPropose?.from).toBe('alice');
      expect(invite.afalPropose?.to).toBe('bob');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/inbox?status=PENDING');
      expect(opts.headers['Authorization']).toBe('Bearer bob-inbox-token');
    });

    it('returns empty when no invites', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          invites: [],
          latest_event_id: 0,
        }),
      );

      const transport = createTransport();
      const result = await transport.checkInbox();
      expect(result.invites).toHaveLength(0);
    });
  });

  describe('acceptInvite', () => {
    it('calls POST /invites/:id/accept and returns AcceptResult', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          invite_id: 'inv_abc',
          session_id: 'sess_123',
          contract_hash: 'hash123',
          responder_submit_token: 'rs_tok',
          responder_read_token: 'rr_tok',
        }),
      );

      const transport = createTransport();
      const result = await transport.acceptInvite('inv_abc');

      expect(isAcceptResult(result)).toBe(true);
      expect(result.session_id).toBe('sess_123');
      expect(result.submit_token).toBe('rs_tok');
      expect(result.read_token).toBe('rr_tok');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3100/invites/inv_abc/accept');
      expect(opts.method).toBe('POST');
    });
  });

  describe('createRelayInvite', () => {
    it('calls POST /invites with contract', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          invite_id: 'inv_xyz',
          contract_hash: 'hash456',
          status: 'PENDING',
          expires_at: '2026-03-06T00:00:00Z',
        }),
      );

      const transport = createTransport();
      const result = await transport.createRelayInvite({
        to_agent_id: 'alice',
        contract: { purpose_code: 'COMPATIBILITY' },
        provider: 'anthropic',
        purpose_code: 'COMPATIBILITY',
      });

      expect(result.invite_id).toBe('inv_xyz');
      expect(result.contract_hash).toBe('hash456');
      expect(result.status).toBe('PENDING');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3100/invites');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer bob-inbox-token');
    });
  });

  describe('getInviteDetail', () => {
    it('calls GET /invites/:id', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          invite_id: 'inv_abc',
          from_agent_id: 'alice',
          to_agent_id: 'bob',
          status: 'ACCEPTED',
          purpose_code: 'COMPATIBILITY',
          contract_hash: 'hash123',
          provider: 'anthropic',
          created_at: '2025-01-15T10:00:00Z',
          updated_at: '2025-01-15T10:00:00Z',
          expires_at: '2025-01-22T10:00:00Z',
          session_id: 'sess_123',
          submit_token: 'is_tok',
          read_token: 'ir_tok',
        }),
      );

      const transport = createTransport();
      const detail = await transport.getInviteDetail('inv_abc');

      expect(detail.status).toBe('ACCEPTED');
      expect(detail.session_id).toBe('sess_123');
      expect(detail.submit_token).toBe('is_tok');
      expect(detail.read_token).toBe('ir_tok');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3100/invites/inv_abc');
    });
  });
});

describe('isAcceptResult', () => {
  it('returns true for valid AcceptResult', () => {
    expect(isAcceptResult({ session_id: 'a', submit_token: 'b', read_token: 'c' })).toBe(true);
  });

  it('returns false for undefined', () => {
    expect(isAcceptResult(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAcceptResult(null)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isAcceptResult({})).toBe(false);
  });

  it('returns false for partial object', () => {
    expect(isAcceptResult({ session_id: 'a' })).toBe(false);
  });
});
