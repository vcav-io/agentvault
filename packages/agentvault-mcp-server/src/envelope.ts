/**
 * Constant-shape response envelope for MCP tools.
 * All fields are always present; unused fields are set to null.
 */

export type StatusCode =
  | 'SUCCESS'
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'WAITING'
  | 'SEALED'
  | 'RUNNING'
  | 'EXECUTING'
  | 'COMPLETE'
  | 'BLOCKED'
  | 'ERROR';

export type ErrorCode =
  | 'INVITE_TIMEOUT'
  | 'COUNTERPARTY_UNREACHABLE'
  | 'INVALID_INPUT'
  | 'SESSION_ERROR'
  | 'ENCRYPTION_FAILED'
  | 'VERIFICATION_FAILED'
  | 'PRECONDITION_FAILED'
  | 'MODEL_NOT_PROMOTED'
  | 'CONTRACT_DEPRECATED'
  | 'GRANT_EXPIRED'
  | 'AUDIENCE_MISMATCH'
  | 'SCOPE_MISMATCH'
  | 'PURPOSE_MISMATCH'
  | 'LABEL_CEILING_EXCEEDED'
  | 'USE_LIMIT_EXCEEDED'
  | 'CONTRACT_MISMATCH'
  | 'GRANT_REGISTRY_FULL'
  | 'UNKNOWN_ERROR';

export interface ToolError {
  code: ErrorCode;
  detail: string;
  retryable?: boolean;
}

export interface ToolResponse<T = unknown> {
  ok: boolean;
  status: StatusCode;
  data: T | null;
  error: ToolError | null;
}

/**
 * Build a success response with constant shape
 */
export function buildSuccess<T>(
  status: StatusCode,
  data: T
): ToolResponse<T> {
  return {
    ok: true,
    status,
    data,
    error: null,
  };
}

const RETRYABLE_BY_DEFAULT: Record<ErrorCode, boolean> = {
  COUNTERPARTY_UNREACHABLE: true,
  INVITE_TIMEOUT: false,
  INVALID_INPUT: false,
  SESSION_ERROR: false,
  ENCRYPTION_FAILED: false,
  VERIFICATION_FAILED: false,
  PRECONDITION_FAILED: false,
  MODEL_NOT_PROMOTED: false,
  CONTRACT_DEPRECATED: false,
  GRANT_EXPIRED: false,
  AUDIENCE_MISMATCH: false,
  SCOPE_MISMATCH: false,
  PURPOSE_MISMATCH: false,
  LABEL_CEILING_EXCEEDED: false,
  USE_LIMIT_EXCEEDED: false,
  CONTRACT_MISMATCH: false,
  GRANT_REGISTRY_FULL: false,
  UNKNOWN_ERROR: false,
};

/**
 * Build an error response with constant shape
 */
export function buildError(
  code: ErrorCode,
  detail: string,
  retryable?: boolean
): ToolResponse<never> {
  return {
    ok: false,
    status: 'ERROR',
    data: null,
    error: { code, detail, retryable: retryable ?? RETRYABLE_BY_DEFAULT[code] },
  };
}
