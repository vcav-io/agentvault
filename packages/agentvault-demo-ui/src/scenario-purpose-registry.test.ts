import { describe, expect, it, vi } from 'vitest';
import type { ToolRegistry } from 'agentvault-mcp-server/tools';

import {
  applyScenarioPurposeDefaults,
  withScenarioPurposeRegistry,
} from './scenario-purpose-registry.js';

describe('scenario purpose registry', () => {
  it('adds acceptable_purposes for initiate calls when configured', () => {
    expect(
      applyScenarioPurposeDefaults(
        { mode: 'INITIATE', counterparty: 'bob', my_input: 'hello' },
        ['MEDIATION', 'COMPATIBILITY'],
      ),
    ).toEqual({
      mode: 'INITIATE',
      counterparty: 'bob',
      my_input: 'hello',
      acceptable_purposes: ['MEDIATION', 'COMPATIBILITY'],
    });
  });

  it('removes a guessed purpose when it is already covered by acceptable_purposes', () => {
    expect(
      applyScenarioPurposeDefaults(
        { mode: 'INITIATE', counterparty: 'bob', purpose: 'COMPATIBILITY', my_input: 'hello' },
        ['MEDIATION', 'COMPATIBILITY'],
      ),
    ).toEqual({
      mode: 'INITIATE',
      counterparty: 'bob',
      my_input: 'hello',
      acceptable_purposes: ['MEDIATION', 'COMPATIBILITY'],
    });
  });

  it('leaves explicit contracts and existing acceptable_purposes untouched', () => {
    const contract = { purpose_code: 'CUSTOM' };
    expect(
      applyScenarioPurposeDefaults(
        { mode: 'INITIATE', counterparty: 'bob', contract, my_input: 'hello' },
        ['MEDIATION', 'COMPATIBILITY'],
      ),
    ).toEqual({
      mode: 'INITIATE',
      counterparty: 'bob',
      contract,
      my_input: 'hello',
    });

    expect(
      applyScenarioPurposeDefaults(
        {
          mode: 'INITIATE',
          counterparty: 'bob',
          acceptable_purposes: ['COMPATIBILITY'],
          my_input: 'hello',
        },
        ['MEDIATION', 'COMPATIBILITY'],
      ),
    ).toEqual({
      mode: 'INITIATE',
      counterparty: 'bob',
      acceptable_purposes: ['COMPATIBILITY'],
      my_input: 'hello',
    });
  });

  it('wraps relay_signal dispatch through the scenario defaults', async () => {
    const baseRegistry: ToolRegistry = {
      handleGetIdentity: vi.fn(),
      handleRelaySignal: vi.fn().mockResolvedValue({ ok: true }),
      handleVerifyReceipt: vi.fn(),
      dispatch: vi.fn(),
      toolDefs: [],
    };

    const wrapped = withScenarioPurposeRegistry(baseRegistry, ['MEDIATION', 'COMPATIBILITY']);
    await wrapped.dispatch('agentvault.relay_signal', {
      mode: 'INITIATE',
      counterparty: 'bob',
      purpose: 'MEDIATION',
      my_input: 'hello',
    });

    expect(baseRegistry.handleRelaySignal).toHaveBeenCalledWith({
      mode: 'INITIATE',
      counterparty: 'bob',
      acceptable_purposes: ['MEDIATION', 'COMPATIBILITY'],
      my_input: 'hello',
    });
  });
});
