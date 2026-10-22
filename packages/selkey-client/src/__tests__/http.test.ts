import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSession, submitInput } from '../http.js';

const TOKEN = 'op-token-0123456789abcdef0123456789abcdef';
const CREATED = {
  session_id: 's',
  contract_hash: 'h',
  initiator_submit_token: 'a',
  initiator_read_token: 'b',
  responder_submit_token: 'c',
  responder_read_token: 'd',
};

function stubFetch(status = 200, body: unknown = CREATED) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
  return calls;
}

function authHeader(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.['Authorization'];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('operator token', () => {
  it('sends the operator token as a bearer token when creating a session', async () => {
    const calls = stubFetch();
    await createSession({ relay_url: 'https://relay.test/', operator_token: TOKEN }, { purpose_code: 'X' });
    expect(calls[0].url).toBe('https://relay.test/sessions');
    expect(authHeader(calls[0].init)).toBe(`Bearer ${TOKEN}`);
  });

  it('sends no Authorization header without a token', async () => {
    const calls = stubFetch();
    await createSession({ relay_url: 'https://relay.test' }, { purpose_code: 'X' });
    expect(authHeader(calls[0].init)).toBeUndefined();
  });

  it('does not send the operator token on participant requests', async () => {
    const calls = stubFetch(200, { state: 'PARTIAL' });
    await submitInput(
      { relay_url: 'https://relay.test', operator_token: TOKEN },
      's',
      'submit-token',
      'initiator',
      'hi',
      'ab'.repeat(32),
    );
    expect(authHeader(calls[0].init)).toBe('Bearer submit-token');
  });

  it('keeps the token out of relay errors', async () => {
    stubFetch(401, 'unauthorized');
    const err = await createSession({ relay_url: 'https://relay.test', operator_token: TOKEN }, {}).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });

  it('refuses a token with whitespace', async () => {
    stubFetch();
    await expect(
      createSession({ relay_url: 'https://relay.test', operator_token: 'a b' }, {}),
    ).rejects.toThrow(/operator_token/);
  });
});
