/**
 * Tests for shared inbox response validators.
 */

import { describe, it, expect } from 'vitest';
import {
  RelayValidationError,
  validateInviteStatus,
  validateInviteSummary,
  validateInviteDetail,
  validateAcceptResponse,
  validateCreateInviteResponse,
  validateInboxResponse,
} from '../validation/inbox-validators.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const validSummary = {
  invite_id: 'inv_abc',
  from_agent_id: 'alice',
  status: 'PENDING',
  purpose_code: 'COMPATIBILITY',
  contract_hash: 'sha256:abc123',
  created_at: '2026-03-01T00:00:00Z',
  expires_at: '2026-03-08T00:00:00Z',
};

const validDetail = {
  ...validSummary,
  to_agent_id: 'bob',
  provider: 'anthropic',
  updated_at: '2026-03-01T00:00:00Z',
};

const validAccept = {
  invite_id: 'inv_abc',
  session_id: 'sess_123',
  contract_hash: 'sha256:abc123',
  responder_submit_token: 'rs_tok',
  responder_read_token: 'rr_tok',
};

const validCreate = {
  invite_id: 'inv_abc',
  contract_hash: 'sha256:abc123',
  status: 'PENDING',
  expires_at: '2026-03-08T00:00:00Z',
};

const validInbox = {
  invites: [validSummary],
  latest_event_id: 42,
};

// ── validateInviteStatus ──────────────────────────────────────────────────

describe('validateInviteStatus', () => {
  it.each(['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELED'])(
    'accepts %s',
    (status) => {
      expect(() => validateInviteStatus(status)).not.toThrow();
    },
  );

  it('rejects invalid status string', () => {
    expect(() => validateInviteStatus('UNKNOWN')).toThrow(RelayValidationError);
  });

  it('rejects number', () => {
    expect(() => validateInviteStatus(42)).toThrow(RelayValidationError);
  });

  it('rejects null', () => {
    expect(() => validateInviteStatus(null)).toThrow(RelayValidationError);
  });

  it('rejects undefined', () => {
    expect(() => validateInviteStatus(undefined)).toThrow(RelayValidationError);
  });
});

// ── validateInviteSummary ─────────────────────────────────────────────────

describe('validateInviteSummary', () => {
  it('accepts valid summary', () => {
    expect(() => validateInviteSummary(validSummary)).not.toThrow();
  });

  it('accepts summary with optional from_agent_pubkey', () => {
    expect(() =>
      validateInviteSummary({ ...validSummary, from_agent_pubkey: 'key123' }),
    ).not.toThrow();
  });

  it('accepts chrono +00:00 timestamps', () => {
    expect(() =>
      validateInviteSummary({
        ...validSummary,
        created_at: '2026-03-01T00:00:00+00:00',
        expires_at: '2026-03-08T00:00:00+00:00',
      }),
    ).not.toThrow();
  });

  it('rejects null', () => {
    expect(() => validateInviteSummary(null)).toThrow(RelayValidationError);
    expect(() => validateInviteSummary(null)).toThrow('expected object');
  });

  it('rejects array', () => {
    expect(() => validateInviteSummary([])).toThrow(RelayValidationError);
  });

  it('rejects string', () => {
    expect(() => validateInviteSummary('hello')).toThrow(RelayValidationError);
  });

  it('rejects missing invite_id', () => {
    const { invite_id, ...rest } = validSummary;
    expect(() => validateInviteSummary(rest)).toThrow('invite_id');
  });

  it('rejects missing from_agent_id', () => {
    const { from_agent_id, ...rest } = validSummary;
    expect(() => validateInviteSummary(rest)).toThrow('from_agent_id');
  });

  it('rejects missing status', () => {
    const { status, ...rest } = validSummary;
    expect(() => validateInviteSummary(rest)).toThrow('InviteStatus');
  });

  it('rejects bad status enum', () => {
    expect(() =>
      validateInviteSummary({ ...validSummary, status: 'BAD' }),
    ).toThrow(RelayValidationError);
  });

  it('rejects numeric invite_id', () => {
    expect(() =>
      validateInviteSummary({ ...validSummary, invite_id: 123 }),
    ).toThrow('must be string');
  });

  it('rejects invalid timestamp', () => {
    expect(() =>
      validateInviteSummary({ ...validSummary, created_at: 'not-a-date' }),
    ).toThrow('not a valid timestamp');
  });

  it('rejects missing created_at', () => {
    const { created_at, ...rest } = validSummary;
    expect(() => validateInviteSummary(rest)).toThrow('created_at');
  });
});

// ── validateInviteDetail ──────────────────────────────────────────────────

