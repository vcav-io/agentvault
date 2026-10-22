import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GeminiProvider } from './gemini.js';

let server: Server;
let base: string;
const landingKeys: Array<string | undefined> = [];

function handler(req: IncomingMessage, res: ServerResponse): void {
  if (req.url?.startsWith('/landing')) {
    landingKeys.push(req.headers['x-goog-api-key'] as string | undefined);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"candidates":[]}');
  } else if (req.url?.startsWith('/redirect')) {
    res.writeHead(307, { Location: `${base}/landing` });
    res.end();
  } else {
    // Headers arrive; the body never completes.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"candidates":');
  }
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const chat = { messages: [{ role: 'user' as const, content: 'hi' }], tools: [] };

describe('GeminiProvider requests', () => {
  it('does not follow a redirect with the API key', async () => {
    const provider = new GeminiProvider('dummy-key', 'm', `${base}/redirect`);
    await expect(provider.chat(chat)).rejects.toMatchObject({ name: 'UnexpectedRedirectError' });
    expect(landingKeys).toHaveLength(0);
  });

  it('gives up on a response body that never completes', async () => {
    const provider = new GeminiProvider('dummy-key', 'm', `${base}/stall`, 150);
    await expect(provider.chat(chat)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
