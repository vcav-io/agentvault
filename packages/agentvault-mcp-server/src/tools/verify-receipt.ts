/**
 * agentvault.verify_receipt — verify the cryptographic signature of a session receipt.
 *
 * Thin MCP wrapper around the shared verification logic in agentvault-client.
 */

import {
  verifyReceipt,
  type VerifyResult,
} from 'agentvault-client/verify';
import { buildSuccess } from '../envelope.js';
import type { ToolResponse } from '../envelope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyReceiptArgs {
  receipt: Record<string, unknown>;
  public_key_hex: string;
}

export type VerifyReceiptOutput = VerifyResult;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleVerifyReceipt(
  args: VerifyReceiptArgs,
): Promise<ToolResponse<VerifyReceiptOutput>> {
  const result = verifyReceipt(args.receipt, args.public_key_hex);
  return buildSuccess('SUCCESS', result);
}
