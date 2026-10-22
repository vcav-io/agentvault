/**
 * Local relay selection.
 *
 * Both INITIATE and RESPOND only talk to relays that this agent has
 * configured locally: SELKEY_RELAY_URL, plus any entries in
 * SELKEY_RELAY_ALLOWLIST (comma-separated). Relay URLs supplied by a peer
 * (Agent Card, invite payload, COMMIT) are only used when they match one of
 * these.
 *
 * If SELKEY_RELAY_VERIFYING_KEY_HEX is set:
 * - contracts this agent builds carry it as `relay_verifying_key_hex`, so a
 *   relay with a different key rejects the session before inputs are accepted;
 * - the relay's /health verifying_key_hex must match it before any input is
 *   submitted.
 *
 * Plain http:// relays are accepted only on loopback hosts, unless
 * SELKEY_RELAY_ALLOW_INSECURE_HTTP=true (for example a private compose
 * network in the local demo).
 */

import { fetchRelayPublicKey, relayKeyId, verifyReceipt } from 'selkey/verify';
import type { OwnInputArtefact, VerifyArtefacts } from 'selkey/verify';

export const RELAY_URL_ENV = 'SELKEY_RELAY_URL';
export const RELAY_ALLOWLIST_ENV = 'SELKEY_RELAY_ALLOWLIST';
export const RELAY_VERIFYING_KEY_ENV = 'SELKEY_RELAY_VERIFYING_KEY_HEX';
export const RELAY_ALLOW_INSECURE_HTTP_ENV = 'SELKEY_RELAY_ALLOW_INSECURE_HTTP';

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
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Whether the relay URL uses an acceptable transport: https, or http on a
 * loopback host. SELKEY_RELAY_ALLOW_INSECURE_HTTP=true also allows other
 * http hosts.
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
  return process.env[RELAY_ALLOW_INSECURE_HTTP_ENV] === 'true';
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
    `Relay "${url}" uses plain http on a non-loopback host. Use https, or set ` +
    `${RELAY_ALLOW_INSECURE_HTTP_ENV}=true for a private network.`
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

/**
 * Bind a contract to the configured relay key: when a key is pinned, the
 * contract gets `relay_verifying_key_hex`, which the relay checks against its
 * own signing key when the session is created. A contract that already names
 * a different key is refused. Without a pin the contract is unchanged.
 */
export function withPinnedRelayKey<T extends object>(contract: T): T {
  const pinned = configuredRelayKeyHex();
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
 * Relay-key variants a responder accepts in an expected contract: the plain
 * contract (no relay key), plus the contract bound to the configured key.
 */
export function expectedRelayKeyVariants(): Array<string | undefined> {
  const pinned = configuredRelayKeyHex();
  return pinned ? [undefined, pinned] : [undefined];
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
