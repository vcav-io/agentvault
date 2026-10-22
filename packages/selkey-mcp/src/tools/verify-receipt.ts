/**
 * selkey.verify_receipt — verify the cryptographic signature of a session receipt.
 *
 * Thin MCP wrapper around the shared verification logic in selkey.
 *
 * A relay verifying key is required: either the `public_key_hex` argument or
 * a key pinned via SELKEY_RELAY_VERIFYING_KEY_HEX. Keys embedded in the
 * receipt are never used as the verification key.
 */

import {
  verifyReceipt,
  type VerifyResult,
} from 'selkey/verify';
import { buildError, buildSuccess } from '../envelope.js';
import type { ToolResponse } from '../envelope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyReceiptArgs {
  receipt: Record<string, unknown>;
  public_key_hex?: string;
}

export type VerifyReceiptOutput = VerifyResult & {
  /** Present when the receipt carries assurance_level or tee_info. */
  assurance_note?: string;
};

/**
 * assurance_level and tee_info are fields the relay writes into the receipt.
 * The signature shows the relay asserted them; this tool does not verify a
 * TEE attestation quote, measurement or certificate chain.
 */
export const ASSURANCE_NOTE =
  'assurance_level and tee_info are asserted by the relay (covered by its signature) ' +
  'and are not independently verified here: this tool does not check TEE attestation ' +
  'quotes, measurements or certificate chains.';

export const RELAY_VERIFYING_KEY_ENV = 'SELKEY_RELAY_VERIFYING_KEY_HEX';

const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleVerifyReceipt(
  args: VerifyReceiptArgs,
): Promise<ToolResponse<VerifyReceiptOutput>> {
  if (typeof args?.receipt !== 'object' || args.receipt === null) {
    return buildError('INVALID_INPUT', 'receipt must be a JSON object');
  }

  const pinnedRaw = process.env[RELAY_VERIFYING_KEY_ENV]?.trim();
  const argKey = typeof args.public_key_hex === 'string' ? args.public_key_hex.trim() : '';

  if (pinnedRaw && !KEY_HEX_RE.test(pinnedRaw)) {
    return buildError(
      'PRECONDITION_FAILED',
      `${RELAY_VERIFYING_KEY_ENV} must be a 64-character hex Ed25519 public key`,
    );
  }
  if (argKey && !KEY_HEX_RE.test(argKey)) {
    return buildError('INVALID_INPUT', 'public_key_hex must be a 64-character hex Ed25519 public key');
  }

  const pinned = pinnedRaw ? pinnedRaw.toLowerCase() : undefined;
  const supplied = argKey ? argKey.toLowerCase() : undefined;

  if (pinned && supplied && pinned !== supplied) {
    return buildError(
      'VERIFICATION_FAILED',
      `public_key_hex does not match the relay key pinned in ${RELAY_VERIFYING_KEY_ENV}`,
    );
  }

  const key = supplied ?? pinned;
  if (!key) {
    return buildError(
      'INVALID_INPUT',
      `A relay verifying key is required: pass public_key_hex or set ${RELAY_VERIFYING_KEY_ENV}. ` +
        'Keys embedded in the receipt are not trusted on their own.',
    );
  }

  const result: VerifyReceiptOutput = verifyReceipt(args.receipt, key);
  if (result.assurance_level !== undefined || result.tee_info !== undefined) {
    result.assurance_note = ASSURANCE_NOTE;
  }
  return buildSuccess('SUCCESS', result);
}
