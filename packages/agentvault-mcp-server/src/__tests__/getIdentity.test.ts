import { describe, it, expect } from 'vitest';
import { handleGetIdentity, type InboxService } from '../tools/getIdentity.js';
import type { NormalizedKnownAgent } from '../tools/relaySignal.js';

describe('handleGetIdentity', () => {
  it('returns agent_id when provided', async () => {
    const result = await handleGetIdentity('test-agent-123', []);
    expect(result.ok).toBe(true);
    expect(result.data?.agent_id).toBe('test-agent-123');
  });

  it('returns undefined agent_id when not provided', async () => {
    const result = await handleGetIdentity(undefined, []);
    expect(result.ok).toBe(true);
    expect(result.data?.agent_id).toBeUndefined();
  });

  it('returns the known_agents array', async () => {
    const knownAgents: NormalizedKnownAgent[] = [
      { agent_id: 'agent-a', aliases: ['alice', 'a'] },
      { agent_id: 'agent-b', aliases: ['bob'] },
    ];
    const result = await handleGetIdentity(undefined, knownAgents);
    expect(result.ok).toBe(true);
    expect(result.data?.known_agents).toEqual(knownAgents);
  });

  it('works with empty known_agents', async () => {
    const result = await handleGetIdentity(undefined, []);
    expect(result.ok).toBe(true);
    expect(result.data?.known_agents).toEqual([]);
  });

  it('returns SUCCESS status', async () => {
    const result = await handleGetIdentity(undefined, []);
    expect(result.status).toBe('SUCCESS');
    expect(result.error).toBeNull();
  });

  describe('inbox integration', () => {
    it('omits pending_invites without inboxService', async () => {
      const result = await handleGetIdentity(undefined, []);
      expect(result.ok).toBe(true);
      expect(result.data).not.toHaveProperty('pending_invites');
      expect(result.data).not.toHaveProperty('next_action');
      expect(result.data).not.toHaveProperty('inbox_hint');
    });

    it('returns pending_invites: 0 with inbox_hint when no pending invites', async () => {
      const inboxService: InboxService = {
        checkInbox: async () => ({ invites: [] }),
      };
      const result = await handleGetIdentity(undefined, [], inboxService);
      expect(result.ok).toBe(true);
      expect(result.data?.pending_invites).toBe(0);
      expect(result.data).not.toHaveProperty('next_action');
      expect(result.data?.inbox_hint).toBe('No pending invites.');
    });

    it('returns next_action and inbox_hint with 1 pending invite', async () => {
      const inboxService: InboxService = {
        checkInbox: async () => ({ invites: [{ invite_id: 'inv-1' }] }),
      };
      const result = await handleGetIdentity(undefined, [], inboxService);
      expect(result.ok).toBe(true);
      expect(result.data?.pending_invites).toBe(1);
      expect(result.data?.next_action).toEqual({
        tool: 'agentvault.relay_signal',
        args: { mode: 'RESPOND' },
        reason: 'pending_invite',
      });
      expect(result.data?.inbox_hint).toBe('You have 1 pending invite(s).');
    });

    it('pre-fills from and expected_purpose in next_action when single invite has metadata', async () => {
      const inboxService: InboxService = {
        checkInbox: async () => ({
          invites: [{
            invite_id: 'inv-1',
            from_agent_id: 'alice',
            afalPropose: { purpose_code: 'MEDIATION' },
          }],
        }),
      };
      const result = await handleGetIdentity(undefined, [], inboxService);
      expect(result.data?.next_action).toEqual({
        tool: 'agentvault.relay_signal',
        args: { mode: 'RESPOND', from: 'alice', expected_purpose: 'MEDIATION' },
        reason: 'pending_invite',
      });
    });

    it('does not pre-fill from/purpose with multiple invites', async () => {
      const inboxService: InboxService = {
        checkInbox: async () => ({
          invites: [
            { invite_id: 'inv-1', from_agent_id: 'alice', afalPropose: { purpose_code: 'MEDIATION' } },
            { invite_id: 'inv-2', from_agent_id: 'bob', afalPropose: { purpose_code: 'COMPATIBILITY' } },
          ],
        }),
      };
      const result = await handleGetIdentity(undefined, [], inboxService);
      expect(result.data?.next_action?.args).toEqual({ mode: 'RESPOND' });
    });

    it('returns correct count with 3 pending invites', async () => {
      const inboxService: InboxService = {
        checkInbox: async () => ({
          invites: [{ invite_id: 'inv-1' }, { invite_id: 'inv-2' }, { invite_id: 'inv-3' }],
        }),
      };
      const result = await handleGetIdentity(undefined, [], inboxService);
      expect(result.ok).toBe(true);
      expect(result.data?.pending_invites).toBe(3);
      expect(result.data?.inbox_hint).toContain('3 pending invite(s)');
      expect(result.data?.next_action?.reason).toBe('pending_invite');
    });

    it('omits pending_invites and adds warning hint when inboxService throws', async () => {
      const inboxService: InboxService = {
        checkInbox: async () => {
          throw new Error('network error');
        },
      };
      const result = await handleGetIdentity(undefined, [], inboxService);
      expect(result.ok).toBe(true);
      expect(result.data).not.toHaveProperty('pending_invites');
      expect(result.data).not.toHaveProperty('next_action');
      expect(result.data?.inbox_hint).toContain('inbox check failed');
    });
  });
});
