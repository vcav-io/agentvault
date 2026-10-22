/**
 * Signed agent cards carry issued_at and expires_at inside the signed payload
 * (domain VCAV-AGENT-CARD-V2:) and are used only within that window.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import {
  AGENT_CARD_LIFETIME_MS,
  AGENT_CARD_MAX_LIFETIME_MS,
  SELKEY_A2A_EXTENSION_URI,
  buildAgentCard,
  buildCardSignedPayload,
  signAgentCard,
  verifyAgentCardSignature,
  type SelkeyA2AExtensionParams,
} from '../a2a-agent-card.js';
import { DOMAIN_PREFIXES, sign, type DomainPrefix } from '../afal-signing.js';
import { AfalHttpServer } from '../afal-http-server.js';
import { AfalResponder } from '../afal-responder.js';
import { DirectAfalTransport, type AgentDescriptor } from '../direct-afal-transport.js';
import { PinStore } from '../pin-store.js';

const SEED = '03'.repeat(32);
const PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(SEED)));
const T0 = Date.parse('2026-10-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function params(issuedMs: number, expiresMs: number, extra: Partial<SelkeyA2AExtensionParams> = {}) {
  return {
    public_key_hex: PUB,
    supported_purposes: ['MEDIATION'],
    a2a_send_message_url: 'http://127.0.0.1:9/a2a/send-message',
    issued_at: new Date(issuedMs).toISOString(),
    expires_at: new Date(expiresMs).toISOString(),
    ...extra,
  } satisfies SelkeyA2AExtensionParams;
}

function signedAt(p: SelkeyA2AExtensionParams): string {
  // Sign directly over the payload, as a peer with its own clock would.
  return sign(DOMAIN_PREFIXES.AGENT_CARD, buildCardSignedPayload('bob', p) as unknown as Record<string, unknown>, SEED);
}

function descriptor(agentId: string): AgentDescriptor {
  return {
    descriptor_version: '1',
    agent_id: agentId,
    issued_at: new Date(T0).toISOString(),
    expires_at: new Date(T0 + 365 * 24 * HOUR).toISOString(),
    identity_key: { algorithm: 'ed25519', public_key_hex: PUB },
    envelope_key: { algorithm: 'ed25519', public_key_hex: PUB },
    endpoints: { propose: '', commit: '' },
    capabilities: {},
    policy_commitments: {},
  } as unknown as AgentDescriptor;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('agent card validity window', () => {
  it('accepts a card within its window', () => {
    const p = params(T0, T0 + 24 * HOUR);
    expect(verifyAgentCardSignature('bob', p, signedAt(p), PUB, T0 + HOUR)).toBe(true);
  });

  it('rejects an expired card', () => {
    const p = params(T0, T0 + 24 * HOUR);
    expect(verifyAgentCardSignature('bob', p, signedAt(p), PUB, T0 + 24 * HOUR)).toBe(false);
    expect(verifyAgentCardSignature('bob', p, signedAt(p), PUB, T0 + 25 * HOUR)).toBe(false);
  });

  it('rejects a card issued in the future beyond the allowed skew', () => {
    const near = params(T0 + 30_000, T0 + HOUR);
    expect(verifyAgentCardSignature('bob', near, signedAt(near), PUB, T0)).toBe(true);
    const far = params(T0 + 5 * 60_000, T0 + HOUR);
    expect(verifyAgentCardSignature('bob', far, signedAt(far), PUB, T0)).toBe(false);
  });

  it('rejects a card whose lifetime exceeds the maximum', () => {
    const max = params(T0, T0 + AGENT_CARD_MAX_LIFETIME_MS);
    expect(verifyAgentCardSignature('bob', max, signedAt(max), PUB, T0 + HOUR)).toBe(true);
    const tooLong = params(T0, T0 + AGENT_CARD_MAX_LIFETIME_MS + 1000);
    expect(verifyAgentCardSignature('bob', tooLong, signedAt(tooLong), PUB, T0 + HOUR)).toBe(false);
  });

  it('rejects missing, malformed or inverted timestamps', () => {
    const base = params(T0, T0 + HOUR);
    const cases: SelkeyA2AExtensionParams[] = [
      { ...base, expires_at: undefined },
      { ...base, issued_at: undefined },
      { ...base, issued_at: '2026-10-22T13:00:00+01:00' },
      { ...base, expires_at: 'tomorrow' },
      params(T0 + HOUR, T0),
      params(T0, T0),
    ];
    for (const p of cases) {
      expect(verifyAgentCardSignature('bob', p, signedAt(p), PUB, T0 + 1000)).toBe(false);
    }
    expect(() => signAgentCard('bob', { ...base, expires_at: undefined }, SEED)).toThrow(/issued_at and expires_at/);
  });

  it('rejects a card signed under the previous domain', () => {
    const p = params(T0, T0 + HOUR);
    const v1 = sign(
      'VCAV-AGENT-CARD-V1:' as DomainPrefix,
      buildCardSignedPayload('bob', p) as unknown as Record<string, unknown>,
      SEED,
    );
    expect(DOMAIN_PREFIXES.AGENT_CARD).toBe('VCAV-AGENT-CARD-V2:');
    expect(verifyAgentCardSignature('bob', p, v1, PUB, T0 + 1000)).toBe(false);
  });
});

describe('served agent card', () => {
  it('stays valid on a long-running server', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const server = new AfalHttpServer({
      port: 0,
      responder: new AfalResponder({
        agentId: 'bob',
        seedHex: SEED,
        policy: {
          trustedAgents: [],
          allowedPurposeCodes: ['MEDIATION'],
          allowedLaneIds: ['API_MEDIATED'],
          maxEntropyBits: 256,
          defaultTier: 'DENY',
        },
      }),
      localDescriptor: descriptor('bob'),
      relayUrl: 'https://relay.example.com',
      supportedPurposes: ['MEDIATION'],
      seedHex: SEED,
    });
    const check = (nowMs: number) => {
      const card = server.agentCard;
      const ext = card.capabilities.extensions.find((e) => e.uri === SELKEY_A2A_EXTENSION_URI)!;
      const p = ext.params as unknown as SelkeyA2AExtensionParams;
      expect(Date.parse(p.expires_at!) - Date.parse(p.issued_at!)).toBe(AGENT_CARD_LIFETIME_MS);
      return verifyAgentCardSignature(card.name, p, p.card_signature!, PUB, nowMs);
    };
    expect(check(T0)).toBe(true);
    // Well past the first card's expiry, the server still serves a valid card.
    vi.setSystemTime(T0 + 3 * AGENT_CARD_LIFETIME_MS);
    expect(check(T0 + 3 * AGENT_CARD_LIFETIME_MS)).toBe(true);
  });

  it('builds a card that the transport accepts (round trip)', () => {
    const card = buildAgentCard({
      baseUrl: 'http://127.0.0.1:9',
      descriptor: descriptor('bob'),
      supportedPurposes: ['MEDIATION'],
      seedHex: SEED,
      nowMs: T0,
    });
    const p = card.capabilities.extensions[0].params as unknown as SelkeyA2AExtensionParams;
    expect(verifyAgentCardSignature('bob', p, p.card_signature!, PUB, T0 + HOUR)).toBe(true);
    expect(verifyAgentCardSignature('bob', p, p.card_signature!, PUB, T0 + AGENT_CARD_LIFETIME_MS)).toBe(false);
  });
});

describe('initiator use of a peer card', () => {
  it('does not keep using a cached card after it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const card = {
      name: 'bob',
      description: 'peer',
      version: '1.0.0',
      url: 'http://peer.example.com',
      capabilities: {
        extensions: [
          {
            uri: SELKEY_A2A_EXTENSION_URI,
            description: 'x',
            required: false,
            params: (() => {
              const p = params(T0, T0 + 90_000);
              return { ...p, card_signature: signedAt(p) };
            })(),
          },
        ],
      },
      skills: [],
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/.well-known/agent-card.json')) {
        return { ok: true, status: 200, json: async () => card };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = new DirectAfalTransport({
      agentId: 'alice',
      seedHex: '04'.repeat(32),
      localDescriptor: descriptor('alice'),
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
      pinStore: PinStore.inMemory([{ agentId: 'bob', publicKeyHex: PUB }]),
    });
    expect(await transport.discoverPeerAgentCard('bob')).not.toBeNull();
    const cardFetches = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('agent-card.json')).length;
    expect(cardFetches()).toBe(1);
    // Within the card's window the cached discovery is reused.
    vi.setSystemTime(T0 + 30_000);
    expect(await transport.discoverPeerAgentCard('bob')).not.toBeNull();
    expect(cardFetches()).toBe(1);
    // After the card expires (but within the 5 minute cache), it is not reused.
    vi.setSystemTime(T0 + 120_000);
    expect(await transport.discoverPeerAgentCard('bob')).toBeNull();
    expect(cardFetches()).toBe(2);
  });
});
