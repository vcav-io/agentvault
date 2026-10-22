/**
 * relay_signal charges the owner-side disclosure budget before this agent's
 * input is submitted, and refuses to submit when a budget would be exceeded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRelayContract, computeRelayContractHash } from 'selkey/contracts';

const { mockCreateAndSubmit, mockJoinAndWait, mockPollUntilDone } = vi.hoisted(() => ({
  mockCreateAndSubmit: vi.fn(),
  mockJoinAndWait: vi.fn(),
  mockPollUntilDone: vi.fn(),
}));
vi.mock('selkey', () => ({
  createAndSubmit: mockCreateAndSubmit,
  pollUntilDone: mockPollUntilDone,
  joinAndWait: mockJoinAndWait,
}));
vi.mock('selkey/http', () => ({
  submitInput: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn().mockResolvedValue({ state: 'PROCESSING' }),
  getOutput: vi.fn().mockResolvedValue({ state: 'PROCESSING' }),
}));

import {
  handleRelaySignal,
  _setDiscoverPollConfigForTesting,
  _setRelayPollConfigForTesting,
} from '../tools/relaySignal.js';
import { _resetHandlesForTesting, decodeRelayToken } from '../tools/relayHandles.js';
import type { AfalTransport } from '../afal-transport.js';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { submitInput } from 'selkey/http';
import { DirectAfalTransport, type AgentDescriptor } from '../direct-afal-transport.js';
import { PinStore } from '../pin-store.js';
import { DOMAIN_PREFIXES, signMessage } from '../afal-signing.js';
import { listKnownModelProfiles } from '../model-profiles.js';
import { listSupportedContractOffers } from '../contract-offers.js';

const ENV_KEYS = [
  'SELKEY_WORKDIR',
  'SELKEY_RELAY_URL',
  'SELKEY_AGENT_ID',
  'SELKEY_RELAY_VERIFYING_KEY_HEX',
  'SELKEY_ENTROPY_LEDGER',
  'SELKEY_ENTROPY_BUDGET_PER_COUNTERPARTY_BITS',
  'SELKEY_ENTROPY_BUDGET_GLOBAL_BITS',
  'SELKEY_ENTROPY_BUDGET_WINDOW_SECONDS',
  'SELKEY_ENV',
  'SELKEY_OPERATOR_TOKEN',
  'SELKEY_RELAY_ALLOWLIST',
];
let saved: Record<string, string | undefined> = {};
let tmp: string;

function transport(): AfalTransport {
  return {
    agentId: 'alice-demo',
    sendPropose: vi.fn().mockResolvedValue(undefined),
    checkInbox: vi.fn().mockResolvedValue({ invites: [] }),
    peekInbox: vi.fn().mockResolvedValue({ invites: [] }),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
  };
}

function ledgerEntries(): Array<{ key: string; counterparty: string; bits: number }> {
  const file = path.join(tmp, '.selkey', 'budget-ledger.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).entries : [];
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selkey-ledger-relay-'));
  process.env['SELKEY_WORKDIR'] = tmp;
  process.env['SELKEY_RELAY_URL'] = 'https://relay.test';
  process.env['SELKEY_AGENT_ID'] = 'alice-demo';
  process.env['SELKEY_ENTROPY_LEDGER'] = 'enforce';
  process.env['SELKEY_ENV'] = 'dev';
  _resetHandlesForTesting();
  _setDiscoverPollConfigForTesting(0, 0);
  _setRelayPollConfigForTesting(0, 0);
  mockCreateAndSubmit.mockReset().mockResolvedValue({
    sessionId: 'sess-1',
    contractHash: 'h'.repeat(64),
    initiatorReadToken: 'ir',
    responderSubmitToken: 'rs',
    responderReadToken: 'rr',
  });
  mockJoinAndWait.mockReset();
  mockPollUntilDone.mockReset();
  vi.mocked(submitInput).mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = saved[k];
  }
  _setDiscoverPollConfigForTesting(30_000, 3_000);
  _setRelayPollConfigForTesting(25_000, 2_000);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('relay_signal owner-side disclosure budget', () => {
  it('charges the counterparty before the initiator submits its input', async () => {
    const result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport(),
    );
    expect(result.ok).toBe(true);
    expect(mockCreateAndSubmit).toHaveBeenCalledTimes(1);
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ counterparty: 'bob-demo', bits: 12, purpose: 'MEDIATION' }),
    ]);
  });

  it('refuses to submit once the per-counterparty budget is used up', async () => {
    process.env['SELKEY_ENTROPY_BUDGET_PER_COUNTERPARTY_BITS'] = '20';
    const first = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'one' },
      transport(),
    );
    expect(first.ok).toBe(true);
    const second = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'two' },
      transport(),
    );
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe('ENTROPY_BUDGET_EXCEEDED');
    expect(mockCreateAndSubmit).toHaveBeenCalledTimes(1);
  });

  it('stops distinct counterparties at the global budget', async () => {
    process.env['SELKEY_ENTROPY_BUDGET_GLOBAL_BITS'] = '30';
    for (const peer of ['peer-1', 'peer-2']) {
      const ok = await handleRelaySignal(
        { mode: 'INITIATE', counterparty: peer, purpose: 'MEDIATION', my_input: 'x' },
        transport(),
      );
      expect(ok.ok).toBe(true);
    }
    const third = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'peer-3', purpose: 'MEDIATION', my_input: 'x' },
      transport(),
    );
    expect(third.error?.code).toBe('ENTROPY_BUDGET_EXCEEDED');
    expect(mockCreateAndSubmit).toHaveBeenCalledTimes(2);
  });

  it('keeps the charge for a session that aborts after submission', async () => {
    mockPollUntilDone.mockRejectedValue(new Error('Relay session ABORTED: PROVIDER_ERROR'));
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const result = await handleRelaySignal({ mode: 'CREATE', contract, my_input: 'hello' });
    expect(result.ok).toBe(false);
    expect(mockCreateAndSubmit).toHaveBeenCalledTimes(1);
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ counterparty: 'bob-demo', bits: 12 }),
    ]);
  });

  it('charges the responder before JOIN submits, and refuses JOIN without a contract', async () => {
    mockJoinAndWait.mockRejectedValue(new Error('Relay session ABORTED'));
    process.env['SELKEY_AGENT_ID'] = 'bob-demo';
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const joinArgs = {
      mode: 'JOIN' as const,
      session_id: 'sess-9',
      submit_token: 's',
      read_token: 'r',
      contract_hash: computeRelayContractHash(contract),
      my_input: 'hi',
    };
    await handleRelaySignal({ ...joinArgs, contract });
    expect(ledgerEntries()).toEqual([
      expect.objectContaining({ key: 'join:sess-9', counterparty: 'alice-demo', bits: 12 }),
    ]);

    mockJoinAndWait.mockClear();
    const noContract = await handleRelaySignal({ ...joinArgs, session_id: 'sess-10' });
    expect(noContract.ok).toBe(false);
    expect(noContract.error?.code).toBe('ENTROPY_BOUND_UNAVAILABLE');
    expect(mockJoinAndWait).not.toHaveBeenCalled();
  });

  it('refuses a contract whose output schema does not bound the output', async () => {
    const contract = {
      ...buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!,
      output_schema: { type: 'object', properties: { note: { type: 'string' } } },
      output_schema_hash: undefined,
    };
    const result = await handleRelaySignal({ mode: 'CREATE', contract, my_input: 'hello' });
    expect(result.error?.code).toBe('ENTROPY_BOUND_UNAVAILABLE');
    expect(mockCreateAndSubmit).not.toHaveBeenCalled();
  });
});

// ── Direct AFAL: one charge per relay session, local contracts ────────────

const ALICE_SEED = '01'.repeat(32);
const BOB_SEED = '02'.repeat(32);
const pubOf = (seed: string) => bytesToHex(ed25519.getPublicKey(hexToBytes(seed)));

function signedDescriptor(agentId: string, seed: string, base = '', offers = true): AgentDescriptor {
  return signMessage(
    DOMAIN_PREFIXES.DESCRIPTOR,
    {
      descriptor_version: '1',
      agent_id: agentId,
      issued_at: '2026-01-01T00:00:00Z',
      expires_at: '2099-12-31T23:59:59Z',
      identity_key: { algorithm: 'ed25519', public_key_hex: pubOf(seed) },
      envelope_key: { algorithm: 'ed25519', public_key_hex: pubOf(seed) },
      endpoints: { propose: base ? `${base}/propose` : '', commit: base ? `${base}/commit` : '' },
      capabilities: {
        supported_body_formats: ['wrapped_v1'],
        supports_commit: true,
        supported_model_profiles: listKnownModelProfiles(),
        ...(offers ? { supported_contract_offers: listSupportedContractOffers() } : {}),
      },
      policy_commitments: {},
    },
    seed,
  ) as unknown as AgentDescriptor;
}

describe('direct AFAL sessions and the disclosure budget', () => {
  /** A peer that admits every PROPOSE and answers COMMIT with `commit()`. */
  function stubPeer(commit: () => Promise<unknown>) {
    const commits: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/agent-card.json')) return { ok: false, status: 404, json: async () => ({}) };
      if (url.endsWith('/afal/descriptor')) {
        return { ok: true, json: async () => signedDescriptor('bob-demo', BOB_SEED, 'http://peer.example.com/afal', false) };
      }
      if (url.endsWith('/propose')) {
        const body = JSON.parse(String(init?.body)) as { propose: { proposal_id: string } };
        const admit = signMessage(
          DOMAIN_PREFIXES.ADMIT,
          {
            admission_version: '1',
            proposal_id: body.propose.proposal_id,
            outcome: 'ADMIT',
            admit_token_id: 'a'.repeat(64),
            admission_tier: 'DEFAULT',
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          },
          BOB_SEED,
        );
        return { ok: true, json: async () => admit };
      }
      if (url.endsWith('/commit')) {
        commits.push(JSON.parse(String(init?.body)));
        return commit();
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { commits };
  }

  function alice(): DirectAfalTransport {
    return new DirectAfalTransport({
      agentId: 'alice-demo',
      seedHex: ALICE_SEED,
      localDescriptor: signedDescriptor('alice-demo', ALICE_SEED),
      relayUrl: 'https://relay.test',
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
      pinStore: PinStore.inMemory([{ agentId: 'bob-demo', publicKeyHex: pubOf(BOB_SEED) }]),
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not create another session when the peer rejects the COMMIT', async () => {
    const { commits } = stubPeer(async () => ({ ok: false, status: 500, text: async () => 'abort' }));
    const transport = alice();
    let result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );
    for (let i = 0; i < 3 && result.ok; i++) {
      const token = (result.data as { resume_token?: string | null } | null)?.resume_token;
      if (!token) break;
      result = await handleRelaySignal({ resume_token: token }, transport);
    }
    expect(result.ok).toBe(false);
    expect(mockCreateAndSubmit).toHaveBeenCalledTimes(1);
    expect(commits).toHaveLength(1);
    expect(ledgerEntries()).toHaveLength(1);
  });

  it('re-sends the COMMIT for the existing session when the peer was unreachable', async () => {
    let attempt = 0;
    const { commits } = stubPeer(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('fetch failed');
      return { ok: true, text: async () => 'ok' };
    });
    const transport = alice();
    const first = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );
    expect(first.ok).toBe(true);
    const token = (first.data as { resume_token: string }).resume_token;
    const second = await handleRelaySignal({ resume_token: token }, transport);
    expect(second.ok).toBe(true);
    expect(mockCreateAndSubmit).toHaveBeenCalledTimes(1);
    expect(commits).toHaveLength(2);
    const sessions = commits.map((c) => (c as { relay_session: { session_id: string } }).relay_session.session_id);
    expect(sessions).toEqual(['sess-1', 'sess-1']);
    expect(ledgerEntries()).toHaveLength(1);
  });

  it('continues to poll the relay when a re-sent COMMIT finds the admission already used', async () => {
    let attempt = 0;
    const { commits } = stubPeer(async () => {
      attempt += 1;
      // The first COMMIT is processed but its response is lost.
      if (attempt === 1) throw new TypeError('fetch failed');
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ ok: false, error: 'Unknown or expired admit_token_id', code: 'UNKNOWN_ADMIT_TOKEN' }),
      };
    });
    const transport = alice();
    const first = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );
    const token = (first.data as { resume_token: string }).resume_token;
    const second = await handleRelaySignal({ resume_token: token }, transport);
    expect(second.ok).toBe(true);
    expect((second.data as { state: string; phase: string }).state).not.toBe('FAILED');
    expect((second.data as { phase: string }).phase).toBe('POLL_RELAY');
    expect(commits).toHaveLength(2);
    expect(mockCreateAndSubmit).toHaveBeenCalledTimes(1);
    expect(ledgerEntries()).toHaveLength(1);
  });

  it('fails a re-sent COMMIT rejected without the structured code', async () => {
    let attempt = 0;
    stubPeer(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('fetch failed');
      // Same words, but no structured code: not read as already committed.
      return { ok: false, status: 400, text: async () => 'Unknown or expired admit_token_id UNKNOWN_ADMIT_TOKEN' };
    });
    const transport = alice();
    const first = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );
    const token = (first.data as { resume_token: string }).resume_token;
    const second = await handleRelaySignal({ resume_token: token }, transport);
    expect((second.data as { state: string }).state).toBe('FAILED');
  });

  it('fails a first COMMIT answered with the unknown-admission code', async () => {
    stubPeer(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ ok: false, error: 'x', code: 'UNKNOWN_ADMIT_TOKEN' }),
    }));
    const result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      alice(),
    );
    expect(result.ok).toBe(false);
  });

  /** Run INITIATE against a real loopback responder, then RESPOND and JOIN; returns the JOIN result. */
  async function directRoundTripJoin() {
    mockCreateAndSubmit.mockImplementation(async (_config: unknown, contract: object) => ({
      sessionId: 'sess-rt',
      contractHash: computeRelayContractHash(contract),
      initiatorReadToken: 'ir',
      responderSubmitToken: 'rs',
      responderReadToken: 'rr',
    }));
    const bob = new DirectAfalTransport({
      agentId: 'bob-demo',
      seedHex: BOB_SEED,
      localDescriptor: signedDescriptor('bob-demo', BOB_SEED),
      relayUrl: 'https://relay.test',
      respondMode: {
        httpPort: 0,
        bindAddress: '127.0.0.1',
        policy: {
          trustedAgents: [{ agentId: 'alice-demo', publicKeyHex: pubOf(ALICE_SEED) }],
          allowedPurposeCodes: ['MEDIATION'],
          allowedLaneIds: ['API_MEDIATED'],
          maxEntropyBits: 256,
          defaultTier: 'DENY',
        },
      },
    });
    await bob.start();
    try {
      const port = (bob as unknown as { httpServer: { port: number } }).httpServer.port;
      const initiator = new DirectAfalTransport({
        agentId: 'alice-demo',
        seedHex: ALICE_SEED,
        localDescriptor: signedDescriptor('alice-demo', ALICE_SEED),
        relayUrl: 'https://relay.test',
        peerDescriptorUrl: `http://127.0.0.1:${port}/afal/descriptor`,
        pinStore: PinStore.inMemory([{ agentId: 'bob-demo', publicKeyHex: pubOf(BOB_SEED) }]),
      });
      await handleRelaySignal({ mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'a' }, initiator);
      const responded = await handleRelaySignal({ mode: 'RESPOND', from: 'alice-demo', my_input: 'b' }, bob);
      const token = (responded.data as { resume_token: string }).resume_token;
      return await handleRelaySignal({ resume_token: token }, bob);
    } finally {
      await bob.stop();
    }
  }

  const relayError = (status: number, message: string) =>
    Object.assign(new Error(message), { name: 'RelayHttpError', status });

  it('treats a relay 401 on submit as a stale session, by status code', async () => {
    vi.mocked(submitInput).mockRejectedValueOnce(relayError(401, 'session token rejected'));
    const joined = await directRoundTripJoin();
    const data = joined.data as { state: string; error_code: string; user_message: string };
    expect(data.state).toBe('FAILED');
    expect(data.error_code).toBe('SESSION_ERROR');
    expect(data.user_message).toMatch(/session may be stale/);
  });

  it('does not treat other relay errors that mention Unauthorized as a stale session', async () => {
    vi.mocked(submitInput).mockRejectedValueOnce(relayError(400, 'Relay HTTP 400: Unauthorized field'));
    const joined = await directRoundTripJoin();
    expect(joined.ok).toBe(false);
    expect(JSON.stringify(joined)).not.toMatch(/session may be stale/);
  });

  it('charges both sides of a direct round trip with the locally built contract', async () => {
    mockCreateAndSubmit.mockImplementation(async (_config: unknown, contract: object) => ({
      sessionId: 'sess-rt',
      contractHash: computeRelayContractHash(contract),
      initiatorReadToken: 'ir',
      responderSubmitToken: 'rs',
      responderReadToken: 'rr',
    }));
    const bob = new DirectAfalTransport({
      agentId: 'bob-demo',
      seedHex: BOB_SEED,
      localDescriptor: signedDescriptor('bob-demo', BOB_SEED),
      relayUrl: 'https://relay.test',
      respondMode: {
        httpPort: 0,
        bindAddress: '127.0.0.1',
        policy: {
          trustedAgents: [{ agentId: 'alice-demo', publicKeyHex: pubOf(ALICE_SEED) }],
          allowedPurposeCodes: ['MEDIATION'],
          allowedLaneIds: ['API_MEDIATED'],
          maxEntropyBits: 256,
          defaultTier: 'DENY',
        },
      },
    });
    await bob.start();
    try {
      const port = (bob as unknown as { httpServer: { port: number } }).httpServer.port;
      const initiator = new DirectAfalTransport({
        agentId: 'alice-demo',
        seedHex: ALICE_SEED,
        localDescriptor: signedDescriptor('alice-demo', ALICE_SEED),
        relayUrl: 'https://relay.test',
        peerDescriptorUrl: `http://127.0.0.1:${port}/afal/descriptor`,
        pinStore: PinStore.inMemory([{ agentId: 'bob-demo', publicKeyHex: pubOf(BOB_SEED) }]),
      });
      const initiated = await handleRelaySignal(
        { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'a' },
        initiator,
      );
      expect(initiated.ok).toBe(true);

      const responded = await handleRelaySignal({ mode: 'RESPOND', from: 'alice-demo', my_input: 'b' }, bob);
      const token = (responded.data as { resume_token: string }).resume_token;
      const joined = await handleRelaySignal({ resume_token: token }, bob);
      expect(joined.ok).toBe(true);
      expect(vi.mocked(submitInput)).toHaveBeenCalledTimes(1);
      expect(ledgerEntries()).toEqual([
        expect.objectContaining({ counterparty: 'bob-demo', bits: 12 }),
        expect.objectContaining({ counterparty: 'alice-demo', bits: 12 }),
      ]);
    } finally {
      await bob.stop();
    }
  });

  it('completes a direct round trip with the relay key pinned on both sides and the ledger enforced', async () => {
    const RELAY_SEED = '0a'.repeat(32);
    const relayKey = pubOf(RELAY_SEED);
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = relayKey;
    expect(process.env['SELKEY_ENTROPY_LEDGER']).toBe('enforce');
    // The relay's /health serves the pinned key; everything else goes to the
    // real responder on loopback.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (String(url) === 'https://relay.test/health') {
        return new Response(JSON.stringify({ status: 'ok', verifying_key_hex: relayKey }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return realFetch(url, init);
    });
    let created: Record<string, unknown> | undefined;
    mockCreateAndSubmit.mockImplementation(async (_config: unknown, contract: Record<string, unknown>) => {
      created = contract;
      return {
        sessionId: 'sess-pinned',
        contractHash: computeRelayContractHash(contract),
        initiatorReadToken: 'ir',
        responderSubmitToken: 'rs',
        responderReadToken: 'rr',
      };
    });
    const bob = new DirectAfalTransport({
      agentId: 'bob-demo',
      seedHex: BOB_SEED,
      localDescriptor: signedDescriptor('bob-demo', BOB_SEED),
      relayUrl: 'https://relay.test',
      respondMode: {
        httpPort: 0,
        bindAddress: '127.0.0.1',
        policy: {
          trustedAgents: [{ agentId: 'alice-demo', publicKeyHex: pubOf(ALICE_SEED) }],
          allowedPurposeCodes: ['MEDIATION'],
          allowedLaneIds: ['API_MEDIATED'],
          maxEntropyBits: 256,
          defaultTier: 'DENY',
        },
      },
    });
    await bob.start();
    try {
      const port = (bob as unknown as { httpServer: { port: number } }).httpServer.port;
      const initiator = new DirectAfalTransport({
        agentId: 'alice-demo',
        seedHex: ALICE_SEED,
        localDescriptor: signedDescriptor('alice-demo', ALICE_SEED),
        relayUrl: 'https://relay.test',
        peerDescriptorUrl: `http://127.0.0.1:${port}/afal/descriptor`,
        pinStore: PinStore.inMemory([{ agentId: 'bob-demo', publicKeyHex: pubOf(BOB_SEED) }]),
      });
      const initiated = await handleRelaySignal(
        { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'a' },
        initiator,
      );
      expect(initiated.ok).toBe(true);
      expect(created?.['relay_verifying_key_hex']).toBe(relayKey);
      const inviteHash = computeRelayContractHash(created!);

      const responded = await handleRelaySignal({ mode: 'RESPOND', from: 'alice-demo', my_input: 'b' }, bob);
      expect(responded.ok).toBe(true);
      const token = (responded.data as { resume_token: string }).resume_token;
      const joined = await handleRelaySignal({ resume_token: token }, bob);
      expect(joined.ok).toBe(true);

      // The responder bound the session to its own locally built contract,
      // which carries the pinned relay key and hashes to the invite hash.
      const handle = decodeRelayToken(token, 'bob-demo', null);
      expect(handle?.contract).toBeDefined();
      expect(handle!.contract!['relay_verifying_key_hex']).toBe(relayKey);
      expect(computeRelayContractHash(handle!.contract!)).toBe(inviteHash);
      expect(handle!.contractHash).toBe(inviteHash);
      expect(vi.mocked(submitInput)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(submitInput).mock.calls[0][6]).toBe(inviteHash);
      // One charge per side, each for the contract's bound.
      expect(ledgerEntries()).toEqual([
        expect.objectContaining({ counterparty: 'bob-demo', bits: 12 }),
        expect.objectContaining({ counterparty: 'alice-demo', bits: 12 }),
      ]);
    } finally {
      await bob.stop();
    }
  });
});

