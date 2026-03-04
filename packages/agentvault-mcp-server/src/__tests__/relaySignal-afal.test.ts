/**
 * Tests for AFAL-shaped relay signal behavior.
 *
 * These test the integration of AfalTransport into relaySignal — verifying
 * that INITIATE builds AfalPropose and RESPOND extracts it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleRelaySignal, _setDiscoverPollConfigForTesting } from '../tools/relaySignal.js';
import { _resetHandlesForTesting } from '../tools/relayHandles.js';
import type { AfalTransport, AfalInviteMessage } from '../afal-transport.js';
import type { AfalPropose } from '../afal-types.js';
import { computeProposalId } from '../afal-types.js';

// Mock agentvault-client to avoid real HTTP calls
vi.mock('agentvault-client', () => ({
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

vi.mock('agentvault-client/http', () => ({
  submitInput: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('agentvault-client/contracts', () => ({
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

function createMockAfalTransport(invites: AfalInviteMessage[] = []): AfalTransport {
  return {
    sendPropose: vi.fn().mockResolvedValue(undefined),
    checkInbox: vi.fn().mockResolvedValue({ invites }),
    peekInbox: vi.fn().mockResolvedValue({ invites }),
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    agentId: 'alice-demo',
  };
}

beforeEach(() => {
  _resetHandlesForTesting();
  // Disable bounded polling — single check, no sleep
  _setDiscoverPollConfigForTesting(0, 0);
  process.env['AV_RELAY_URL'] = 'http://relay.test';
  process.env['AV_AGENT_ID'] = 'alice-demo';
});

afterEach(() => {
  _setDiscoverPollConfigForTesting(30_000, 3_000);
});

describe('INITIATE with AFAL', () => {
  it('constructs AfalPropose with correct fields from purpose', async () => {
    const transport = createMockAfalTransport();

    await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    expect(transport.sendPropose).toHaveBeenCalledOnce();
    const call = vi.mocked(transport.sendPropose).mock.calls[0][0];
    const propose = call.propose;

    expect(propose.proposal_version).toBe('1');
    expect(propose.from).toBe('alice-demo');
    expect(propose.to).toBe('bob-demo');
    expect(propose.purpose_code).toBe('MEDIATION');
    expect(propose.lane_id).toBe('API_MEDIATED');
    expect(propose.output_schema_id).toBe('vcav_e_mediation_signal_v2');
    expect(propose.output_schema_version).toBe('1');
    expect(propose.requested_entropy_bits).toBe(12);
    expect(propose.model_profile_id).toBe('api-claude-sonnet-v1');
    expect(propose.model_profile_version).toBe('1');
    expect(propose.admission_tier_requested).toBe('DEFAULT');
    expect(propose.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(propose.proposal_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sends propose via adapter with relay tokens', async () => {
    const transport = createMockAfalTransport();

    await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    const call = vi.mocked(transport.sendPropose).mock.calls[0][0];
    expect(call.relay.session_id).toBe('sess-mock');
    expect(call.relay.responder_submit_token).toBe('resp-sub-tok');
    expect(call.relay.responder_read_token).toBe('resp-read-tok');
    expect(call.templateId).toBe('mediation-demo.v1.standard');
    expect(call.budgetTier).toBe('SMALL');
  });

  it('proposal_id is stable (recomputable from same fields)', async () => {
    const transport = createMockAfalTransport();

    await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    const call = vi.mocked(transport.sendPropose).mock.calls[0][0];
    const propose = call.propose;

    // Recompute proposal_id from the propose fields
    const { proposal_id: _id, ...fields } = propose;
    const recomputed = computeProposalId(fields);
    expect(recomputed).toBe(propose.proposal_id);
  });
});

describe('legacy payload type guard (isRelayInvitePayload)', () => {
  it('skips legacy invite when payload fields are truthy non-strings', async () => {
    // session_id: true passes the pre-filter's truthiness check but fails
    // the type guard's typeof === 'string' check — this exercises isRelayInvitePayload
    const invite: AfalInviteMessage = {
      invite_id: 'inv-truthy',
      from_agent_id: 'bob-demo',
      payload_type: 'VCAV_E_INVITE_V1',
      template_id: 'mediation-demo.v1.standard',
      payload: {
        session_id: true, // truthy but not string — passes pre-filter, fails type guard
        responder_submit_token: 'sub-tok',
        responder_read_token: 'read-tok',
        relay_url: 'http://relay.test',
      },
    };

    const transport = createMockAfalTransport([invite]);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'hi' },
      transport,
    );

    // Invite passes pre-filter but is rejected by isRelayInvitePayload type guard
    expect(result.status).toBe('PENDING');
    const data = result.data as { phase: string };
    expect(data.phase).toBe('DISCOVER');
  });

  it('skips legacy invite when payload fields are non-string', async () => {
    const invite: AfalInviteMessage = {
      invite_id: 'inv-badtype',
      from_agent_id: 'bob-demo',
      payload_type: 'VCAV_E_INVITE_V1',
      template_id: 'mediation-demo.v1.standard',
      payload: {
        session_id: 42, // should be string
        responder_submit_token: 'sub-tok',
        responder_read_token: 'read-tok',
        relay_url: 'http://relay.test',
      },
    };

    const transport = createMockAfalTransport([invite]);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'hi' },
      transport,
    );

    // Invite is skipped due to non-string session_id — should still be in DISCOVER
    expect(result.status).toBe('PENDING');
    const data = result.data as { phase: string };
    expect(data.phase).toBe('DISCOVER');
  });
});

describe('RESPOND with AFAL', () => {
  it('extracts AfalPropose from enriched inbox invite', async () => {
    const afalPropose: AfalPropose = {
      proposal_version: '1',
      proposal_id: 'a'.repeat(64),
      nonce: 'b'.repeat(64),
      timestamp: '2026-02-24T10:00:00.000Z',
      from: 'bob-demo',
      to: 'alice-demo',
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

    const invite: AfalInviteMessage = {
      invite_id: 'inv-1',
      from_agent_id: 'bob-demo',
      payload_type: 'VCAV_E_INVITE_V1',
      template_id: 'mediation-demo.v1.standard',
      payload: {
        session_id: 'sess-bob',
        responder_submit_token: 'sub-tok',
        responder_read_token: 'read-tok',
        relay_url: 'http://relay.test',
      },
      afalPropose,
    };

    const transport = createMockAfalTransport([invite]);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'hi' },
      transport,
    );

    // Should have found the invite and transitioned to JOIN
    expect(result.status).toBe('PENDING');
    const data = result.data as { phase: string; from: string };
    expect(data.phase).toBe('JOIN');
    expect(data.from).toBe('bob-demo');
  });

  it('falls back to legacy handling for old-format invites', async () => {
    const invite: AfalInviteMessage = {
      invite_id: 'inv-2',
      from_agent_id: 'bob-demo',
      payload_type: 'VCAV_E_INVITE_V1',
      template_id: 'mediation-demo.v1.standard',
      payload: {
        session_id: 'sess-bob',
        responder_submit_token: 'sub-tok',
        responder_read_token: 'read-tok',
        relay_url: 'http://relay.test',
      },
      // No afalPropose — legacy invite
    };

    const transport = createMockAfalTransport([invite]);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'hi' },
      transport,
    );

    expect(result.status).toBe('PENDING');
    const data = result.data as { phase: string };
    expect(data.phase).toBe('JOIN');
  });
});
