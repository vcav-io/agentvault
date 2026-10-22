/**
 * Local relay selection.
 *
 * Both INITIATE and RESPOND only talk to relays that this agent has
 * configured locally: SELKEY_RELAY_URL, plus any entries in
 * SELKEY_RELAY_ALLOWLIST (comma-separated). Relay URLs supplied by a peer
 * (Agent Card, invite payload, COMMIT) are only used when they match one of
 * these.
 *
 * SELKEY_RELAY_VERIFYING_KEY_HEX pins the relay's signing key:
 * - contracts this agent builds carry it as `relay_verifying_key_hex`, so a
 *   relay with a different key rejects the session before inputs are accepted;
 * - as a responder, this agent accepts only contracts that carry it;
 * - the relay's /health verifying_key_hex must match it before any input is
 *   submitted.
 * Outside development (SELKEY_ENV=dev) the pin is required: without it this
 * agent neither starts nor responds to relay sessions. In development an
 * unpinned agent still works, and a pinned responder also accepts contracts
 * without a relay key.
 *
 * Plain http:// relays are accepted only on loopback hosts (localhost,
 * 127.0.0.0/8, [::1]) and on host names listed in
 * SELKEY_RELAY_INSECURE_HTTP_HOSTS (comma-separated, for example "relay" on
 * a private compose network in the local demo).
 */

import { fetchRelayPublicKey, relayKeyId, verifyReceipt } from 'selkey/verify';
import type { OwnInputArtefact, VerifyArtefacts } from 'selkey/verify';
import type { RelayClientConfig } from 'selkey/types';

export const RELAY_URL_ENV = 'SELKEY_RELAY_URL';
export const RELAY_ALLOWLIST_ENV = 'SELKEY_RELAY_ALLOWLIST';
export const RELAY_VERIFYING_KEY_ENV = 'SELKEY_RELAY_VERIFYING_KEY_HEX';
export const RELAY_INSECURE_HTTP_HOSTS_ENV = 'SELKEY_RELAY_INSECURE_HTTP_HOSTS';
export const SELKEY_ENV = 'SELKEY_ENV';
export const OPERATOR_TOKEN_ENV = 'SELKEY_OPERATOR_TOKEN';

const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

export class RelayTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayTrustError';
  }
}

