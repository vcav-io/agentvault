import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorInboxAdapter, PURPOSE_TO_TEMPLATE } from '../afal-transport.js';
import type { InviteTransport, InviteMessage } from '../invite-transport.js';
import type { AfalPropose, RelayInvitePayload } from '../afal-types.js';
import { computeProposalId } from '../afal-types.js';

function createMockTransport(invites: InviteMessage[] = []): InviteTransport {
  return {
    sendInvite: vi.fn().mockResolvedValue(undefined),
    checkInbox: vi.fn().mockResolvedValue({ invites }),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    agentId: 'alice-demo',
  };
}

function createTestPropose(overrides: Partial<AfalPropose> = {}): AfalPropose {
  const fields: Omit<AfalPropose, 'proposal_id'> = {
    proposal_version: '1',
    nonce: 'a'.repeat(64),
    timestamp: '2026-02-24T10:00:00.000Z',
    from: 'alice-demo',
    to: 'bob-demo',
    purpose_code: 'MEDIATION',
    lane_id: 'API_MEDIATED',
    output_schema_id: 'vcav_e_mediation_signal_v2',
    output_schema_version: '1',
    requested_budget_tier: 'SMALL',
    requested_entropy_bits: 12,
    model_profile_id: 'api-claude-sonnet-v1',
    model_profile_version: '1',
    admission_tier_requested: 'DEFAULT',
    ...overrides,
  };
  const proposal_id = computeProposalId(fields);
  return { ...fields, proposal_id, ...overrides };
}

function createTestRelay(): RelayInvitePayload {
  return {
    session_id: 'sess-001',
    responder_submit_token: 'sub-tok',
    responder_read_token: 'read-tok',
    relay_url: 'http://relay.example.com',
  };
}

