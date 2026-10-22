/**
 * Agent identity pins: the store, the initiator's use of pins for ADMIT/DENY,
 * ADMIT binding to the PROPOSE, negotiation selections, and authenticated
 * negotiation requests at the responder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { DirectAfalTransport, checkAdmitBinding } from '../direct-afal-transport.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { AfalHttpServer } from '../afal-http-server.js';
import { AfalResponder } from '../afal-responder.js';
import { SELKEY_A2A_EXTENSION_URI } from '../a2a-agent-card.js';
import { DOMAIN_PREFIXES, signMessage } from '../afal-signing.js';
import { computeProposalId } from '../afal-types.js';
import type { AfalPropose } from '../afal-types.js';
import {
  A2A_SEND_MESSAGE_PATH,
  SELKEY_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
  SELKEY_CONTRACT_OFFER_SELECTION_MEDIA_TYPE,
  buildA2ASendMessageRequest,
} from '../a2a-messages.js';
import { MAX_PENDING_PINS, PinError, PinStore, keyFingerprint, resolveAgentHint } from '../pin-store.js';
import { runPinsCli, type PinsCliIo } from '../pin-cli.js';
import { signNegotiationRequest } from '../negotiation-auth.js';
import { IfcService } from '../ifc.js';
import { InsecureStateFileError } from '../secure-fs.js';
import { signCard } from './helpers/sign-card.js';

const ALICE_SEED = '01'.repeat(32);
const ALICE_PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(ALICE_SEED)));
const BOB_SEED = '02'.repeat(32);
const BOB_PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(BOB_SEED)));
const OTHER_SEED = '07'.repeat(32);
const OTHER_PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(OTHER_SEED)));
const PROFILE_A = { id: 'api-claude-sonnet-v1', version: '1', hash: 'a'.repeat(64) };
const PROFILE_B = { id: 'api-openai-4.1-mini-v1', version: '1', hash: 'b'.repeat(64) };
const posix = process.platform !== 'win32';

function descriptor(agentId: string, pub: string, seed: string): AgentDescriptor {
  return signMessage(
    DOMAIN_PREFIXES.DESCRIPTOR,
    {
      descriptor_version: '1',
      agent_id: agentId,
      issued_at: '2026-01-01T00:00:00Z',
      expires_at: '2099-12-31T23:59:59Z',
      identity_key: { algorithm: 'ed25519', public_key_hex: pub },
      envelope_key: { algorithm: 'ed25519', public_key_hex: pub },
      endpoints: {
        propose: 'http://peer.example.com/afal/propose',
        commit: 'http://peer.example.com/afal/commit',
      },
      capabilities: {},
      policy_commitments: {},
    },
    seed,
  ) as unknown as AgentDescriptor;
}

/** An agent card for "bob-test" carrying `pub` (optionally self-signed). */
const SEED_FOR: Record<string, string> = { [ALICE_PUB]: ALICE_SEED, [BOB_PUB]: BOB_SEED, [OTHER_PUB]: OTHER_SEED };

/** A signed agent card for "bob-test" carrying `pub`, signed by that key. */
function card(pub: string, extraParams: Record<string, unknown> = {}): Record<string, unknown> {
  return signCard(unsignedCard(pub, extraParams), SEED_FOR[pub] ?? OTHER_SEED);
}

function unsignedCard(pub: string, extraParams: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'bob-test',
    url: 'http://peer.example.com',
    capabilities: {
      extensions: [
        {
          uri: SELKEY_A2A_EXTENSION_URI,
          params: {
            public_key_hex: pub,
            supported_purposes: ['MEDIATION'],
            afal_endpoint: 'http://peer.example.com/afal',
            ...extraParams,
          },
        },
      ],
    },
  };
}

function propose(overrides: Partial<Omit<AfalPropose, 'proposal_id'>> = {}): AfalPropose {
  const fields: Omit<AfalPropose, 'proposal_id'> = {
    proposal_version: '1',
    nonce: 'c'.repeat(64),
    timestamp: new Date().toISOString(),
    from: 'alice-test',
    to: 'bob-test',
    purpose_code: 'MEDIATION',
    lane_id: 'API_MEDIATED',
    output_schema_id: 'vcav_e_mediation_signal_v2',
    output_schema_version: '1',
    requested_budget_tier: 'SMALL',
    requested_entropy_bits: 12,
    model_profile_id: PROFILE_A.id,
    model_profile_version: PROFILE_A.version,
    model_profile_hash: PROFILE_A.hash,
    admission_tier_requested: 'DEFAULT',
    ...overrides,
  };
  return { ...fields, proposal_id: computeProposalId(fields) };
}

