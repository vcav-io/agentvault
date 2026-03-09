import { describe, it, expect, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  buildAgentCard,
  buildCardSignedPayload,
  signAgentCard,
  verifyAgentCardSignature,
  AGENTVAULT_A2A_EXTENSION_URI,
} from '../a2a-agent-card.js';
import type { AgentVaultA2AExtensionParams } from '../a2a-agent-card.js';
import { DirectAfalTransport } from '../direct-afal-transport.js';
import type { AgentDescriptor } from '../direct-afal-transport.js';
import { signMessage, DOMAIN_PREFIXES } from '../afal-signing.js';

// ── Test keypairs ────────────────────────────────────────────────────────────

const TEST_SEED_HEX = '0101010101010101010101010101010101010101010101010101010101010101';
const TEST_PUBLIC_KEY_HEX = bytesToHex(ed25519.getPublicKey(hexToBytes(TEST_SEED_HEX)));

const PEER_SEED_HEX = '0202020202020202020202020202020202020202020202020202020202020202';
const PEER_PUBLIC_KEY_HEX = bytesToHex(ed25519.getPublicKey(hexToBytes(PEER_SEED_HEX)));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDescriptor(agentId: string, publicKeyHex: string): AgentDescriptor {
  return {
    descriptor_version: '1',
    agent_id: agentId,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    identity_key: { algorithm: 'ed25519', public_key_hex: publicKeyHex },
    envelope_key: { algorithm: 'ed25519', public_key_hex: publicKeyHex },
    endpoints: { propose: '', commit: '' },
    capabilities: {},
    policy_commitments: {},
  };
}

function makeSignedDescriptor(
  agentId: string,
  publicKeyHex: string,
  seedHex: string,
): AgentDescriptor {
  const unsigned = makeDescriptor(agentId, publicKeyHex);
  return signMessage(
    DOMAIN_PREFIXES.DESCRIPTOR,
    unsigned as unknown as Record<string, unknown>,
    seedHex,
  ) as unknown as AgentDescriptor;
}

function makeExtensionParams(overrides?: Partial<AgentVaultA2AExtensionParams>): AgentVaultA2AExtensionParams {
  return {
    public_key_hex: TEST_PUBLIC_KEY_HEX,
    supported_purposes: ['COMPATIBILITY'],
    relay_url: 'https://relay.example.com',
    a2a_send_message_url: 'http://localhost:3000/a2a/send-message',
    afal_endpoint: 'http://localhost:3000/afal',
    ...overrides,
  };
}

// ── Pure function tests ──────────────────────────────────────────────────────

describe('buildCardSignedPayload', () => {
  it('includes all trust-relevant fields', () => {
    const params = makeExtensionParams();
    const payload = buildCardSignedPayload('test-agent', params);

    expect(payload.agent_id).toBe('test-agent');
    expect(payload.extension_uri).toBe(AGENTVAULT_A2A_EXTENSION_URI);
    expect(payload.extension_version).toBe('1');
    expect(payload.public_key_hex).toBe(TEST_PUBLIC_KEY_HEX);
    expect(payload.supported_purposes).toEqual(['COMPATIBILITY']);
    expect(payload.relay_url).toBe('https://relay.example.com');
    expect(payload.a2a_send_message_url).toBe('http://localhost:3000/a2a/send-message');
    expect(payload.afal_endpoint).toBe('http://localhost:3000/afal');
  });

  it('omits optional fields when not present', () => {
    const params = makeExtensionParams();
    delete params.relay_url;
    delete params.afal_endpoint;
    delete params.a2a_send_message_url;
    const payload = buildCardSignedPayload('test-agent', params);

    expect(payload).not.toHaveProperty('relay_url');
    expect(payload).not.toHaveProperty('afal_endpoint');
    expect(payload).not.toHaveProperty('a2a_send_message_url');
  });
});

describe('signAgentCard / verifyAgentCardSignature round-trip', () => {
  it('produces a valid signature that verifies', () => {
    const params = makeExtensionParams();
    const signature = signAgentCard('test-agent', params, TEST_SEED_HEX);

    expect(typeof signature).toBe('string');
    expect(signature.length).toBe(128); // 64 bytes = 128 hex chars

    const valid = verifyAgentCardSignature('test-agent', params, signature, TEST_PUBLIC_KEY_HEX);
    expect(valid).toBe(true);
  });

  it('rejects tampered relay_url', () => {
    const params = makeExtensionParams();
    const signature = signAgentCard('test-agent', params, TEST_SEED_HEX);

    const tampered = makeExtensionParams({ relay_url: 'https://evil-relay.example.com' });
    const valid = verifyAgentCardSignature('test-agent', tampered, signature, TEST_PUBLIC_KEY_HEX);
    expect(valid).toBe(false);
  });

  it('rejects tampered agent_id (card.name mismatch)', () => {
    const params = makeExtensionParams();
    const signature = signAgentCard('test-agent', params, TEST_SEED_HEX);

    // Verify with different agent_id — simulates card served under wrong name
    const valid = verifyAgentCardSignature('evil-agent', params, signature, TEST_PUBLIC_KEY_HEX);
    expect(valid).toBe(false);
  });

  it('rejects signature from wrong key', () => {
    const params = makeExtensionParams({ public_key_hex: PEER_PUBLIC_KEY_HEX });
    const signature = signAgentCard('test-agent', params, PEER_SEED_HEX);

    // Try to verify with a different key
    const valid = verifyAgentCardSignature('test-agent', params, signature, TEST_PUBLIC_KEY_HEX);
    expect(valid).toBe(false);
  });
});

