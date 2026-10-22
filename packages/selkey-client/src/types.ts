/**
 * Types for the Selkey relay client.
 *
 * No imports from orchestrator, AFAL, vault-runtime, or autopilot.
 * This module is a standalone client boundary.
 */

/** Wire format matches Rust `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]`. */
export type SessionState = 'CREATED' | 'PARTIAL' | 'PROCESSING' | 'COMPLETED' | 'ABORTED';

/** Wire format matches Rust `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]`. */
export type AbortReason = 'TIMEOUT' | 'SCHEMA_VALIDATION' | 'PROVIDER_ERROR' | 'CONTRACT_MISMATCH' | 'POLICY_GATE';

export interface RelayClientConfig {
  relay_url: string;
  timeout_ms?: number;
  /**
   * Operator bearer token for relays that run with SELKEY_OPERATOR_TOKEN.
   * Sent as `Authorization: Bearer <token>` on session creation
   * (POST /sessions). It is never included in errors or logs.
   */
  operator_token?: string;
}

export interface CreateSessionRequest {
  contract: object;
  provider?: string;
}

export interface CreateSessionResponse {
  session_id: string;
  contract_hash: string;
  initiator_submit_token: string;
  initiator_read_token: string;
  responder_submit_token: string;
  responder_read_token: string;
}

export interface SessionStatusResponse {
  state: SessionState;
  abort_reason?: AbortReason;
}

export interface Receipt {
  [key: string]: unknown;
}

/** POST /sessions/:id/input request body. */
export interface SubmitInputRequest {
  /** Ignored by the relay (the role comes from the submit token). */
  role: string;
  context: unknown;
  /**
   * Required. A fresh 32-byte nonce from the client CSPRNG, as 64 lowercase
   * hex characters. The relay uses it for the receipt's input commitment and
   * never returns it.
   */
  commitment_nonce: string;
  expected_contract_hash?: string;
}

export interface SessionOutputResponse {
  state: SessionState;
  abort_reason?: AbortReason;
  output?: unknown;
  /** Signed receipt. Current relays emit receipt v3 (`receipt_schema_version` "3.0.0"). */
  receipt?: Receipt | null;
  /** Earlier relays only: v1 receipt signature. */
  receipt_signature?: string | null;
  /** Earlier relays only: v2 receipt. */
  receipt_v2?: Record<string, unknown> | null;
}

// ── Inbox Types ──────────────────────────────────────────────────────────

/** Wire format matches Rust `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]`. */
export type InviteStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CANCELED';

export type DeclineReasonCode = 'BUSY' | 'NOT_INTERESTED' | 'INVALID' | 'OTHER';

export interface InviteSummary {
  invite_id: string;
  from_agent_id: string;
  from_agent_pubkey?: string;
  status: InviteStatus;
  purpose_code: string;
  contract_hash: string;
  created_at: string;
  expires_at: string;
}

export interface InviteDetailResponse {
  invite_id: string;
  from_agent_id: string;
  to_agent_id: string;
  from_agent_pubkey?: string;
  status: InviteStatus;
  purpose_code: string;
  contract_hash: string;
  /** Full proposed contract — enables structured confirmation. */
  contract_json: Record<string, unknown>;
  provider: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  decline_reason_code?: DeclineReasonCode;
  session_id?: string;
  submit_token?: string;
  read_token?: string;
}

export interface InboxResponse {
  invites: InviteSummary[];
  latest_event_id: number;
}

export interface CreateInviteRequest {
  to_agent_id: string;
  contract: object;
  provider?: string;
  purpose_code: string;
  from_agent_pubkey?: string;
}

export interface CreateInviteResponse {
  invite_id: string;
  contract_hash: string;
  status: InviteStatus;
  expires_at: string;
}

export interface AcceptInviteRequest {
  expected_contract_hash?: string;
}

export interface AcceptInviteResponse {
  invite_id: string;
  session_id: string;
  contract_hash: string;
  responder_submit_token: string;
  responder_read_token: string;
}

export interface DeclineInviteRequest {
  reason_code?: DeclineReasonCode;
}

export interface InboxQuery {
  status?: InviteStatus;
  from_agent_id?: string;
  limit?: number;
}
