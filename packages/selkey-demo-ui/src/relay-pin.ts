/**
 * Relay key pin for the local demo.
 *
 * Both demo agents need SELKEY_RELAY_VERIFYING_KEY_HEX. When it is not
 * configured, the demo pins the key the LOCAL relay serves on /health at the
 * first start: the relay must be on a loopback host or on a private host
 * listed in SELKEY_RELAY_INSECURE_HTTP_HOSTS (the compose network). The pin
 * then stays fixed for the life of the demo server, and the UI says where it
 * came from. A remote relay always needs a configured key.
 */

const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

export type DemoRelayPinSource = 'configured' | 'local-relay';

export interface DemoRelayPin {
  keyHex: string;
  source: DemoRelayPinSource;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** True if the demo may read the relay key from `relayUrl`'s /health. */
export function isLocalDemoRelay(relayUrl: string, insecureHosts: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  const listed = (insecureHosts ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return isLoopbackHost(host) || listed.includes(host);
}

/**
 * Decide the relay key pin. `current` is the pin already in force (from an
 * earlier start); a local relay that now serves a different key is refused.
 */
export function resolveDemoRelayPin(params: {
  configured: string | undefined;
  current: DemoRelayPin | undefined;
  relayUrl: string;
  health: Record<string, unknown> | null;
  insecureHosts: string | undefined;
}): DemoRelayPin {
  const configured = params.configured?.trim();
  if (configured) {
    if (!KEY_HEX_RE.test(configured)) {
      throw new Error('SELKEY_RELAY_VERIFYING_KEY_HEX must be 64 hex characters');
    }
    return { keyHex: configured.toLowerCase(), source: 'configured' };
  }
  if (!isLocalDemoRelay(params.relayUrl, params.insecureHosts)) {
    throw new Error(
      `The relay at ${params.relayUrl} is not local: set SELKEY_RELAY_VERIFYING_KEY_HEX to its verifying key.`,
    );
  }
  const served = params.health?.['verifying_key_hex'];
  if (typeof served !== 'string' || !KEY_HEX_RE.test(served)) {
    throw new Error('The local relay /health response has no valid verifying_key_hex');
  }
  const keyHex = served.toLowerCase();
  if (params.current && params.current.keyHex !== keyHex) {
    throw new Error(
      'The local relay now serves a different verifying key than the one pinned at the first start. ' +
        'Restart the demo server to pin the new key.',
    );
  }
  return { keyHex, source: 'local-relay' };
}
