import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createToolRegistry, getToolDefs } from '../tool-registry.js';
import type { AfalTransport, AfalInviteMessage } from '../afal-transport.js';
import { IfcService } from '../ifc.js';
import { _setDiscoverPollConfigForTesting } from '../tools/relaySignal.js';
import { _resetHandlesForTesting } from '../tools/relayHandles.js';

// This suite mocks `selkey/contracts` with schema-less contracts, which the
// owner-side disclosure ledger (on by default) refuses. The ledger itself is
// covered by entropy-ledger*.test.ts and the direct round trip in
// responder-contract-checks.test.ts.
beforeEach(() => {
  process.env['SELKEY_ENTROPY_LEDGER'] = 'off';
});
afterEach(() => {
  delete process.env['SELKEY_ENTROPY_LEDGER'];
});


// Mock selkey to avoid real HTTP calls
vi.mock('selkey', () => ({
  createAndSubmit: vi.fn().mockResolvedValue({
    sessionId: 'sess-mock',
    contractHash: 'hash-mock',
    initiatorReadToken: 'init-read-tok',
    responderSubmitToken: 'resp-sub-tok',
    responderReadToken: 'resp-read-tok',
  }),
  pollUntilDone: vi.fn().mockResolvedValue({ state: 'WAITING' }),
  joinAndWait: vi.fn(),
}));

vi.mock('selkey/http', () => ({
  submitInput: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('selkey/contracts', () => ({
  buildRelayContract: vi.fn().mockImplementation((purpose: string, participants: string[]) => {
    if (purpose === 'MEDIATION') {
      return {
        purpose_code: 'MEDIATION',
        output_schema_id: 'vcav_e_mediation_signal_v2',
        participants,
        entropy_budget_bits: 12,
        model_profile_id: 'api-claude-sonnet-v1',
        metadata: { scenario: 'cofounder-mediation', version: '3' },
      };
    }
    return undefined;
  }),
  listRelayPurposes: vi.fn().mockReturnValue(['MEDIATION', 'COMPATIBILITY']),
  computeRelayContractHash: vi.fn().mockReturnValue('relay-hash-mock'),
}));

function createMockTransport(invites: AfalInviteMessage[] = []): AfalTransport {
  return {
    sendPropose: vi.fn().mockResolvedValue(undefined),
    checkInbox: vi.fn().mockResolvedValue({ invites }),
    peekInbox: vi.fn().mockResolvedValue({ invites }),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    agentId: 'test-agent',
  };
}

beforeEach(() => {
  _resetHandlesForTesting();
  _setDiscoverPollConfigForTesting(0, 0);
  process.env['SELKEY_RELAY_URL'] = 'http://relay.test';
  process.env['SELKEY_AGENT_ID'] = 'test-agent';
});

afterEach(() => {
  _setDiscoverPollConfigForTesting(30_000, 3_000);
});

describe('getToolDefs', () => {
  it('returns identity and relay tool definitions', () => {
    const defs = getToolDefs();
    const names = defs.map((d) => d.name);
    expect(names).toContain('selkey.get_identity');
    expect(names).toContain('selkey.relay_signal');
    expect(names).toContain('selkey.create_ifc_grant');
    expect(names).toContain('selkey.send_ifc_message');
    expect(names).toContain('selkey.read_ifc_messages');
  });

  it('each tool def has name, description, and inputSchema', () => {
    const defs = getToolDefs();
    for (const def of defs) {
      expect(typeof def.name).toBe('string');
      expect(typeof def.description).toBe('string');
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('createToolRegistry', () => {
  it('returns a registry with bound handlers and toolDefs', () => {
    const transport = createMockTransport();
    const registry = createToolRegistry({
      transport,
      knownAgents: [{ agent_id: 'bob', aliases: ['Bob'] }],
    });

    expect(typeof registry.handleGetIdentity).toBe('function');
    expect(typeof registry.handleRelaySignal).toBe('function');
    expect(typeof registry.dispatch).toBe('function');
    expect(Array.isArray(registry.toolDefs)).toBe(true);
    expect(registry.toolDefs.length).toBeGreaterThan(0);
  });

  it('handleGetIdentity returns identity with bound knownAgents', async () => {
    const transport = createMockTransport();
    const registry = createToolRegistry({
      transport,
      knownAgents: [{ agent_id: 'bob', aliases: ['Bob'] }],
    });

    const result = await registry.handleGetIdentity();
    expect(result.ok).toBe(true);
    expect(result.data?.agent_id).toBe('test-agent');
    expect(result.data?.known_agents).toEqual([{ agent_id: 'bob', aliases: ['Bob'] }]);
  });

  it('handleGetIdentity uses transport for inbox checking', async () => {
    const transport = createMockTransport();
    const registry = createToolRegistry({
      transport,
      knownAgents: [],
    });

    const result = await registry.handleGetIdentity();
    expect(result.ok).toBe(true);
    expect(result.data?.pending_invites).toBe(0);
    expect(transport.peekInbox).toHaveBeenCalledOnce();
  });

  it('handleGetIdentity uses explicit inboxService when provided', async () => {
    const transport = createMockTransport();
    const inboxService = {
      checkInbox: vi.fn().mockResolvedValue({
        invites: [{ invite_id: 'inv-1' }],
      }),
    };
    const registry = createToolRegistry({
      transport,
      knownAgents: [],
      inboxService,
    });

    const result = await registry.handleGetIdentity();
    expect(result.ok).toBe(true);
    expect(result.data?.pending_invites).toBe(1);
    expect(inboxService.checkInbox).toHaveBeenCalledOnce();
    expect(transport.checkInbox).not.toHaveBeenCalled();
  });

  it('dispatch routes get_identity correctly', async () => {
    const transport = createMockTransport();
    const registry = createToolRegistry({
      transport,
      knownAgents: [],
    });

    const result = await registry.dispatch('selkey.get_identity', {});
    expect((result as { ok: boolean }).ok).toBe(true);
  });

  it('dispatch routes relay_signal correctly', async () => {
    const transport = createMockTransport();
    const registry = createToolRegistry({
      transport,
      knownAgents: [{ agent_id: 'bob', aliases: ['Bob'] }],
    });

    const result = await registry.dispatch('selkey.relay_signal', {
      mode: 'INITIATE',
      counterparty: 'bob',
      purpose: 'MEDIATION',
      my_input: 'hello',
    });

    expect((result as { ok: boolean }).ok).toBe(true);
  });

  it('dispatch throws for unknown tool', async () => {
    const transport = createMockTransport();
    const registry = createToolRegistry({
      transport,
      knownAgents: [],
    });

    expect(() => registry.dispatch('unknown.tool', {})).toThrow('Unknown tool: unknown.tool');
  });

  it('handleGetIdentity includes pending IFC messages when configured', async () => {
    const transport = createMockTransport();
    const ifcService = new IfcService({
      agentId: 'test-agent',
      seedHex: '0101010101010101010101010101010101010101010101010101010101010101',
      verifyingKeyHex:
        '8a88e3dd7409f195fd52db2d3cba5d72ca670bf1d94121bf3748801b40f6f5c2',
      knownAgents: [],
    });
    vi.spyOn(ifcService, 'pendingCount').mockReturnValue(2);
    const registry = createToolRegistry({
      transport,
      knownAgents: [],
      ifcService,
    });

    const identity = await registry.handleGetIdentity();
    expect(identity.data?.pending_ifc_messages).toBe(2);
    expect(identity.data?.next_action?.tool).toBe('selkey.read_ifc_messages');
  });
});
