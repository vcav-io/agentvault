import type { DemoEvent } from './events.js';

export const DEMO_SMOKE_MODE = process.env['DEMO_SMOKE_MODE'] === '1';

export const SMOKE_RELAY_HEALTH: Record<string, unknown> = {
  verifying_key_hex: '11'.repeat(32),
  model_id: 'demo-smoke-relay',
  policy_summary: {
    policy_id: 'default-dev-policy',
    policy_hash: '22'.repeat(32),
    model_profile_allowlist: ['api-gpt5-v1', 'api-gpt41mini-v1'],
    provider_allowlist: ['openai'],
    enforcement_rules: [
      { rule_id: 'no_digits', classification: 'ENFORCED' },
      { rule_id: 'no_currency_symbols', classification: 'ENFORCED' },
    ],
    entropy_constraints: {
      budget_bits: 12,
      classification: 'ENFORCED',
    },
  },
};

const SMOKE_RECEIPT_V2 = {
  assurance_level: 'SELF_ASSERTED',
  operator: {
    operator_id: 'demo-smoke-relay',
    operator_key_fingerprint: 'smoke-key',
  },
  session_id: 'smoke-session-001',
  commitments: {
    contract_hash: '33'.repeat(32),
    output_schema_hash: '44'.repeat(32),
    output_hash: '55'.repeat(32),
    prompt_template_hash: '66'.repeat(32),
    input_commitments: {
      alice: { input_hash: '77'.repeat(32) },
      bob: { input_hash: '88'.repeat(32) },
    },
  },
  claims: {
    status: 'completed',
    signal_class: 'BOUNDED_SIGNAL',
    execution_lane: 'API_MEDIATED',
    budget_enforcement_mode: 'schema+guardian',
    model_identity_asserted: {
      provider: 'openai',
      model_id: 'gpt-5',
    },
    token_usage: {
      prompt_tokens: 128,
      completion_tokens: 18,
    },
    channel_capacity_bits_upper_bound: 12,
    entropy_budget_bits: 12,
    budget_usage: {
      bits_used_before: 0,
      bits_used_after: 3,
      budget_limit: 12,
    },
  },
  signature: {
    algorithm: 'ed25519',
    signature_hex: '99'.repeat(64),
  },
};

const SMOKE_EVENTS: Array<{ delayMs: number; event: Omit<DemoEvent, 'ts'> }> = [
  {
    delayMs: 20,
    event: {
      type: 'tool_call',
      agent: 'alice',
      payload: {
        tool: 'relay_signal',
        args: { mode: 'INITIATE' },
      },
    },
  },
  {
    delayMs: 40,
    event: {
      type: 'tool_result',
      agent: 'alice',
      payload: {
        result: {
          status: 'PENDING',
          data: {
            phase: 'POLL_RELAY',
            session_id: 'smoke-session-001',
          },
        },
      },
    },
  },
  {
    delayMs: 60,
    event: {
      type: 'tool_call',
      agent: 'alice',
      payload: {
        tool: 'relay_signal',
        args: { mode: 'POLL_RELAY' },
      },
    },
  },
  {
    delayMs: 80,
    event: {
      type: 'tool_result',
      agent: 'alice',
      payload: {
        result: {
          status: 'PENDING',
          data: {
            phase: 'POLL_RELAY',
            session_id: 'smoke-session-001',
          },
        },
      },
    },
  },
  {
    delayMs: 100,
    event: {
      type: 'tool_call',
      agent: 'bob',
      payload: {
        tool: 'relay_signal',
        args: { mode: 'RESPOND' },
      },
    },
  },
  {
    delayMs: 120,
    event: {
      type: 'tool_result',
      agent: 'bob',
      payload: {
        result: {
          status: 'PENDING',
          data: {
            phase: 'JOIN',
            user_message: 'Accepted bounded mediation session',
          },
        },
      },
    },
  },
  {
    delayMs: 140,
    event: {
      type: 'tool_call',
      agent: 'bob',
      payload: {
        tool: 'relay_signal',
        args: { mode: 'POLL_RELAY' },
      },
    },
  },
  {
    delayMs: 160,
    event: {
      type: 'tool_result',
      agent: 'bob',
      payload: {
        result: {
          status: 'PENDING',
          data: {
            phase: 'JOIN',
            user_message: 'Joined bounded mediation session',
          },
        },
      },
    },
  },
  {
    delayMs: 180,
    event: {
      type: 'llm_text',
      agent: 'alice',
      payload: {
        text: 'The bounded session is active.',
      },
    },
  },
  {
    delayMs: 200,
    event: {
      type: 'tool_call',
      agent: 'alice',
      payload: {
        tool: 'relay_signal',
        args: { mode: 'POLL_RELAY' },
      },
    },
  },
  {
    delayMs: 220,
    event: {
      type: 'tool_result',
      agent: 'alice',
      payload: {
        result: {
          status: 'COMPLETE',
          data: {
            output: {
              output: {
                compatibility_signal: 'WORKABLE_COMPROMISE',
                recommendation: 'Proceed with a bounded follow-up discussion.',
              },
              receipt_v2: SMOKE_RECEIPT_V2,
            },
          },
        },
      },
    },
  },
  {
    delayMs: 240,
    event: {
      type: 'agent_status',
      agent: 'alice',
      payload: {
        status: 'completed',
      },
    },
  },
  {
    delayMs: 260,
    event: {
      type: 'agent_status',
      agent: 'bob',
      payload: {
        status: 'completed',
      },
    },
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function emitSmokeRun(
  emit: (event: DemoEvent) => void,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  let previousDelay = 0;
  for (const { delayMs, event } of SMOKE_EVENTS) {
    const waitMs = Math.max(0, delayMs - previousDelay);
    previousDelay = delayMs;
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    emit({
      ...event,
      ts: now(),
    });
  }
}

export function verifySmokeReceipt(): {
  verified: boolean;
  schema_version: string;
  assurance_level: string;
  operator_id: string;
  errors: string[];
  warnings: string[];
} {
  return {
    verified: true,
    schema_version: '2',
    assurance_level: 'SELF_ASSERTED',
    operator_id: 'demo-smoke-relay',
    errors: [],
    warnings: [],
  };
}