function admit(
  seed: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return signMessage(
    DOMAIN_PREFIXES.ADMIT,
    {
      admission_version: '1',
      outcome: 'ADMIT',
      admit_token_id: 'e'.repeat(64),
      admission_tier: 'DEFAULT',
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      ...fields,
    },
    seed,
  );
}

function initiator(pinStore: PinStore): DirectAfalTransport {
  return new DirectAfalTransport({
    agentId: 'alice-test',
    seedHex: ALICE_SEED,
    localDescriptor: descriptor('alice-test', ALICE_PUB, ALICE_SEED),
    peerDescriptorUrl: 'http://peer.example.com/.well-known/agent-card.json',
    pinStore,
  });
}

/** fetch mock: agent card, then an ADMIT built from the PROPOSE that was sent. */
function mockPeer(cardPub: string, makeAdmit: (sentProposalId: string) => Record<string, unknown>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/propose')) {
      const body = JSON.parse(String(init?.body)) as { propose: { proposal_id: string } };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(makeAdmit(body.propose.proposal_id)) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(card(cardPub)) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selkey-pins-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Pin store ───────────────────────────────────────────────────────────────

describe('pin store', () => {
  it('uses "ed25519:" + hex(SHA-256(raw key)) as the key fingerprint', () => {
    expect(keyFingerprint(BOB_PUB)).toBe(`ed25519:${bytesToHex(sha256(hexToBytes(BOB_PUB)))}`);
    expect(keyFingerprint(BOB_PUB.toUpperCase())).toBe(keyFingerprint(BOB_PUB));
  });

  it.skipIf(!posix)('persists pins 0600 in a 0700 directory and reloads them', () => {
    const file = path.join(tmp, '.selkey', 'pins.json');
    PinStore.open({ filePath: file, seeds: [{ agentId: 'bob-test', publicKeyHex: BOB_PUB, aliases: ['Bob'] }] });
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const reloaded = PinStore.open({ filePath: file });
    expect(reloaded.pinnedKeyFor('bob-test')).toBe(BOB_PUB);
    expect(reloaded.resolveAgentId('Bob')).toBe('bob-test');
  });

  it.skipIf(!posix)('refuses to load a group- or world-writable pins.json', () => {
    const file = path.join(tmp, '.selkey', 'pins.json');
    PinStore.open({ filePath: file, seeds: [{ agentId: 'bob-test', publicKeyHex: BOB_PUB }] });
    fs.chmodSync(file, 0o664);
    expect(() => PinStore.open({ filePath: file })).toThrow(InsecureStateFileError);
  });

  it('looks up agent ids by their NFC form and never by case-folded aliases', () => {
    const store = PinStore.inMemory([
      { agentId: 'café', publicKeyHex: BOB_PUB, aliases: ['Bob'] },
    ]);
    expect(store.pinnedKeyFor('café')).toBe(BOB_PUB); // decomposed é
    expect(store.resolveAgentId('Bob')).toBe('café');
    expect(store.resolveAgentId('bob')).toBeUndefined();
    expect(store.resolveAgentId('BOB')).toBeUndefined();
  });

  it('rejects an alias that names more than one agent', () => {
    const agents = [
      { agent_id: 'bob-a', aliases: ['Bob'] },
      { agent_id: 'bob-b', aliases: ['Bob'] },
    ];
    expect(() => resolveAgentHint('Bob', agents)).toThrow(/more than one agent/);
    // An alias that equals another agent's id is ambiguous too.
    expect(() => resolveAgentHint('bob-b', [{ agent_id: 'bob-a', aliases: ['bob-b'] }, { agent_id: 'bob-b' }])).toThrow(
      PinError,
    );
  });

  it('fails a changed key and reports both fingerprints', () => {
    const store = PinStore.inMemory([{ agentId: 'bob-test', publicKeyHex: BOB_PUB }]);
    try {
      store.checkPresentedKey('bob-test', OTHER_PUB);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PinError);
      expect((err as PinError).code).toBe('KEY_CHANGED');
      expect((err as Error).message).toContain(keyFingerprint(BOB_PUB));
      expect((err as Error).message).toContain(keyFingerprint(OTHER_PUB));
    }
    expect(store.pinnedKeyFor('bob-test')).toBe(BOB_PUB);
  });

  it('rejects an unpinned peer in preshared mode', () => {
    const store = PinStore.inMemory();
    expect(() => store.checkPresentedKey('bob-test', BOB_PUB)).toThrow(/No pinned key/);
  });

  it('applies a rotation statement signed by the pinned key and rejects others', () => {
    const store = PinStore.inMemory([{ agentId: 'bob-test', publicKeyHex: BOB_PUB }]);
    const unsigned = {
      agent_id: 'bob-test',
      old_fpr: keyFingerprint(BOB_PUB),
      new_fpr: keyFingerprint(OTHER_PUB),
      issued_at: new Date().toISOString(),
    };
    const byNewKey = signMessage(DOMAIN_PREFIXES.KEY_ROTATION, unsigned, OTHER_SEED);
    expect(() => store.applyRotation(byNewKey, OTHER_PUB)).toThrow(/not signed by the pinned key/);
    const byOldKey = signMessage(DOMAIN_PREFIXES.KEY_ROTATION, unsigned, BOB_SEED);
    expect(() => store.applyRotation(byOldKey, ALICE_PUB)).toThrow(/new_fpr/);
    expect(store.applyRotation(byOldKey, OTHER_PUB).public_key_hex).toBe(OTHER_PUB);
    // The statement cannot be replayed once the pin has moved on.
    expect(() => store.applyRotation(byOldKey, OTHER_PUB)).toThrow(/old_fpr/);
  });
});

