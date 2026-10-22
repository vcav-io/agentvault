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
    enforcement_rules: ['no_digits', 'no_currency_symbols'],
    entropy_constraints: {
      budget_bits: 12,
      classification: 'ENFORCED',
    },
  },
};

// Illustrative receipt v3 shape for the offline smoke flow (not signed).
const SMOKE_RECEIPT = {
  receipt_schema_version: '3.0.0',
  receipt_canonicalization: 'JCS_RFC8785',
  receipt_id: 'smoke-receipt-001',
  session_id: 'smoke-session-001',
  issued_at: '2026-01-01T00:00:00Z',
  assurance_level: 'SELF_ASSERTED',
  operator: {
    operator_id: 'demo-smoke-relay',
    operator_key_fingerprint: '22'.repeat(32),
  },
  commitments: {
    contract_hash: '33'.repeat(32),
    contract_hash_alg: 'SHA256_JCS_V2',
    schema_hash: '44'.repeat(32),
    output_hash: '55'.repeat(32),
    input_commitments: [
      { participant_id: 'alice', input_commitment: '77'.repeat(32), scheme: 'SHA256_N32_JCS_V3' },
      { participant_id: 'bob', input_commitment: '88'.repeat(32), scheme: 'SHA256_N32_JCS_V3' },
    ],
    assembled_prompt_hash: '99'.repeat(32),
    prompt_assembly_version: '1.0.0',
    prompt_template_hash: '66'.repeat(32),
  },
  claims: {
    status: 'success',
    signal_class: 'SESSION_COMPLETED',
    execution_lane: 'standard',
    budget_enforcement_mode: 'enforced',
    model_identity_asserted: 'openai/gpt-5',
    token_usage: {
      prompt_tokens: 128,
      completion_tokens: 18,
      total_tokens: 146,
    },
    channel_capacity_bits_upper_bound: 12,
    entropy_budget_bits: 12,
    budget_usage: {
      scope: 'SESSION',
      bits_used_before: 0,
      bits_used_after: 3,
      budget_limit: 12,
    },
  },
  signature: {
    alg: 'Ed25519',
    value: 'smoke-signature',
    signed_fields: 'ALL_EXCEPT_SIGNATURE',
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
              receipt: SMOKE_RECEIPT,
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
    schema_version: '3.0.0',
    assurance_level: 'SELF_ASSERTED',
    operator_id: 'demo-smoke-relay',
    errors: [],
    warnings: [],
  };
}
