/**
 * Request guards for the demo server.
 *
 * - Host header validation: only loopback names (localhost, 127.0.0.1, [::1])
 *   on the demo port, the configured bind address, and hosts listed in
 *   DEMO_ALLOWED_HOSTS are served. Requests whose Host names anything else are
 *   refused, so a page on another origin that re-resolves its own hostname to
 *   127.0.0.1 cannot read or drive the demo.
 * - State-changing requests (anything but GET/HEAD/OPTIONS) must be same-origin:
 *   they need the X-Selkey-Demo-Request header and a JSON content type (both
 *   force a CORS preflight, which this server never answers), an Origin, if
 *   sent, that names an allowed host, and a Sec-Fetch-Site, if sent, of
 *   same-origin or none.
 */

import type { NextFunction, Request, Response } from 'express';

export const DEMO_REQUEST_HEADER = 'x-selkey-demo-request';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Lower-cased `host:port` strings that the demo answers to. */
export function buildAllowedHosts(params: {
  port: number;
  bindAddress?: string;
  extraHosts?: string;
}): Set<string> {
  const allowed = new Set<string>();
  const add = (hostPort: string) => allowed.add(hostPort.trim().toLowerCase());
  for (const host of LOOPBACK_HOSTS) add(`${host}:${params.port}`);
  const bind = params.bindAddress?.trim();
  if (bind && bind !== '0.0.0.0' && bind !== '::') {
    add(bind.includes(':') && !bind.startsWith('[') ? `[${bind}]:${params.port}` : `${bind}:${params.port}`);
  }
  for (const entry of (params.extraHosts ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Entries may be "host" (demo port implied) or "host:port".
    const hasPort = /:\d+$/.test(trimmed) && !/^\[[^\]]*\]$/.test(trimmed);
    add(hasPort ? trimmed : `${trimmed}:${params.port}`);
  }
  return allowed;
}

export function isAllowedHost(hostHeader: string | undefined, allowed: Set<string>): boolean {
  if (!hostHeader) return false;
  return allowed.has(hostHeader.trim().toLowerCase());
}

function isAllowedOrigin(origin: string, allowed: Set<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return allowed.has(parsed.host.toLowerCase());
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createRequestGuards(allowed: Set<string>) {
  function hostGuard(req: Request, res: Response, next: NextFunction): void {
    if (!isAllowedHost(req.headers.host, allowed)) {
      res.status(421).json({ error: 'Host not allowed' });
      return;
    }
    next();
  }

  function sameOriginGuard(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const marker = req.headers[DEMO_REQUEST_HEADER];
    const contentType = req.headers['content-type'] ?? '';
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    const ok =
      marker === '1' &&
      contentType.toLowerCase().startsWith('application/json') &&
      (origin === undefined || isAllowedOrigin(origin, allowed)) &&
      (fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none');
    if (!ok) {
      res.status(403).json({ error: 'Cross-origin or unmarked request refused' });
      return;
    }
    next();
  }

  return { hostGuard, sameOriginGuard };
}
