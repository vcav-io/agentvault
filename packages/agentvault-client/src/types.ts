/**
 * Types for the AgentVault relay client.
 *
 * No imports from orchestrator, AFAL, vault-runtime, or autopilot.
 * This module is a standalone client boundary.
 */

/** Wire format matches Rust `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]`. */
export type SessionState =
  | 'CREATED'
  | 'PARTIAL'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'ABORTED';

/** Wire format matches Rust `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]`. */
export type AbortReason =
  | 'TIMEOUT'
  | 'SCHEMA_VALIDATION'
  | 'PROVIDER_ERROR'
  | 'CONTRACT_MISMATCH';

export interface RelayClientConfig {
  relay_url: string;
  timeout_ms?: number;
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

export interface SessionOutputResponse {
  state: SessionState;
  abort_reason?: AbortReason;
  output?: unknown;
  receipt?: Receipt;
  receipt_signature?: string;
}
