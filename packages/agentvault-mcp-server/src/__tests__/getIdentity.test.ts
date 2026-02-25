import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleGetIdentity } from '../tools/getIdentity.js';
import type { NormalizedKnownAgent } from '../tools/relaySignal.js';

describe('handleGetIdentity', () => {
  const originalAgentId = process.env['VCAV_AGENT_ID'];

  beforeEach(() => {
    delete process.env['VCAV_AGENT_ID'];
  });

  afterEach(() => {
    if (originalAgentId === undefined) {
      delete process.env['VCAV_AGENT_ID'];
    } else {
      process.env['VCAV_AGENT_ID'] = originalAgentId;
    }
  });

  it('returns agent_id from env', () => {
    process.env['VCAV_AGENT_ID'] = 'test-agent-123';
    const result = handleGetIdentity([]);
    expect(result.ok).toBe(true);
    expect(result.data?.agent_id).toBe('test-agent-123');
  });

  it('returns undefined agent_id when env not set', () => {
    const result = handleGetIdentity([]);
    expect(result.ok).toBe(true);
    expect(result.data?.agent_id).toBeUndefined();
  });

  it('returns the known_agents array', () => {
    const knownAgents: NormalizedKnownAgent[] = [
      { agent_id: 'agent-a', aliases: ['alice', 'a'] },
      { agent_id: 'agent-b', aliases: ['bob'] },
    ];
    const result = handleGetIdentity(knownAgents);
    expect(result.ok).toBe(true);
    expect(result.data?.known_agents).toEqual(knownAgents);
  });

  it('works with empty known_agents', () => {
    const result = handleGetIdentity([]);
    expect(result.ok).toBe(true);
    expect(result.data?.known_agents).toEqual([]);
  });

  it('returns SUCCESS status', () => {
    const result = handleGetIdentity([]);
    expect(result.status).toBe('SUCCESS');
    expect(result.error).toBeNull();
  });
});
