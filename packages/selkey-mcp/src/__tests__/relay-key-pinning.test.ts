/**
 * Relay key pinning on the client side:
 * - contracts built by this agent carry the configured relay key;
 * - the responder expects the same pinned contract;
 * - only https or loopback http relays are used.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRelayContract, computeRelayContractHash } from 'selkey/contracts';
import { createAndSubmit } from 'selkey';
import { submitInput } from 'selkey/http';
import {
  handleRelaySignal,
  _setDiscoverPollConfigForTesting,
  _setRelayPollConfigForTesting,
} from '../tools/relaySignal.js';
import { _resetHandlesForTesting } from '../tools/relayHandles.js';
import type { AfalTransport, AfalInviteMessage } from '../afal-transport.js';
import type { RelaySignalOutput } from '../tools/relaySignal.js';
import {
  assertRelayTrusted,
  getAllowedRelayUrls,
  isRelayTransportAllowed,
  isRelayUrlAllowed,
  resolveLocalRelayUrl,
  withPinnedRelayKey,
} from '../relay-trust.js';

vi.mock('selkey', () => ({
  createAndSubmit: vi.fn(),
  pollUntilDone: vi.fn(),
  joinAndWait: vi.fn(),
}));

vi.mock('selkey/http', () => ({
  submitInput: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn().mockResolvedValue({ state: 'PROCESSING' }),
  getOutput: vi.fn(),
}));

const ALICE = 'alice-demo';
const BOB = 'bob-demo';
const RELAY = 'https://relay.test';
const PINNED = '2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12';
const OTHER = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

const ENV_KEYS = [
  'SELKEY_RELAY_URL',
  'SELKEY_RELAY_ALLOWLIST',
  'SELKEY_RELAY_VERIFYING_KEY_HEX',
  'SELKEY_RELAY_ALLOW_INSECURE_HTTP',
  'SELKEY_AFAL_ALLOWED_PURPOSES',
  'SELKEY_AGENT_ID',
  'SELKEY_WORKDIR',
];
let savedEnv: Record<string, string | undefined> = {};

function stubHealth(keyHex: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ status: 'ok', verifying_key_hex: keyHex }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
  process.env['SELKEY_RELAY_URL'] = RELAY;
  process.env['SELKEY_WORKDIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'selkey-relaykey-test-'));
  _resetHandlesForTesting();
  _setDiscoverPollConfigForTesting(0, 0);
  _setRelayPollConfigForTesting(0, 0);
  vi.mocked(createAndSubmit).mockReset();
  vi.mocked(createAndSubmit).mockResolvedValue({
    sessionId: 'sess-1',
    contractHash: 'hash-1',
    initiatorReadToken: 'init-read',
    responderSubmitToken: 'resp-sub',
    responderReadToken: 'resp-read',
  } as never);
  vi.mocked(submitInput).mockClear();
});

afterEach(() => {
  const workdir = process.env['SELKEY_WORKDIR'];
  if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = savedEnv[k];
  }
  _setDiscoverPollConfigForTesting(30_000, 3_000);
  _setRelayPollConfigForTesting(25_000, 2_000);
  vi.unstubAllGlobals();
});

function initiatorTransport(): AfalTransport {
  return {
    sendPropose: vi.fn().mockResolvedValue(undefined),
    checkInbox: vi.fn().mockResolvedValue({ invites: [] }),
    peekInbox: vi.fn().mockResolvedValue({ invites: [] }),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    agentId: ALICE,
  };
}

function responderTransport(invites: AfalInviteMessage[]): AfalTransport {
  return {
    sendPropose: vi.fn(),
    checkInbox: vi.fn().mockResolvedValue({ invites }),
    peekInbox: vi.fn().mockResolvedValue({ invites }),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    agentId: BOB,
  };
}

function directInvite(contractHash: string): AfalInviteMessage {
  return {
    invite_id: 'inv-1',
    from_agent_id: ALICE,
    payload_type: 'VCAV_E_INVITE_V1',
    contract_hash: contractHash,
    payload: {
      session_id: 'sess-1',
      responder_submit_token: 'sub-tok',
      responder_read_token: 'read-tok',
      relay_url: RELAY,
    },
  };
}

function contractFor(): Record<string, unknown> {
  const c = buildRelayContract('MEDIATION', [ALICE, BOB]);
  if (!c) throw new Error('no MEDIATION template');
  return c as unknown as Record<string, unknown>;
}

async function initiate(): Promise<{ contract: Record<string, unknown> | undefined; status: string }> {
  const result = await handleRelaySignal(
    { mode: 'INITIATE', counterparty: BOB, purpose: 'MEDIATION', my_input: 'hello' },
    initiatorTransport(),
  );
  const call = vi.mocked(createAndSubmit).mock.calls[0];
  return { contract: call?.[1] as Record<string, unknown> | undefined, status: result.status };
}

describe('initiator binds contracts to the pinned relay key', () => {
  it('sets relay_verifying_key_hex from SELKEY_RELAY_VERIFYING_KEY_HEX', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = PINNED.toUpperCase();
    stubHealth(PINNED);
    const { contract } = await initiate();
    expect(contract).toBeDefined();
    expect(contract?.['relay_verifying_key_hex']).toBe(PINNED);
  });

  it('leaves the contract unchanged when no key is pinned', async () => {
    const { contract } = await initiate();
    expect(contract).toBeDefined();
    expect(contract).not.toHaveProperty('relay_verifying_key_hex');
  });

  it('refuses an explicit contract that names a different relay key', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = PINNED;
    stubHealth(PINNED);
    const result = await handleRelaySignal(
      {
        mode: 'INITIATE',
        counterparty: BOB,
        contract: { ...contractFor(), relay_verifying_key_hex: OTHER },
        my_input: 'hello',
      },
      initiatorTransport(),
    );
    expect(result.status).toBe('ERROR');
    expect(result.error?.detail).toMatch(/relay_verifying_key_hex does not match/);
    expect(createAndSubmit).not.toHaveBeenCalled();
  });

  it('CREATE mode binds the contract to the pinned relay key', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = PINNED;
    stubHealth(PINNED);
    await handleRelaySignal({ mode: 'CREATE', contract: contractFor(), my_input: 'x' });
    const sent = vi.mocked(createAndSubmit).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sent['relay_verifying_key_hex']).toBe(PINNED);
  });

  it('withPinnedRelayKey keeps a contract that already names the pinned key', () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = PINNED;
    const c = { a: 1, relay_verifying_key_hex: PINNED };
    expect(withPinnedRelayKey(c)).toBe(c);
  });
});

describe('responder expects the pinned contract', () => {
  async function respond(hash: string): Promise<RelaySignalOutput> {
    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: ALICE, expected_purpose: 'MEDIATION', my_input: 'hi' },
      responderTransport([directInvite(hash)]),
    );
    return result.data as RelaySignalOutput;
  }

  it('accepts a contract bound to its own pinned relay key', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = PINNED;
    const hash = computeRelayContractHash({ ...contractFor(), relay_verifying_key_hex: PINNED });
    const data = await respond(hash);
    expect(data.phase).toBe('JOIN');
  });

  it('rejects a contract bound to a different relay key', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = PINNED;
    const hash = computeRelayContractHash({ ...contractFor(), relay_verifying_key_hex: OTHER });
    const data = await respond(hash);
    expect(data.phase).toBe('FAILED');
    expect(data.error_code).toBe('CONTRACT_MISMATCH');
  });

  it('still accepts the unpinned contract', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = PINNED;
    const data = await respond(computeRelayContractHash(contractFor()));
    expect(data.phase).toBe('JOIN');
  });
});

describe('relay health check uses the pinned key id', () => {
  it('rejects a relay whose /health key differs from the pin', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = PINNED;
    stubHealth(OTHER);
    await expect(assertRelayTrusted(RELAY)).rejects.toThrow(/does not match SELKEY_RELAY_VERIFYING_KEY_HEX/);
  });

  it('accepts a relay serving the pinned key', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = PINNED;
    stubHealth(PINNED.toUpperCase());
    await expect(assertRelayTrusted(RELAY)).resolves.toBeUndefined();
  });
});

describe('relay transport', () => {
  it('allows https and loopback http', () => {
    for (const url of [
      'https://relay.example.com',
      'http://localhost:3100',
      'http://127.0.0.1:3100',
      'http://127.1.2.3',
      'http://[::1]:3100',
    ]) {
      expect(isRelayTransportAllowed(url)).toBe(true);
    }
  });

  it('refuses plain http to a non-loopback host', () => {
    for (const url of ['http://relay.example.com', 'http://10.0.0.5:3100', 'http://127.0.0.1.example.com']) {
      expect(isRelayTransportAllowed(url)).toBe(false);
    }
  });

  it('drops non-loopback http entries from the relay allowlist', () => {
    process.env['SELKEY_RELAY_ALLOWLIST'] = 'http://relay.example.com,http://127.0.0.1:3100';
    expect(getAllowedRelayUrls()).toEqual(['https://relay.test', 'http://127.0.0.1:3100']);
    expect(isRelayUrlAllowed('http://relay.example.com')).toBe(false);
  });

  it('refuses a non-loopback http SELKEY_RELAY_URL', async () => {
    process.env['SELKEY_RELAY_URL'] = 'http://relay.example.com';
    expect(() => resolveLocalRelayUrl()).toThrow(/plain http on a non-loopback host/);
    await expect(assertRelayTrusted('http://relay.example.com')).rejects.toThrow(
      /plain http on a non-loopback host/,
    );
  });

  it('SELKEY_RELAY_ALLOW_INSECURE_HTTP=true allows plain http', () => {
    process.env['SELKEY_RELAY_URL'] = 'http://relay:3100';
    process.env['SELKEY_RELAY_ALLOW_INSECURE_HTTP'] = 'true';
    expect(resolveLocalRelayUrl()).toBe('http://relay:3100');
    expect(isRelayUrlAllowed('http://relay:3100')).toBe(true);
  });
});