describe('pin store shared with the CLI', () => {
  const file = () => path.join(tmp, '.selkey', 'pins.json');

  it('sees a CLI remove without a restart', async () => {
    const server = PinStore.open({ filePath: file(), seeds: [{ agentId: 'bob-test', publicKeyHex: BOB_PUB }] });
    expect(server.pinnedKeyFor('bob-test')).toBe(BOB_PUB);
    const cli = PinStore.open({ filePath: file() });
    expect(await runPinsCli(['remove', 'bob-test'], cli, cliIo(''))).toBe(0);
    expect(server.pinnedKeyFor('bob-test')).toBeUndefined();
  });

  it('does not overwrite a CLI confirmation with a later server write', async () => {
    const server = PinStore.open({ filePath: file(), mode: 'tofu' });
    expect(() => server.checkPresentedKey('bob-test', BOB_PUB)).toThrow(PinError);
    const cli = PinStore.open({ filePath: file(), mode: 'tofu' });
    expect(await runPinsCli(['confirm', 'bob-test'], cli, cliIo(keyFingerprint(BOB_PUB)))).toBe(0);
    // The server records another first contact afterwards.
    expect(() => server.checkPresentedKey('carol-test', OTHER_PUB)).toThrow(PinError);
    const reread = PinStore.open({ filePath: file(), mode: 'tofu' });
    expect(reread.pinnedKeyFor('bob-test')).toBe(BOB_PUB);
    expect(reread.listPending().map((p) => p.agent_id)).toEqual(['carol-test']);
    expect(server.pinnedKeyFor('bob-test')).toBe(BOB_PUB);
  });

  it('refuses a configured key that differs from a stored re-pin unless reseeding', () => {
    PinStore.open({ filePath: file(), seeds: [{ agentId: 'bob-test', publicKeyHex: BOB_PUB }] }).setPin(
      'bob-test',
      OTHER_PUB,
    );
    expect(() =>
      PinStore.open({ filePath: file(), seeds: [{ agentId: 'bob-test', publicKeyHex: BOB_PUB }] }),
    ).toThrow(/differs from the stored pin/);
    expect(PinStore.open({ filePath: file() }).pinnedKeyFor('bob-test')).toBe(OTHER_PUB);
    const reseeded = PinStore.open({
      filePath: file(),
      seeds: [{ agentId: 'bob-test', publicKeyHex: BOB_PUB }],
      reseed: true,
    });
    expect(reseeded.pinnedKeyFor('bob-test')).toBe(BOB_PUB);
  });

  it('rejects a replayed or older rotation statement, across restarts', () => {
    const store = PinStore.open({ filePath: file(), seeds: [{ agentId: 'bob-test', publicKeyHex: BOB_PUB }] });
    const t1 = new Date(Date.now() - 60_000).toISOString();
    const t2 = new Date().toISOString();
    const forward = signMessage(
      DOMAIN_PREFIXES.KEY_ROTATION,
      { agent_id: 'bob-test', old_fpr: keyFingerprint(BOB_PUB), new_fpr: keyFingerprint(OTHER_PUB), issued_at: t1 },
      BOB_SEED,
    );
    const back = signMessage(
      DOMAIN_PREFIXES.KEY_ROTATION,
      { agent_id: 'bob-test', old_fpr: keyFingerprint(OTHER_PUB), new_fpr: keyFingerprint(BOB_PUB), issued_at: t2 },
      OTHER_SEED,
    );
    store.applyRotation(forward, OTHER_PUB);
    store.applyRotation(back, BOB_PUB);
    const restarted = PinStore.open({ filePath: file() });
    expect(restarted.pinnedKeyFor('bob-test')).toBe(BOB_PUB);
    expect(() => restarted.applyRotation(forward, OTHER_PUB)).toThrow(/already applied or is not newer/);
    expect(restarted.pinnedKeyFor('bob-test')).toBe(BOB_PUB);
  });

  it('keeps at most a bounded number of pending first-contact keys', () => {
    const store = PinStore.inMemory([], 'tofu');
    for (let i = 0; i < MAX_PENDING_PINS + 10; i++) {
      expect(() => store.checkPresentedKey(`agent-${i}`, BOB_PUB)).toThrow(PinError);
    }
    expect(store.listPending()).toHaveLength(MAX_PENDING_PINS);
  });
});