describe('OrchestratorInboxAdapter', () => {
  let mockTransport: InviteTransport;
  let adapter: OrchestratorInboxAdapter;

  beforeEach(() => {
    mockTransport = createMockTransport();
    adapter = new OrchestratorInboxAdapter(mockTransport);
  });

  describe('sendPropose', () => {
    it('embeds draft in payload alongside relay tokens', async () => {
      const propose = createTestPropose();
      const relay = createTestRelay();

      await adapter.sendPropose({
        propose,
        relay,
        templateId: 'mediation-demo.v1.standard',
        budgetTier: 'SMALL',
      });

      expect(mockTransport.sendInvite).toHaveBeenCalledOnce();
      const call = vi.mocked(mockTransport.sendInvite).mock.calls[0][0];
      expect(call.payload['session_id']).toBe('sess-001');
      expect(call.payload['responder_submit_token']).toBe('sub-tok');
      expect(call.payload['relay_url']).toBe('http://relay.example.com');
      expect(call.payload['afal_propose_draft']).toBeDefined();
    });

    it('preserves payload_type as VCAV_E_INVITE_V1', async () => {
      const propose = createTestPropose();
      const relay = createTestRelay();

      await adapter.sendPropose({
        propose,
        relay,
        templateId: 'mediation-demo.v1.standard',
        budgetTier: 'SMALL',
      });

      const call = vi.mocked(mockTransport.sendInvite).mock.calls[0][0];
      expect(call.payload_type).toBe('VCAV_E_INVITE_V1');
    });

    it('maps purpose_code to correct template_id', async () => {
      const propose = createTestPropose({ purpose_code: 'COMPATIBILITY' });
      const relay = createTestRelay();

      await adapter.sendPropose({
        propose,
        relay,
        templateId: PURPOSE_TO_TEMPLATE['COMPATIBILITY'],
        budgetTier: 'SMALL',
      });

      const call = vi.mocked(mockTransport.sendInvite).mock.calls[0][0];
      expect(call.template_id).toBe('dating.v1.d2');
    });

    it('adds compliance: UNSIGNED to draft wrapper', async () => {
      const propose = createTestPropose();
      const relay = createTestRelay();

      await adapter.sendPropose({
        propose,
        relay,
        templateId: 'mediation-demo.v1.standard',
        budgetTier: 'SMALL',
      });

      const call = vi.mocked(mockTransport.sendInvite).mock.calls[0][0];
      const draft = call.payload['afal_propose_draft'] as Record<string, unknown>;
      expect(draft['compliance']).toBe('UNSIGNED');
    });

    it('omits signature and descriptor_hash from draft', async () => {
      const propose = createTestPropose();
      const relay = createTestRelay();

      await adapter.sendPropose({
        propose,
        relay,
        templateId: 'mediation-demo.v1.standard',
        budgetTier: 'SMALL',
      });

      const call = vi.mocked(mockTransport.sendInvite).mock.calls[0][0];
      const draft = call.payload['afal_propose_draft'] as Record<string, unknown>;
      expect(draft['signature']).toBeUndefined();
      expect(draft['descriptor_hash']).toBeUndefined();
    });
  });

  describe('checkInbox', () => {
    it('parses afal_propose_draft into AfalPropose', async () => {
      const propose = createTestPropose();
      const draft: Record<string, unknown> = {
        compliance: 'UNSIGNED',
        proposal_version: propose.proposal_version,
        proposal_id: propose.proposal_id,
        nonce: propose.nonce,
        timestamp: propose.timestamp,
        from: propose.from,
        to: propose.to,
        purpose_code: propose.purpose_code,
        lane_id: propose.lane_id,
        output_schema_id: propose.output_schema_id,
        output_schema_version: propose.output_schema_version,
        requested_budget_tier: propose.requested_budget_tier,
        requested_entropy_bits: propose.requested_entropy_bits,
        model_profile_id: propose.model_profile_id,
        model_profile_version: propose.model_profile_version,
        admission_tier_requested: propose.admission_tier_requested,
      };

      const invite: InviteMessage = {
        invite_id: 'inv-1',
        from_agent_id: 'alice-demo',
        payload_type: 'VCAV_E_INVITE_V1',
        payload: {
          session_id: 'sess-1',
          responder_submit_token: 'tok',
          responder_read_token: 'tok',
          relay_url: 'http://relay.example.com',
          afal_propose_draft: draft,
        },
      };

      mockTransport = createMockTransport([invite]);
      adapter = new OrchestratorInboxAdapter(mockTransport);
      const result = await adapter.checkInbox();

      expect(result.invites).toHaveLength(1);
      const parsed = result.invites[0].afalPropose;
      expect(parsed).toBeDefined();
      expect(parsed!.proposal_id).toBe(propose.proposal_id);
      expect(parsed!.purpose_code).toBe('MEDIATION');
      expect(parsed!.from).toBe('alice-demo');
      expect(parsed!.to).toBe('bob-demo');
    });

    it('returns undefined afalPropose for legacy payloads', async () => {
      const invite: InviteMessage = {
        invite_id: 'inv-2',
        from_agent_id: 'alice-demo',
        payload_type: 'VCAV_E_INVITE_V1',
        payload: {
          session_id: 'sess-1',
          responder_submit_token: 'tok',
          responder_read_token: 'tok',
          relay_url: 'http://relay.example.com',
        },
      };

      mockTransport = createMockTransport([invite]);
      adapter = new OrchestratorInboxAdapter(mockTransport);
      const result = await adapter.checkInbox();

      expect(result.invites).toHaveLength(1);
      expect(result.invites[0].afalPropose).toBeUndefined();
    });
  });

  describe('acceptInvite', () => {
    it('delegates to underlying transport', async () => {
      await adapter.acceptInvite('inv-42');
      expect(mockTransport.acceptInvite).toHaveBeenCalledWith('inv-42');
    });
  });

  describe('agentId', () => {
    it('delegates to underlying transport', () => {
      expect(adapter.agentId).toBe('alice-demo');
    });
  });
});

