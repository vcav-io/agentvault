import { describe, expect, it } from 'vitest';

import { TransportUnreachableError, isRetryableTransportError } from '../transport-errors.js';

describe('retryable transport errors', () => {
  it('is decided by error type and status, not by message text', () => {
    expect(isRetryableTransportError(new TransportUnreachableError('http://peer', new Error('x')))).toBe(true);
    expect(isRetryableTransportError(new TypeError('fetch failed'))).toBe(true);
    // Peer-chosen text in an ordinary error is never retryable.
    for (const text of ['COMMIT rejected: 500 abort', 'fetch failed', 'ECONNREFUSED', 'Relay HTTP 503: x']) {
      expect(isRetryableTransportError(new Error(text))).toBe(false);
    }
  });

  it('retries relay server errors by status code only', () => {
    const relayError = (status: number) =>
      Object.assign(new Error(`Relay HTTP ${status}: body`), { name: 'RelayHttpError', status });
    expect(isRetryableTransportError(relayError(503))).toBe(true);
    expect(isRetryableTransportError(relayError(400))).toBe(false);
  });
});
