import { describe, expect, it } from 'vitest';
import { isLocalDemoRelay, resolveDemoRelayPin } from './relay-pin.js';

const KEY = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const health = (key: string) => ({ verifying_key_hex: key });

describe('demo relay key pin', () => {
  it('uses a configured key', () => {
    expect(
      resolveDemoRelayPin({
        configured: KEY.toUpperCase(),
        current: undefined,
        relayUrl: 'https://relay.example.com',
        health: health(OTHER),
        insecureHosts: undefined,
      }),
    ).toEqual({ keyHex: KEY, source: 'configured' });
  });

  it('pins the key a loopback or compose-internal relay serves', () => {
    for (const [relayUrl, hosts] of [
      ['http://localhost:3100', undefined],
      ['http://127.0.0.1:3100', undefined],
      ['http://[::1]:3100', undefined],
      ['http://relay:3100', 'relay'],
    ] as const) {
      expect(
        resolveDemoRelayPin({ configured: undefined, current: undefined, relayUrl, health: health(KEY), insecureHosts: hosts }),
      ).toEqual({ keyHex: KEY, source: 'local-relay' });
    }
  });

  it('requires a configured key for a relay that is not local', () => {
    expect(() =>
      resolveDemoRelayPin({
        configured: undefined,
        current: undefined,
        relayUrl: 'https://relay.example.com',
        health: health(KEY),
        insecureHosts: undefined,
      }),
    ).toThrow(/SELKEY_RELAY_VERIFYING_KEY_HEX/);
    expect(isLocalDemoRelay('http://user@localhost:3100', undefined)).toBe(false);
    expect(isLocalDemoRelay('http://relay:3100', undefined)).toBe(false);
  });

  it('keeps the first pin when the local relay key changes', () => {
    expect(() =>
      resolveDemoRelayPin({
        configured: undefined,
        current: { keyHex: KEY, source: 'local-relay' },
        relayUrl: 'http://localhost:3100',
        health: health(OTHER),
        insecureHosts: undefined,
      }),
    ).toThrow(/different verifying key/);
  });

  it('refuses a /health response without a valid key', () => {
    expect(() =>
      resolveDemoRelayPin({
        configured: undefined,
        current: undefined,
        relayUrl: 'http://localhost:3100',
        health: {},
        insecureHosts: undefined,
      }),
    ).toThrow(/verifying_key_hex/);
  });
});
