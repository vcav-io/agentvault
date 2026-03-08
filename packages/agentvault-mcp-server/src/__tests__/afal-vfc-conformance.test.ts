import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { DirectAfalTransport } from '../direct-afal-transport.js';
import { AfalHttpServer } from '../afal-http-server.js';
import { AfalResponder } from '../afal-responder.js';
import type { AdmissionPolicy } from '../afal-responder.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { AGENTVAULT_A2A_EXTENSION_URI } from '../a2a-agent-card.js';
import { signMessage, DOMAIN_PREFIXES, contentHash } from '../afal-signing.js';
import { computeProposalId, generateNonce } from '../afal-types.js';
import type { AfalAdmit, AfalPropose, RelayInvitePayload } from '../afal-types.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const VFC_SCHEMA_DIR =
  process.env['VFC_SCHEMA_DIR'] ?? join(TEST_DIR, '../../../../../vfc/schemas');
const HAS_VFC_SCHEMAS = existsSync(VFC_SCHEMA_DIR);

const Ajv2020 = (await import('ajv/dist/2020.js')).default as unknown as new (
  ...args: unknown[]
) => any;
const addFormats = (await import('ajv-formats')).default as unknown as (ajv: unknown) => void;
const ajv: any = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function compileSchema(filename: string) {
  const schema = JSON.parse(readFileSync(join(VFC_SCHEMA_DIR, filename), 'utf8')) as object;
  return ajv.compile(schema);
}

const validateDescriptor = HAS_VFC_SCHEMAS
  ? compileSchema('afal_agent_descriptor.schema.json')
  : null;
const validatePropose = HAS_VFC_SCHEMAS ? compileSchema('afal_propose.schema.json') : null;
const validateAdmit = HAS_VFC_SCHEMAS ? compileSchema('afal_admit.schema.json') : null;
const validateDeny = HAS_VFC_SCHEMAS ? compileSchema('afal_deny.schema.json') : null;
const validateCommit = HAS_VFC_SCHEMAS ? compileSchema('afal_commit.schema.json') : null;

function assertSchema(
  validator: ReturnType<typeof compileSchema> | null,
  value: unknown,
  label: string,
): void {
  expect(validator, `${label}: schema validator should be available`).not.toBeNull();
  if (validator === null) return;
  const ok = validator(value);
  expect(ok, `${label}: ${ajv.errorsText(validator.errors ?? [])}`).toBe(true);
}

const ALICE_SEED = '0101010101010101010101010101010101010101010101010101010101010101';
const ALICE_PUBKEY = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';
const BOB_SEED = '0202020202020202020202020202020202020202020202020202020202020202';
const BOB_PUBKEY = bytesToHex(ed25519.getPublicKey(hexToBytes(BOB_SEED)));

function makeDescriptor(
  agentId: string,
  pubkeyHex: string,
  seedHex: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  const unsigned: Omit<AgentDescriptor, 'signature'> = {
    descriptor_version: '1',
    agent_id: agentId,
    issued_at: '2026-01-01T00:00:00Z',
    expires_at: '2099-12-31T23:59:59Z',
    identity_key: { algorithm: 'ed25519', public_key_hex: pubkeyHex },
    envelope_key: { algorithm: 'ed25519', public_key_hex: pubkeyHex },
    endpoints: {
      propose: 'http://127.0.0.1:9999/afal/propose',
      commit: 'http://127.0.0.1:9999/afal/commit',
    },
    capabilities: { supported_body_formats: ['wrapped_v1'], supports_commit: true },
    policy_commitments: {},
    ...overrides,
  };
  return signMessage(
    DOMAIN_PREFIXES.DESCRIPTOR,
    unsigned as Record<string, unknown>,
    seedHex,
  ) as unknown as AgentDescriptor;
}

function makePolicy(): AdmissionPolicy {
  return {
    trustedAgents: [{ agentId: 'alice-test', publicKeyHex: ALICE_PUBKEY }],
    allowedPurposeCodes: ['MEDIATION'],
    allowedLaneIds: ['API_MEDIATED'],
    maxEntropyBits: 256,
    defaultTier: 'DENY',
  };
}

function makePropose(localDescriptor: AgentDescriptor): AfalPropose {
  const fields: Omit<AfalPropose, 'proposal_id'> = {
    proposal_version: '1',
    nonce: generateNonce(),
    timestamp: new Date().toISOString(),
    from: 'alice-test',
    to: 'bob-test',
    descriptor_hash: contentHash(localDescriptor),
    purpose_code: 'MEDIATION',
    lane_id: 'API_MEDIATED',
    output_schema_id: 'vcav_e_mediation_signal_v2',
    output_schema_version: '1',
    model_profile_id: 'api-claude-sonnet-v1',
    model_profile_version: '1',
    model_profile_hash: '0'.repeat(64),
    requested_budget_tier: 'SMALL',
    requested_entropy_bits: 12,
    admission_tier_requested: 'DEFAULT',
  };
  return { ...fields, proposal_id: computeProposalId(fields) };
}

function makeRelay(): RelayInvitePayload {
  return {
    session_id: 'sess-001',
    responder_submit_token: 'submit-tok',
    responder_read_token: 'read-tok',
    relay_url: 'http://relay.example.com',
  };
}

const describeIfSchemas = HAS_VFC_SCHEMAS ? describe : describe.skip;

