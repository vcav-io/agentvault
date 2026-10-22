import { describe, it, expect } from 'vitest';
import { buildSuccess, buildError } from '../envelope.js';

describe('buildSuccess', () => {
  it('returns constant-shape envelope with data and no error', () => {
    const result = buildSuccess('COMPLETE', { foo: 'bar' });
    expect(result).toEqual({
      ok: true,
      status: 'COMPLETE',
      data: { foo: 'bar' },
      error: null,
    });
  });
});

describe('buildError', () => {
  it('returns constant-shape envelope with error and no data', () => {
    const result = buildError('INVALID_INPUT', 'bad args');
    expect(result).toEqual({
      ok: false,
      status: 'ERROR',
      data: null,
      error: { code: 'INVALID_INPUT', detail: 'bad args', retryable: false },
    });
  });

  it('uses default retryable flag per error code', () => {
    const retryable = buildError('COUNTERPARTY_UNREACHABLE', 'down');
    expect(retryable.error!.retryable).toBe(true);

    const notRetryable = buildError('INVALID_INPUT', 'bad');
    expect(notRetryable.error!.retryable).toBe(false);
  });

  it('allows overriding retryable flag', () => {
    const result = buildError('INVALID_INPUT', 'bad', true);
    expect(result.error!.retryable).toBe(true);
  });
});
