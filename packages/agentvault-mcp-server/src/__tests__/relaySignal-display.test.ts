/**
 * Tests for display directives and interpretation_context in relay_signal responses.
 *
 * Verifies that completedResponse, awaitingResponse, and failedResponse
 * include the correct display guardrails, interpretation context, and resume_token_display.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRelaySignal } from '../tools/relaySignal.js';
import type { RelaySignalOutput } from '../tools/relaySignal.js';
import { _resetHandlesForTesting } from '../tools/relayHandles.js';
import type { AfalTransport, AfalInviteMessage } from '../afal-transport.js';

// Mock agentvault-client to avoid real HTTP calls
const { mockPollUntilDone, mockGetStatus, mockGetOutput } = vi.hoisted(() => ({
  mockPollUntilDone: vi.fn().mockResolvedValue({ state: 'PROCESSING' }),
  mockGetStatus: vi.fn().mockResolvedValue({ state: 'PROCESSING' }),
  mockGetOutput: vi.fn().mockResolvedValue({ state: 'COMPLETED', output: {} }),
}));
vi.mock('agentvault-client', () => ({
  createAndSubmit: vi.fn().mockResolvedValue({
    sessionId: 'sess-mock',
    contractHash: 'hash-mock',
    initiatorReadToken: 'init-read-tok',
    responderSubmitToken: 'resp-sub-tok',
    responderReadToken: 'resp-read-tok',
  }),
  pollUntilDone: mockPollUntilDone,
  joinAndWait: vi.fn(),
}));

vi.mock('agentvault-client/http', () => ({
  submitInput: vi.fn().mockResolvedValue(undefined),
  getStatus: mockGetStatus,
  getOutput: mockGetOutput,
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
    if (purpose === 'COMPATIBILITY') {
      return {
        purpose_code: 'COMPATIBILITY',
        output_schema_id: 'vcav_e_compatibility_signal_v2',
        participants,
        entropy_budget_bits: 32,
        model_profile_id: 'api-claude-sonnet-v1',
        metadata: { scenario: 'scheduling-compatibility', version: '2' },
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
    acceptInvite: vi.fn().mockResolvedValue(undefined),
    agentId: 'alice-demo',
  };
}

/** Helper: INITIATE then resume to reach completedResponse or failedResponse. */
async function initiateAndResume(transport: AfalTransport): Promise<{ resumeToken: string }> {
  const initiateResult = await handleRelaySignal(
    { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
    transport,
  );
  const resumeToken = (initiateResult.data as RelaySignalOutput).resume_token!;
  return { resumeToken };
}

beforeEach(() => {
  _resetHandlesForTesting();
  mockPollUntilDone.mockResolvedValue({ state: 'PROCESSING' });
  mockGetStatus.mockResolvedValue({ state: 'PROCESSING' });
  mockGetOutput.mockResolvedValue({ state: 'COMPLETED', output: {} });
  process.env['VCAV_RELAY_URL'] = 'http://relay.test';
  process.env['VCAV_AGENT_ID'] = 'alice-demo';
  delete process.env['VCAV_RESUME_TOKEN_SECRET'];
});

describe('completedResponse display directives', () => {
  it('display is a slim guardrail with only forbidden and redact', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'PARTIAL_ALIGNMENT' },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);

    expect(result.status).toBe('COMPLETE');
    const data = result.data as RelaySignalOutput;
    expect(data.display).toBeDefined();
    // Slim: no mode, no allowed_sections, no privacy_statement
    expect('mode' in data.display).toBe(false);
    expect('allowed_sections' in data.display).toBe(false);
    expect('privacy_statement' in data.display).toBe(false);
    // CAPS_CASE policy keys
    expect(data.display.forbidden).toContain('CLAIM_COUNTERPARTY_KNOWLEDGE');
    expect(data.display.forbidden).toContain('PRINT_RESUME_TOKEN');
    expect(data.display.forbidden).toContain('QUOTE_MY_INPUT');
    expect(data.display.redact).toContain('resume_token');
    // output is NOT redacted — it's the bounded signal agents need to show
    expect(data.display.redact).not.toContain('output');
  });

  it('does not include display_text', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'PARTIAL_ALIGNMENT' },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    expect('display_text' in data).toBe(false);
  });

  it('includes interpretation_context with correct purpose and structure', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'ALIGNMENT_POSSIBLE' },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;

    expect(data.interpretation_context).toBeDefined();
    const ctx = data.interpretation_context!;
    expect(ctx.purpose).toBe('MEDIATION');
    expect(ctx.signal_description).toBeTruthy();
    expect(Array.isArray(ctx.signal_fields)).toBe(true);
    expect(ctx.signal_fields.length).toBeGreaterThan(0);
    expect(ctx.epistemic_limits.valid_claims.length).toBeGreaterThan(0);
    expect(ctx.epistemic_limits.invalid_claims.length).toBeGreaterThan(0);
  });

  it('interpretation_context.signal_fields covers all MEDIATION output fields', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'ALIGNMENT_POSSIBLE' },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    const fields = data.interpretation_context!.signal_fields.map((f) => f.field);
    expect(fields).toContain('mediation_signal');
    expect(fields).toContain('common_ground_code');
    expect(fields).toContain('confidence_band');
    expect(fields).toContain('next_step_signal');
  });

  it('invalid_claims includes counterparty knowledge boundary examples', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'ALIGNMENT_POSSIBLE' },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    const invalidClaims = data.interpretation_context!.epistemic_limits.invalid_claims.join(' ');
    // Must include the exact bad patterns observed in live testing
    expect(invalidClaims).toMatch(/never saw/i);
    expect(invalidClaims).toMatch(/counterparty/i);
  });

  it('provenance contains session_id from handle', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'ALIGNMENT_POSSIBLE' },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    const provenance = data.interpretation_context!.provenance;
    expect(provenance.session_id).toBe('sess-mock');
    expect(provenance.receipt_available).toBe(true);
  });

  it('resume_token_display is null for completed responses', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'FULL_ALIGNMENT' },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    expect(data.resume_token).toBeNull();
    expect(data.resume_token_display).toBeNull();
  });
});

