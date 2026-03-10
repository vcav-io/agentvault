/**
 * Tests for heartbeat-safe relay_signal behavior.
 *
 * Verifies non-blocking phase behavior, resume_strategy, session state files,
 * and index management for OpenClaw heartbeat integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleRelaySignal, _setDiscoverPollConfigForTesting, _setRelayPollConfigForTesting } from '../tools/relaySignal.js';
import type { RelaySignalOutput, SessionStateEntry } from '../tools/relaySignal.js';
import { _resetHandlesForTesting } from '../tools/relayHandles.js';
import type { AfalTransport, AfalInviteMessage } from '../afal-transport.js';

// Mock agentvault-client to avoid real HTTP calls
const { mockGetStatus, mockGetOutput } = vi.hoisted(() => ({
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
  pollUntilDone: vi.fn().mockResolvedValue({ state: 'PROCESSING' }),
  joinAndWait: vi.fn(),
}));

vi.mock('agentvault-client/http', () => ({
  submitInput: vi.fn().mockResolvedValue(undefined),
  getStatus: mockGetStatus,
  getOutput: mockGetOutput,
}));

vi.mock('agentvault-client/contracts', () => ({
  buildRelayContract: vi.fn().mockImplementation((purpose: string, participants: string[]) => {
    if (purpose === 'MEDIATION' || purpose === 'COMPATIBILITY') {
      return {
        purpose_code: purpose,
        output_schema_id: `vcav_e_${purpose.toLowerCase()}_signal_v2`,
        participants,
        entropy_budget_bits: 12,
        model_profile_id: 'api-claude-sonnet-v1',
        metadata: { scenario: 'test', version: '1' },
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

let tmpDir: string;

beforeEach(() => {
  _resetHandlesForTesting();
  // Disable bounded polling by default — single check, no sleep
  _setDiscoverPollConfigForTesting(0, 0);
  _setRelayPollConfigForTesting(0, 0);
  mockGetStatus.mockResolvedValue({ state: 'PROCESSING' });
  mockGetOutput.mockResolvedValue({ state: 'COMPLETED', output: {} });
  // Use a temp directory for session state files
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcav-heartbeat-test-'));
  process.env['AV_WORKDIR'] = tmpDir;
  process.env['AV_RELAY_URL'] = 'http://relay.test';
  process.env['AV_AGENT_ID'] = 'alice-demo';
  delete process.env['AV_RESUME_TOKEN_SECRET'];
});

afterEach(() => {
  // Restore poll defaults
  _setDiscoverPollConfigForTesting(30_000, 3_000);
  _setRelayPollConfigForTesting(25_000, 2_000);
  // Clean up temp dir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env['AV_WORKDIR'];
});

/** Helper: INITIATE and return the resume token + initial data. */
async function initiateSession(transport: AfalTransport): Promise<{
  resumeToken: string;
  data: RelaySignalOutput;
}> {
  const result = await handleRelaySignal(
    { mode: 'INITIATE', counterparty: 'bob-demo', purpose: 'MEDIATION', my_input: 'hello' },
    transport,
  );
  const data = result.data as RelaySignalOutput;
  return { resumeToken: data.resume_token!, data };
}

function readSessionIndex(): SessionStateEntry[] {
  const indexPath = path.join(tmpDir, '.agentvault', 'active_sessions.json');
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return [];
  }
}

