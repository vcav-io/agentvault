import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  boundedFetch,
  ResponseTooLargeError,
  UnexpectedRedirectError,
} from '../bounded-fetch.js';
import { createSession, getStatus } from '../http.js';
import { pollInbox, RelayTimeoutError } from '../inbox.js';
import { fetchRelayPublicKey, relayKeyId } from '../verify-receipt.js';

const KEY = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

let server: Server;
let base: string;
const seen: Array<{ url: string; auth: string | undefined }> = [];

function handler(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '').split('?')[0];
  if (path.startsWith('/landing')) {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'PARTIAL', invites: [] }));
    return;
  }
  if (path.startsWith('/redirect')) {
    res.writeHead(302, { Location: `${base}/landing` });
    res.end();
    return;
  }
  if (path.startsWith('/huge-stream')) {
    // No Content-Length: the limit must be enforced while reading.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const chunk = 'x'.repeat(64 * 1024);
    let sent = 0;
    const pump = (): void => {
      while (sent < 64) {
        sent++;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
    return;
  }
  if (path.startsWith('/huge-declared')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(16 * 1024 * 1024) });
    res.write('{');
    return; // never completes; the declared length alone must be refused
  }
  if (path.startsWith('/stall-body')) {
    // Headers arrive at once; the body never finishes.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"state":');
    return;
  }
  if (path.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ verifying_key_hex: KEY, pad: 'p'.repeat(128 * 1024) }));
    return;
  }
  res.writeHead(404);
  res.end();
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('boundedFetch', () => {
  it('returns a readable response within the limits', async () => {
    const res = await boundedFetch(`${base}/landing`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'PARTIAL' });
  });

  it('does not follow redirects', async () => {
    await expect(boundedFetch(`${base}/redirect`)).rejects.toBeInstanceOf(UnexpectedRedirectError);
  });

  it('refuses a streamed body over the size limit', async () => {
    await expect(
      boundedFetch(`${base}/huge-stream`, {}, { maxBytes: 1024 * 1024 }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('refuses a declared Content-Length over the size limit', async () => {
    await expect(
      boundedFetch(`${base}/huge-declared`, {}, { maxBytes: 1024 * 1024 }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('applies the time limit while reading the body', async () => {
    await expect(boundedFetch(`${base}/stall-body`, {}, { timeoutMs: 100 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });
});

describe('relay client requests', () => {
  it('does not follow a redirect on a token-carrying request', async () => {
    seen.length = 0;
    await expect(
      getStatus({ relay_url: `${base}/redirect` }, 'sess', 'read-token'),
    ).rejects.toBeInstanceOf(UnexpectedRedirectError);
    expect(seen).toHaveLength(0);
  });

  it('does not follow a redirect when creating a session with an operator token', async () => {
    seen.length = 0;
    await expect(
      createSession({ relay_url: `${base}/redirect`, operator_token: 'op-token-0123456789' }, {}),
    ).rejects.toBeInstanceOf(UnexpectedRedirectError);
    expect(seen).toHaveLength(0);
  });

  it('refuses a relay response over max_response_bytes', async () => {
    await expect(
      getStatus({ relay_url: `${base}/huge-stream`, max_response_bytes: 1024 * 1024 }, 's', 't'),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('times out a relay response whose body never completes', async () => {
    await expect(
      getStatus({ relay_url: `${base}/stall-body`, timeout_ms: 100 }, 's', 't'),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('reports a stalled inbox body as a relay timeout', async () => {
    await expect(
      pollInbox({ relay_url: `${base}/stall-body`, timeout_ms: 100 }, 'inbox-token'),
    ).rejects.toBeInstanceOf(RelayTimeoutError);
  });

  it('does not follow a redirect on an inbox request', async () => {
    seen.length = 0;
    await expect(pollInbox({ relay_url: `${base}/redirect` }, 'inbox-token')).rejects.toBeInstanceOf(
      UnexpectedRedirectError,
    );
    expect(seen).toHaveLength(0);
  });

  it('caps the /health response read by fetchRelayPublicKey', async () => {
    await expect(fetchRelayPublicKey(base, relayKeyId(KEY))).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });
});
