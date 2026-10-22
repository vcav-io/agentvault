import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseJsonStrict } from '../jcs-v3.js';
import { fetchRelayPublicKey, relayKeyId } from '../verify-receipt.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vectors: any = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../test-vectors/selkey/relay_key_id.json'), 'utf8'),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const relayFixture: any = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../test-vectors/relay/relay_receipts.json'), 'utf8'),
);

const PINNED = relayFixture.relay_verifying_key_hex as string;
const OTHER = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

function mockHealth(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relayKeyId', () => {
  for (const c of vectors.cases) {
    it(`matches the vector for ${c.public_key_hex.slice(0, 8)}…`, () => {
      expect(relayKeyId(c.public_key_hex)).toBe(c.key_id);
    });
  }

  it('equals "ed25519:" + operator_key_fingerprint of relay-produced receipts', () => {
    for (const c of relayFixture.cases) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = parseJsonStrict(c.output_response_json) as any;
      expect(relayKeyId(PINNED)).toBe(`ed25519:${response.receipt.operator.operator_key_fingerprint}`);
    }
  });

  it('rejects keys that are not 32 bytes of hex', () => {
    expect(() => relayKeyId('ab')).toThrow();
    expect(() => relayKeyId('z'.repeat(64))).toThrow();
  });
});

describe('fetchRelayPublicKey', () => {
  it('returns the served key when it matches the expected key id', async () => {
    mockHealth({ verifying_key_hex: PINNED.toUpperCase() });
    await expect(fetchRelayPublicKey('http://127.0.0.1:3100', relayKeyId(PINNED))).resolves.toBe(PINNED);
  });

  it('accepts the pinned key hex in place of its key id', async () => {
    mockHealth({ verifying_key_hex: PINNED });
    await expect(fetchRelayPublicKey('http://127.0.0.1:3100/', PINNED)).resolves.toBe(PINNED);
  });

  it('throws when the served key differs from the expected key', async () => {
    mockHealth({ verifying_key_hex: OTHER });
    await expect(fetchRelayPublicKey('http://127.0.0.1:3100', relayKeyId(PINNED))).rejects.toThrow(
      /does not match the expected key/,
    );
  });

  it('requires an expected key id', async () => {
    const fetchMock = mockHealth({ verifying_key_hex: PINNED });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((fetchRelayPublicKey as any)('http://127.0.0.1:3100')).rejects.toThrow(
      /expected relay key id/,
    );
    await expect(fetchRelayPublicKey('http://127.0.0.1:3100', 'sha256:abc')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a malformed served key', async () => {
    mockHealth({ verifying_key_hex: 'abc' });
    await expect(fetchRelayPublicKey('http://127.0.0.1:3100', PINNED)).rejects.toThrow(
      /valid verifying_key_hex/,
    );
  });
});
