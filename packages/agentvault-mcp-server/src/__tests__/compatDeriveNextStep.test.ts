/**
 * Unit tests for deriveCompatNextStep — pure function, no mocks needed.
 *
 * Covers all 5 rules, fallback (null), agrees true/false/undefined cases.
 */

import { describe, it, expect } from 'vitest';
import { deriveCompatNextStep } from '../tools/relaySignal.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '2',
    compatibility_signal: 'STRONG_MATCH',
    thesis_fit: 'ALIGNED',
    size_fit: 'WITHIN_BAND',
    stage_fit: 'ALIGNED',
    confidence: 'HIGH',
    primary_reasons: ['SECTOR_MATCH', 'SIZE_COMPATIBLE'],
    blocking_reasons: [],
    next_step: 'PROCEED',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule 1: blocking_reasons present → DO_NOT_PROCEED
// ---------------------------------------------------------------------------

describe('Rule 1: blocking_reasons present', () => {
  it('returns DO_NOT_PROCEED when one blocking reason present', () => {
    const result = deriveCompatNextStep(makeOutput({
      blocking_reasons: ['SIZE_INCOMPATIBLE'],
      next_step: 'PROCEED',
    }));
    expect(result).not.toBeNull();
    expect(result!.value).toBe('DO_NOT_PROCEED');
    expect(result!.rule_summary).toMatch(/[Bb]locking reasons/);
    expect(result!.model_value).toBe('PROCEED');
    expect(result!.agrees).toBe(false);
  });

  it('rule_summary does not contain prescriptive language', () => {
    const result = deriveCompatNextStep(makeOutput({ blocking_reasons: ['SECTOR_MISMATCH'] }));
    const forbidden = /recommend|advise|suggest|should/i;
    expect(result!.rule_summary).not.toMatch(forbidden);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: NO_MATCH signal → DO_NOT_PROCEED
// ---------------------------------------------------------------------------

describe('Rule 2: NO_MATCH signal', () => {
  it('returns DO_NOT_PROCEED for NO_MATCH signal', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'NO_MATCH',
      blocking_reasons: [],
      next_step: 'DO_NOT_PROCEED',
    }));
    expect(result).not.toBeNull();
    expect(result!.value).toBe('DO_NOT_PROCEED');
    expect(result!.agrees).toBe(true);
  });

  it('agrees is false when model chose wrong value for NO_MATCH', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'NO_MATCH',
      blocking_reasons: [],
      next_step: 'PROCEED',
    }));
    expect(result!.agrees).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: STRONG_MATCH
// ---------------------------------------------------------------------------

describe('Rule 3: STRONG_MATCH', () => {
  it('returns PROCEED when all conditions met', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'STRONG_MATCH',
      confidence: 'HIGH',
      thesis_fit: 'ALIGNED',
      size_fit: 'WITHIN_BAND',
      stage_fit: 'ALIGNED',
      primary_reasons: ['SECTOR_MATCH', 'SIZE_COMPATIBLE'],
      blocking_reasons: [],
      next_step: 'PROCEED',
    }));
    expect(result!.value).toBe('PROCEED');
    expect(result!.agrees).toBe(true);
  });

  it('returns PROCEED_WITH_CAVEATS when confidence is not HIGH', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'STRONG_MATCH',
      confidence: 'MEDIUM',
      thesis_fit: 'ALIGNED',
      size_fit: 'WITHIN_BAND',
      stage_fit: 'ALIGNED',
      primary_reasons: ['SECTOR_MATCH', 'SIZE_COMPATIBLE'],
      blocking_reasons: [],
      next_step: 'PROCEED',
    }));
    expect(result!.value).toBe('PROCEED_WITH_CAVEATS');
    expect(result!.agrees).toBe(false);
  });

  it('returns PROCEED_WITH_CAVEATS when primary_reasons has fewer than 2', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'STRONG_MATCH',
      confidence: 'HIGH',
      thesis_fit: 'ALIGNED',
      size_fit: 'WITHIN_BAND',
      stage_fit: 'ALIGNED',
      primary_reasons: ['SECTOR_MATCH'],
      blocking_reasons: [],
      next_step: 'PROCEED',
    }));
    expect(result!.value).toBe('PROCEED_WITH_CAVEATS');
  });

  it('returns PROCEED_WITH_CAVEATS when a dimension is not ALIGNED', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'STRONG_MATCH',
      confidence: 'HIGH',
      thesis_fit: 'PARTIAL',
      size_fit: 'WITHIN_BAND',
      stage_fit: 'ALIGNED',
      primary_reasons: ['SECTOR_MATCH', 'SIZE_COMPATIBLE'],
      blocking_reasons: [],
    }));
    expect(result!.value).toBe('PROCEED_WITH_CAVEATS');
  });
});

// ---------------------------------------------------------------------------
// Rule 4: PARTIAL_MATCH
// ---------------------------------------------------------------------------

