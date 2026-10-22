import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
  computeTranscriptHash,
  computeTranscriptHashHex,
  verifyAttestationHash,
  checkMeasurementAllowlist,
  verifyTeeReceipt,
} from '../tee-verify.js';
import type {
  TranscriptInputs,
  MeasurementEntry,
  ReceiptCommitments,
  RelayConfig,
  TeeAttestation,
} from '../tee-verify.js';

// ---------------------------------------------------------------------------
// Transcript hash — golden fixture parity with Rust tee-transcript
// ---------------------------------------------------------------------------

describe('computeTranscriptHash', () => {
  it('matches the Rust golden fixture', () => {
    const inputs: TranscriptInputs = {
      contract_hash: 'aaaa',
      prompt_template_hash: 'bbbb',
      initiator_submission_hash: 'cccc',
      responder_submission_hash: 'dddd',
      output_hash: 'eeee',
      receipt_signing_pubkey_hex: 'ffff',
    };

    const hash = computeTranscriptHash(inputs);
    expect(hash.length).toBe(64); // SHA-512 = 64 bytes

    const hex = bytesToHex(hash);
    expect(hex).toBe(
      'b0fceb1f1dfd40fab87a529883810443dabde5416f0d06fbc57026a8bff0989c' +
        '233781c7beeca30d85154ea3896eba00e21d99a8aac2dbd05ae85bb1e806a256',
    );
  });

  it('computeTranscriptHashHex returns the same result', () => {
    const inputs: TranscriptInputs = {
      contract_hash: 'aaaa',
      prompt_template_hash: 'bbbb',
      initiator_submission_hash: 'cccc',
      responder_submission_hash: 'dddd',
      output_hash: 'eeee',
      receipt_signing_pubkey_hex: 'ffff',
    };

    expect(computeTranscriptHashHex(inputs)).toBe(
      'b0fceb1f1dfd40fab87a529883810443dabde5416f0d06fbc57026a8bff0989c' +
        '233781c7beeca30d85154ea3896eba00e21d99a8aac2dbd05ae85bb1e806a256',
    );
  });

  it('different inputs produce different hashes', () => {
    const a = computeTranscriptHashHex({
      contract_hash: 'aaaa',
      prompt_template_hash: '',
      initiator_submission_hash: '',
      responder_submission_hash: '',
      output_hash: 'eeee',
      receipt_signing_pubkey_hex: '',
    });
    const b = computeTranscriptHashHex({
      contract_hash: 'bbbb',
      prompt_template_hash: '',
      initiator_submission_hash: '',
      responder_submission_hash: '',
      output_hash: 'eeee',
      receipt_signing_pubkey_hex: '',
    });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Attestation hash
// ---------------------------------------------------------------------------

describe('verifyAttestationHash', () => {
  it('returns Valid when hash matches', () => {
    const rawBytes = utf8ToBytes('test-quote-data');
    const b64 = btoa(String.fromCharCode(...rawBytes));
    const expectedHash = bytesToHex(sha256(rawBytes));
    expect(verifyAttestationHash(b64, expectedHash)).toBe('Valid');
  });

  it('returns Mismatch when hash differs', () => {
    const rawBytes = utf8ToBytes('test-quote-data');
    const b64 = btoa(String.fromCharCode(...rawBytes));
    expect(verifyAttestationHash(b64, 'deadbeef')).toBe('Mismatch');
  });

  it('returns MissingFields when either arg is undefined', () => {
    expect(verifyAttestationHash(undefined, 'abc')).toBe('MissingFields');
    expect(verifyAttestationHash('abc', undefined)).toBe('MissingFields');
    expect(verifyAttestationHash(undefined, undefined)).toBe('MissingFields');
  });

  it('returns DecodeFailed for invalid base64', () => {
    expect(verifyAttestationHash('not valid base64!!!', 'abc')).toBe('DecodeFailed');
  });
});

// ---------------------------------------------------------------------------
// Measurement allowlist
// ---------------------------------------------------------------------------

describe('checkMeasurementAllowlist', () => {
  const allowlist: MeasurementEntry[] = [
    { measurement: 'abc123', build_id: 'v1.0.0', git_rev: 'deadbeef' },
    { measurement: 'def456', build_id: 'v1.1.0', git_rev: 'cafebabe' },
  ];

  it('returns matching entry', () => {
    const result = checkMeasurementAllowlist('abc123', allowlist);
    expect(result).toEqual({ measurement: 'abc123', build_id: 'v1.0.0', git_rev: 'deadbeef' });
  });

  it('returns undefined for unknown measurement', () => {
    expect(checkMeasurementAllowlist('unknown', allowlist)).toBeUndefined();
  });

  it('returns undefined for empty allowlist', () => {
    expect(checkMeasurementAllowlist('abc123', [])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full TEE verification
// ---------------------------------------------------------------------------

describe('verifyTeeReceipt', () => {
  const MEASUREMENT = 'abc123';
  const allowlist: MeasurementEntry[] = [
    { measurement: MEASUREMENT, build_id: 'v1.0.0', git_rev: 'deadbeef' },
  ];

  const commitments: ReceiptCommitments = {
    contract_hash: 'aaaa',
    prompt_template_hash: 'bbbb',
    output_hash: 'eeee',
    initiator_submission_hash: 'cccc',
    responder_submission_hash: 'dddd',
  };

  const EXPECTED_TRANSCRIPT_HASH =
    'b0fceb1f1dfd40fab87a529883810443dabde5416f0d06fbc57026a8bff0989c' +
    '233781c7beeca30d85154ea3896eba00e21d99a8aac2dbd05ae85bb1e806a256';

  it('downgrades UserData to a receipt-claimed binding without quote parsing', () => {
    const att: TeeAttestation = {
      measurement: MEASUREMENT,
      receipt_signing_pubkey_hex: 'ffff',
      user_data_hex: EXPECTED_TRANSCRIPT_HASH,
    };

    const result = verifyTeeReceipt(commitments, att, allowlist);
    expect(result.transcript_hash_valid).toBe(true);
    expect(result.transcript_binding).toBe('ReceiptClaimedUserData');
    expect(result.quote_field_cross_checked).toBe(false);
    expect(result.measurement_match).toBeUndefined();
    expect(result.receipt_claimed_measurement_match).toBeDefined();
    expect(result.submission_hashes_present).toBe(true);
  });

  it('falls back to TranscriptHashFallback binding', () => {
    const att: TeeAttestation = {
      measurement: MEASUREMENT,
      receipt_signing_pubkey_hex: 'ffff',
      transcript_hash_hex: EXPECTED_TRANSCRIPT_HASH,
    };

    const result = verifyTeeReceipt(commitments, att, allowlist);
    expect(result.transcript_hash_valid).toBe(true);
    expect(result.transcript_binding).toBe('TranscriptHashFallback');
  });

  it('returns None binding when neither field is present', () => {
    const att: TeeAttestation = {
      measurement: MEASUREMENT,
      receipt_signing_pubkey_hex: 'ffff',
    };

    const result = verifyTeeReceipt(commitments, att, allowlist);
    expect(result.transcript_hash_valid).toBe(false);
    expect(result.transcript_binding).toBe('None');
  });

  it('detects transcript hash mismatch', () => {
    const att: TeeAttestation = {
      measurement: MEASUREMENT,
      receipt_signing_pubkey_hex: 'ffff',
      user_data_hex: 'wrong_hash',
    };

    const result = verifyTeeReceipt(commitments, att, allowlist);
    expect(result.transcript_hash_valid).toBe(false);
    expect(result.transcript_binding).toBe('ReceiptClaimedUserData');
  });

  it('keeps unknown receipt-claimed measurement separate from quote-verified matches', () => {
    const att: TeeAttestation = {
      measurement: 'unknown_measurement',
      receipt_signing_pubkey_hex: 'ffff',
      user_data_hex: EXPECTED_TRANSCRIPT_HASH,
    };

    const result = verifyTeeReceipt(commitments, att, allowlist);
    expect(result.measurement_match).toBeUndefined();
    expect(result.receipt_claimed_measurement_match).toBeUndefined();
  });

  it('does not elevate allowlisted receipt-claimed measurement to quote-verified status', () => {
    const att: TeeAttestation = {
      measurement: MEASUREMENT,
      receipt_signing_pubkey_hex: 'ffff',
      user_data_hex: EXPECTED_TRANSCRIPT_HASH,
    };

    const result = verifyTeeReceipt(commitments, att, allowlist);
    expect(result.measurement_match).toBeUndefined();
    expect(result.receipt_claimed_measurement_match).toBeDefined();
  });

  it('detects missing submission hashes', () => {
    const partialCommitments: ReceiptCommitments = {
      contract_hash: 'aaaa',
      output_hash: 'eeee',
    };

    const att: TeeAttestation = {
      measurement: MEASUREMENT,
      receipt_signing_pubkey_hex: 'ffff',
      user_data_hex: computeTranscriptHashHex({
        contract_hash: 'aaaa',
        prompt_template_hash: '',
        initiator_submission_hash: '',
        responder_submission_hash: '',
        output_hash: 'eeee',
        receipt_signing_pubkey_hex: 'ffff',
      }),
    };

    const result = verifyTeeReceipt(partialCommitments, att, allowlist);
    expect(result.submission_hashes_present).toBe(false);
    expect(result.transcript_hash_valid).toBe(true);
  });

  it('verifies attestation hash when quote is present', () => {
    const rawBytes = utf8ToBytes('fake-quote-bytes');
    const quoteB64 = btoa(String.fromCharCode(...rawBytes));
    const attestationHash = bytesToHex(sha256(rawBytes));

    const att: TeeAttestation = {
      measurement: MEASUREMENT,
      receipt_signing_pubkey_hex: 'ffff',
      user_data_hex: EXPECTED_TRANSCRIPT_HASH,
      quote: quoteB64,
      attestation_hash: attestationHash,
    };

    const result = verifyTeeReceipt(commitments, att, allowlist);
    expect(result.attestation_hash_status).toBe('Valid');
  });
});

// ---------------------------------------------------------------------------
// Transcript version selection (v2 / v3)
// ---------------------------------------------------------------------------

describe('verifyTeeReceipt transcript versions', () => {
  // Inputs, relay config and expected hashes from the selkey-tee golden
  // vectors (test-vectors/tee/transcript_v3_golden.json, "success" and
  // "default"; v2 from tee-transcript golden_fixture_parity_v2).
  const commitments: ReceiptCommitments = {
    contract_hash: 'aaaa',
    prompt_template_hash: 'bbbb',
    output_hash: 'eeee',
    initiator_submission_hash: 'cccc',
    responder_submission_hash: 'dddd',
  };
  const MODEL_ID = 'anthropic/test-model';
  const RELAY_CONFIG: RelayConfig = {
    provider_id: 'anthropic',
    provider_base_url: 'https://api.anthropic.com',
    model_id_requested: 'claude-sonnet-4-5-20250929',
    policy_lockfile_hash: '',
    model_profile_allowlist_hash: '',
    relay_git_rev: '0123456789abcdef0123456789abcdef01234567',
    echo_mode: false,
    simulated: false,
    env: '',
  };
  const V3_HASH =
    'a4a5db7e5da33cd0455e8f5740e23b3709faa3909524326bd33df4744c418813' +
    '8ed5ad4c148204a769a13803e94f4e4bb76ede99c917ef04719a713943ae61b8';
  const V2_HASH =
    '2731b2be1576ab14e1f94543ccbd60ae8185591f9d097aec6536fd1fe5a28178' +
    '3933c46970696dd02891c7ca123adf0afcd7bb10bf2589fd76c3350a49c3dc65';
  const V1_HASH =
    'b0fceb1f1dfd40fab87a529883810443dabde5416f0d06fbc57026a8bff0989c' +
    '233781c7beeca30d85154ea3896eba00e21d99a8aac2dbd05ae85bb1e806a256';

  const att = (user_data_hex: string): TeeAttestation => ({
    receipt_signing_pubkey_hex: 'ffff',
    user_data_hex,
  });

  it('accepts a v3 transcript checked against the supplied relay config', () => {
    const result = verifyTeeReceipt(commitments, att(V3_HASH), [], {
      model_identity_asserted: MODEL_ID,
      relay_config: RELAY_CONFIG,
    });
    expect(result.transcript_hash_valid).toBe(true);
    expect(result.transcript_schema).toBe('V3');
    expect(result.relay_config).toEqual(RELAY_CONFIG);
    expect(result.transcript_binding).toBe('ReceiptClaimedUserData');
    expect(result.quote_field_cross_checked).toBe(false);
    expect(result.measurement_match).toBeUndefined();
    expect(result.model_identity_asserted_used).toBe(MODEL_ID);
  });

  it('reports an empty model identity when none is supplied', () => {
    const result = verifyTeeReceipt(commitments, att(V1_HASH), []);
    expect(result.model_identity_asserted_used).toBe('');
  });

  it('does not match v3 when a receipt value is not well-formed UTF-16', () => {
    const result = verifyTeeReceipt(commitments, att(V3_HASH), [], {
      model_identity_asserted: 'anthropic/test-model\uD800',
      relay_config: RELAY_CONFIG,
    });
    expect(result.transcript_hash_valid).toBe(false);
    expect(result.transcript_schema).toBeUndefined();
  });

  it('accepts a v3 transcript in transcript_hash_hex', () => {
    const result = verifyTeeReceipt(
      commitments,
      { receipt_signing_pubkey_hex: 'ffff', transcript_hash_hex: V3_HASH },
      [],
      { model_identity_asserted: MODEL_ID, relay_config: RELAY_CONFIG },
    );
    expect(result.transcript_hash_valid).toBe(true);
    expect(result.transcript_schema).toBe('V3');
    expect(result.transcript_binding).toBe('TranscriptHashFallback');
  });

  it('does not match a v3 transcript against a different relay config', () => {
    const result = verifyTeeReceipt(commitments, att(V3_HASH), [], {
      model_identity_asserted: MODEL_ID,
      relay_config: { ...RELAY_CONFIG, simulated: true },
    });
    expect(result.transcript_hash_valid).toBe(false);
    expect(result.transcript_schema).toBeUndefined();
    expect(result.relay_config).toBeUndefined();
  });

  it('cannot match a v3 transcript without a relay config', () => {
    const result = verifyTeeReceipt(commitments, att(V3_HASH), [], {
      model_identity_asserted: MODEL_ID,
    });
    expect(result.transcript_hash_valid).toBe(false);
    expect(result.transcript_schema).toBeUndefined();
  });

  it('accepts a v2 transcript by default and reports V2', () => {
    const result = verifyTeeReceipt(commitments, att(V2_HASH), [], {
      model_identity_asserted: MODEL_ID,
    });
    expect(result.transcript_hash_valid).toBe(true);
    expect(result.transcript_schema).toBe('V2');
    expect(result.relay_config).toBeUndefined();
  });

  it('requires the receipt model identity for a v2 transcript', () => {
    const result = verifyTeeReceipt(commitments, att(V2_HASH), []);
    expect(result.transcript_hash_valid).toBe(false);
    expect(result.transcript_schema).toBeUndefined();
  });

  it('accepts a v1 transcript by default and reports V1', () => {
    const result = verifyTeeReceipt(commitments, att(V1_HASH), [], {
      model_identity_asserted: MODEL_ID,
    });
    expect(result.transcript_hash_valid).toBe(true);
    expect(result.transcript_schema).toBe('V1');
  });

  it('reports v1/v2 matches as invalid when a relay config is supplied', () => {
    for (const hash of [V1_HASH, V2_HASH]) {
      const result = verifyTeeReceipt(commitments, att(hash), [], {
        model_identity_asserted: MODEL_ID,
        relay_config: RELAY_CONFIG,
      });
      expect(result.transcript_hash_valid).toBe(false);
      expect(result.transcript_schema).toBe(hash === V1_HASH ? 'V1' : 'V2');
      expect(result.relay_config).toBeUndefined();
    }
  });

  it('reports v1/v2 matches as invalid when v3 is required', () => {
    for (const hash of [V1_HASH, V2_HASH]) {
      const result = verifyTeeReceipt(commitments, att(hash), [], {
        model_identity_asserted: MODEL_ID,
        require_transcript_v3: true,
      });
      expect(result.transcript_hash_valid).toBe(false);
      expect(result.transcript_schema).toBe(hash === V1_HASH ? 'V1' : 'V2');
    }
  });

  it('rejects a malformed relay config', () => {
    expect(() =>
      verifyTeeReceipt(commitments, att(V3_HASH), [], {
        relay_config: { ...RELAY_CONFIG, extra: 'x' } as unknown as RelayConfig,
      }),
    ).toThrow(TypeError);
  });
});
