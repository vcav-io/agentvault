/**
 * Relay contract templates and hashing for AgentVault bounded signals.
 *
 * Templates are the canonical source of truth for bundled relay contracts.
 * `computeRelayContractHash` uses RFC 8785 (JCS) canonicalization + SHA-256,
 * matching the Rust relay's `compute_contract_hash` (relay.rs). No domain
 * prefix — this is a contract hash, not a signature hash.
 */

import { canonicalize } from 'json-canonicalize';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * Full relay contract as sent to the relay. All fields must be present
 * (including nulls) to ensure hash parity with Rust serde serialization.
 */
export interface RelayContract {
  purpose_code: string;
  output_schema_id: string;
  output_schema: object;
  participants: string[];
  prompt_template_hash: string;
  entropy_budget_bits: number | null;
  timing_class: string | null;
  metadata: Record<string, string> | null;
  model_profile_id: string | null;
}

type ContractTemplate = Omit<RelayContract, 'participants'>;

/**
 * Bundled contract templates. Fields match the Rust `Contract` struct
 * serialization exactly — all Optional fields present as null when absent.
 */
const TEMPLATES: Record<string, ContractTemplate> = {
  MEDIATION: {
    purpose_code: 'MEDIATION',
    output_schema_id: 'vcav_e_mediation_signal_v2',
    output_schema: {
      type: 'object',
      properties: {
        mediation_signal: {
          type: 'string',
          enum: ['ALIGNMENT_POSSIBLE', 'PARTIAL_ALIGNMENT', 'FUNDAMENTAL_DISAGREEMENT', 'NEEDS_FACILITATION', 'INSUFFICIENT_SIGNAL'],
        },
        common_ground_code: {
          type: 'string',
          enum: ['GOAL_ALIGNMENT', 'RESOURCE_ALIGNMENT', 'RELATIONSHIP_CONTINUITY', 'VALUE_ALIGNMENT', 'OPERATIONAL_ALIGNMENT', 'NO_COMMON_GROUND_DETECTED'],
        },
        next_step_signal: {
          type: 'string',
          enum: ['DIRECT_DIALOGUE', 'STRUCTURED_NEGOTIATION', 'THIRD_PARTY_FACILITATION', 'COOLING_PERIOD', 'SEEK_CLARIFICATION'],
        },
        confidence_band: {
          type: 'string',
          enum: ['LOW', 'MEDIUM', 'HIGH'],
        },
      },
      required: ['mediation_signal', 'common_ground_code', 'next_step_signal', 'confidence_band'],
      additionalProperties: false,
    },
    prompt_template_hash: 'bc4fdec512a08e5fd46f57a5f07d3ea6b2e0cf68f9e8f7cd4ba3d16d10bc36f2',
    entropy_budget_bits: 12,
    model_profile_id: 'api-claude-sonnet-v1',
    metadata: { scenario: 'cofounder-mediation', version: '3' },
    timing_class: null,
  },
  COMPATIBILITY: {
    purpose_code: 'COMPATIBILITY',
    output_schema_id: 'vcav_e_compatibility_signal_v1',
    output_schema: {
      type: 'object',
      properties: {
        compatibility_signal: {
          type: 'string',
          enum: ['STRONG_MATCH', 'PARTIAL_MATCH', 'WEAK_MATCH', 'NO_MATCH'],
        },
        overlap_summary: {
          type: 'string',
          maxLength: 100,
        },
      },
      required: ['compatibility_signal', 'overlap_summary'],
      additionalProperties: false,
    },
    prompt_template_hash: '57a4a7ef5b187a226b9c0e9cbcbdece326b115093176a80edafd72e85a94bc06',
    entropy_budget_bits: 8,
    model_profile_id: 'api-claude-sonnet-v1',
    metadata: { scenario: 'scheduling-compatibility', version: '1' },
    timing_class: null,
  },
};

const WHITESPACE_RE = /\s/;

function validateParticipantId(id: string): string | null {
  if (id.length === 0) return 'Participant ID must not be empty';
  if (WHITESPACE_RE.test(id)) return `Participant ID "${id}" contains whitespace`;
  return null;
}

/**
 * Build a full relay contract from a bundled template and participant list.
 * Returns undefined for unknown purpose codes.
 * Throws on invalid participant IDs (empty or contains whitespace).
 */
export function buildRelayContract(
  purpose: string,
  participants: string[],
): RelayContract | undefined {
  const template = TEMPLATES[purpose];
  if (!template) return undefined;

  for (const p of participants) {
    const err = validateParticipantId(p);
    if (err) throw new Error(err);
  }

  return { ...template, participants };
}

/** List available bundled purpose codes. */
export function listRelayPurposes(): string[] {
  return Object.keys(TEMPLATES);
}

/**
 * Compute SHA-256 hash of a relay contract using RFC 8785 (JCS)
 * canonicalization. Matches the Rust relay's `compute_contract_hash`.
 */
export function computeRelayContractHash(contract: object): string {
  const canonical = canonicalize(contract);
  return bytesToHex(sha256(canonical));
}