// ── TOFU and the CLI ────────────────────────────────────────────────────────

function cliIo(answer: string, interactive = true): PinsCliIo & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    isInteractive: interactive,
    prompt: async () => answer,
  };
}

describe('first-contact confirmation (tofu)', () => {
  it('records the key as pending and needs a person to confirm the fingerprint in a terminal', async () => {
    const file = path.join(tmp, '.selkey', 'pins.json');
    const store = PinStore.open({ filePath: file, mode: 'tofu' });
    mockPeer(BOB_PUB, (id) => admit(BOB_SEED, { proposal_id: id }));
    const transport = initiator(store);

    await expect(transport.sendPropose({ propose: propose(), templateId: 't', budgetTier: 'SMALL' })).rejects.toMatchObject({
      code: 'NEEDS_CONFIRMATION',
    });
    expect(store.pinnedKeyFor('bob-test')).toBeUndefined();

    // A non-interactive caller (e.g. an agent's shell tool) cannot confirm.
    const fromDisk = PinStore.open({ filePath: file, mode: 'tofu' });
    expect(await runPinsCli(['confirm', 'bob-test'], fromDisk, cliIo(keyFingerprint(BOB_PUB), false))).toBe(1);
    // A wrong fingerprint is refused.
    expect(await runPinsCli(['confirm', 'bob-test'], fromDisk, cliIo(keyFingerprint(OTHER_PUB)))).toBe(1);
    expect(await runPinsCli(['confirm', 'bob-test'], fromDisk, cliIo(keyFingerprint(BOB_PUB)))).toBe(0);

    const confirmed = PinStore.open({ filePath: file, mode: 'tofu' });
    expect(confirmed.pinnedKeyFor('bob-test')).toBe(BOB_PUB);
    const result = await initiator(confirmed).sendPropose({ propose: propose(), templateId: 't', budgetTier: 'SMALL' });
    expect(result).toBeDefined();
  });
});

// ── Initiator binding ───────────────────────────────────────────────────────

