/**
 * Which URLs a peer may direct this agent to.
 *
 * Peer endpoints (PROPOSE, COMMIT, negotiate, A2A SendMessage) are read from
 * the peer's signed agent card or descriptor. They are used only when they
 * are on the same origin as the configured peer URL
 * (SELKEY_AFAL_PEER_DESCRIPTOR_URL), or on an origin listed in
 * SELKEY_AFAL_PEER_ENDPOINT_ORIGINS. In development (SELKEY_ENV=dev), a
 * loopback endpoint is also accepted when the configured peer URL is itself
 * on loopback, since local agents often differ only in host spelling
 * (localhost vs 127.0.0.1).
 */

import { isDevEnvironment, isLoopbackHost } from './relay-trust.js';

export const PEER_ENDPOINT_ORIGINS_ENV = 'SELKEY_AFAL_PEER_ENDPOINT_ORIGINS';

/** A peer-supplied endpoint is outside the origins this agent will contact. */
export class PeerEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerEndpointError';
  }
}

function parseHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url;
}

/** Origins from a comma-separated list. Entries that are not http(s) URLs are ignored. */
export function parsePeerEndpointOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const url = parseHttpUrl(entry);
      return url ? [url.origin] : [];
    });
}

export interface PeerEndpointPolicy {
  /** The configured peer URL; its origin is always allowed. */
  anchorUrl: string;
  /** Further allowed origins. Defaults to SELKEY_AFAL_PEER_ENDPOINT_ORIGINS. */
  allowedOrigins?: string[];
  /** Allow loopback endpoints for a loopback anchor. Defaults to SELKEY_ENV=dev. */
  allowLoopback?: boolean;
}

/** Throws PeerEndpointError unless `endpoint` is allowed by `policy`. */
export function assertPeerEndpointAllowed(endpoint: string, policy: PeerEndpointPolicy): void {
  const target = parseHttpUrl(endpoint);
  if (!target) {
    throw new PeerEndpointError('Peer endpoint must be an http(s) URL without credentials');
  }
  const anchor = parseHttpUrl(policy.anchorUrl);
  if (anchor && target.origin === anchor.origin) return;

  const allowed =
    policy.allowedOrigins ?? parsePeerEndpointOrigins(process.env[PEER_ENDPOINT_ORIGINS_ENV]);
  if (allowed.includes(target.origin)) return;

  const allowLoopback = policy.allowLoopback ?? isDevEnvironment();
  if (
    allowLoopback &&
    anchor &&
    isLoopbackHost(anchor.hostname) &&
    isLoopbackHost(target.hostname)
  ) {
    return;
  }

  throw new PeerEndpointError(
    `Peer endpoint origin ${target.origin} differs from the configured peer origin ` +
      `${anchor?.origin ?? '(none)'}; list it in ${PEER_ENDPOINT_ORIGINS_ENV} to allow it`,
  );
}
