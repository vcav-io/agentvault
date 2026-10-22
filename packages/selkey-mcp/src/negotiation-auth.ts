/**
 * Authenticated pre-contract negotiation requests.
 *
 * Contract-offer and topic-alignment proposals sent to /afal/negotiate (or the
 * A2A equivalent) carry the sender's agent_id and are signed with the
 * sender's AFAL key under the VCAV-REQUEST-V1: domain prefix. The responder
 * verifies the signature against pins[from] — never a key in the request —
 * and requires the request to be addressed to itself and fresh.
 *
 * Signed fields: every field of the proposal plus
 *   request_type  "CONTRACT_OFFER_PROPOSAL" | "TOPIC_ALIGNMENT_PROPOSAL"
 *   from          sender agent_id
 *   timestamp     RFC 3339
 *   nonce         64 hex
 */

import { randomBytes } from 'node:crypto';

import { DOMAIN_PREFIXES, signMessage, verifyMessage } from './afal-signing.js';
import type { PinResolver } from './pin-store.js';

export type NegotiationRequestType = 'CONTRACT_OFFER_PROPOSAL' | 'TOPIC_ALIGNMENT_PROPOSAL';

const MAX_REQUEST_AGE_MS = 10 * 60 * 1000;

export type SignedNegotiationRequest<T> = T & {
  request_type: NegotiationRequestType;
  from: string;
  timestamp: string;
  nonce: string;
  signature: string;
};

export function signNegotiationRequest<T extends object>(
  requestType: NegotiationRequestType,
  proposal: T,
  fromAgentId: string,
  seedHex: string,
): SignedNegotiationRequest<T> {
  const unsigned = {
    ...proposal,
    request_type: requestType,
    from: fromAgentId,
    timestamp: new Date().toISOString(),
    nonce: randomBytes(32).toString('hex'),
  };
  return signMessage(
    DOMAIN_PREFIXES.REQUEST,
    unsigned as unknown as Record<string, unknown>,
    seedHex,
  ) as unknown as SignedNegotiationRequest<T>;
}

export type NegotiationAuthResult = { ok: true; from: string } | { ok: false; error: string };

/**
 * Verify a signed negotiation request: request type, a pinned sender, a
 * signature under the pinned key, addressed to `localAgentId`, and a
 * timestamp within 10 minutes.
 */
export function verifyNegotiationRequest(
  body: unknown,
  expectedType: NegotiationRequestType,
  localAgentId: string,
  pins: PinResolver,
  nowMs: number = Date.now(),
): NegotiationAuthResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Negotiation request must be a JSON object' };
  }
  const raw = body as Record<string, unknown>;
  if (raw['request_type'] !== expectedType) {
    return { ok: false, error: 'Negotiation request is missing or has the wrong request_type' };
  }
  const from = raw['from'];
  if (typeof from !== 'string' || !from) {
    return { ok: false, error: 'Negotiation request must name its sender (from)' };
  }
  const pinnedKey = pins.pinnedKeyFor(from);
  if (!pinnedKey) {
    return { ok: false, error: 'Negotiation sender is not a pinned agent' };
  }
  if (!verifyMessage(DOMAIN_PREFIXES.REQUEST, raw, pinnedKey)) {
    return { ok: false, error: 'Negotiation request signature does not verify under the sender pin' };
  }
  if (raw['expected_counterparty'] !== localAgentId) {
    return { ok: false, error: 'Negotiation request is not addressed to this agent' };
  }
  const ts = typeof raw['timestamp'] === 'string' ? Date.parse(raw['timestamp']) : NaN;
  if (Number.isNaN(ts) || Math.abs(nowMs - ts) > MAX_REQUEST_AGE_MS) {
    return { ok: false, error: 'Negotiation request timestamp is missing or stale' };
  }
  if (typeof raw['nonce'] !== 'string' || !/^[0-9a-f]{64}$/.test(raw['nonce'])) {
    return { ok: false, error: 'Negotiation request nonce is missing or malformed' };
  }
  return { ok: true, from };
}
