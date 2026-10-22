import { SELKEY_A2A_EXTENSION_URI, signAgentCard } from '../../a2a-agent-card.js';
import type { SelkeyA2AExtensionParams } from '../../a2a-agent-card.js';

/**
 * Return a copy of an A2A agent card whose Selkey extension carries a valid
 * card_signature by `seedHex` over the extension params and card.name, with
 * a current issued_at/expires_at window unless the fixture sets one.
 */
export function signCard<T>(card: T, seedHex: string): T {
  const copy = JSON.parse(JSON.stringify(card)) as {
    name?: string;
    capabilities?: { extensions?: Array<{ uri?: string; params?: Record<string, unknown> }> };
  };
  for (const ext of copy.capabilities?.extensions ?? []) {
    if (ext.uri !== SELKEY_A2A_EXTENSION_URI || !ext.params) continue;
    const { card_signature: _old, ...params } = ext.params;
    if (!Array.isArray(params['supported_purposes'])) params['supported_purposes'] = [];
    // A card is valid for a bounded time; give unsigned fixtures a current window.
    if (typeof params['issued_at'] !== 'string') params['issued_at'] = new Date().toISOString();
    if (typeof params['expires_at'] !== 'string') {
      params['expires_at'] = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    }
    ext.params = {
      ...params,
      card_signature: signAgentCard(
        String(copy.name),
        params as unknown as SelkeyA2AExtensionParams,
        seedHex,
      ),
    };
  }
  return copy as T;
}