/** Normalise a relay URL for comparison (scheme, host, port, path without trailing slash). */
export function normalizeRelayUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost') return true;
  if (host === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function insecureHttpHosts(): Set<string> {
  return new Set(
    (process.env[RELAY_INSECURE_HTTP_HOSTS_ENV] ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Whether the relay URL uses an acceptable transport: https, or http on a
 * loopback host or a host listed in SELKEY_RELAY_INSECURE_HTTP_HOSTS.
 */
export function isRelayTransportAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  if (isLoopbackHost(parsed.hostname)) return true;
  return insecureHttpHosts().has(parsed.hostname.toLowerCase());
}

/** Locally configured relay URLs (normalised). Non-loopback http:// entries are dropped. */
export function getAllowedRelayUrls(extra: Array<string | undefined> = []): string[] {
  const raw: string[] = [];
  const primary = process.env[RELAY_URL_ENV];
  if (primary) raw.push(primary);
  const list = process.env[RELAY_ALLOWLIST_ENV];
  if (list) raw.push(...list.split(','));
  for (const url of extra) {
    if (url) raw.push(url);
  }
  const out = new Set<string>();
  for (const url of raw) {
    const normalized = normalizeRelayUrl(url);
    if (normalized && isRelayTransportAllowed(normalized)) out.add(normalized);
  }
  return [...out];
}

export function isRelayUrlAllowed(url: string, extra: Array<string | undefined> = []): boolean {
  const normalized = normalizeRelayUrl(url);
  if (!normalized) return false;
  return getAllowedRelayUrls(extra).includes(normalized);
}

/**
 * Resolve the relay to use for a new session. An explicit URL must be in the
 * local allowlist; otherwise SELKEY_RELAY_URL is used. Peer-advertised relays
 * are never used as a fallback.
 */
export function resolveLocalRelayUrl(argsUrl?: string): string {
  if (argsUrl) {
    if (!isRelayUrlAllowed(argsUrl)) {
      throw new RelayTrustError(
        `relay_url "${argsUrl}" is not a locally configured relay. ` +
          `Set ${RELAY_URL_ENV} or add it to ${RELAY_ALLOWLIST_ENV}.`,
      );
    }
    return argsUrl;
  }
  const configured = process.env[RELAY_URL_ENV];
  if (!configured) {
    throw new RelayTrustError(
      `relay_url is required (set ${RELAY_URL_ENV} to a locally trusted relay)`,
    );
  }
  if (!isRelayTransportAllowed(configured)) {
    throw new RelayTrustError(insecureRelayMessage(configured));
  }
  return configured;
}

function insecureRelayMessage(url: string): string {
  return (
    `Relay "${url}" uses plain http on a non-loopback host. Use https, or add its host name to ` +
    `${RELAY_INSECURE_HTTP_HOSTS_ENV} for a private network.`
  );
}

/**
 * The configured relay verifying key (lowercase hex), or undefined when no key
 * is pinned. Throws if the configured value is malformed.
 */
export function configuredRelayKeyHex(): string | undefined {
  const pinned = process.env[RELAY_VERIFYING_KEY_ENV]?.trim();
  if (!pinned) return undefined;
  if (!KEY_HEX_RE.test(pinned)) {
    throw new RelayTrustError(
      `${RELAY_VERIFYING_KEY_ENV} must be a 64-character hex Ed25519 public key`,
    );
  }
  return pinned.toLowerCase();
}

/** True when SELKEY_ENV is "dev" (local development and demos). */
export function isDevEnvironment(): boolean {
  return process.env[SELKEY_ENV]?.trim() === 'dev';
}

/**
 * The configured relay key. Outside development a missing key is an error:
 * `action` says what this agent refuses to do without it.
 */
export function requireRelayKeyPin(action: string): string | undefined {
  const pinned = configuredRelayKeyHex();
  if (pinned || isDevEnvironment()) return pinned;
  throw new RelayTrustError(
    `${RELAY_VERIFYING_KEY_ENV} is not set, so this agent will not ${action}. ` +
      `Set ${RELAY_VERIFYING_KEY_ENV} to the relay's verifying key (64 hex characters), obtained from the ` +
      `relay operator out of band. Only local development (${SELKEY_ENV}=dev) runs without a pinned relay key.`,
  );
}

/**
 * Bind a contract to the configured relay key: when a key is pinned, the
 * contract gets `relay_verifying_key_hex`, which the relay checks against its
 * own signing key when the session is created. A contract that already names
 * a different key is refused. Without a pin (development only) the contract
 * is unchanged.
 */
export function withPinnedRelayKey<T extends object>(contract: T): T {
  const pinned = requireRelayKeyPin('start a relay session');
  if (!pinned) return contract;
  const existing = (contract as Record<string, unknown>)['relay_verifying_key_hex'];
  if (existing !== undefined && existing !== null) {
    if (typeof existing !== 'string' || existing.toLowerCase() !== pinned) {
      throw new RelayTrustError(
        `Contract relay_verifying_key_hex does not match ${RELAY_VERIFYING_KEY_ENV}`,
      );
    }
    return contract;
  }
  return { ...contract, relay_verifying_key_hex: pinned };
}

/**
 * Relay-key variants a responder accepts in an expected contract. Outside
 * development: only the contract bound to the configured key (a missing key
 * is an error). In development: the plain contract, plus the bound one when a
 * key is configured.
 */
export function expectedRelayKeyVariants(): Array<string | undefined> {
  const pinned = requireRelayKeyPin('respond to a relay session');
  if (!pinned) return [undefined];
  return isDevEnvironment() ? [undefined, pinned] : [pinned];
}

/**
 * A contract a responder joins with explicit session tokens (legacy JOIN)
 * must carry the configured relay key outside development.
 */
export function assertContractCarriesRelayPin(contract: unknown): void {
  const pinned = requireRelayKeyPin('join a relay session');
  if (!pinned || isDevEnvironment()) return;
  const key =
    contract && typeof contract === 'object'
      ? (contract as Record<string, unknown>)['relay_verifying_key_hex']
      : undefined;
  if (typeof key !== 'string' || key.toLowerCase() !== pinned) {
    throw new RelayTrustError(
      `The contract must carry relay_verifying_key_hex equal to ${RELAY_VERIFYING_KEY_ENV}; input was not submitted`,
    );
  }
}

/** Throws unless the relay URL is allowlisted and (if pinned) serves the pinned verifying key. */
export async function assertRelayTrusted(
  relayUrl: string,
  extra: Array<string | undefined> = [],
): Promise<void> {
  if (!isRelayTransportAllowed(relayUrl)) {
    throw new RelayTrustError(insecureRelayMessage(relayUrl));
  }
  if (!isRelayUrlAllowed(relayUrl, extra)) {
    throw new RelayTrustError(
      `Relay "${relayUrl}" is not a locally configured relay. ` +
        `Set ${RELAY_URL_ENV} or add it to ${RELAY_ALLOWLIST_ENV}.`,
    );
  }
  const pinned = configuredRelayKeyHex();
  if (!pinned) return;
  try {
    await fetchRelayPublicKey(relayUrl, relayKeyId(pinned));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RelayTrustError(
      detail.includes('does not match')
        ? `Relay verifying key at ${relayUrl} does not match ${RELAY_VERIFYING_KEY_ENV}`
        : `Could not read relay verifying key from ${relayUrl}/health: ${detail}`,
    );
  }
}

export type ReceiptCheck =
  | { status: 'NOT_PINNED' }
  | { status: 'VERIFIED' }
  | { status: 'FAILED'; detail: string };

export function isRelayKeyPinned(): boolean {
  return Boolean(process.env[RELAY_VERIFYING_KEY_ENV]?.trim());
}

/** Data this agent holds locally about its own side of the session. */
export interface LocalSessionData {
  /** This agent's input, its participant id and the commitment nonce it sent. */
  ownInput?: OwnInputArtefact;
  /** The contract this agent agreed to, if it holds it. */
  contract?: unknown;
  /**
   * True when this agent submitted input to the session. The receipt must
   * then commit to that input; without the data for the own-input check the
   * receipt is not accepted.
   */
  submittedInput?: boolean;
}

/**
 * The session receipt. Relays emit receipt v3 only, under `receipt`; any
 * other version or location is not accepted on live flows.
 */
function pickReceipt(output: { receipt?: unknown }): Record<string, unknown> | undefined {
  const r = output.receipt;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const receipt = r as Record<string, unknown>;
  return receipt['receipt_schema_version'] === '3.0.0' ? receipt : undefined;
}

/**
 * Verify a session output's receipt against SELKEY_RELAY_VERIFYING_KEY_HEX.
 * Returns NOT_PINNED when no key is configured.
 *
 * Besides the signature, the receipt must commit to what this agent holds
 * locally: the output it received, its own input (opened with the commitment
 * nonce it sent; receipt v3), and the contract when it is known.
 */
export function checkReceiptAgainstPinnedKey(
  output: {
    state?: string;
    output?: unknown;
    receipt?: unknown;
    receipt_signature?: string | null;
    receipt_v2?: Record<string, unknown> | null;
  },
  local: LocalSessionData = {},
): ReceiptCheck {
  const pinned = process.env[RELAY_VERIFYING_KEY_ENV]?.trim();
  if (!pinned) return { status: 'NOT_PINNED' };
  if (!KEY_HEX_RE.test(pinned)) {
    return {
      status: 'FAILED',
      detail: `${RELAY_VERIFYING_KEY_ENV} must be a 64-character hex Ed25519 public key`,
    };
  }
  const key = pinned.toLowerCase();

  const receipt = pickReceipt(output);
  if (!receipt) {
    return {
      status: 'FAILED',
      detail: 'Session output has no receipt v3 (receipt_schema_version "3.0.0") to verify',
    };
  }
  if (local.submittedInput && !local.ownInput) {
    return {
      status: 'FAILED',
      detail: "Cannot check the receipt's commitment to this agent's input (missing participant id or nonce)",
    };
  }

  // A key embedded in the receipt is never trusted in place of the pinned key.
  const att = receipt['tee_attestation'];
  if (att && typeof att === 'object') {
    const embedded = (att as Record<string, unknown>)['receipt_signing_pubkey_hex'];
    if (embedded !== undefined && String(embedded).toLowerCase() !== key) {
      return {
        status: 'FAILED',
        detail: 'Receipt tee_attestation signing key does not match the pinned relay key',
      };
    }
  }

  const artefacts: VerifyArtefacts = {};
  if (output.output !== undefined && output.output !== null) artefacts.output = output.output;
  if (local.ownInput) artefacts.ownInput = local.ownInput;
  if (local.contract !== undefined) artefacts.contract = local.contract;

  const result = verifyReceipt(
    receipt,
    key,
    Object.keys(artefacts).length > 0 ? artefacts : undefined,
  );
  if (!result.valid) {
    return {
      status: 'FAILED',
      detail: `Receipt did not verify against the pinned relay key: ${result.errors.join('; ') || 'invalid'}`,
    };
  }
  return { status: 'VERIFIED' };
}

/**
 * Relay client config for `relayUrl`. SELKEY_OPERATOR_TOKEN is the operator
 * token of the relay at SELKEY_RELAY_URL, so it is attached only for that
 * relay (never for other allowlisted relays). The client sends it only on
 * session creation.
 */
export function relayClientConfig(relayUrl: string): RelayClientConfig {
  const token = process.env[OPERATOR_TOKEN_ENV]?.trim();
  const configured = process.env[RELAY_URL_ENV];
  const sameRelay =
    configured !== undefined &&
    normalizeRelayUrl(configured) !== null &&
    normalizeRelayUrl(configured) === normalizeRelayUrl(relayUrl);
  return token && sameRelay ? { relay_url: relayUrl, operator_token: token } : { relay_url: relayUrl };
}