describe('buildAgentCard with seedHex', () => {
  it('includes card_signature in extension params when seedHex is provided', () => {
    const descriptor = makeDescriptor('test-agent', TEST_PUBLIC_KEY_HEX);
    const card = buildAgentCard({
      baseUrl: 'http://localhost:3000',
      descriptor,
      supportedPurposes: ['COMPATIBILITY'],
      relayUrl: 'https://relay.example.com',
      seedHex: TEST_SEED_HEX,
    });

    const ext = card.capabilities.extensions[0];
    expect(ext.params['card_signature']).toBeDefined();
    expect(typeof ext.params['card_signature']).toBe('string');
    expect((ext.params['card_signature'] as string).length).toBe(128);

    // Verify the signature is valid
    const extensionParams: AgentVaultA2AExtensionParams = {
      public_key_hex: ext.params['public_key_hex'] as string,
      supported_purposes: ext.params['supported_purposes'] as string[],
      relay_url: ext.params['relay_url'] as string,
      a2a_send_message_url: ext.params['a2a_send_message_url'] as string,
      afal_endpoint: ext.params['afal_endpoint'] as string,
    };

    const valid = verifyAgentCardSignature(
      card.name,
      extensionParams,
      ext.params['card_signature'] as string,
      ext.params['public_key_hex'] as string,
    );
    expect(valid).toBe(true);
  });

  it('omits card_signature when seedHex is not provided', () => {
    const descriptor = makeDescriptor('test-agent', TEST_PUBLIC_KEY_HEX);
    const card = buildAgentCard({
      baseUrl: 'http://localhost:3000',
      descriptor,
      supportedPurposes: ['COMPATIBILITY'],
    });

    const ext = card.capabilities.extensions[0];
    expect(ext.params['card_signature']).toBeUndefined();
  });
});

// ── Transport-level tests ────────────────────────────────────────────────────