describe('initiator verifies peers against pins', () => {
  it('rejects a self-signed agent card whose key is not pinned', async () => {
    const fetchMock = mockPeer(OTHER_PUB, (id) => admit(OTHER_SEED, { proposal_id: id }));
    const transport = initiator(PinStore.inMemory());
    await expect(
      transport.sendPropose({ propose: propose(), templateId: 't', budgetTier: 'SMALL' }),
    ).rejects.toThrow(/No pinned key for agent "bob-test"/);
    // Nothing was proposed to the unpinned peer.
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/propose'))).toBe(false);
  });

  it('rejects a peer whose card key differs from the pin, even if its ADMIT verifies under that key', async () => {
    mockPeer(OTHER_PUB, (id) => admit(OTHER_SEED, { proposal_id: id }));
    const transport = initiator(PinStore.inMemory([{ agentId: 'bob-test', publicKeyHex: BOB_PUB }]));
    await expect(
      transport.sendPropose({ propose: propose(), templateId: 't', budgetTier: 'SMALL' }),
    ).rejects.toMatchObject({ code: 'KEY_CHANGED' });
  });

  it('does not use endpoints from an unsigned agent card, even one carrying the pinned key', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(unsignedCard(BOB_PUB, { afal_endpoint: 'http://other-host.example/afal' })),
        text: () => Promise.resolve(''),
        url,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const transport = initiator(PinStore.inMemory([{ agentId: 'bob-test', publicKeyHex: BOB_PUB }]));
    await expect(
      transport.sendPropose({ propose: propose(), templateId: 't', budgetTier: 'SMALL' }),
    ).rejects.toThrow();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('other-host.example'))).toBe(false);
    expect(await transport.discoverPeerAgentCard()).toBeNull();
  });

  it('does not use a card whose signed fields were changed', async () => {
    const tampered = card(BOB_PUB);
    const ext = (tampered.capabilities as { extensions: Array<{ params: Record<string, unknown> }> }).extensions[0];
    ext.params['afal_endpoint'] = 'http://other-host.example/afal';
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(tampered) }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = initiator(PinStore.inMemory([{ agentId: 'bob-test', publicKeyHex: BOB_PUB }]));
    await expect(
      transport.sendPropose({ propose: propose(), templateId: 't', budgetTier: 'SMALL' }),
    ).rejects.toThrow();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('other-host.example'))).toBe(false);
  });

  it('accepts an ADMIT signed by the pinned key', async () => {
    mockPeer(BOB_PUB, (id) => admit(BOB_SEED, { proposal_id: id }));
    const transport = initiator(PinStore.inMemory([{ agentId: 'bob-test', publicKeyHex: BOB_PUB }]));
    const p = propose();
    await transport.sendPropose({ propose: p, templateId: 't', budgetTier: 'SMALL' });
    expect(transport._getStoredAdmit(p.proposal_id)).toBeDefined();
  });

  it('rejects an ADMIT that answers a different proposal', async () => {
    mockPeer(BOB_PUB, () => admit(BOB_SEED, { proposal_id: 'f'.repeat(64) }));
    const transport = initiator(PinStore.inMemory([{ agentId: 'bob-test', publicKeyHex: BOB_PUB }]));
    await expect(
      transport.sendPropose({ propose: propose(), templateId: 't', budgetTier: 'SMALL' }),
    ).rejects.toThrow(/ADMIT proposal_id does not match/);
  });

  it('sends acceptable_model_profiles in the signed PROPOSE', async () => {
    const fetchMock = mockPeer(BOB_PUB, (id) => admit(BOB_SEED, { proposal_id: id, selected_model_profile: PROFILE_B }));
    const transport = initiator(PinStore.inMemory([{ agentId: 'bob-test', publicKeyHex: BOB_PUB }]));
    const p = propose({ acceptable_model_profiles: [PROFILE_A, PROFILE_B] });
    const result = await transport.sendPropose({ propose: p, templateId: 't', budgetTier: 'SMALL' });
    expect(result?.selectedModelProfile).toEqual(PROFILE_B);
    const sent = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/propose'));
    const body = JSON.parse(String(sent?.[1]?.body)) as { propose: Record<string, unknown> };
    expect(body.propose['acceptable_model_profiles']).toEqual([PROFILE_A, PROFILE_B]);
  });
});

