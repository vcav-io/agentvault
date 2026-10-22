/**
 * Requests to peers are bounded: a time limit that covers the body, no
 * redirects, a response size limit, and endpoints only on the configured peer
 * origin (or an explicitly allowed one).
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { ResponseTooLargeError, UnexpectedRedirectError } from 'selkey/fetch';

import { buildAgentCard } from '../a2a-agent-card.js';
import { DOMAIN_PREFIXES, signMessage } from '../afal-signing.js';
import { DirectAfalTransport, type AgentDescriptor } from '../direct-afal-transport.js';
import { PeerEndpointError, assertPeerEndpointAllowed } from '../peer-endpoints.js';
import { PinStore } from '../pin-store.js';
import {
  TransportUnreachableError,
  fetchPeer,
  isRetryableTransportError,
} from '../transport-errors.js';

const SEED = '07'.repeat(32);
const PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(SEED)));

let server: Server;
let base: string;
let landingHits = 0;

function handler(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '';
  if (path === '/landing') {
    landingHits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  } else if (path === '/redirect') {
    res.writeHead(307, { Location: `${base}/landing` });
    res.end();
  } else if (path === '/huge') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const chunk = 'x'.repeat(256 * 1024);
    let sent = 0;
    const pump = (): void => {
      while (sent < 16) {
        sent++;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  } else if (path === '/stall') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"outcome":');
  } else {
    res.writeHead(404);
    res.end();
  }
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPeer bounds', () => {
  it('gives up on a peer whose response body never completes', async () => {
    const started = Date.now();
    const err = await fetchPeer(`${base}/stall`, { method: 'POST', body: '{}' }, 150).catch((e) => e);
    expect(err).toBeInstanceOf(TransportUnreachableError);
    expect((err as Error & { cause?: Error }).cause?.name).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not follow a redirect from a peer', async () => {
    landingHits = 0;
    const err = await fetchPeer(`${base}/redirect`, { method: 'POST', body: '{}' }).catch((e) => e);
    expect(err).toBeInstanceOf(UnexpectedRedirectError);
    expect(isRetryableTransportError(err)).toBe(false);
    expect(landingHits).toBe(0);
  });

  it('refuses a peer response over the size limit', async () => {
    const err = await fetchPeer(`${base}/huge`).catch((e) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect(isRetryableTransportError(err)).toBe(false);
  });
});

function descriptorFor(endpoints: AgentDescriptor['endpoints']): AgentDescriptor {
  const now = Date.now();
  return {
    descriptor_version: '1',
    agent_id: 'bob',
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    identity_key: { algorithm: 'ed25519', public_key_hex: PUB },
    envelope_key: { algorithm: 'ed25519', public_key_hex: PUB },
    endpoints,
    capabilities: {},
    policy_commitments: {},
  };
}

function stubPeer(responses: { card?: unknown; descriptor?: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith('/.well-known/agent-card.json') && responses.card) {
      return new Response(JSON.stringify(responses.card), { status: 200 });
    }
    if (String(url).endsWith('/afal/descriptor') && responses.descriptor) {
      return new Response(JSON.stringify(responses.descriptor), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  return calls;
}

function initiator(extra: { peerEndpointOrigins?: string[] } = {}): DirectAfalTransport {
  return new DirectAfalTransport({
    agentId: 'alice',
    seedHex: '08'.repeat(32),
    localDescriptor: descriptorFor({ propose: '', commit: '' }),
    peerDescriptorUrl: 'https://bob.example.com/afal/descriptor',
    pinStore: PinStore.inMemory([{ agentId: 'bob', publicKeyHex: PUB }]),
    ...extra,
  });
}

describe('peer endpoint origin', () => {
  it('rejects a signed agent card whose endpoints are on another origin', async () => {
    const card = buildAgentCard({
      baseUrl: 'http://169.254.169.254',
      descriptor: descriptorFor({ propose: '', commit: '' }),
      supportedPurposes: ['MEDIATION'],
      seedHex: SEED,
    });
    const calls = stubPeer({ card });
    await expect(initiator().discoverPeerAgentCard('bob')).rejects.toBeInstanceOf(PeerEndpointError);
    expect(calls.every((u) => u.startsWith('https://bob.example.com/'))).toBe(true);
  });

  it('accepts a signed agent card whose endpoints are on the configured origin', async () => {
    const card = buildAgentCard({
      baseUrl: 'https://bob.example.com',
      descriptor: descriptorFor({ propose: '', commit: '' }),
      supportedPurposes: ['MEDIATION'],
      seedHex: SEED,
    });
    stubPeer({ card });
    const discovery = await initiator().discoverPeerAgentCard('bob');
    expect(discovery?.a2aSendMessageUrl).toBe('https://bob.example.com/a2a/send-message');
  });

  it('accepts another origin when it is explicitly allowed', async () => {
    const card = buildAgentCard({
      baseUrl: 'https://afal.bob.example.com:9443',
      descriptor: descriptorFor({ propose: '', commit: '' }),
      supportedPurposes: ['MEDIATION'],
      seedHex: SEED,
    });
    stubPeer({ card });
    const transport = initiator({ peerEndpointOrigins: ['https://afal.bob.example.com:9443'] });
    const discovery = await transport.discoverPeerAgentCard('bob');
    expect(discovery?.afalEndpoint).toBe('https://afal.bob.example.com:9443/afal');
  });

  it('rejects a signed descriptor whose endpoints are on another origin', async () => {
    const descriptor = signMessage(
      DOMAIN_PREFIXES.DESCRIPTOR,
      descriptorFor({
        propose: 'http://10.0.0.5/afal/propose',
        commit: 'http://10.0.0.5/afal/commit',
      }) as unknown as Record<string, unknown>,
      SEED,
    );
    const calls = stubPeer({ descriptor });
    await expect(initiator().discoverPeerAgentCard('bob')).rejects.toBeInstanceOf(PeerEndpointError);
    expect(calls.some((u) => u.includes('10.0.0.5'))).toBe(false);
  });
});

describe('assertPeerEndpointAllowed', () => {
  const anchorUrl = 'http://127.0.0.1:3201/afal/descriptor';

  it('allows loopback spellings of a loopback peer only in development', () => {
    expect(() =>
      assertPeerEndpointAllowed('http://localhost:3201/afal/propose', { anchorUrl, allowedOrigins: [], allowLoopback: false }),
    ).toThrow(PeerEndpointError);
    expect(() =>
      assertPeerEndpointAllowed('http://localhost:3201/afal/propose', { anchorUrl, allowedOrigins: [], allowLoopback: true }),
    ).not.toThrow();
  });

  it('never treats a non-loopback endpoint as loopback', () => {
    expect(() =>
      assertPeerEndpointAllowed('http://169.254.169.254/afal/propose', { anchorUrl, allowedOrigins: [], allowLoopback: true }),
    ).toThrow(PeerEndpointError);
  });

  it('rejects credentials and non-http schemes even on the configured origin', () => {
    const policy = { anchorUrl, allowedOrigins: [], allowLoopback: false };
    expect(() => assertPeerEndpointAllowed('http://u:p@127.0.0.1:3201/afal/propose', policy)).toThrow(PeerEndpointError);
    expect(() => assertPeerEndpointAllowed('file:///etc/passwd', policy)).toThrow(PeerEndpointError);
  });
});