describe('Rule 4: PARTIAL_MATCH', () => {
  it('returns ASK_FOR_PUBLIC_INFO when 2 or more weak dimensions', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'PARTIAL_MATCH',
      thesis_fit: 'MISALIGNED',
      size_fit: 'UNKNOWN',
      stage_fit: 'ALIGNED',
      blocking_reasons: [],
      next_step: 'ASK_FOR_PUBLIC_INFO',
    }));
    expect(result!.value).toBe('ASK_FOR_PUBLIC_INFO');
    expect(result!.agrees).toBe(true);
  });

  it('returns PROCEED_WITH_CAVEATS when fewer than 2 weak dimensions', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'PARTIAL_MATCH',
      thesis_fit: 'ALIGNED',
      size_fit: 'UNKNOWN',
      stage_fit: 'ALIGNED',
      blocking_reasons: [],
      next_step: 'PROCEED_WITH_CAVEATS',
    }));
    expect(result!.value).toBe('PROCEED_WITH_CAVEATS');
    expect(result!.agrees).toBe(true);
  });

  it('counts MISALIGNED and UNKNOWN as weak, not PARTIAL', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'PARTIAL_MATCH',
      thesis_fit: 'PARTIAL',
      size_fit: 'MISALIGNED',
      stage_fit: 'MISALIGNED',
      blocking_reasons: [],
    }));
    expect(result!.value).toBe('ASK_FOR_PUBLIC_INFO');
  });
});

// ---------------------------------------------------------------------------
// Rule 5: WEAK_MATCH
// ---------------------------------------------------------------------------

describe('Rule 5: WEAK_MATCH', () => {
  it('returns ASK_FOR_PUBLIC_INFO when confidence is LOW', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'WEAK_MATCH',
      confidence: 'LOW',
      blocking_reasons: [],
      next_step: 'ASK_FOR_PUBLIC_INFO',
    }));
    expect(result!.value).toBe('ASK_FOR_PUBLIC_INFO');
    expect(result!.agrees).toBe(true);
  });

  it('returns DO_NOT_PROCEED when confidence is MEDIUM', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'WEAK_MATCH',
      confidence: 'MEDIUM',
      blocking_reasons: [],
      next_step: 'PROCEED',
    }));
    expect(result!.value).toBe('DO_NOT_PROCEED');
    expect(result!.agrees).toBe(false);
  });

  it('returns DO_NOT_PROCEED when confidence is HIGH', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'WEAK_MATCH',
      confidence: 'HIGH',
      blocking_reasons: [],
    }));
    expect(result!.value).toBe('DO_NOT_PROCEED');
  });
});

// ---------------------------------------------------------------------------
// Fallback: unknown / missing signal
// ---------------------------------------------------------------------------

describe('Fallback: unknown or missing signal', () => {
  it('returns null for unknown signal value', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'UNKNOWN_SIGNAL_VALUE',
      blocking_reasons: [],
    }));
    expect(result).toBeNull();
  });

  it('returns null when compatibility_signal is missing', () => {
    const output: Record<string, unknown> = {
      blocking_reasons: [],
      next_step: 'PROCEED',
    };
    const result = deriveCompatNextStep(output);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// agrees field semantics
// ---------------------------------------------------------------------------

describe('agrees field semantics', () => {
  it('agrees is true when derived value matches model value', () => {
    const result = deriveCompatNextStep(makeOutput({ next_step: 'PROCEED' }));
    expect(result!.agrees).toBe(true);
  });

  it('agrees is false when derived value differs from model value', () => {
    const result = deriveCompatNextStep(makeOutput({
      compatibility_signal: 'NO_MATCH',
      blocking_reasons: [],
      next_step: 'PROCEED',
    }));
    expect(result!.agrees).toBe(false);
  });

  it('agrees is undefined when next_step is absent from output', () => {
    const output = makeOutput();
    delete output['next_step'];
    const result = deriveCompatNextStep(output);
    expect(result).not.toBeNull();
    expect('agrees' in result!).toBe(false);
  });

  it('model_value is empty string when next_step absent', () => {
    const output = makeOutput({ compatibility_signal: 'NO_MATCH', blocking_reasons: [] });
    delete output['next_step'];
    const result = deriveCompatNextStep(output);
    expect(result!.model_value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Authority envelope: rule_summary language guardrails
// ---------------------------------------------------------------------------

describe('rule_summary language guardrails', () => {
  const forbidden = /recommend|advise|suggest|should/i;

  const cases: Array<Record<string, unknown>> = [
    makeOutput({ blocking_reasons: ['SIZE_INCOMPATIBLE'] }),
    makeOutput({ compatibility_signal: 'NO_MATCH', blocking_reasons: [] }),
    makeOutput({ compatibility_signal: 'STRONG_MATCH', confidence: 'MEDIUM', blocking_reasons: [] }),
    makeOutput({ compatibility_signal: 'PARTIAL_MATCH', thesis_fit: 'MISALIGNED', size_fit: 'UNKNOWN', blocking_reasons: [] }),
    makeOutput({ compatibility_signal: 'WEAK_MATCH', confidence: 'LOW', blocking_reasons: [] }),
    makeOutput({ compatibility_signal: 'WEAK_MATCH', confidence: 'HIGH', blocking_reasons: [] }),
  ];

  cases.forEach((output, idx) => {
    it(`rule_summary for case ${idx} has no prescriptive language`, () => {
      const result = deriveCompatNextStep(output);
      expect(result!.rule_summary).not.toMatch(forbidden);
    });
  });
});