describe('tryResolvePeerViaAgentCard card signature verification (transport-level)', () => {
  let responderTransport: DirectAfalTransport;
  let initiatorTransport: DirectAfalTransport;

  afterEach(async () => {
    if (responderTransport) await responderTransport.stop();
  });

  /**
   * Start a responder transport that serves an agent card.
   * Returns the agent card URL for the initiator to discover.
   */
  async function startResponder(opts?: {
    seedHex?: string;
    advertiseAfalEndpoint?: boolean;
  }): Promise<string> {
    const peerDescriptor = makeSignedDescriptor('peer-agent', PEER_PUBLIC_KEY_HEX, PEER_SEED_HEX);

    responderTransport = new DirectAfalTransport({
      agentId: 'peer-agent',
      seedHex: PEER_SEED_HEX,
      localDescriptor: peerDescriptor,
      respondMode: {
        httpPort: 0,
        bindAddress: '127.0.0.1',
        policy: {
          trustedAgents: [],
          allowedPurposeCodes: ['COMPATIBILITY'],
          allowedLaneIds: ['API_MEDIATED'],
          maxEntropyBits: 256,
          defaultTier: 'DENY',
        },
        advertiseAfalEndpoint: opts?.advertiseAfalEndpoint,
      },
    });

    // Patch the seedHex onto the HTTP server config so the agent card is signed
    // (or not, depending on the test). The constructor always passes the
    // transport's seedHex; override it here for control.
    const httpServer = (responderTransport as unknown as { httpServer: { config: { seedHex?: string } } }).httpServer;
    if (opts && 'seedHex' in opts) {
      httpServer.config.seedHex = opts.seedHex;
    }

    await responderTransport.start();

    const server = responderTransport as unknown as { httpServer: { port: number } };
    return `http://127.0.0.1:${server.httpServer.port}`;
  }

  it('accepts unsigned card in lenient mode (default)', async () => {
    // Start responder WITHOUT seedHex — card will be unsigned
    const baseUrl = await startResponder({ seedHex: undefined });

    const localDescriptor = makeSignedDescriptor('local-agent', TEST_PUBLIC_KEY_HEX, TEST_SEED_HEX);
    initiatorTransport = new DirectAfalTransport({
      agentId: 'local-agent',
      seedHex: TEST_SEED_HEX,
      localDescriptor,
      peerDescriptorUrl: `${baseUrl}/.well-known/agent-card.json`,
      // requireSignedCards defaults to false (lenient mode)
    });

    const discovery = await initiatorTransport.discoverPeerAgentCard();
    expect(discovery).not.toBeNull();
    expect(discovery!.supportedPurposes).toContain('COMPATIBILITY');
  });

  it('rejects unsigned card in strict mode', async () => {
    // Start responder WITHOUT seedHex — card will be unsigned
    const baseUrl = await startResponder({ seedHex: undefined });

    const localDescriptor = makeSignedDescriptor('local-agent', TEST_PUBLIC_KEY_HEX, TEST_SEED_HEX);
    initiatorTransport = new DirectAfalTransport({
      agentId: 'local-agent',
      seedHex: TEST_SEED_HEX,
      localDescriptor,
      peerDescriptorUrl: `${baseUrl}/.well-known/agent-card.json`,
      requireSignedCards: true,
    });

    await expect(initiatorTransport.discoverPeerAgentCard()).rejects.toThrow(
      'unsigned',
    );
  });

  it('accepts signed card with valid signature', async () => {
    // Start responder WITH seedHex — card will be signed
    const baseUrl = await startResponder({ seedHex: PEER_SEED_HEX });

    const localDescriptor = makeSignedDescriptor('local-agent', TEST_PUBLIC_KEY_HEX, TEST_SEED_HEX);
    initiatorTransport = new DirectAfalTransport({
      agentId: 'local-agent',
      seedHex: TEST_SEED_HEX,
      localDescriptor,
      peerDescriptorUrl: `${baseUrl}/.well-known/agent-card.json`,
      requireSignedCards: true,
    });

    const discovery = await initiatorTransport.discoverPeerAgentCard();
    expect(discovery).not.toBeNull();
    expect(discovery!.supportedPurposes).toContain('COMPATIBILITY');
  });

  it('strict mode rejects card that omits a2a_send_message_url from signed payload even if card.url is present', async () => {
    // Start responder WITH seedHex but WITHOUT afal_endpoint — this means
    // the card has a2a_send_message_url in it (set by buildAgentCard).
    // We need to test: signed card where a2a_send_message_url is NOT in the
    // extension params, but card.url IS present. In strict mode, the resolver
    // must not fall back to deriving a2a_send_message_url from card.url.
    //
    // To achieve this, we start a normal responder, then intercept the agent
    // card serving to strip a2a_send_message_url from the params (while keeping
    // the card.url and re-signing without it).
    const peerDescriptor = makeSignedDescriptor('peer-agent', PEER_PUBLIC_KEY_HEX, PEER_SEED_HEX);

    responderTransport = new DirectAfalTransport({
      agentId: 'peer-agent',
      seedHex: PEER_SEED_HEX,
      localDescriptor: peerDescriptor,
      respondMode: {
        httpPort: 0,
        bindAddress: '127.0.0.1',
        policy: {
          trustedAgents: [],
          allowedPurposeCodes: ['COMPATIBILITY'],
          allowedLaneIds: ['API_MEDIATED'],
          maxEntropyBits: 256,
          defaultTier: 'DENY',
        },
        // No afal_endpoint either — so the only way to get an endpoint
        // would be fallback from card.url
        advertiseAfalEndpoint: false,
      },
    });

    await responderTransport.start();

    const server = responderTransport as unknown as { httpServer: { port: number; config: { seedHex?: string } } };
    const baseUrl = `http://127.0.0.1:${server.httpServer.port}`;

    // The card built by buildAgentCard always includes a2a_send_message_url.
    // We need to override the agentCard getter to produce a card where
    // a2a_send_message_url is absent from extension params but card.url
    // is present, and the card is signed over that (no a2a_send_message_url).
    //
    // We do this by building a custom card and overriding the getter.
    const httpServerObj = (responderTransport as unknown as { httpServer: { agentCard: unknown } }).httpServer;
    const customExtParams: AgentVaultA2AExtensionParams = {
      public_key_hex: PEER_PUBLIC_KEY_HEX,
      supported_purposes: ['COMPATIBILITY'],
      // NO a2a_send_message_url
      // NO afal_endpoint
    };
    const cardSig = signAgentCard('peer-agent', customExtParams, PEER_SEED_HEX);
    const customCard = {
      name: 'peer-agent',
      description: 'Test card',
      version: '1.0.0',
      url: baseUrl, // card.url IS present
      capabilities: {
        extensions: [{
          uri: AGENTVAULT_A2A_EXTENSION_URI,
          description: 'Test',
          required: false,
          params: {
            ...customExtParams,
            card_signature: cardSig,
          },
        }],
      },
      skills: [],
    };
    Object.defineProperty(httpServerObj, 'agentCard', { get: () => customCard });

    const localDescriptor = makeSignedDescriptor('local-agent', TEST_PUBLIC_KEY_HEX, TEST_SEED_HEX);
    initiatorTransport = new DirectAfalTransport({
      agentId: 'local-agent',
      seedHex: TEST_SEED_HEX,
      localDescriptor,
      peerDescriptorUrl: `${baseUrl}/.well-known/agent-card.json`,
      requireSignedCards: true,
    });

    // In strict mode, since a2a_send_message_url is not in extension params,
    // the resolver must NOT fall back to deriving from card.url.
    // Without either a2a_send_message_url or afal_endpoint, discovery returns null.
    const discovery = await initiatorTransport.discoverPeerAgentCard();
    expect(discovery).toBeNull();
  });
});
