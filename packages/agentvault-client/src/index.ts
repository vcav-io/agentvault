/**
 * High-level AgentVault relay client API.
 *
 * Combines HTTP calls with polling. No imports from orchestrator, AFAL,
 * vault-runtime, or autopilot — this is a standalone client boundary.
 */

import {
  createSession as httpCreateSession,
  submitInput as httpSubmitInput,
  getStatus as httpGetStatus,
  getOutput as httpGetOutput,
} from './http.js';
import type { RelayClientConfig, CreateSessionResponse, SessionOutputResponse } from './types.js';

export type { RelayClientConfig, SessionOutputResponse } from './types.js';
export type { CreateSessionResponse } from './types.js';

const POLL_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateAndSubmitResult {
  sessionId: string;
  contractHash: string;
  responderSubmitToken: string;
  responderReadToken: string;
  initiatorReadToken: string;
}

/**
 * Create a relay session and submit the initiator's input in one call.
 * Returns session ID, contract hash, and the tokens the responder needs.
 */
export async function createAndSubmit(
  config: RelayClientConfig,
  contract: object,
  myInput: unknown,
  role: string,
): Promise<CreateAndSubmitResult> {
  const session: CreateSessionResponse = await httpCreateSession(config, contract);
  await httpSubmitInput(config, session.session_id, session.initiator_submit_token, role, myInput);
  return {
    sessionId: session.session_id,
    contractHash: session.contract_hash,
    responderSubmitToken: session.responder_submit_token,
    responderReadToken: session.responder_read_token,
    initiatorReadToken: session.initiator_read_token,
  };
}

/**
 * Join an existing relay session: submit input with expected contract hash
 * (relay verifies server-side), poll until Completed or Aborted, then
 * retrieve and return the output.
 */
export async function joinAndWait(
  config: RelayClientConfig,
  sessionId: string,
  submitToken: string,
  readToken: string,
  expectedContractHash: string,
  myInput: unknown,
  role: string,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<SessionOutputResponse> {
  // Verify session is reachable before submitting input.
  await httpGetStatus(config, sessionId, submitToken);

  // Pass expected_contract_hash to the relay — the relay verifies it matches
  // the session's actual contract hash and rejects with ContractMismatch if not.
  await httpSubmitInput(config, sessionId, submitToken, role, myInput, expectedContractHash);

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await httpGetStatus(config, sessionId, readToken);
    if (status.state === 'COMPLETED') {
      return httpGetOutput(config, sessionId, readToken);
    }
    if (status.state === 'ABORTED') {
      return {
        state: 'ABORTED',
        abort_reason: status.abort_reason,
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    state: 'ABORTED',
    abort_reason: 'TIMEOUT',
  };
}

/**
 * Poll an existing session until Completed or Aborted, then return the output.
 * Used by CREATE mode after submitting own input.
 */
export async function pollUntilDone(
  config: RelayClientConfig,
  sessionId: string,
  readToken: string,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<SessionOutputResponse> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await httpGetStatus(config, sessionId, readToken);
    if (status.state === 'COMPLETED') {
      return httpGetOutput(config, sessionId, readToken);
    }
    if (status.state === 'ABORTED') {
      return {
        state: 'ABORTED',
        abort_reason: status.abort_reason,
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    state: 'ABORTED',
    abort_reason: 'TIMEOUT',
  };
}
