/**
 * Relay contract templates and hashing for AgentVault bounded signals.
 *
 * **Deprecated**: The hardcoded TEMPLATES map is a legacy convenience layer.
 * New code should use `buildContract` from `./contract-builder.js` with a
 * registry index for composable, registry-backed contract construction.
 *
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
export interface ModelConstraints {
  allowed_providers: string[];
  allowed_models: string[];
  min_tier?: string;
}

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
  model_profile_hash?: string;

  // v2 contract fields (optional — Rust uses skip_serializing_if = "Option::is_none")
  /** Content hash of the enforcement policy governing this session. */
  enforcement_policy_hash?: string;
  /** SHA-256 of JCS(output_schema) — allows schema lookup by hash. */
  output_schema_hash?: string;
  /** Model constraints (allowed providers/models). */
  model_constraints?: ModelConstraints;
  /** Per-session max completion tokens. */
  max_completion_tokens?: number;
  /** Session TTL in seconds. */
  session_ttl_secs?: number;
  /** Invite TTL in seconds. */
  invite_ttl_secs?: number;
  /** Entropy enforcement mode: Advisory | Gate | Strict. */
  entropy_enforcement?: string;
  /** Relay signing key pinning. */
  relay_verifying_key_hex?: string;
}

export interface ModelProfileBinding {
  id: string;
  hash: string;
  version?: string;
}

type ContractTemplate = Omit<RelayContract, 'participants'>;

/**
 * Bundled contract templates. Fields match the Rust `Contract` struct
 * serialization exactly — all Optional fields present as null when absent.
 *
 * @deprecated Use `buildContract` from `./contract-builder.js` with a registry
 * index for composable contract construction. These templates are preserved
 * for backward compatibility only.
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
          enum: [
            'ALIGNMENT_POSSIBLE',
            'PARTIAL_ALIGNMENT',
            'FUNDAMENTAL_DISAGREEMENT',
            'NEEDS_FACILITATION',
            'INSUFFICIENT_SIGNAL',
          ],
        },
        common_ground_code: {
          type: 'string',
          enum: [
            'GOAL_ALIGNMENT',
            'RESOURCE_ALIGNMENT',
            'RELATIONSHIP_CONTINUITY',
            'VALUE_ALIGNMENT',
            'OPERATIONAL_ALIGNMENT',
            'NO_COMMON_GROUND_DETECTED',
          ],
        },
        next_step_signal: {
          type: 'string',
          enum: [
            'DIRECT_DIALOGUE',
            'STRUCTURED_NEGOTIATION',
            'THIRD_PARTY_FACILITATION',
            'COOLING_PERIOD',
            'SEEK_CLARIFICATION',
          ],
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
    model_profile_hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
    metadata: { scenario: 'cofounder-mediation', version: '3' },
    timing_class: null,
    // v2 fields — enforcement_policy_hash from relay_policies.lock
    enforcement_policy_hash: 'b977379e7787cd2165e2dcf9d790ed339cbc90df481f343c3bd0fec4ec5fe459',
    entropy_enforcement: 'Advisory',
  },
  COMPATIBILITY: {
    purpose_code: 'COMPATIBILITY',
    output_schema_id: 'vcav_e_compatibility_signal_v2',
    output_schema: {
      type: 'object',
      properties: {
        schema_version: { type: 'string', enum: ['2'] },
        compatibility_signal: {
          type: 'string',
          enum: ['STRONG_MATCH', 'PARTIAL_MATCH', 'WEAK_MATCH', 'NO_MATCH'],
        },
        thesis_fit: {
          type: 'string',
          enum: ['ALIGNED', 'PARTIAL', 'MISALIGNED', 'UNKNOWN'],
        },
        size_fit: {
          type: 'string',
          enum: ['WITHIN_BAND', 'TOO_LOW', 'TOO_HIGH', 'UNKNOWN'],
        },
        stage_fit: {
          type: 'string',
          enum: ['ALIGNED', 'PARTIAL', 'MISALIGNED', 'UNKNOWN'],
        },
        confidence: {
          type: 'string',
          enum: ['HIGH', 'MEDIUM', 'LOW'],
        },
        primary_reasons: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'SECTOR_MATCH',
              'SIZE_COMPATIBLE',
              'STAGE_COMPATIBLE',
              'GEOGRAPHIC_PROXIMITY',
              'EXPERIENCE_RELEVANCE',
              'TIMELINE_COMPATIBLE',
            ],
          },
          minItems: 0,
          maxItems: 3,
          uniqueItems: true,
          'x-vcav-entropy-bits-upper-bound': 8,
        },
        blocking_reasons: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'SIZE_INCOMPATIBLE',
              'SECTOR_MISMATCH',
              'STAGE_MISMATCH',
              'GEOGRAPHY_MISMATCH',
              'TIMELINE_CONFLICT',
              'STRUCTURE_INCOMPATIBLE',
            ],
          },
          minItems: 0,
          maxItems: 2,
          uniqueItems: true,
          'x-vcav-entropy-bits-upper-bound': 5,
        },
        next_step: {
          type: 'string',
          enum: ['PROCEED', 'PROCEED_WITH_CAVEATS', 'ASK_FOR_PUBLIC_INFO', 'DO_NOT_PROCEED'],
        },
      },
      required: [
        'schema_version',
        'compatibility_signal',
        'thesis_fit',
        'size_fit',
        'stage_fit',
        'confidence',
        'primary_reasons',
        'blocking_reasons',
        'next_step',
      ],
      additionalProperties: false,
    },
    prompt_template_hash: '18b1b459ceb12fc03cb005314f6b4e168c113ead7255b4b65329fb8a6c60f874',
    entropy_budget_bits: 32,
    model_profile_id: 'api-claude-sonnet-v1',
    model_profile_hash: '5f01005dcfe4c95ee52b5f47958b4943134cc97da487b222dd4f936d474f70f8',
    metadata: { scenario: 'scheduling-compatibility', version: '2' },
    timing_class: null,
    // v2 fields — enforcement_policy_hash from relay_policies.lock
    enforcement_policy_hash: 'b977379e7787cd2165e2dcf9d790ed339cbc90df481f343c3bd0fec4ec5fe459',
    entropy_enforcement: 'Advisory',
  },
};

// Compute and bind output_schema_hash for each template at module init
for (const key of Object.keys(TEMPLATES)) {
  const tpl = TEMPLATES[key];
  tpl.output_schema_hash = computeOutputSchemaHash(tpl.output_schema);
}

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
 *
 * @deprecated Use `buildContract` from `./contract-builder.js` with a registry
 * index for composable contract construction.
 */
