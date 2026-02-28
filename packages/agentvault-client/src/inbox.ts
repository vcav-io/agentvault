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

export class RelayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayValidationError';
  }
}

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
    if (
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError')
    ) {
      throw new RelayTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Runtime validators ────────────────────────────────────────────────────

function requireFields(obj: unknown, fields: string[], typeName: string): Record<string, unknown> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new RelayValidationError(
      `${typeName}: expected object, got ${obj === null ? 'null' : typeof obj}`,
    );
  }
  const record = obj as Record<string, unknown>;
  for (const field of fields) {
    if (!(field in record)) {
      throw new RelayValidationError(`${typeName}: missing required field "${field}"`);
    }
  }
  return record;
}

function validateCreateInviteResponse(raw: unknown): CreateInviteResponse {
  const r = requireFields(raw, ['invite_id', 'contract_hash', 'status', 'expires_at'], 'CreateInviteResponse');
  return r as unknown as CreateInviteResponse;
}

function validateInboxResponse(raw: unknown): InboxResponse {
  const r = requireFields(raw, ['invites', 'latest_event_id'], 'InboxResponse');
  if (!Array.isArray(r.invites)) {
    throw new RelayValidationError('InboxResponse: "invites" must be an array');
  }
  return r as unknown as InboxResponse;
}

function validateInviteDetailResponse(raw: unknown): InviteDetailResponse {
  const r = requireFields(
    raw,
    ['invite_id', 'from_agent_id', 'to_agent_id', 'status', 'purpose_code', 'contract_hash', 'provider', 'created_at', 'updated_at', 'expires_at'],
    'InviteDetailResponse',
  );
  return r as unknown as InviteDetailResponse;
}

function validateAcceptInviteResponse(raw: unknown): AcceptInviteResponse {
  const r = requireFields(
    raw,
    ['invite_id', 'session_id', 'contract_hash', 'responder_submit_token', 'responder_read_token'],
    'AcceptInviteResponse',
  );
  return r as unknown as AcceptInviteResponse;
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
  return validateCreateInviteResponse(await res.json());
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
  return validateInboxResponse(await res.json());
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
  return validateInviteDetailResponse(await res.json());
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
  return validateAcceptInviteResponse(await res.json());
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
  return validateInviteDetailResponse(await res.json());
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
  return validateInviteDetailResponse(await res.json());
}
