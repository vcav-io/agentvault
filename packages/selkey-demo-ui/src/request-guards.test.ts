import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAllowedHosts, createRequestGuards, isAllowedHost } from './request-guards.js';

let server: http.Server;
let port: number;

function request(opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

beforeAll(async () => {
  const app = express();
  // Port is unknown until listen; build guards lazily per request.
  app.use((req, res, next) => {
    const guards = createRequestGuards(
      buildAllowedHosts({ port, bindAddress: '127.0.0.1', extraHosts: 'demo.internal,box.lan:8080' }),
    );
    guards.hostGuard(req, res, () => guards.sameOriginGuard(req, res, next));
  });
  app.use(express.json());
  app.get('/api/status', (_req, res) => res.json({ ok: true }));
  app.post('/api/reset', (_req, res) => res.json({ ok: true }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

const json = (host: string, extra: Record<string, string> = {}) => ({
  Host: host,
  'Content-Type': 'application/json',
  'X-Selkey-Demo-Request': '1',
  ...extra,
});

describe('demo Host header validation', () => {
  it('serves loopback hosts on the demo port', async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
      expect(await request({ method: 'GET', path: '/api/status', headers: { Host: host } })).toBe(200);
    }
  });

  it('serves configured extra hosts', async () => {
    expect(await request({ method: 'GET', path: '/api/status', headers: { Host: `demo.internal:${port}` } })).toBe(200);
    expect(isAllowedHost('box.lan:8080', buildAllowedHosts({ port, extraHosts: 'box.lan:8080' }))).toBe(true);
  });

  it('refuses other hosts, other ports and a missing Host', async () => {
    expect(await request({ method: 'GET', path: '/api/status', headers: { Host: `other-host.example:${port}` } })).toBe(421);
    expect(await request({ method: 'GET', path: '/api/status', headers: { Host: 'localhost:1' } })).toBe(421);
    expect(await request({ method: 'GET', path: '/api/status', headers: { Host: 'localhost' } })).toBe(421);
    expect(isAllowedHost(undefined, buildAllowedHosts({ port }))).toBe(false);
  });

  it('refuses state-changing requests for other hosts even with the marker header', async () => {
    expect(
      await request({ method: 'POST', path: '/api/reset', headers: json(`other-host.example:${port}`), body: '{}' }),
    ).toBe(421);
  });
});

describe('demo same-origin checks on POST', () => {
  it('accepts a marked JSON request from the demo page', async () => {
    const host = `127.0.0.1:${port}`;
    expect(
      await request({
        method: 'POST',
        path: '/api/reset',
        headers: json(host, { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' }),
        body: '{}',
      }),
    ).toBe(200);
  });

  it('refuses a request without the marker header', async () => {
    const host = `127.0.0.1:${port}`;
    expect(
      await request({
        method: 'POST',
        path: '/api/reset',
        headers: { Host: host, 'Content-Type': 'application/json' },
        body: '{}',
      }),
    ).toBe(403);
  });

  it('refuses a simple form-encoded request', async () => {
    const host = `127.0.0.1:${port}`;
    expect(
      await request({
        method: 'POST',
        path: '/api/reset',
        headers: { Host: host, 'Content-Type': 'text/plain', 'X-Selkey-Demo-Request': '1' },
        body: '{}',
      }),
    ).toBe(403);
  });

  it('refuses a foreign Origin or a cross-site fetch', async () => {
    const host = `127.0.0.1:${port}`;
    expect(
      await request({
        method: 'POST',
        path: '/api/reset',
        headers: json(host, { Origin: 'http://other-host.example' }),
        body: '{}',
      }),
    ).toBe(403);
    expect(
      await request({
        method: 'POST',
        path: '/api/reset',
        headers: json(host, { 'Sec-Fetch-Site': 'cross-site' }),
        body: '{}',
      }),
    ).toBe(403);
  });
});