describe('ADMIT binding', () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const p = propose({ acceptable_model_profiles: [PROFILE_A] });
  const base = { proposal_id: p.proposal_id, expires_at: new Date(now + 10 * 60 * 1000).toISOString() };

  it('accepts a matching ADMIT that expires within 10 minutes', () => {
    expect(() => checkAdmitBinding({ ...base, selected_model_profile: PROFILE_A }, p, now)).not.toThrow();
  });

  it('rejects an ADMIT valid for more than 10 minutes', () => {
    expect(() =>
      checkAdmitBinding({ ...base, expires_at: new Date(now + 60 * 60 * 1000).toISOString() }, p, now),
    ).toThrow(/more than 10 minutes/);
  });

  it('rejects an expired ADMIT', () => {
    expect(() => checkAdmitBinding({ ...base, expires_at: new Date(now - 1).toISOString() }, p, now)).toThrow(
      /expired/,
    );
  });

  it('rejects a selected model profile that was not offered', () => {
    expect(() => checkAdmitBinding({ ...base, selected_model_profile: PROFILE_B }, p, now)).toThrow(
      /not among the profiles offered/,
    );
    const single = propose();
    expect(() =>
      checkAdmitBinding(
        { proposal_id: single.proposal_id, expires_at: base.expires_at, selected_model_profile: PROFILE_B },
        single,
        now,
      ),
    ).toThrow(/not among the profiles offered/);
  });
});

// ── Negotiation selections ──────────────────────────────────────────────────

describe('negotiation selections are checked against the offered candidates', () => {
  it('rejects a contract offer or model profile that was not offered', async () => {
    const proposal = {
      negotiation_id: 'neg-1',
      acceptable_offers: [
        { kind: 'offer' as const, contract_offer_id: 'offer-1', acceptable_model_profiles: [PROFILE_A] },
      ],
      expected_counterparty: 'bob-test',
    };
    const cardWithNegotiation = card(BOB_PUB, {
      supports_precontract_negotiation: true,
      supported_contract_offers: [{ contract_offer_id: 'offer-1', supported_model_profiles: [PROFILE_A] }],
    });

    for (const [selection, message] of [
      [{ negotiation_id: 'neg-1', state: 'AGREED', selected_contract_offer_id: 'offer-2', selected_model_profile: PROFILE_A }, /not offered/],
      [{ negotiation_id: 'neg-1', state: 'AGREED', selected_contract_offer_id: 'offer-1', selected_model_profile: PROFILE_B }, /model profile that was not offered/],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve(url.endsWith('/negotiate') ? selection : cardWithNegotiation),
          }),
        ),
      );
      const transport = initiator(PinStore.inMemory([{ agentId: 'bob-test', publicKeyHex: BOB_PUB }]));
      await expect(transport.negotiateContractOffer(proposal)).rejects.toThrow(message);
    }
  });

  it('rejects a topic code that was not offered', async () => {
    const cardWithTopics = card(BOB_PUB, {
      supports_topic_alignment: true,
      supported_topic_codes: ['salary_alignment', 'reference_check'],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              url.endsWith('/negotiate')
                ? { alignment_id: 'al-1', state: 'ALIGNED', selected_topic_code: 'reference_check' }
                : cardWithTopics,
            ),
        }),
      ),
    );
    const transport = initiator(PinStore.inMemory([{ agentId: 'bob-test', publicKeyHex: BOB_PUB }]));
    await expect(
      transport.alignTopic({ alignment_id: 'al-1', acceptable_topic_codes: ['salary_alignment'], expected_counterparty: 'bob-test' }),
    ).rejects.toThrow(/topic code that was not offered/);
  });

});

// ── Responder: authenticated negotiation requests ───────────────────────────