export function buildRelayContract(
  purpose: string,
  participants: string[],
  modelProfileId?: string,
): RelayContract | undefined {
  const template = TEMPLATES[purpose];
  if (!template) return undefined;
  if (participants.length !== 2) {
    throw new Error('Relay contracts require exactly 2 participants');
  }

  for (const p of participants) {
    const err = validateParticipantId(p);
    if (err) throw new Error(err);
  }

  const contract = { ...template, participants };
  if (modelProfileId) {
    contract.model_profile_id = modelProfileId;
  }
  return contract;
}

export function withRelayContractModelProfile(
  contract: RelayContract,
  profile: ModelProfileBinding,
): RelayContract {
  return {
    ...contract,
    model_profile_id: profile.id,
    model_profile_hash: profile.hash,
  };
}

/** List available bundled purpose codes. */
export function listRelayPurposes(): string[] {
  return Object.keys(TEMPLATES);
}

/**
 * Build a contract that references a schema by hash rather than embedding it inline.
 * Uses a stub `output_schema: {}` for VFC wire-format compatibility (the VFC Contract
 * type requires `output_schema` as a non-optional field). The relay detects the stub
 * via the "no properties key" heuristic and performs a registry lookup by hash.
 *
 * Assumption: all current output schemas are objects with a `properties` key.
 * The relay's `is_stub_schema` check uses this heuristic. Clean path is making
 * `output_schema` optional in VFC (separate PR).
 */
export function buildRelayContractWithSchemaRef(
  purpose: string,
  participants: string[],
  opts?: { schemaHash?: string; policyHash?: string },
): RelayContract | undefined {
  const template = TEMPLATES[purpose];
  if (!template) return undefined;
  if (participants.length !== 2) {
    throw new Error('Relay contracts require exactly 2 participants');
  }

  for (const p of participants) {
    const err = validateParticipantId(p);
    if (err) throw new Error(err);
  }

  // Compute schema hash from the template's full schema
  const schemaHash = opts?.schemaHash ?? computeOutputSchemaHash(template.output_schema);

  return {
    ...template,
    participants,
    output_schema: {} as object, // stub — triggers registry lookup on relay
    output_schema_hash: schemaHash,
    ...(opts?.policyHash !== undefined
      ? { enforcement_policy_hash: opts.policyHash }
      : {}),
  };
}

/**
 * Compute SHA-256 hash of a relay contract using RFC 8785 (JCS)
 * canonicalization. Matches the Rust relay's `compute_contract_hash`.
 */
export function computeRelayContractHash(contract: object): string {
  const canonical = canonicalize(contract);
  return bytesToHex(sha256(canonical));
}

/**
 * Compute SHA-256 hash of an output schema using RFC 8785 (JCS)
 * canonicalization. Matches the Rust relay's `compute_output_schema_hash`.
 * The hash is bound into receipts as `output_schema_hash`.
 */
export function computeOutputSchemaHash(schema: object): string {
  const canonical = canonicalize(schema);
  return bytesToHex(sha256(canonical));
}