describe('validateInviteDetail', () => {
  it('accepts valid detail', () => {
    expect(() => validateInviteDetail(validDetail)).not.toThrow();
  });

  it('rejects missing to_agent_id', () => {
    const { to_agent_id, ...rest } = validDetail;
    expect(() => validateInviteDetail(rest)).toThrow('to_agent_id');
  });

  it('rejects missing provider', () => {
    const { provider, ...rest } = validDetail;
    expect(() => validateInviteDetail(rest)).toThrow('provider');
  });

  it('rejects missing updated_at', () => {
    const { updated_at, ...rest } = validDetail;
    expect(() => validateInviteDetail(rest)).toThrow('updated_at');
  });

  it('rejects invalid status', () => {
    expect(() =>
      validateInviteDetail({ ...validDetail, status: 'INVALID' }),
    ).toThrow(RelayValidationError);
  });

  it('rejects null', () => {
    expect(() => validateInviteDetail(null)).toThrow(RelayValidationError);
  });
});

// ── validateAcceptResponse ────────────────────────────────────────────────

describe('validateAcceptResponse', () => {
  it('accepts valid response', () => {
    expect(() => validateAcceptResponse(validAccept)).not.toThrow();
  });

  it('rejects missing session_id', () => {
    const { session_id, ...rest } = validAccept;
    expect(() => validateAcceptResponse(rest)).toThrow('session_id');
  });

  it('rejects missing responder_submit_token', () => {
    const { responder_submit_token, ...rest } = validAccept;
    expect(() => validateAcceptResponse(rest)).toThrow('responder_submit_token');
  });

  it('rejects missing responder_read_token', () => {
    const { responder_read_token, ...rest } = validAccept;
    expect(() => validateAcceptResponse(rest)).toThrow('responder_read_token');
  });

  it('rejects numeric session_id', () => {
    expect(() =>
      validateAcceptResponse({ ...validAccept, session_id: 42 }),
    ).toThrow('must be string');
  });

  it('rejects null', () => {
    expect(() => validateAcceptResponse(null)).toThrow(RelayValidationError);
  });
});

// ── validateCreateInviteResponse ──────────────────────────────────────────

describe('validateCreateInviteResponse', () => {
  it('accepts valid response', () => {
    expect(() => validateCreateInviteResponse(validCreate)).not.toThrow();
  });

  it('rejects missing invite_id', () => {
    const { invite_id, ...rest } = validCreate;
    expect(() => validateCreateInviteResponse(rest)).toThrow('invite_id');
  });

  it('rejects bad status', () => {
    expect(() =>
      validateCreateInviteResponse({ ...validCreate, status: 'NOPE' }),
    ).toThrow(RelayValidationError);
  });

  it('rejects invalid expires_at', () => {
    expect(() =>
      validateCreateInviteResponse({ ...validCreate, expires_at: 'garbage' }),
    ).toThrow('not a valid timestamp');
  });
});

// ── validateInboxResponse ─────────────────────────────────────────────────

describe('validateInboxResponse', () => {
  it('accepts valid response', () => {
    expect(() => validateInboxResponse(validInbox)).not.toThrow();
  });

  it('accepts empty invites array', () => {
    expect(() =>
      validateInboxResponse({ invites: [], latest_event_id: 0 }),
    ).not.toThrow();
  });

  it('rejects missing invites', () => {
    expect(() =>
      validateInboxResponse({ latest_event_id: 0 }),
    ).toThrow('invites');
  });

  it('rejects non-array invites', () => {
    expect(() =>
      validateInboxResponse({ invites: 'bad', latest_event_id: 0 }),
    ).toThrow('must be an array');
  });

  it('rejects null', () => {
    expect(() => validateInboxResponse(null)).toThrow(RelayValidationError);
  });

  it('rejects array input', () => {
    expect(() => validateInboxResponse([])).toThrow(RelayValidationError);
  });

  it('rejects string latest_event_id', () => {
    expect(() =>
      validateInboxResponse({ invites: [], latest_event_id: 'bad' }),
    ).toThrow('must be number');
  });

  it('validates individual invite summaries in array', () => {
    expect(() =>
      validateInboxResponse({
        invites: [{ invite_id: 'inv_1' }],
        latest_event_id: 0,
      }),
    ).toThrow('invites[0]');
  });

  it('error includes array index for bad element', () => {
    const badInbox = {
      invites: [validSummary, { invite_id: 'inv_2', status: 'BAD' }],
      latest_event_id: 1,
    };
    expect(() => validateInboxResponse(badInbox)).toThrow('invites[1]');
  });
});