describe('computeProposalId', () => {
  it('is deterministic (same fields → same id)', () => {
    const fields: Omit<AfalPropose, 'proposal_id'> = {
      proposal_version: '1',
      nonce: 'b'.repeat(64),
      timestamp: '2026-02-24T10:00:00.000Z',
      from: 'alice-demo',
      to: 'bob-demo',
      purpose_code: 'MEDIATION',
      lane_id: 'API_MEDIATED',
      output_schema_id: 'vcav_e_mediation_signal_v2',
      output_schema_version: '1',
      requested_budget_tier: 'SMALL',
      requested_entropy_bits: 12,
      model_profile_id: 'api-claude-sonnet-v1',
      model_profile_version: '1',
      admission_tier_requested: 'DEFAULT',
    };
    const id1 = computeProposalId(fields);
    const id2 = computeProposalId(fields);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when nonce changes', () => {
    const base: Omit<AfalPropose, 'proposal_id'> = {
      proposal_version: '1',
      nonce: 'c'.repeat(64),
      timestamp: '2026-02-24T10:00:00.000Z',
      from: 'alice-demo',
      to: 'bob-demo',
      purpose_code: 'MEDIATION',
      lane_id: 'API_MEDIATED',
      output_schema_id: 'vcav_e_mediation_signal_v2',
      output_schema_version: '1',
      requested_budget_tier: 'SMALL',
      requested_entropy_bits: 12,
      model_profile_id: 'api-claude-sonnet-v1',
      model_profile_version: '1',
      admission_tier_requested: 'DEFAULT',
    };
    const id1 = computeProposalId(base);
    const id2 = computeProposalId({ ...base, nonce: 'd'.repeat(64) });
    expect(id1).not.toBe(id2);
  });
});

describe('payload size guard', () => {
  it('MEDIATION payload JSON < 2048 bytes', async () => {
    const propose = createTestPropose();
    const relay = createTestRelay();

    const mockTx = createMockTransport();
    const adapter = new OrchestratorInboxAdapter(mockTx);
    await adapter.sendPropose({
      propose,
      relay,
      templateId: 'mediation-demo.v1.standard',
      budgetTier: 'SMALL',
    });

    const call = vi.mocked(mockTx.sendInvite).mock.calls[0][0];
    const payloadJson = JSON.stringify(call.payload);
    expect(payloadJson.length).toBeLessThan(2048);
  });

  it('COMPATIBILITY payload JSON < 2048 bytes', async () => {
    const propose = createTestPropose({ purpose_code: 'COMPATIBILITY' });
    const relay = createTestRelay();

    const mockTx = createMockTransport();
    const adapter = new OrchestratorInboxAdapter(mockTx);
    await adapter.sendPropose({
      propose,
      relay,
      templateId: PURPOSE_TO_TEMPLATE['COMPATIBILITY'],
      budgetTier: 'SMALL',
    });

    const call = vi.mocked(mockTx.sendInvite).mock.calls[0][0];
    const payloadJson = JSON.stringify(call.payload);
    expect(payloadJson.length).toBeLessThan(2048);
  });

  it('maximal draft (128-char agent IDs, 64-char schema IDs) < 2048 bytes', async () => {
    const longId = 'x'.repeat(128);
    const longSchemaId = 's'.repeat(64);
    const propose = createTestPropose({
      from: longId,
      to: longId,
      output_schema_id: longSchemaId,
      model_profile_id: longSchemaId,
    });
    const relay: RelayInvitePayload = {
      session_id: 'x'.repeat(36),
      responder_submit_token: 'x'.repeat(64),
      responder_read_token: 'x'.repeat(64),
      relay_url: 'http://relay.example.com/very/long/path/that/is/realistic',
    };

    const mockTx = createMockTransport();
    const adapter = new OrchestratorInboxAdapter(mockTx);
    await adapter.sendPropose({
      propose,
      relay,
      templateId: 'mediation-demo.v1.standard',
      budgetTier: 'SMALL',
    });

    const call = vi.mocked(mockTx.sendInvite).mock.calls[0][0];
    const payloadJson = JSON.stringify(call.payload);
    expect(payloadJson.length).toBeLessThan(2048);
  });
});
