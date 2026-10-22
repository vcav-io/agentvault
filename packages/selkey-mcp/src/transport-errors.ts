/**
 * Structured transport failures.
 *
 * Whether an operation may be retried is decided from error TYPES and status
 * codes only, never from error message text: messages can embed response
 * bodies chosen by a peer or relay.
 */

/** A request to a peer did not get an HTTP response (network failure or timeout). */
export class TransportUnreachableError extends Error {
  constructor(target: string, cause: unknown) {
    super(`Could not reach ${target}`, { cause });
    this.name = 'TransportUnreachableError';
  }
}

/** Default limit for one request to a peer, including reading its body. */
export const PEER_FETCH_TIMEOUT_MS = 10_000;

/** A signal that aborts after `timeoutMs`, or when `signal` does. */
export function peerTimeoutSignal(timeoutMs: number = PEER_FETCH_TIMEOUT_MS, signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * fetch() wrapper: a rejected fetch (no HTTP response) becomes
 * TransportUnreachableError; HTTP responses are returned as-is. The request,
 * including reading the response body, is aborted after `timeoutMs`.
 */
export async function fetchPeer(
  url: string,
  init?: RequestInit,
  timeoutMs: number = PEER_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: peerTimeoutSignal(timeoutMs, init?.signal) });
  } catch (err) {
    throw new TransportUnreachableError(safeOrigin(url), err);
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'peer';
  }
}

/**
 * True for failures where no request reached a counterparty or relay, or the
 * relay reported a server error by status code:
 * - TransportUnreachableError;
 * - a TypeError thrown by fetch itself (no HTTP response);
 * - an AbortError / TimeoutError from a local timeout;
 * - a relay client error (name "RelayHttpError") with status >= 500.
 */
export function isRetryableTransportError(err: unknown): boolean {
  if (err instanceof TransportUnreachableError) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  if (err instanceof TypeError && err.message === 'fetch failed') return true;
  if (err.name === 'RelayHttpError') {
    const status = (err as Error & { status?: unknown }).status;
    return typeof status === 'number' && status >= 500;
  }
  return false;
}

/** HTTP status of a relay client error, if any. */
export function relayHttpStatus(err: unknown): number | undefined {
  if (err instanceof Error && err.name === 'RelayHttpError') {
    const status = (err as Error & { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}
