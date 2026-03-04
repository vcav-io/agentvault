import { describe, it, expect } from 'vitest';
import { dispatch } from '../dispatch.js';
import { handleRelaySignal } from '../tools/relaySignal.js';

describe('dispatch', () => {
  it('rejects unknown tool names', async () => {
    await expect(dispatch('agentvault.nonexistent', {})).rejects.toThrow(
      'Unknown tool: agentvault.nonexistent',
    );
  });
});

describe('handleRelaySignal input validation', () => {
  it('requires mode on fresh call', async () => {
    const result = await handleRelaySignal({});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.detail).toContain('mode is required');
  });

  it('rejects unknown mode', async () => {
    const result = await handleRelaySignal({ mode: 'INVALID' as any });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.detail).toContain('Unknown mode');
  });

  it('INITIATE requires AfalTransport', async () => {
    const result = await handleRelaySignal({
      mode: 'INITIATE',
      counterparty: 'agent-2',
      purpose: 'MEDIATION',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SESSION_ERROR');
    expect(result.error?.detail).toContain('AfalTransport');
  });

  it('RESPOND requires AfalTransport', async () => {
    const result = await handleRelaySignal({
      mode: 'RESPOND',
      from: 'agent-1',
      expected_purpose: 'MEDIATION',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SESSION_ERROR');
    expect(result.error?.detail).toContain('AfalTransport');
  });

  it('JOIN requires session_id, submit_token, read_token, contract_hash', async () => {
    const result = await handleRelaySignal({ mode: 'JOIN' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.detail).toContain('session_id');
  });

  it('CREATE requires contract', async () => {
    // Set env to avoid relay_url error
    const orig = process.env['AV_RELAY_URL'];
    process.env['AV_RELAY_URL'] = 'http://localhost:9999';
    try {
      const result = await handleRelaySignal({ mode: 'CREATE' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(result.error?.detail).toContain('contract');
    } finally {
      if (orig === undefined) delete process.env['AV_RELAY_URL'];
      else process.env['AV_RELAY_URL'] = orig;
    }
  });

  it('strips extra args alongside resume_token and proceeds to decode', async () => {
    const result = await handleRelaySignal({
      resume_token: 'some-token',
      mode: 'INITIATE',
    });
    // Extra args are stripped; the fake token then fails decoding
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.detail).toContain('Invalid or expired resume_token');
  });
});
