/**
 * AFAL protocol type interfaces for agentvault-mcp-server.
 *
 * These are minimal structural guides — schema validation is the real check.
 * Fields not available in M2 (signature, descriptor_hash, model_profile_hash,
 * prev_receipt_hash) are optional.
 *
 * See: vfc schemas/afal_propose.schema.json (Binding Spec v1, Section 3.1)
 */

import { createHash, randomBytes } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';

// ── AFAL Message Types ──────────────────────────────────────────────────

export interface AfalPropose {
  proposal_version: string;
  proposal_id: string;
  nonce: string;
  timestamp: string;
  from: string;
  to: string;
  purpose_code: string;
  lane_id: string;
  output_schema_id: string;
  output_schema_version: string;
  requested_budget_tier: string;
  requested_entropy_bits: number;
  model_profile_id: string;
  model_profile_version: string;
  admission_tier_requested: string;
  descriptor_hash?: string;
  model_profile_hash?: string;
  prev_receipt_hash?: string;
  relay_binding_hash?: string;
  signature?: string;
}

export interface AfalAdmit {
  proposal_id: string;
  admission_tier: string;
  session_token?: string;
}

export interface AfalDeny {
  proposal_id: string;
  reason_code: string;
  reason_text?: string;
}

// ── Relay Invite Payload ────────────────────────────────────────────────

export interface RelayInvitePayload {
  session_id: string;
  responder_submit_token: string;
  responder_read_token: string;
  relay_url: string;
}

// ── Type Guard ──────────────────────────────────────────────────────────

export function hasAfalDraft(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & { afal_propose_draft: Record<string, unknown> } {
  return (
    payload['afal_propose_draft'] != null &&
    typeof payload['afal_propose_draft'] === 'object' &&
    !Array.isArray(payload['afal_propose_draft'])
  );
}

// ── Proposal ID Derivation ──────────────────────────────────────────────

/**
 * Allowlist of fields included in the proposal_id hash.
 * Using an allowlist (not denylist) prevents accidental inclusion of extra
 * properties and makes the hash computation explicit.
 *
 * Excluded by design:
 * - proposal_id: it's the output
 * - compliance: adapter metadata, not part of the propose
 * - signature: not available at hash time
 */
const HASHABLE_FIELDS = new Set([
  'proposal_version',
  'nonce',
  'timestamp',
  'from',
  'to',
  'purpose_code',
  'lane_id',
  'output_schema_id',
  'output_schema_version',
  'requested_budget_tier',
  'requested_entropy_bits',
  'model_profile_id',
  'model_profile_version',
  'admission_tier_requested',
  'descriptor_hash',
  'model_profile_hash',
  'prev_receipt_hash',
]);

/**
 * Compute a deterministic proposal_id from an AfalPropose's hashable fields.
 *
 * proposal_id = hex(sha256(JCS(hashable_fields)))
 *
 * The nonce provides uniqueness, timestamp makes it an event ID.
 * Given the same fields, you can recompute and verify the ID.
 */
export function computeProposalId(propose: Omit<AfalPropose, 'proposal_id'>): string {
  const hashable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(propose)) {
    if (HASHABLE_FIELDS.has(key) && value !== undefined) {
      hashable[key] = value;
    }
  }
  const canonical = canonicalize(hashable);
  return createHash('sha256').update(canonical).digest('hex');
}

// ── Nonce Generation ────────────────────────────────────────────────────

export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}