function readSessionFile(handleId: string): Record<string, unknown> | null {
  const filePath = path.join(tmpDir, '.agentvault', 'sessions', `${handleId}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ── resume_strategy tests ────────────────────────────────────────────────

describe('resume_strategy in responses', () => {
  it('INITIATE returns IMMEDIATE when relay is processing (POLL_RELAY phase)', async () => {
    const transport = createMockAfalTransport();
    const { data } = await initiateSession(transport);

    expect(data.state).toBe('AWAITING');
    expect(data.resume_strategy).toBe('IMMEDIATE');
    expect(data.next_update_seconds).toBe(5);
  });

  it('phasePollRelay returns DEFERRED with seconds=30 when still processing (poll budget exhausted)', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateSession(transport);

    // Default mockGetStatus returns { state: 'PROCESSING' }
    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;

    expect(data.state).toBe('AWAITING');
    expect(data.resume_strategy).toBe('DEFERRED');
    expect(data.next_update_seconds).toBe(30);
  });

  it('RESPOND with no invite returns DEFERRED with seconds=30', async () => {
    const transport = createMockAfalTransport([]); // empty inbox
    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'world' },
      transport,
    );
    const data = result.data as RelaySignalOutput;

    expect(data.state).toBe('AWAITING');
    expect(data.resume_strategy).toBe('DEFERRED');
    expect(data.next_update_seconds).toBe(30);
  });

  it('completed response has no resume_strategy', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateSession(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'PARTIAL_ALIGNMENT' },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;

    expect(data.state).toBe('COMPLETED');
    expect(data.resume_strategy).toBeUndefined();
  });
});

// ── Session state file tests ─────────────────────────────────────────────

describe('session state files', () => {
  it('writes per-session file and index on AWAITING response', async () => {
    const transport = createMockAfalTransport();
    await initiateSession(transport);

    const index = readSessionIndex();
    expect(index.length).toBe(1);
    expect(index[0].resume_strategy).toBe('IMMEDIATE');

    // Per-session file should exist
    const sessionFile = readSessionFile(index[0].handle_id);
    expect(sessionFile).not.toBeNull();
    expect(sessionFile!.phase).toBe('POLL_RELAY');
    expect(sessionFile!.role).toBe('INITIATOR');
    expect(sessionFile!.counterparty).toBe('bob-demo');
    expect(sessionFile!.resume_strategy).toBe('IMMEDIATE');
    expect(sessionFile!.next_update_seconds).toBe(5);
  });

  it('removes per-session file on COMPLETED response', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateSession(transport);

    // Verify file exists
    let index = readSessionIndex();
    expect(index.length).toBe(1);
    const handleId = index[0].handle_id;

    // Complete the session
    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({ state: 'COMPLETED', output: {} });

    await handleRelaySignal({ resume_token: resumeToken }, transport);

    // File should be removed, index should be empty
    expect(readSessionFile(handleId)).toBeNull();
    index = readSessionIndex();
    expect(index.length).toBe(0);
  });

  it('removes per-session file on FAILED response', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateSession(transport);

    let index = readSessionIndex();
    const handleId = index[0].handle_id;

    // Abort the session
    mockGetStatus.mockResolvedValueOnce({ state: 'ABORTED', abort_reason: 'PROVIDER_ERROR' });

    await handleRelaySignal({ resume_token: resumeToken }, transport);

    expect(readSessionFile(handleId)).toBeNull();
    index = readSessionIndex();
    expect(index.length).toBe(0);
  });

  it('due_at is updated_at + next_update_seconds', async () => {
    const transport = createMockAfalTransport();
    await initiateSession(transport);

    const index = readSessionIndex();
    const sessionFile = readSessionFile(index[0].handle_id)!;

    const updatedAt = new Date(sessionFile.updated_at as string).getTime();
    const dueAt = new Date(sessionFile.due_at as string).getTime();
    const nextSec = sessionFile.next_update_seconds as number;

    expect(dueAt).toBe(updatedAt + nextSec * 1000);
  });

  it('expires_at is preserved across updates (set once at creation)', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateSession(transport);

    const index = readSessionIndex();
    const handleId = index[0].handle_id;
    const firstFile = readSessionFile(handleId)!;
    const firstExpiresAt = firstFile.expires_at as string;

    // Resume to trigger another write
    await handleRelaySignal({ resume_token: resumeToken }, transport);

    const secondFile = readSessionFile(handleId)!;
    expect(secondFile.expires_at).toBe(firstExpiresAt);
  });

  it('attempt_count increments on same phase', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateSession(transport);

    const index = readSessionIndex();
    const handleId = index[0].handle_id;
    const first = readSessionFile(handleId)!;
    expect(first.attempt_count).toBe(1);

    // Resume (still POLL_RELAY, still PROCESSING)
    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;
    const newToken = data.resume_token!;

    const second = readSessionFile(handleId)!;
    expect(second.attempt_count).toBe(2);

    // Resume again
    await handleRelaySignal({ resume_token: newToken }, transport);
    const third = readSessionFile(handleId)!;
    expect(third.attempt_count).toBe(3);
  });

  it('attempt_count resets to 0 on phase change', async () => {
    // Use RESPOND mode with an invite to see phase change from DISCOVER → JOIN
    const invites: AfalInviteMessage[] = [
      {
        invite_id: 'inv-test',
        from_agent_id: 'bob-demo',
        payload_type: 'VCAV_E_INVITE_V1',
        payload: {
          session_id: 'sess-join',
          responder_submit_token: 'sub-tok',
          responder_read_token: 'read-tok',
          relay_url: 'http://relay.test',
        },
        contract_hash: 'relay-hash-mock',
        template_id: 'mediation-demo.v1.standard',
      },
    ];
    const transport = createMockAfalTransport(invites);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'world' },
      transport,
    );
    const data = result.data as RelaySignalOutput;

    // Should have found the invite and moved to JOIN phase
    expect(data.phase).toBe('JOIN');

    const index = readSessionIndex();
    const handleId = index[0].handle_id;
    const sessionFile = readSessionFile(handleId)!;
    // Phase changed from DISCOVER → JOIN, so attempt_count should be 0 (reset) + 1 (current write)
    // Actually on first write it's 1 (no existing file), then phase changes to JOIN on same write
    // The first write creates the file with DISCOVER phase, finds invite, changes to JOIN, writes again
    // Wait — writeSessionStateFile is called from awaitingResponse. phaseDiscover finds the invite,
    // sets handle.phase = 'JOIN', then returns awaitingResponse which calls writeSessionStateFile.
    // Since there was no prior file (first call), existingPhase is undefined, so:
    // attemptCount = (undefined && undefined !== 'JOIN') is falsy ? 0 : 0 + 1 = 1
    expect(sessionFile.attempt_count).toBe(1);
    expect(sessionFile.phase).toBe('JOIN');
  });
});

// ── Index sorting tests ──────────────────────────────────────────────────

describe('session index sorting', () => {
  it('IMMEDIATE entries sort before DEFERRED', async () => {
    // Create two sessions: one IMMEDIATE (INITIATE), one DEFERRED (RESPOND with no invite)
    const transport1 = createMockAfalTransport();
    await initiateSession(transport1); // IMMEDIATE (POLL_RELAY)

    const transport2 = createMockAfalTransport([]); // empty inbox
    (transport2 as unknown as Record<string, unknown>).agentId = 'alice-demo';
    await handleRelaySignal(
      { mode: 'RESPOND', from: 'carol-demo', expected_purpose: 'COMPATIBILITY', my_input: 'test' },
      transport2,
    );

    const index = readSessionIndex();
    expect(index.length).toBe(2);
    expect(index[0].resume_strategy).toBe('IMMEDIATE');
    expect(index[1].resume_strategy).toBe('DEFERRED');
  });
});

// ── Crash recovery tests ─────────────────────────────────────────────────

describe('crash recovery', () => {
  it('expired session files are cleaned up during index rebuild', async () => {
    // Manually create an expired session file
    const sessionsDir = path.join(tmpDir, '.agentvault', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const expiredState = {
      handle_id: 'expired-handle',
      resume_token: 'expired-token',
      phase: 'POLL_RELAY',
      role: 'INITIATOR',
      counterparty: 'bob-demo',
      resume_strategy: 'IMMEDIATE',
      next_update_seconds: 5,
      due_at: new Date(Date.now() - 60000).toISOString(),
      expires_at: new Date(Date.now() - 60000).toISOString(), // expired 1 minute ago
      updated_at: new Date(Date.now() - 120000).toISOString(),
      attempt_count: 5,
    };
    fs.writeFileSync(
      path.join(sessionsDir, 'expired-handle.json'),
      JSON.stringify(expiredState, null, 2),
    );

    // Now create a real session which triggers index rebuild
    const transport = createMockAfalTransport();
    await initiateSession(transport);

    const index = readSessionIndex();
    // Should only have the new session, not the expired one
    expect(index.length).toBe(1);
    expect(index[0].handle_id).not.toBe('expired-handle');

    // Expired file should be deleted
    expect(fs.existsSync(path.join(sessionsDir, 'expired-handle.json'))).toBe(false);
  });
});

describe('stale resume-token fallback', () => {
  it('falls back to fresh RESPOND args when resume_token is invalid but enough context is present', async () => {
    const transport = createMockAfalTransport([
      {
        invite_id: 'inv-fallback',
        from_agent_id: 'bob-demo',
        template_id: 'dating.v1.d2',
        contract_hash: 'compat-hash',
        payload_type: 'VCAV_E_INVITE_V1',
        payload: {
          session_id: 'sess-fallback',
          responder_submit_token: 'resp-submit',
          responder_read_token: 'resp-read',
          relay_url: 'http://relay.test',
        },
      },
    ]);

    const result = await handleRelaySignal(
      {
        resume_token: 'expired-token',
        mode: 'RESPOND',
        from: 'bob-demo',
        expected_purpose: 'COMPATIBILITY',
        my_input: 'hello',
      },
      transport,
    );

    const data = result.data as RelaySignalOutput;
    expect(result.status).toBe('PENDING');
    expect(data.phase).toBe('JOIN');
    expect(data.from).toBe('bob-demo');
    expect(data.contract_hash).toBe('compat-hash');
  });

  it('falls back to fresh INITIATE args when resume_token is invalid but enough context is present', async () => {
    const transport = createMockAfalTransport();

    const result = await handleRelaySignal(
      {
        resume_token: 'expired-token',
        mode: 'INITIATE',
        counterparty: 'bob-demo',
        purpose: 'COMPATIBILITY',
        my_input: 'I want to see if there is room to proceed.',
      },
      transport,
    );

    const data = result.data as RelaySignalOutput;
    expect(result.status).toBe('PENDING');
    expect(data.phase).toBe('POLL_RELAY');
    expect(data.state).toBe('AWAITING');
    expect(data.action_required).toBe('CALL_AGAIN');
    expect(data.mode).toBe('INITIATE');
  });

  it('keeps resume-only invalid tokens on the strict INVALID_INPUT path', async () => {
    const transport = createMockAfalTransport();

    const result = await handleRelaySignal(
      {
        resume_token: 'expired-token',
      },
      transport,
    );

    expect(result.status).toBe('ERROR');
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.detail).toContain(
      'Invalid or expired resume_token',
    );
  });
});

// ── AV_WORKDIR tests ───────────────────────────────────────────────────

describe('AV_WORKDIR', () => {
  it('uses AV_WORKDIR for session state files', async () => {
    const transport = createMockAfalTransport();
    await initiateSession(transport);

    // Session files should be in tmpDir (which is AV_WORKDIR)
    const index = readSessionIndex();
    expect(index.length).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, '.agentvault', 'active_sessions.json'))).toBe(true);
  });

  it('logs warning when AV_WORKDIR is not set', async () => {
    delete process.env['AV_WORKDIR'];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const transport = createMockAfalTransport();
    await initiateSession(transport);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[AV WARNING] AV_WORKDIR not set'),
    );
    warnSpy.mockRestore();
  });
});

// ── HANDLE_TTL_MS tests ──────────────────────────────────────────────────

describe('HANDLE_TTL_MS', () => {
  it('expires_at is approximately 30 minutes from creation', async () => {
    const transport = createMockAfalTransport();
    const before = Date.now();
    await initiateSession(transport);
    const after = Date.now();

    const index = readSessionIndex();
    const sessionFile = readSessionFile(index[0].handle_id)!;
    const expiresAt = new Date(sessionFile.expires_at as string).getTime();

    // expires_at should be ~30 minutes from now (1,800,000ms)
    const thirtyMin = 30 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyMin - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + thirtyMin + 1000);
  });
});

// ── Non-blocking phase behavior ──────────────────────────────────────────

describe('non-blocking phases', () => {
  it('phasePollRelay returns COMPLETED on first check when relay is done', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateSession(transport);

    mockGetStatus.mockResolvedValueOnce({ state: 'COMPLETED' });
    mockGetOutput.mockResolvedValueOnce({
      state: 'COMPLETED',
      output: { mediation_signal: 'ALIGNMENT_POSSIBLE' },
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;

    expect(data.state).toBe('COMPLETED');
    expect(data.output).toBeDefined();
  });

  it('phasePollRelay returns FAILED on ABORTED status', async () => {
    const transport = createMockAfalTransport();
    const { resumeToken } = await initiateSession(transport);

    mockGetStatus.mockResolvedValueOnce({
      state: 'ABORTED',
      abort_reason: 'SCHEMA_VALIDATION',
    });

    const result = await handleRelaySignal({ resume_token: resumeToken }, transport);
    const data = result.data as RelaySignalOutput;

    expect(data.state).toBe('FAILED');
    expect(data.error_code).toContain('SCHEMA_VALIDATION');
  });

  it('phaseDiscover returns DEFERRED when no invite found after bounded poll', async () => {
    const transport = createMockAfalTransport([]); // empty inbox
    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'world' },
      transport,
    );
    const data = result.data as RelaySignalOutput;

    expect(data.state).toBe('AWAITING');
    expect(data.phase).toBe('DISCOVER');
    expect(data.resume_strategy).toBe('DEFERRED');
    expect(data.next_update_seconds).toBe(30);
    // Bounded poll should have peeked inbox (non-destructive read)
    expect(transport.peekInbox).toHaveBeenCalled();
  });

  it('phaseDiscover finds invite on second poll attempt', async () => {
    // Enable polling with no sleep — budget allows multiple checks
    _setDiscoverPollConfigForTesting(10_000, 0);

    const invite: AfalInviteMessage = {
      invite_id: 'inv-delayed',
      from_agent_id: 'bob-demo',
      payload_type: 'VCAV_E_INVITE_V1',
      payload: {
        session_id: 'sess-delayed',
        responder_submit_token: 'sub-tok',
        responder_read_token: 'read-tok',
        relay_url: 'http://relay.test',
      },
      contract_hash: 'relay-hash-mock',
      template_id: 'mediation-demo.v1.standard',
    };
    // First peek returns empty, second returns the invite
    const transport = createMockAfalTransport([]);
    (transport.peekInbox as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ invites: [] })
      .mockResolvedValueOnce({ invites: [invite] });

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'world' },
      transport,
    );
    const data = result.data as RelaySignalOutput;

    expect(data.state).toBe('AWAITING');
    expect(data.phase).toBe('JOIN');
    expect(data.resume_strategy).toBe('IMMEDIATE');
    expect(transport.peekInbox).toHaveBeenCalledTimes(2);
  });

  it('phaseDiscover returns IMMEDIATE when invite found (phase transitions to JOIN)', async () => {
    const invites: AfalInviteMessage[] = [
      {
        invite_id: 'inv-test',
        from_agent_id: 'bob-demo',
        payload_type: 'VCAV_E_INVITE_V1',
        payload: {
          session_id: 'sess-join',
          responder_submit_token: 'sub-tok',
          responder_read_token: 'read-tok',
          relay_url: 'http://relay.test',
        },
        contract_hash: 'relay-hash-mock',
        template_id: 'mediation-demo.v1.standard',
      },
    ];
    const transport = createMockAfalTransport(invites);

    const result = await handleRelaySignal(
      { mode: 'RESPOND', from: 'bob-demo', expected_purpose: 'MEDIATION', my_input: 'world' },
      transport,
    );
    const data = result.data as RelaySignalOutput;

    expect(data.state).toBe('AWAITING');
    expect(data.phase).toBe('JOIN');
    expect(data.resume_strategy).toBe('IMMEDIATE');
    expect(data.next_update_seconds).toBe(0);
  });
});