describe('legacy JOIN', () => {
  it('refuses a contract that does not hash to contract_hash, before charging', async () => {
    process.env['SELKEY_AGENT_ID'] = 'bob-demo';
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const result = await handleRelaySignal({
      mode: 'JOIN',
      session_id: 'sess-9',
      submit_token: 's',
      read_token: 'r',
      contract_hash: 'c'.repeat(64),
      contract,
      my_input: 'hi',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONTRACT_MISMATCH');
    expect(mockJoinAndWait).not.toHaveBeenCalled();
    expect(ledgerEntries()).toEqual([]);
  });
});

// ── Relay key pin outside development ──────────────────────────────────────

describe('relay key pin outside development', () => {
  const RELAY_KEY = pubOf('0a'.repeat(32));

  function bobResponder(): DirectAfalTransport {
    return new DirectAfalTransport({
      agentId: 'bob-demo',
      seedHex: BOB_SEED,
      localDescriptor: signedDescriptor('bob-demo', BOB_SEED),
      relayUrl: 'https://relay.test',
      respondMode: {
        httpPort: 0,
        bindAddress: '127.0.0.1',
        policy: {
          trustedAgents: [{ agentId: 'alice-demo', publicKeyHex: pubOf(ALICE_SEED) }],
          allowedPurposeCodes: ['MEDIATION'],
          allowedLaneIds: ['API_MEDIATED'],
          maxEntropyBits: 256,
          defaultTier: 'DENY',
        },
      },
    });
  }

  function aliceInitiator(port: number): DirectAfalTransport {
    return new DirectAfalTransport({
      agentId: 'alice-demo',
      seedHex: ALICE_SEED,
      localDescriptor: signedDescriptor('alice-demo', ALICE_SEED),
      relayUrl: 'https://relay.test',
      peerDescriptorUrl: `http://127.0.0.1:${port}/afal/descriptor`,
      pinStore: PinStore.inMemory([{ agentId: 'bob-demo', publicKeyHex: pubOf(BOB_SEED) }]),
    });
  }

  beforeEach(() => {
    mockCreateAndSubmit.mockImplementation(async (_config: unknown, contract: object) => ({
      sessionId: 'sess-pin',
      contractHash: computeRelayContractHash(contract),
      initiatorReadToken: 'ir',
      responderSubmitToken: 'rs',
      responderReadToken: 'rr',
    }));
  });

  it('refuses INITIATE, CREATE and RESPOND without a pinned relay key', async () => {
    delete process.env['SELKEY_ENV'];
    const initiate = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'a' },
      transport(),
    );
    expect(initiate.error?.code).toBe('PRECONDITION_FAILED');
    expect(initiate.error?.message ?? JSON.stringify(initiate)).toMatch(/SELKEY_RELAY_VERIFYING_KEY_HEX/);
    const create = await handleRelaySignal({
      mode: 'CREATE',
      contract: buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!,
      my_input: 'a',
    });
    expect(create.error?.code).toBe('PRECONDITION_FAILED');
    const respond = await handleRelaySignal({ mode: 'RESPOND', from: 'alice-demo', my_input: 'b' }, transport());
    expect(respond.error?.code).toBe('PRECONDITION_FAILED');
    expect(mockCreateAndSubmit).not.toHaveBeenCalled();
    expect(ledgerEntries()).toEqual([]);
  });

  it('runs without a pin in development', async () => {
    const bob = bobResponder();
    await bob.start();
    try {
      const port = (bob as unknown as { httpServer: { port: number } }).httpServer.port;
      const initiated = await handleRelaySignal(
        { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'a' },
        aliceInitiator(port),
      );
      expect(initiated.ok).toBe(true);
      const responded = await handleRelaySignal({ mode: 'RESPOND', from: 'alice-demo', my_input: 'b' }, bob);
      const token = (responded.data as { resume_token: string }).resume_token;
      const joined = await handleRelaySignal({ resume_token: token }, bob);
      expect(joined.ok).toBe(true);
      expect(vi.mocked(submitInput)).toHaveBeenCalledTimes(1);
    } finally {
      await bob.stop();
    }
  });

  it('rejects, outside development, a contract from an initiator that did not pin the relay key', async () => {
    const bob = bobResponder();
    await bob.start();
    try {
      const port = (bob as unknown as { httpServer: { port: number } }).httpServer.port;
      // The initiator runs without a pin (development), so its contract has no relay key.
      const initiated = await handleRelaySignal(
        { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'a' },
        aliceInitiator(port),
      );
      expect(initiated.ok).toBe(true);
      // The responder runs outside development with a pinned key.
      delete process.env['SELKEY_ENV'];
      process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = RELAY_KEY;
      const responded = await handleRelaySignal({ mode: 'RESPOND', from: 'alice-demo', my_input: 'b' }, bob);
      let result = responded;
      const token = (responded.data as { resume_token?: string | null } | null)?.resume_token;
      if (token) result = await handleRelaySignal({ resume_token: token }, bob);
      expect((result.data as { state: string; error_code?: string }).state).toBe('FAILED');
      expect((result.data as { error_code?: string }).error_code).toBe('CONTRACT_MISMATCH');
      expect(vi.mocked(submitInput)).not.toHaveBeenCalled();
    } finally {
      await bob.stop();
    }
  });

  it('refuses a legacy JOIN outside development unless the contract carries the pinned key', async () => {
    delete process.env['SELKEY_ENV'];
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = RELAY_KEY;
    // The relay itself serves the pinned key, so only the contract check can refuse.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ verifying_key_hex: RELAY_KEY }), { status: 200 }));
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    const result = await handleRelaySignal({
      mode: 'JOIN',
      session_id: 'sess-x',
      submit_token: 's',
      read_token: 'r',
      contract,
      contract_hash: computeRelayContractHash(contract),
      my_input: 'b',
    });
    expect(result.error?.code).toBe('PRECONDITION_FAILED');
    expect(mockJoinAndWait).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('sends the operator token only to the configured relay', async () => {
    process.env['SELKEY_OPERATOR_TOKEN'] = 'op-token-0123456789abcdef0123456789abcdef';
    process.env['SELKEY_RELAY_ALLOWLIST'] = 'https://other-relay.test';
    mockPollUntilDone.mockResolvedValue({ state: 'COMPLETED', output: {} });
    const contract = buildRelayContract('MEDIATION', ['alice-demo', 'bob-demo'])!;
    await handleRelaySignal({ mode: 'CREATE', contract, my_input: 'a' });
    expect(mockCreateAndSubmit.mock.calls[0][0]).toEqual({
      relay_url: 'https://relay.test',
      operator_token: 'op-token-0123456789abcdef0123456789abcdef',
    });
    await handleRelaySignal({ mode: 'CREATE', contract, my_input: 'a', relay_url: 'https://other-relay.test' });
    expect(mockCreateAndSubmit.mock.calls[1][0]).toEqual({ relay_url: 'https://other-relay.test' });
  });
});
