/**
 * agentvault.verify_receipt — verify the cryptographic signature of a session receipt.
 *
 * Thin MCP wrapper around the shared verification logic in agentvault-client.
 */

import {
  verifyReceipt,
  extractReceiptPublicKey,
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
  const { receipt } = args;

  // Resolve public key
  const publicKeyHex = args.public_key_hex ?? extractReceiptPublicKey(receipt);
  if (!publicKeyHex) {
    return buildSuccess('SUCCESS', {
      valid: false,
      schema_version: 'unknown',
      errors: [
        'No verification key available. Pass public_key_hex explicitly, or provide a TEE receipt with tee_attestation.receipt_signing_pubkey_hex.',
      ],
      warnings: [],
    });
  }

  const result = verifyReceipt(receipt, publicKeyHex);
  return buildSuccess('SUCCESS', result);
}
