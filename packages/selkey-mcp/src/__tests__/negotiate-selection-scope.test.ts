/**
 * Pre-contract negotiation must not change which contracts RESPOND accepts.
 *
 * A selection made at /afal/negotiate (even for a pinned, authenticated
 * caller) is not added to the responder's accepted set. Bespoke
 * contracts are accepted only via an explicit expected_contract_hash.
 */

import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

// Stand-in for an admitted registry: every bespoke selection validates and
// compiles to a contract carrying the named refs.
vi.mock('../bespoke-contracts.js', async () => {
  const contracts = await import('selkey/contracts');
  return {
    supportsBespokePrecontractNegotiation: () => true,
    advertisesBespokeContractNegotiation: () => true,
    resolveNegotiationRegistryPath: () => '/registry',
    validateBespokeContractSelection: async () => true,
    resolveBespokeContractToContract: async (params: {
      contract: { purpose_code: string; schema_ref: string; program_ref: string };
      participants: string[];
      selectedModelProfile: { id: string; hash: string; version: string };
    }) => {
      const base = contracts.buildRelayContract(params.contract.purpose_code, params.participants);
      if (!base) throw new Error('unknown purpose');
      return contracts.withRelayContractModelProfile(
        {
          ...base,
          output_schema_id: params.contract.schema_ref,
          metadata: { program: params.contract.program_ref },
        },
        params.selectedModelProfile,
      );
    },
  };
});

import { computeRelayContractHash } from 'selkey/contracts';
import { AfalHttpServer } from '../afal-http-server.js';
import { AfalResponder } from '../afal-responder.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { signMessage, DOMAIN_PREFIXES } from '../afal-signing.js';
import { listKnownModelProfiles } from '../model-profiles.js';
import { buildExpectedContractHashes } from '../responder-contracts.js';
import { signNegotiationRequest } from '../negotiation-auth.js';
import { compileResolvedAgreement, resolvedAgreementFromBespoke } from '../resolved-agreement.js';

const SEED = '02'.repeat(32);
const PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(SEED)));
const CAROL_SEED = '03'.repeat(32);
const CAROL_PUB = bytesToHex(ed25519.getPublicKey(hexToBytes(CAROL_SEED)));

describe('negotiation selections and the responder contract set', () => {
  it('does not add a bespoke selection from /afal/negotiate to the contracts RESPOND accepts', async () => {
    const descriptor = signMessage(
      DOMAIN_PREFIXES.DESCRIPTOR,
      {
        descriptor_version: '1',
        agent_id: 'bob-test',
        issued_at: '2026-01-01T00:00:00Z',
        expires_at: '2099-12-31T23:59:59Z',
        identity_key: { algorithm: 'ed25519', public_key_hex: PUB },
        envelope_key: { algorithm: 'ed25519', public_key_hex: PUB },
        endpoints: { propose: '', commit: '' },
        capabilities: { supported_body_formats: ['wrapped_v1'], supports_commit: true },
        policy_commitments: {},
      },
      SEED,
    ) as unknown as AgentDescriptor;
    const responder = new AfalResponder({
      agentId: 'bob-test',
      seedHex: SEED,
      policy: {
        trustedAgents: [{ agentId: 'carol-test', publicKeyHex: CAROL_PUB }],
        allowedPurposeCodes: ['MEDIATION'],
        allowedLaneIds: ['API_MEDIATED'],
        maxEntropyBits: 256,
        defaultTier: 'DENY',
      },
    });
    const server = new AfalHttpServer({
      port: 0,
      responder,
      localDescriptor: descriptor,
      relayUrl: 'http://relay.test',
      supportedPurposes: ['MEDIATION'],
    });
    await server.start();

    const profile = listKnownModelProfiles()[0];
    const bespoke = {
      purpose_code: 'MEDIATION',
      schema_ref: 'custom_schema',
      policy_ref: 'custom_policy',
      program_ref: 'custom_program',
    };
    let selection: { state: string; selected_model_profile: typeof profile };
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/afal/negotiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          signNegotiationRequest(
            'CONTRACT_OFFER_PROPOSAL',
            {
              negotiation_id: 'neg-1',
              acceptable_offers: [{ kind: 'bespoke', ...bespoke, acceptable_model_profiles: [profile] }],
              expected_counterparty: 'bob-test',
            },
            'carol-test',
            CAROL_SEED,
          ),
        ),
      });
      selection = (await res.json()) as typeof selection;
    } finally {
      await server.stop();
    }
    expect(selection.state).toBe('AGREED');

    const participants: [string, string] = ['carol-test', 'bob-test'];
    const compiled = await compileResolvedAgreement({
      agreement: resolvedAgreementFromBespoke({
        contract: bespoke,
        selectedModelProfile: selection.selected_model_profile,
      }),
      participants,
    });
    const accepted = await buildExpectedContractHashes({ purposes: ['MEDIATION'], participants });
    expect(accepted.has(computeRelayContractHash(compiled))).toBe(false);
  });
});
