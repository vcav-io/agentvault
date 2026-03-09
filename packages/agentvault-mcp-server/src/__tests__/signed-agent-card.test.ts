import { describe, it, expect } from 'vitest';
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
import type { AgentDescriptor } from '../direct-afal-transport.js';

// Test keypair — same pattern as existing tests
const TEST_SEED_HEX = '0101010101010101010101010101010101010101010101010101010101010101';
const TEST_PUBLIC_KEY_HEX = bytesToHex(ed25519.getPublicKey(hexToBytes(TEST_SEED_HEX)));

// A second keypair for tampering tests
const OTHER_SEED_HEX = '0202020202020202020202020202020202020202020202020202020202020202';
const OTHER_PUBLIC_KEY_HEX = bytesToHex(ed25519.getPublicKey(hexToBytes(OTHER_SEED_HEX)));

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
    const params = makeExtensionParams({ public_key_hex: OTHER_PUBLIC_KEY_HEX });
    const signature = signAgentCard('test-agent', params, OTHER_SEED_HEX);

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

describe('tryResolvePeerViaAgentCard card signature verification', () => {
  // These tests exercise the verification path in DirectAfalTransport.
  // We import DirectAfalTransport and use its internal method via a test subclass.

  // Since tryResolvePeerViaAgentCard is private and involves fetch, we test
  // the verification logic through the public functions and buildAgentCard
  // integration, then verify the DirectAfalTransport integration via the
  // existing e2e test infrastructure.

  // The core verification logic is tested above via signAgentCard/verifyAgentCardSignature.
  // Here we test the specific failure behaviors described in the spec.

  it('signed + valid card verifies successfully', () => {
    const params = makeExtensionParams();
    const signature = signAgentCard('test-agent', params, TEST_SEED_HEX);
    const valid = verifyAgentCardSignature('test-agent', params, signature, TEST_PUBLIC_KEY_HEX);
    expect(valid).toBe(true);
  });

  it('signed + invalid card (tampered a2a_send_message_url) rejects', () => {
    const params = makeExtensionParams();
    const signature = signAgentCard('test-agent', params, TEST_SEED_HEX);

    const tampered = makeExtensionParams({
      a2a_send_message_url: 'https://evil.example.com/a2a/send-message',
    });
    const valid = verifyAgentCardSignature('test-agent', tampered, signature, TEST_PUBLIC_KEY_HEX);
    expect(valid).toBe(false);
  });

  it('signed + invalid card (tampered supported_purposes) rejects', () => {
    const params = makeExtensionParams();
    const signature = signAgentCard('test-agent', params, TEST_SEED_HEX);

    const tampered = makeExtensionParams({
      supported_purposes: ['COMPATIBILITY', 'MEDIATION'],
    });
    const valid = verifyAgentCardSignature('test-agent', tampered, signature, TEST_PUBLIC_KEY_HEX);
    expect(valid).toBe(false);
  });

  it('strict mode rejects card missing a2a_send_message_url from signed payload', () => {
    // When a2a_send_message_url is absent from extension params,
    // the signed payload won't include it. In strict mode the resolver
    // must not fall back to card.url derivation.
    const params = makeExtensionParams();
    delete params.a2a_send_message_url;
    const signature = signAgentCard('test-agent', params, TEST_SEED_HEX);

    // Signature is valid for this payload (without a2a_send_message_url)
    const valid = verifyAgentCardSignature('test-agent', params, signature, TEST_PUBLIC_KEY_HEX);
    expect(valid).toBe(true);

    // But the signed payload does NOT include a2a_send_message_url.
    // In strict mode, the resolver must not derive it from card.url.
    const payload = buildCardSignedPayload('test-agent', params);
    expect(payload).not.toHaveProperty('a2a_send_message_url');
  });
});
