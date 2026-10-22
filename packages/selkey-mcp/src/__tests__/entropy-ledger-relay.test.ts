/**
 * relay_signal charges the owner-side disclosure budget before this agent's
 * input is submitted, and refuses to submit when a budget would be exceeded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRelayContract } from 'selkey/contracts';

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
import { _resetHandlesForTesting } from '../tools/relayHandles.js';
import type { AfalTransport } from '../afal-transport.js';

const ENV_KEYS = [
  'SELKEY_WORKDIR',
  'SELKEY_RELAY_URL',
  'SELKEY_AGENT_ID',
  'SELKEY_RELAY_VERIFYING_KEY_HEX',
  'SELKEY_ENTROPY_LEDGER',
  'SELKEY_ENTROPY_BUDGET_PER_COUNTERPARTY_BITS',
  'SELKEY_ENTROPY_BUDGET_GLOBAL_BITS',
  'SELKEY_ENTROPY_BUDGET_WINDOW_SECONDS',
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
  process.env['SELKEY_RELAY_URL'] = 'http://relay.test';
  process.env['SELKEY_AGENT_ID'] = 'alice-demo';
  process.env['SELKEY_ENTROPY_LEDGER'] = 'enforce';
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
      contract_hash: 'c'.repeat(64),
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