describeIfSchemas('AFAL VFC conformance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('served descriptor validates against the canonical VFC descriptor schema', async () => {
    const descriptor = makeDescriptor('bob-test', BOB_PUBKEY, BOB_SEED);
    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: BOB_SEED,
      policy: makePolicy(),
    });
    const server = new AfalHttpServer({ port: 0, responder, localDescriptor: descriptor });
    await server.start();
    try {
      const res = await fetch(`${server.baseUrl}/afal/descriptor`);
      const body = (await res.json()) as unknown;
      assertSchema(validateDescriptor, body, 'descriptor');
    } finally {
      await server.stop();
    }
  });

  it('served Agent Card exposes the AgentVault A2A extension params', async () => {
    const descriptor = makeDescriptor('bob-test', BOB_PUBKEY, BOB_SEED);
    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: BOB_SEED,
      policy: makePolicy(),
    });
    const server = new AfalHttpServer({
      port: 0,
      responder,
      localDescriptor: descriptor,
      relayUrl: 'http://relay.example.com',
      supportedPurposes: ['MEDIATION'],
    });
    await server.start();
    try {
      const res = await fetch(`${server.baseUrl}/.well-known/agent-card.json`);
      const body = (await res.json()) as Record<string, unknown>;
      const capabilities = body['capabilities'] as Record<string, unknown>;
      const extensions = capabilities['extensions'] as Array<Record<string, unknown>>;
      expect(extensions[0]?.['uri']).toBe(AGENTVAULT_A2A_EXTENSION_URI);
      expect((extensions[0]?.['params'] as Record<string, unknown>)['relay_url']).toBe(
        'http://relay.example.com',
      );
      expect((extensions[0]?.['params'] as Record<string, unknown>)['afal_endpoint']).toBe(
        `${server.baseUrl}/afal`,
      );
    } finally {
      await server.stop();
    }
  });

  it('DirectAfalTransport emits a PROPOSE that validates against the canonical VFC schema', async () => {
    const localDescriptor = makeDescriptor('alice-test', ALICE_PUBKEY, ALICE_SEED);
    const peerDescriptor = makeDescriptor('bob-test', BOB_PUBKEY, BOB_SEED);
    const propose = makePropose(localDescriptor);
    const relay = makeRelay();

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(peerDescriptor),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            signMessage(
              DOMAIN_PREFIXES.ADMIT,
              {
                admission_version: '1',
                proposal_id: propose.proposal_id,
                outcome: 'ADMIT',
                admit_token_id: 'a'.repeat(64),
                admission_tier: 'DEFAULT',
                expires_at: '2026-03-08T15:10:00.000Z',
              },
              BOB_SEED,
            ),
          ),
      });

    const transport = new DirectAfalTransport({
      agentId: 'alice-test',
      seedHex: ALICE_SEED,
      localDescriptor,
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
    });

    await transport.sendPropose({ propose, relay, templateId: 't', budgetTier: 'SMALL' });

    const [, init] = mockFetch.mock.calls[1] as [string, RequestInit];
    const wrapped = JSON.parse(init.body as string) as { propose: unknown };
    assertSchema(validatePropose, wrapped.propose, 'propose');
  });

  it('AfalResponder emits ADMIT and DENY envelopes that validate against canonical VFC schemas', () => {
    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: BOB_SEED,
      policy: makePolicy(),
    });
    const localDescriptor = makeDescriptor('alice-test', ALICE_PUBKEY, ALICE_SEED);
    const propose = makePropose(localDescriptor);
    const relay = makeRelay();
    const signedPropose = signMessage(
      DOMAIN_PREFIXES.PROPOSE,
      {
        ...propose,
        relay_binding_hash: contentHash(relay),
      } as Record<string, unknown>,
      ALICE_SEED,
    );

    const admit = responder.handlePropose({ propose: signedPropose, relay }).response;
    assertSchema(validateAdmit, admit, 'admit');

    const deny = responder.handlePropose({ propose: { bad: true }, relay: { bad: true } }).response;
    assertSchema(validateDeny, deny, 'deny');
  });

  it('DirectAfalTransport emits a COMMIT that validates against the canonical VFC schema', async () => {
    const localDescriptor = makeDescriptor('alice-test', ALICE_PUBKEY, ALICE_SEED);
    const transport = new DirectAfalTransport({
      agentId: 'alice-test',
      seedHex: ALICE_SEED,
      localDescriptor,
      peerDescriptorUrl: 'http://peer.example.com/afal/descriptor',
    });
    const propose = makePropose(localDescriptor);
    const admit = signMessage(
      DOMAIN_PREFIXES.ADMIT,
      {
        admission_version: '1',
        proposal_id: propose.proposal_id,
        outcome: 'ADMIT',
        admit_token_id: 'a'.repeat(64),
        admission_tier: 'DEFAULT',
        expires_at: '2026-03-08T15:10:00.000Z',
      },
      BOB_SEED,
    ) as unknown as AfalAdmit;
    const peerDescriptor = makeDescriptor('bob-test', BOB_PUBKEY, BOB_SEED);

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(admit),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('ok'),
      });

    transport._setPeerDescriptorForTesting(peerDescriptor);
    transport._setStoredAdmitForTesting(propose.proposal_id, admit);

    await transport.commitAdmit!(propose.proposal_id, {
      session_id: 'sess-001',
      responder_submit_token: 'sub-tok',
      responder_read_token: 'read-tok',
      relay_url: 'http://relay.example.com',
      contract_hash: 'c'.repeat(64),
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const commit = JSON.parse(init.body as string) as unknown;
    assertSchema(validateCommit, commit, 'commit');
  });
});