describe('awaitingResponse display directives', () => {
  it('includes resume_token_display (truncated form) with full resume_token still present', async () => {
    const transport = createMockAfalTransport();
    const result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    expect(result.status).toBe('PENDING');
    const data = result.data as RelaySignalOutput;

    // Full token must be present
    expect(data.resume_token).toBeTruthy();
    expect(data.resume_token!.length).toBeGreaterThan(16);

    // Display form must be truncated
    expect(data.resume_token_display).toBeTruthy();
    expect(data.resume_token_display!).toContain('…');
    expect(data.resume_token_display!.length).toBeLessThan(data.resume_token!.length);
  });

  it('resume_token_display does not contain the full token value', async () => {
    const transport = createMockAfalTransport();
    const result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    const data = result.data as RelaySignalOutput;
    expect(data.resume_token_display).not.toBe(data.resume_token);
    expect(data.resume_token_display!).toMatch(/^.{12}….{4}$/);
  });

  it('display is slim guardrail — no mode, no allowed_sections', async () => {
    const transport = createMockAfalTransport();
    const result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    const data = result.data as RelaySignalOutput;
    expect(data.display).toBeDefined();
    expect('mode' in data.display).toBe(false);
    expect(data.display.forbidden).toContain('PRINT_RESUME_TOKEN');
    expect(data.display.redact).toContain('resume_token');
  });

  it('does not include interpretation_context or display_text while AWAITING', async () => {
    const transport = createMockAfalTransport();
    const result = await handleRelaySignal(
      { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
      transport,
    );

    const data = result.data as RelaySignalOutput;
    expect(data.interpretation_context).toBeUndefined();
    expect('display_text' in data).toBe(false);
  });
});

describe('failedResponse display directives', () => {
  it('display has only forbidden and redact — no mode or allowed_sections', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({
      state: 'ABORTED',
      abort_reason: 'PROVIDER_ERROR',
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);

    expect(result.status).toBe('ERROR');
    const data = result.data as RelaySignalOutput;
    expect(data.state).toBe('FAILED');
    expect(data.display).toBeDefined();
    expect('mode' in data.display).toBe(false);
    expect('allowed_sections' in data.display).toBe(false);
    expect(data.display.forbidden).toContain('PRINT_RESUME_TOKEN');
    expect(data.display.redact).toContain('resume_token');
  });

  it('does not include display_text or interpretation_context on failure', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({
      state: 'ABORTED',
      abort_reason: 'PROVIDER_ERROR',
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    expect('display_text' in data).toBe(false);
    expect(data.interpretation_context).toBeUndefined();
  });

  it('resume_token is null on failure', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({
      state: 'ABORTED',
      abort_reason: 'PROVIDER_ERROR',
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    expect(data.resume_token).toBeNull();
    expect(data.resume_token_display).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// COMPATIBILITY integration tests
// ---------------------------------------------------------------------------

const COMPAT_OUTPUT = {
  schema_version: '2',
  compatibility_signal: 'STRONG_MATCH',
  thesis_fit: 'ALIGNED',
  size_fit: 'WITHIN_BAND',
  stage_fit: 'ALIGNED',
  confidence: 'HIGH',
  primary_reasons: ['SECTOR_MATCH', 'SIZE_COMPATIBLE'],
  blocking_reasons: [],
  next_step: 'PROCEED',
};

async function initiateCompatAndResume(transport: AfalTransport): Promise<{ resumeToken: string }> {
  const initiateResult = await handleRelaySignal(
    { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'COMPATIBILITY', my_input: 'hello' },
    transport,
  );
  const resumeToken = (initiateResult.data as RelaySignalOutput).resume_token!;
  return { resumeToken };
}

describe('COMPATIBILITY interpretation_context', () => {
  it('signal_fields covers all 8 COMPAT v2 fields', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateCompatAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({ state: 'COMPLETED', output: COMPAT_OUTPUT });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    const ctx = data.interpretation_context!;

    expect(ctx.purpose).toBe('COMPATIBILITY');
    const fieldNames = ctx.signal_fields.map((f) => f.field);
    expect(fieldNames).toContain('compatibility_signal');
    expect(fieldNames).toContain('thesis_fit');
    expect(fieldNames).toContain('size_fit');
    expect(fieldNames).toContain('stage_fit');
    expect(fieldNames).toContain('confidence');
    expect(fieldNames).toContain('primary_reasons');
    expect(fieldNames).toContain('blocking_reasons');
    expect(fieldNames).toContain('next_step');
    expect(fieldNames).not.toContain('overlap_summary');
    expect(fieldNames).toHaveLength(8);
  });

  it('derived_fields included with correct structure for COMPATIBILITY', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateCompatAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({ state: 'COMPLETED', output: COMPAT_OUTPUT });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    const ctx = data.interpretation_context!;

    expect(ctx.derived_fields).toBeDefined();
    expect(ctx.derived_fields!.length).toBeGreaterThan(0);
    const df = ctx.derived_fields![0];
    expect(df.field).toBe('next_step');
    expect(df.value).toBe('PROCEED');
    expect(df.model_value).toBe('PROCEED');
    expect(df.agrees).toBe(true);
    expect(typeof df.rule_summary).toBe('string');
    expect(df.rule_summary.length).toBeGreaterThan(0);
  });

  it('derived_fields.rule_summary contains no prescriptive language', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateCompatAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({ state: 'COMPLETED', output: COMPAT_OUTPUT });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    const df = data.interpretation_context!.derived_fields![0];
    expect(df.rule_summary).not.toMatch(/recommend|advise|suggest|should/i);
  });

  it('epistemic_limits.invalid_claims includes derived_fields authority guardrail', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateCompatAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({ state: 'COMPLETED', output: COMPAT_OUTPUT });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    const invalidClaims = data.interpretation_context!.epistemic_limits.invalid_claims.join(' ');
    expect(invalidClaims).toMatch(/derived_fields/i);
    expect(invalidClaims).toMatch(/deterministic/i);
  });

  it('overlap_summary is absent from COMPATIBILITY context', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateCompatAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({ state: 'COMPLETED', output: COMPAT_OUTPUT });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    const ctx = data.interpretation_context!;

    const fieldNames = ctx.signal_fields.map((f) => f.field);
    expect(fieldNames).not.toContain('overlap_summary');
    const allText = JSON.stringify(ctx);
    expect(allText).not.toContain('overlap_summary');
  });

  it('MEDIATION context has NO derived_fields', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'ALIGNMENT_POSSIBLE' },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    expect(data.interpretation_context!.derived_fields).toBeUndefined();
  });

  it('derived_fields omitted when signal is unknown (no derivation)', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateCompatAndResume(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: {
        ...COMPAT_OUTPUT,
        compatibility_signal: 'UNKNOWN_SIGNAL',
        blocking_reasons: [],
      },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    expect(data.interpretation_context!.derived_fields).toBeUndefined();
  });

  it('agrees is false in derived_fields when model disagrees with derivation', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateCompatAndResume(transport);

    // NO_MATCH should derive DO_NOT_PROCEED; model says PROCEED
    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: {
        ...COMPAT_OUTPUT,
        compatibility_signal: 'NO_MATCH',
        blocking_reasons: [],
        next_step: 'PROCEED',
      },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    const df = data.interpretation_context!.derived_fields![0];
    expect(df.value).toBe('DO_NOT_PROCEED');
    expect(df.model_value).toBe('PROCEED');
    expect(df.agrees).toBe(false);
  });
});
