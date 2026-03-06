/**
 * HTTP functions for relay inbox endpoints.
 *
 * Fetch-based. Same transport pattern as http.ts.
 */

import type {
  RelayClientConfig,
  CreateInviteRequest,
  CreateInviteResponse,
  AcceptInviteResponse,
  InviteDetailResponse,
  InboxResponse,
  InboxQuery,
  DeclineReasonCode,
} from './types.js';

import {
  validateCreateInviteResponse,
  validateInboxResponse,
  validateInviteDetail,
  validateAcceptResponse,
} from './validation/inbox-validators.js';

class RelayHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Relay HTTP ${status}: ${body}`);
    this.name = 'RelayHttpError';
  }
}

export class RelayTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Relay request timed out after ${timeoutMs}ms`);
    this.name = 'RelayTimeoutError';
  }
}

export { RelayValidationError } from './validation/inbox-validators.js';

async function relayFetch(
  config: RelayClientConfig,
  path: string,
  options: RequestInit,
): Promise<Response> {
  const url = `${config.relay_url.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timeoutMs = config.timeout_ms ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new RelayHttpError(res.status, body);
    }
    return res;
  } catch (err) {
    if (err instanceof RelayHttpError) throw err;
    // AbortController fires on timeout — wrap with a descriptive error
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new RelayTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public functions ──────────────────────────────────────────────────────

/** POST /invites — create a new invite. */
export async function createInvite(
  config: RelayClientConfig,
  request: CreateInviteRequest,
  inboxToken: string,
): Promise<CreateInviteResponse> {
  const res = await relayFetch(config, '/invites', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${inboxToken}`,
    },
    body: JSON.stringify(request),
  });
  const raw = await res.json();
  validateCreateInviteResponse(raw);
  return raw;
}

/** GET /inbox — list inbox with optional filters. */
export async function pollInbox(
  config: RelayClientConfig,
  inboxToken: string,
  query?: InboxQuery,
): Promise<InboxResponse> {
  const params = new URLSearchParams();
  if (query?.status) params.set('status', query.status);
  if (query?.from_agent_id) params.set('from_agent_id', query.from_agent_id);
  if (query?.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  const path = qs ? `/inbox?${qs}` : '/inbox';
  const res = await relayFetch(config, path, {
    method: 'GET',
    headers: { Authorization: `Bearer ${inboxToken}` },
  });
  const raw = await res.json();
  validateInboxResponse(raw);
  return raw;
}

/** GET /invites/:id — get invite detail (caller-dependent redaction). */
export async function getInvite(
  config: RelayClientConfig,
  inviteId: string,
  inboxToken: string,
): Promise<InviteDetailResponse> {
  const res = await relayFetch(config, `/invites/${inviteId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${inboxToken}` },
  });
  const raw = await res.json();
  validateInviteDetail(raw);
  return raw;
}

/** POST /invites/:id/accept — accept an invite (creates session, returns tokens). */
export async function acceptInvite(
  config: RelayClientConfig,
  inviteId: string,
  inboxToken: string,
  expectedContractHash?: string,
): Promise<AcceptInviteResponse> {
  const payload: Record<string, unknown> = {};
  if (expectedContractHash) {
    payload.expected_contract_hash = expectedContractHash;
  }
  const res = await relayFetch(config, `/invites/${inviteId}/accept`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${inboxToken}`,
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.json();
  validateAcceptResponse(raw);
  return raw;
}

/** POST /invites/:id/decline — decline an invite. */
export async function declineInvite(
  config: RelayClientConfig,
  inviteId: string,
  inboxToken: string,
  reasonCode?: DeclineReasonCode,
): Promise<InviteDetailResponse> {
  const payload: Record<string, unknown> = {};
  if (reasonCode) {
    payload.reason_code = reasonCode;
  }
  const res = await relayFetch(config, `/invites/${inviteId}/decline`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${inboxToken}`,
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.json();
  validateInviteDetail(raw);
  return raw;
}

/** POST /invites/:id/cancel — cancel an invite (sender only). */
export async function cancelInvite(
  config: RelayClientConfig,
  inviteId: string,
  inboxToken: string,
): Promise<InviteDetailResponse> {
  const res = await relayFetch(config, `/invites/${inviteId}/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${inboxToken}`,
    },
    body: JSON.stringify({}),
  });
  const raw = await res.json();
  validateInviteDetail(raw);
  return raw;
}
