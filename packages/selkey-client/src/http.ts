/**
 * HTTP transport for the Selkey relay.
 *
 * Fetch-based. No imports from orchestrator, AFAL, vault-runtime, or autopilot.
 */

import type {
  RelayClientConfig,
  CreateSessionResponse,
  SessionStatusResponse,
  SessionOutputResponse,
} from './types.js';
import { isValidCommitmentNonce } from './commitment-v3.js';

class RelayHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Relay HTTP ${status}: ${body}`);
    this.name = 'RelayHttpError';
  }
}

async function relayFetch(
  config: RelayClientConfig,
  path: string,
  options: RequestInit,
): Promise<Response> {
  const url = `${config.relay_url.replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timeoutMs = config.timeout_ms ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text();
      throw new RelayHttpError(res.status, body);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function createSession(
  config: RelayClientConfig,
  contract: object,
  provider?: string,
): Promise<CreateSessionResponse> {
  const body: { contract: object; provider?: string } = { contract };
  if (provider !== undefined) {
    body.provider = provider;
  }
  const res = await relayFetch(config, '/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<CreateSessionResponse>;
}

/**
 * Submit this party's input.
 *
 * `commitmentNonce` is a fresh nonce from `generateCommitmentNonce()` (64
 * lowercase hex characters), generated for this submission only. The relay
 * commits to the input with it, and the caller keeps it with its input to
 * check its own commitment in the receipt later. It is a local secret: do not
 * log it or share it with the counterparty.
 */
export async function submitInput(
  config: RelayClientConfig,
  sessionId: string,
  token: string,
  role: string,
  context: unknown,
  commitmentNonce: string,
  expectedContractHash?: string,
): Promise<SessionStatusResponse> {
  if (!isValidCommitmentNonce(commitmentNonce)) {
    throw new Error(
      'commitmentNonce must be 64 lowercase hex characters (use generateCommitmentNonce())',
    );
  }
  const payload: Record<string, unknown> = {
    role,
    context,
    commitment_nonce: commitmentNonce,
  };
  if (expectedContractHash) {
    payload.expected_contract_hash = expectedContractHash;
  }
  const res = await relayFetch(config, `/sessions/${sessionId}/input`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  return res.json() as Promise<SessionStatusResponse>;
}

export async function getStatus(
  config: RelayClientConfig,
  sessionId: string,
  token: string,
): Promise<SessionStatusResponse> {
  const res = await relayFetch(config, `/sessions/${sessionId}/status`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json() as Promise<SessionStatusResponse>;
}

export async function getOutput(
  config: RelayClientConfig,
  sessionId: string,
  token: string,
): Promise<SessionOutputResponse> {
  const res = await relayFetch(config, `/sessions/${sessionId}/output`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json() as Promise<SessionOutputResponse>;
}
