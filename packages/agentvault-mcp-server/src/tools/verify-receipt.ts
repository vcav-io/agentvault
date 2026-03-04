/**
 * agentvault.verify_receipt — verify the cryptographic signature of a session receipt.
 *
 * Thin MCP wrapper around the shared verification logic in agentvault-client.
 */

import {
  verifyReceipt,
  fetchRelayPublicKey,
  type VerifyResult,
} from 'agentvault-client/verify';
import { buildSuccess } from '../envelope.js';
import type { ToolResponse } from '../envelope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyReceiptArgs {
  receipt: Record<string, unknown>;
  public_key_hex?: string;
  relay_url?: string;
}

export type VerifyReceiptOutput = VerifyResult;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleVerifyReceipt(
  args: VerifyReceiptArgs,
): Promise<ToolResponse<VerifyReceiptOutput>> {
  const { receipt, relay_url = 'http://localhost:4840' } = args;

  // Resolve public key
  let publicKeyHex: string;
  if (args.public_key_hex) {
    publicKeyHex = args.public_key_hex;
  } else {
    try {
      publicKeyHex = await fetchRelayPublicKey(relay_url);
    } catch (err) {
      return buildSuccess('SUCCESS', {
        valid: false,
        schema_version: 'unknown',
        errors: [
          `Failed to fetch public key from relay (${relay_url}): ${err instanceof Error ? err.message : String(err)}. ` +
            'Pass public_key_hex explicitly to bypass.',
        ],
        warnings: [],
      });
    }
  }

  const result = verifyReceipt(receipt, publicKeyHex);
  return buildSuccess('SUCCESS', result);
}
