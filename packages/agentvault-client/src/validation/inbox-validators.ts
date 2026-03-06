/**
 * Shared runtime validators for inbox relay responses.
 *
 * Assertion-style — throw RelayValidationError on invalid data.
 * Chrono DateTime<Utc> serializes to RFC 3339 (may use +00:00 or Z suffix).
 */

import type {
  InviteSummary,
  InviteDetailResponse,
  AcceptInviteResponse,
  CreateInviteResponse,
  InboxResponse,
  InviteStatus,
} from '../types.js';

export class RelayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayValidationError';
  }
}

const INVITE_STATUSES: ReadonlySet<string> = new Set([
  'PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELED',
]);

function requireObject(obj: unknown, typeName: string): Record<string, unknown> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new RelayValidationError(
      `${typeName}: expected object, got ${obj === null ? 'null' : Array.isArray(obj) ? 'array' : typeof obj}`,
    );
  }
  return obj as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string, typeName: string): string {
  const value = record[field];
  if (typeof value !== 'string') {
    if (value === undefined) {
      throw new RelayValidationError(`${typeName}: missing required field "${field}"`);
    }
    throw new RelayValidationError(
      `${typeName}: field "${field}" must be string, got ${typeof value}`,
    );
  }
  return value;
}

// Date.parse() (not strict toISOString() round-trip) because Rust chrono
// serializes UTC as "+00:00" which doesn't round-trip through JS Date.
function requireTimestamp(record: Record<string, unknown>, field: string, typeName: string): string {
  const value = requireString(record, field, typeName);
  if (isNaN(Date.parse(value))) {
    throw new RelayValidationError(
      `${typeName}: field "${field}" is not a valid timestamp: "${value}"`,
    );
  }
  return value;
}

export function validateInviteStatus(value: unknown): asserts value is InviteStatus {
  if (typeof value !== 'string' || !INVITE_STATUSES.has(value)) {
    throw new RelayValidationError(
      `InviteStatus: expected one of ${[...INVITE_STATUSES].join(', ')}, got "${String(value)}"`,
    );
  }
}

export function validateInviteSummary(obj: unknown): asserts obj is InviteSummary {
  const r = requireObject(obj, 'InviteSummary');
  requireString(r, 'invite_id', 'InviteSummary');
  requireString(r, 'from_agent_id', 'InviteSummary');
  validateInviteStatus(r.status);
  requireString(r, 'purpose_code', 'InviteSummary');
  requireString(r, 'contract_hash', 'InviteSummary');
  requireTimestamp(r, 'created_at', 'InviteSummary');
  requireTimestamp(r, 'expires_at', 'InviteSummary');
}

export function validateInviteDetail(obj: unknown): asserts obj is InviteDetailResponse {
  const r = requireObject(obj, 'InviteDetailResponse');
  requireString(r, 'invite_id', 'InviteDetailResponse');
  requireString(r, 'from_agent_id', 'InviteDetailResponse');
  requireString(r, 'to_agent_id', 'InviteDetailResponse');
  validateInviteStatus(r.status);
  requireString(r, 'purpose_code', 'InviteDetailResponse');
  requireString(r, 'contract_hash', 'InviteDetailResponse');
  requireString(r, 'provider', 'InviteDetailResponse');
  requireTimestamp(r, 'created_at', 'InviteDetailResponse');
  requireTimestamp(r, 'updated_at', 'InviteDetailResponse');
  requireTimestamp(r, 'expires_at', 'InviteDetailResponse');
}

export function validateAcceptResponse(obj: unknown): asserts obj is AcceptInviteResponse {
  const r = requireObject(obj, 'AcceptInviteResponse');
  requireString(r, 'invite_id', 'AcceptInviteResponse');
  requireString(r, 'session_id', 'AcceptInviteResponse');
  requireString(r, 'contract_hash', 'AcceptInviteResponse');
  requireString(r, 'responder_submit_token', 'AcceptInviteResponse');
  requireString(r, 'responder_read_token', 'AcceptInviteResponse');
}

export function validateCreateInviteResponse(obj: unknown): asserts obj is CreateInviteResponse {
  const r = requireObject(obj, 'CreateInviteResponse');
  requireString(r, 'invite_id', 'CreateInviteResponse');
  requireString(r, 'contract_hash', 'CreateInviteResponse');
  validateInviteStatus(r.status);
  requireTimestamp(r, 'expires_at', 'CreateInviteResponse');
}

export function validateInboxResponse(obj: unknown): asserts obj is InboxResponse {
  const r = requireObject(obj, 'InboxResponse');
  if (!Array.isArray(r.invites)) {
    if (r.invites === undefined) {
      throw new RelayValidationError('InboxResponse: missing required field "invites"');
    }
    throw new RelayValidationError('InboxResponse: "invites" must be an array');
  }
  for (let i = 0; i < r.invites.length; i++) {
    try {
      validateInviteSummary(r.invites[i]);
    } catch (err) {
      if (err instanceof RelayValidationError) {
        throw new RelayValidationError(`InboxResponse.invites[${i}]: ${err.message}`);
      }
      throw err;
    }
  }
  if (typeof r.latest_event_id !== 'number') {
    throw new RelayValidationError(
      `InboxResponse: field "latest_event_id" must be number, got ${typeof r.latest_event_id}`,
    );
  }
}
