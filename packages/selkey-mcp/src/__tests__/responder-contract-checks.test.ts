/**
 * Responder contract and relay selection checks.
 *
 * Uses the real contract builders and hashing (selkey/contracts) so the
 * responder's locally rebuilt contract is compared field-for-field.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildRelayContract,
  computeRelayContractHash,
  type RelayContract,
} from 'selkey/contracts';
import { submitInput, getStatus, getOutput } from 'selkey/http';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { canonicalize } from 'json-canonicalize';
import { createAndSubmit } from 'selkey';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { DirectAfalTransport, type AgentDescriptor } from '../direct-afal-transport.js';
import { signMessage, DOMAIN_PREFIXES } from '../afal-signing.js';
import { listKnownModelProfiles } from '../model-profiles.js';
import { listSupportedContractOffers } from '../contract-offers.js';
import {
  handleRelaySignal,
  _setDiscoverPollConfigForTesting,
  _setRelayPollConfigForTesting,
} from '../tools/relaySignal.js';
import { _resetHandlesForTesting } from '../tools/relayHandles.js';
import type { AfalTransport, AfalInviteMessage } from '../afal-transport.js';
import { RelayInboxTransport, RELAY_INBOX_PAYLOAD_TYPE } from '../relay-inbox-transport.js';
import type { RelaySignalOutput } from '../tools/relaySignal.js';

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

const RESPONDER = 'alice-demo';
const INITIATOR = 'bob-demo';
const LOCAL_RELAY = 'http://relay.test';
const OTHER_RELAY = 'http://unlisted-relay.example';

const ENV_KEYS = [
  'SELKEY_RELAY_URL',
  'SELKEY_RELAY_ALLOWLIST',
  'SELKEY_RELAY_VERIFYING_KEY_HEX',
  'SELKEY_AFAL_ALLOWED_PURPOSES',
  'SELKEY_AGENT_ID',
  'SELKEY_WORKDIR',
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
  process.env['SELKEY_RELAY_URL'] = LOCAL_RELAY;
  process.env['SELKEY_AGENT_ID'] = RESPONDER;
  process.env['SELKEY_WORKDIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'selkey-responder-test-'));
  _resetHandlesForTesting();
  _setDiscoverPollConfigForTesting(0, 0);
  _setRelayPollConfigForTesting(0, 0);
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

function localContract(purpose = 'MEDIATION'): RelayContract {
  const contract = buildRelayContract(purpose, [INITIATOR, RESPONDER]);
  if (!contract) throw new Error(`no template for ${purpose}`);
  return contract;
}

function legacyInvite(contractHash: string, relayUrl = LOCAL_RELAY): AfalInviteMessage {
  return {
    invite_id: 'inv-legacy',
    from_agent_id: INITIATOR,
    payload_type: 'VCAV_E_INVITE_V1',
    contract_hash: contractHash,
    payload: {
      session_id: 'sess-1',
      responder_submit_token: 'sub-tok',
      responder_read_token: 'read-tok',
      relay_url: relayUrl,
    },
  };
}

function mockTransport(invites: AfalInviteMessage[]): AfalTransport {
  return {
    sendPropose: vi.fn(),
    checkInbox: vi.fn().mockResolvedValue({ invites }),
    peekInbox: vi.fn().mockResolvedValue({ invites }),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    agentId: RESPONDER,
  };
}

function inboxTransport(contractJson: Record<string, unknown>): RelayInboxTransport {
  const transport = new RelayInboxTransport({
    agentId: RESPONDER,
    inboxToken: 'inbox-token',
    relayUrl: LOCAL_RELAY,
  });
  const contractHash = computeRelayContractHash(contractJson);
  vi.spyOn(transport, 'peekInbox').mockResolvedValue({
    invites: [
      {
        invite_id: 'inv-inbox',
        from_agent_id: INITIATOR,
        payload_type: RELAY_INBOX_PAYLOAD_TYPE,
        contract_hash: contractHash,
        payload: {},
      } as AfalInviteMessage,
    ],
  });
  vi.spyOn(transport, 'getInviteDetail').mockResolvedValue({
    invite_id: 'inv-inbox',
    from_agent_id: INITIATOR,
    to_agent_id: RESPONDER,
    status: 'PENDING',
    purpose_code: String(contractJson['purpose_code']),
    contract_hash: contractHash,
    contract_json: contractJson,
    provider: 'anthropic',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
  } as never);
  return transport;
}

async function respond(
  transport: AfalTransport,
  extra: Record<string, unknown> = {},
): Promise<RelaySignalOutput> {
  const result = await handleRelaySignal(
    { mode: 'RESPOND', from: INITIATOR, expected_purpose: 'MEDIATION', my_input: 'hi', ...extra },
    transport,
  );
  return result.data as RelaySignalOutput;
}

describe('responder rebuilds and compares the full contract', () => {
  const variants: Array<[string, (c: RelayContract) => Record<string, unknown>]> = [
    ['output schema hash', (c) => ({ ...c, output_schema_hash: 'f'.repeat(64) })],
    ['output schema', (c) => ({ ...c, output_schema: { type: 'object' } })],
    ['prompt template hash', (c) => ({ ...c, prompt_template_hash: 'e'.repeat(64) })],
    ['enforcement policy hash', (c) => ({ ...c, enforcement_policy_hash: 'd'.repeat(64) })],
    ['model profile', (c) => ({ ...c, model_profile_id: 'unknown-profile', model_profile_hash: 'c'.repeat(64) })],
    ['entropy budget', (c) => ({ ...c, entropy_budget_bits: 4096 })],
  ];

  it('accepts a relay-inbox invite whose contract matches the locally built one', async () => {
    const data = await respond(inboxTransport(localContract() as unknown as Record<string, unknown>));
    expect(data.phase).toBe('JOIN');
  });

  for (const [label, mutate] of variants) {
    it(`rejects a relay-inbox contract that differs only in ${label}`, async () => {
      const data = await respond(inboxTransport(mutate(localContract())));
      expect(data.phase).toBe('FAILED');
      expect(data.error_code).toBe('CONTRACT_MISMATCH');
    });

    it(`rejects a direct invite whose contract hash differs only in ${label}`, async () => {
      const hash = computeRelayContractHash(mutate(localContract()));
      const data = await respond(mockTransport([legacyInvite(hash)]));
      expect(data.phase).toBe('FAILED');
      expect(data.error_code).toBe('CONTRACT_MISMATCH');
      expect(submitInput).not.toHaveBeenCalled();
    });
  }

  it('accepts a direct invite whose contract hash matches the locally built one', async () => {
    const hash = computeRelayContractHash(localContract());
    const data = await respond(mockTransport([legacyInvite(hash)]));
    expect(data.phase).toBe('JOIN');
    expect(data.contract_hash).toBe(hash);
  });
});

describe('contracts outside the local set', () => {
  const customHash = computeRelayContractHash({
    ...localContract(),
    output_schema_id: 'custom_schema',
    output_schema: { type: 'object' },
  });

  it('rejects a custom contract without an explicit expected_contract_hash', async () => {
    const data = await respond(mockTransport([legacyInvite(customHash)]));
    expect(data.phase).toBe('FAILED');
    expect(data.error_code).toBe('CONTRACT_MISMATCH');
  });

  it('accepts a custom contract only when its exact hash is expected', async () => {
    const data = await respond(mockTransport([legacyInvite(customHash)]), {
      expected_purpose: undefined,
      expected_contract_hash: customHash,
    });
    expect(data.phase).toBe('JOIN');
    expect(data.contract_hash).toBe(customHash);
  });
});

describe('invite cannot choose the responder expectations', () => {
  it('requires from even when exactly one invite is pending', async () => {
    const hash = computeRelayContractHash(localContract());
    const result = await handleRelaySignal(
      { mode: 'RESPOND', expected_purpose: 'MEDIATION', my_input: 'hi' },
      mockTransport([legacyInvite(hash)]),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.detail).toContain('from is required');
  });

  it('does not adopt the invite purpose when expected_purpose is omitted', async () => {
    // Local configuration accepts MEDIATION only (default); the invite offers
    // a well-formed COMPATIBILITY contract.
    const compat = localContract('COMPATIBILITY');
    const invite: AfalInviteMessage = {
      ...legacyInvite(computeRelayContractHash(compat)),
      afalPropose: { purpose_code: 'COMPATIBILITY' } as AfalInviteMessage['afalPropose'],
    };
    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: INITIATOR, my_input: 'hi' },
      mockTransport([invite]),
    );
    const data = result.data as RelaySignalOutput;
    expect(data.phase).toBe('FAILED');
    expect(data.error_code).toBe('CONTRACT_MISMATCH');
    expect(submitInput).not.toHaveBeenCalled();
  });

  it('accepts the invite purpose when local configuration allows it', async () => {
    process.env['SELKEY_AFAL_ALLOWED_PURPOSES'] = 'MEDIATION,COMPATIBILITY';
    const compat = localContract('COMPATIBILITY');
    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: INITIATOR, my_input: 'hi' },
      mockTransport([legacyInvite(computeRelayContractHash(compat))]),
    );
    expect((result.data as RelaySignalOutput).phase).toBe('JOIN');
  });
});

describe('responder uses only locally configured relays', () => {
  it('refuses an invite whose session relay is not locally configured', async () => {
    const hash = computeRelayContractHash(localContract());
    const data = await respond(mockTransport([legacyInvite(hash, OTHER_RELAY)]));
    expect(data.phase).toBe('FAILED');
    expect(data.error_code).toBe('RELAY_NOT_TRUSTED');
    expect(submitInput).not.toHaveBeenCalled();
  });

  it('accepts an invite relay listed in SELKEY_RELAY_ALLOWLIST', async () => {
    process.env['SELKEY_RELAY_ALLOWLIST'] = `${OTHER_RELAY}/`;
    const hash = computeRelayContractHash(localContract());
    const data = await respond(mockTransport([legacyInvite(hash, OTHER_RELAY)]));
    expect(data.phase).toBe('JOIN');
  });

  it('refuses a RESPOND relay_url that is not locally configured', async () => {
    const result = await handleRelaySignal(
      {
        mode: 'RESPOND',
        from: INITIATOR,
        expected_purpose: 'MEDIATION',
        my_input: 'hi',
        relay_url: OTHER_RELAY,
      },
      mockTransport([]),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('refuses an INITIATE relay_url that is not locally configured', async () => {
    const result = await handleRelaySignal(
      {
        mode: 'INITIATE',
        counterparty: INITIATOR,
        purpose: 'MEDIATION',
        my_input: 'hi',
        relay_url: OTHER_RELAY,
      },
      mockTransport([]),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.detail).toContain('not a locally configured relay');
  });

  it('does not submit input when the relay key differs from the pinned key', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = 'a'.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ verifying_key_hex: 'b'.repeat(64) }),
      }),
    );
    const hash = computeRelayContractHash(localContract());
    const transport = mockTransport([legacyInvite(hash)]);
    const first = await respond(transport);
    expect(first.phase).toBe('JOIN');
    const second = await handleRelaySignal({ resume_token: first.resume_token ?? '' }, transport);
    const data = second.data as RelaySignalOutput;
    expect(data.phase).toBe('FAILED');
    expect(data.error_code).toBe('RELAY_NOT_TRUSTED');
    expect(submitInput).not.toHaveBeenCalled();
  });

  it('submits input when the relay serves the pinned key', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = 'a'.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ verifying_key_hex: 'A'.repeat(64) }),
      }),
    );
    const hash = computeRelayContractHash(localContract());
    const transport = mockTransport([legacyInvite(hash)]);
    const first = await respond(transport);
    await handleRelaySignal({ resume_token: first.resume_token ?? '' }, transport);
    expect(submitInput).toHaveBeenCalledOnce();
  });
});

describe('direct AFAL round trip with locally configured relays', () => {
  const ALICE_SEED = '01'.repeat(32);
  const BOB_SEED = '02'.repeat(32);
  const pub = (seed: string) => bytesToHex(ed25519.getPublicKey(hexToBytes(seed)));

  function descriptor(agentId: string, seed: string): AgentDescriptor {
    return signMessage(
      DOMAIN_PREFIXES.DESCRIPTOR,
      {
        descriptor_version: '1',
        agent_id: agentId,
        issued_at: '2026-01-01T00:00:00Z',
        expires_at: '2099-12-31T23:59:59Z',
        identity_key: { algorithm: 'ed25519', public_key_hex: pub(seed) },
        envelope_key: { algorithm: 'ed25519', public_key_hex: pub(seed) },
        endpoints: { propose: '', commit: '' },
        capabilities: {
          supported_body_formats: ['wrapped_v1'],
          supports_commit: true,
          supported_model_profiles: listKnownModelProfiles(),
          supported_contract_offers: listSupportedContractOffers(),
        },
        policy_commitments: {},
      },
      seed,
    ) as unknown as AgentDescriptor;
  }

  let bob: DirectAfalTransport | undefined;
  afterEach(async () => {
    if (bob) await bob.stop();
    bob = undefined;
  });

  it('responder accepts the contract the initiator built from the same configuration', async () => {
    vi.mocked(createAndSubmit).mockImplementation(async (_config, contract) => ({
      sessionId: 'sess-rt',
      contractHash: computeRelayContractHash(contract as object),
      initiatorReadToken: 'init-read',
      responderSubmitToken: 'resp-submit',
      responderReadToken: 'resp-read',
    }) as never);

    bob = new DirectAfalTransport({
      agentId: 'bob-test',
      seedHex: BOB_SEED,
      localDescriptor: descriptor('bob-test', BOB_SEED),
      relayUrl: LOCAL_RELAY,
      respondMode: {
        httpPort: 0,
        bindAddress: '127.0.0.1',
        policy: {
          trustedAgents: [{ agentId: 'alice-test', publicKeyHex: pub(ALICE_SEED) }],
          allowedPurposeCodes: ['MEDIATION', 'COMPATIBILITY'],
          allowedLaneIds: ['API_MEDIATED'],
          maxEntropyBits: 256,
          defaultTier: 'DENY',
        },
      },
    });
    await bob.start();
    const bobPort = (bob as unknown as { httpServer: { port: number } }).httpServer.port;

    const alice = new DirectAfalTransport({
      agentId: 'alice-test',
      seedHex: ALICE_SEED,
      localDescriptor: descriptor('alice-test', ALICE_SEED),
      relayUrl: LOCAL_RELAY,
      peerDescriptorUrl: `http://127.0.0.1:${bobPort}/afal/descriptor`,
    });

    const initiated = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-test', purpose: 'MEDIATION', my_input: 'a' },
      alice,
    );
    expect(initiated.ok).toBe(true);
    expect(vi.mocked(createAndSubmit)).toHaveBeenCalledWith(
      { relay_url: LOCAL_RELAY },
      expect.any(Object),
      'a',
      'initiator',
    );

    const responded = await handleRelaySignal(
      { mode: 'RESPOND', from: 'alice-test', my_input: 'b' },
      bob,
    );
    const data = responded.data as RelaySignalOutput;
    expect(data.phase).toBe('JOIN');
  });
});

describe('receipt verification against the pinned relay key', () => {
  const RELAY_SEED = '03'.repeat(32);
  const OTHER_SEED = '04'.repeat(32);
  const keyOf = (seed: string) => bytesToHex(ed25519.getPublicKey(hexToBytes(seed)));

  function signedReceiptV2(seed: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const unsigned = {
      receipt_schema_version: '2.1.0',
      session_id: 'sess-1',
      assurance_level: 'SELF_ASSERTED',
      ...extra,
    };
    const digest = sha256(utf8ToBytes('VCAV-RECEIPT-V2:' + canonicalize(unsigned)));
    const sig = Buffer.from(ed25519.sign(digest, hexToBytes(seed))).toString('base64url');
    return { ...unsigned, signature: { alg: 'Ed25519', value: sig } };
  }

  async function runToCompletion(receiptV2: Record<string, unknown>): Promise<RelaySignalOutput> {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ verifying_key_hex: keyOf(RELAY_SEED) }),
      }),
    );
    vi.mocked(getStatus).mockResolvedValueOnce({ state: 'COMPLETED' } as never);
    vi.mocked(getOutput).mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'ALIGNED' },
      receipt_v2: receiptV2,
    } as never);
    const transport = mockTransport([legacyInvite(computeRelayContractHash(localContract()))]);
    const first = await respond(transport);
    const second = await handleRelaySignal({ resume_token: first.resume_token ?? '' }, transport);
    return second.data as RelaySignalOutput;
  }

  it('returns an error instead of output when the receipt is not signed by the pinned key', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = keyOf(RELAY_SEED);
    const data = await runToCompletion(signedReceiptV2(OTHER_SEED));
    expect(data.phase).toBe('FAILED');
    expect(data.error_code).toBe('RECEIPT_VERIFICATION_FAILED');
    expect(data.output).toBeUndefined();
  });

  it('returns an error when the receipt declares a different embedded signing key', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = keyOf(RELAY_SEED);
    const data = await runToCompletion(
      signedReceiptV2(OTHER_SEED, { tee_attestation: { receipt_signing_pubkey_hex: keyOf(OTHER_SEED) } }),
    );
    expect(data.phase).toBe('FAILED');
    expect(data.error_code).toBe('RECEIPT_VERIFICATION_FAILED');
  });

  it('completes when the receipt verifies against the pinned key', async () => {
    process.env['SELKEY_RELAY_VERIFYING_KEY_HEX'] = keyOf(RELAY_SEED);
    const data = await runToCompletion(signedReceiptV2(RELAY_SEED));
    expect(data.phase).toBe('COMPLETED');
    expect(JSON.stringify(data.interpretation_context)).toContain('verified against the pinned relay key');
  });

  it('says the receipt is not verified when no relay key is pinned', async () => {
    const data = await runToCompletion(signedReceiptV2(OTHER_SEED));
    expect(data.phase).toBe('COMPLETED');
    const text = JSON.stringify(data.interpretation_context);
    expect(text).toContain('not verified: no relay key pinned');
    expect(text).not.toContain('cryptographically receipted');
  });
});
