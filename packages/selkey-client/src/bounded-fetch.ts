/**
 * Outbound HTTP with fixed bounds.
 *
 * Every request made through `boundedFetch`:
 * - is aborted after a time limit that also covers reading the body;
 * - never follows redirects (a 3xx response is an error, so a request and its
 *   headers only ever reach the URL the caller chose);
 * - reads at most `maxBytes` of response body.
 *
 * The body is read in full before returning, so the returned Response can be
 * consumed with `.json()` / `.text()` without further limits.
 */

/** Default time limit for one request, including reading its body. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Default response body limit (8 MiB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** The response body was larger than the configured limit. */
export class ResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Response body exceeds ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/** The server answered with a redirect, which is never followed. */
export class UnexpectedRedirectError extends Error {
  constructor(public readonly status: number) {
    super(`Unexpected redirect (HTTP ${status})`);
    this.name = 'UnexpectedRedirectError';
  }
}

export interface BoundedFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Read a response body, failing once more than `maxBytes` have arrived.
 * A declared Content-Length over the limit fails before reading.
 */
export async function readBodyLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = res.headers?.get('content-length');
  if (declared !== null && declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!res.body) {
    return new Uint8Array(0);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Statuses whose Response may not carry a body. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * fetch() with a time limit, no redirects and a response size limit. Returns
 * a Response whose body has already been read (within the limit).
 */
export async function boundedFetch(
  url: string,
  init: RequestInit = {},
  opts: BoundedFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

  const res = await fetch(url, { ...init, redirect: 'manual', signal });
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
    await res.body?.cancel().catch(() => {});
    throw new UnexpectedRedirectError(res.status);
  }
  if (!res.body) return res; // nothing to read
  const body = await readBodyLimited(res, maxBytes);
  return new Response(NULL_BODY_STATUS.has(res.status) ? null : body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