describe('negotiation requests at the responder', () => {
  let server: AfalHttpServer;
  let baseUrl: string;

  beforeEach(async () => {
    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: BOB_SEED,
      policy: {
        trustedAgents: [{ agentId: 'alice-test', publicKeyHex: ALICE_PUB }],
        allowedPurposeCodes: ['MEDIATION'],
        allowedLaneIds: ['API_MEDIATED'],
        maxEntropyBits: 256,
        defaultTier: 'DENY',
      },
    });
    const local = descriptor('bob-test', BOB_PUB, BOB_SEED);
    (local.capabilities as Record<string, unknown>)['supported_contract_offers'] = [
      { contract_offer_id: 'offer-1', supported_model_profiles: [PROFILE_A] },
    ];
    server = new AfalHttpServer({ port: 0, responder, localDescriptor: local });
    await server.start();
    baseUrl = `http://127.0.0.1:${server.port}`;
  });
  afterEach(async () => {
    await server.stop();
  });

  const proposal = {
    negotiation_id: 'neg-1',
    acceptable_offers: [{ kind: 'offer', contract_offer_id: 'offer-1', acceptable_model_profiles: [PROFILE_A] }],
    expected_counterparty: 'bob-test',
  };

  async function post(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/afal/negotiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('answers a request signed by a pinned agent', async () => {
    const res = await post(signNegotiationRequest('CONTRACT_OFFER_PROPOSAL', proposal, 'alice-test', ALICE_SEED));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>)['state']).toBe('AGREED');
  });

  it('rejects an unsigned request', async () => {
    const res = await post(proposal);
    expect(res.status).toBe(401);
  });

  it('rejects a request from an unpinned agent', async () => {
    const res = await post(signNegotiationRequest('CONTRACT_OFFER_PROPOSAL', proposal, 'mallory', OTHER_SEED));
    expect(res.status).toBe(401);
  });

  it('rejects a request naming a pinned agent but signed with another key', async () => {
    const res = await post(signNegotiationRequest('CONTRACT_OFFER_PROPOSAL', proposal, 'alice-test', OTHER_SEED));
    expect(res.status).toBe(401);
  });

  it('rejects a request addressed to another agent', async () => {
    const res = await post(
      signNegotiationRequest(
        'CONTRACT_OFFER_PROPOSAL',
        { ...proposal, expected_counterparty: 'carol-test' },
        'alice-test',
        ALICE_SEED,
      ),
    );
    expect(res.status).toBe(401);
  });

  it('rejects an unsigned request over A2A SendMessage', async () => {
    const res = await fetch(`${baseUrl}${A2A_SEND_MESSAGE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildA2ASendMessageRequest({
          mediaType: SELKEY_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
          data: proposal,
          acceptedOutputModes: [SELKEY_CONTRACT_OFFER_SELECTION_MEDIA_TYPE],
        }),
      ),
    });
    expect(res.status).toBe(401);
  });
});

// ── Responder: COMMIT under the current pin ─────────────────────────────────

describe('responder COMMIT', () => {
  it('rejects a COMMIT when the proposer was re-pinned after PROPOSE', () => {
    const pins = PinStore.inMemory([{ agentId: 'alice-test', publicKeyHex: ALICE_PUB }]);
    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: BOB_SEED,
      pins,
      policy: {
        trustedAgents: [],
        allowedPurposeCodes: ['MEDIATION'],
        allowedLaneIds: ['API_MEDIATED'],
        maxEntropyBits: 256,
        defaultTier: 'DENY',
      },
    });
    const p = propose();
    const signed = signMessage(DOMAIN_PREFIXES.PROPOSE, p as unknown as Record<string, unknown>, ALICE_SEED);
    const result = responder.handlePropose({ propose: signed });
    expect(result.outcome).toBe('ADMIT');
    pins.setPin('alice-test', OTHER_PUB);
    const commit = signMessage(
      DOMAIN_PREFIXES.COMMIT,
      {
        commit_version: '1',
        proposal_id: p.proposal_id,
        from: 'alice-test',
        admit_token_id: result.response['admit_token_id'],
        relay_session: {
          session_id: 's',
          responder_submit_token: 't',
          responder_read_token: 'r',
          relay_url: 'http://relay.test',
          contract_hash: 'h',
        },
      },
      ALICE_SEED,
    );
    expect(responder.handleCommit(commit)).toMatchObject({ ok: false, error: expect.stringMatching(/pin changed/) });
  });
});

// ── IFC aliases ─────────────────────────────────────────────────────────────

describe('IFC counterparty aliases', () => {
  it('does not match an alias case-insensitively', async () => {
    const alice = new IfcService({
      agentId: 'alice-test',
      seedHex: ALICE_SEED,
      verifyingKeyHex: ALICE_PUB,
      knownAgents: [
        {
          agent_id: 'bob-test',
          aliases: ['Bob'],
          public_key_hex: BOB_PUB,
          a2a_send_message_url: 'http://peer.example.com/a2a/send-message',
        },
      ],
    });
    const { grant } = alice.createGrant({
      audience: 'bob-test',
      receipt_id: 'a'.repeat(64),
      session_id: '11111111-1111-1111-1111-111111111111',
      message_classes: ['LOGISTICS'],
      max_uses: 1,
      expires_in_seconds: 60,
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })));
    await expect(
      alice.sendMessage({
        counterparty: 'BOB',
        grant,
        message_class: 'LOGISTICS',
        payload: 'hi',
        related_receipt_id: 'a'.repeat(64),
        related_session_id: '11111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow(/grant audience does not match counterparty/);
  });
});
