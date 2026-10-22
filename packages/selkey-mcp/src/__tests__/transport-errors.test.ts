import { describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { TransportUnreachableError, fetchPeer, isRetryableTransportError } from '../transport-errors.js';

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

describe('fetchPeer', () => {
  it('gives up on a peer that never answers', async () => {
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer(() => {
      // Never respond.
    });
    server.on('connection', (s) => sockets.add(s));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const started = Date.now();
      const err = await fetchPeer(`http://127.0.0.1:${port}/afal/propose`, { method: 'POST', body: '{}' }, 200).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TransportUnreachableError);
      expect(isRetryableTransportError(err)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
