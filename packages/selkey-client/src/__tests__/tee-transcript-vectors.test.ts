/**
 * Conformance with the selkey-tee transcript golden vectors.
 *
 * test-vectors/tee/ holds verbatim copies of tests/fixtures/transcript_golden.json
 * (v1) and tests/fixtures/transcript_v3_golden.json (v3 and relay config) from
 * selkey-tee (the source revision is in test-vectors/tee/TEE_REVISION). The v2
 * vector is the `golden_fixture_parity_v2` value from the tee-transcript crate.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import {
  assertRelayConfig,
  computeRelayConfigHashHex,
  computeTranscriptHashHex,
  computeTranscriptHashV2Hex,
  computeTranscriptHashV3,
  computeTranscriptHashV3Hex,
  encodeRelayConfig,
  type RelayConfig,
  type TranscriptInputsV3,
} from '../tee-verify.js';

const VECTOR_DIR = path.resolve(__dirname, '../../test-vectors/tee');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function load(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, name), 'utf8'));
}

const v1Golden = load('transcript_golden.json');
const v3Golden = load('transcript_v3_golden.json');

function relayConfig(value: unknown): RelayConfig {
  assertRelayConfig(value);
  return value;
}

describe('transcript v1 golden vector', () => {
  it('matches the selkey-tee fixture', () => {
    expect(v1Golden.version).toBe('av-tee-transcript-v1');
    expect(computeTranscriptHashHex(v1Golden.inputs)).toBe(v1Golden.expected_hash_hex);
  });

  it('inserts values into the template without escaping', () => {
    const inputs = { ...v1Golden.inputs, contract_hash: 'a"b\\c' };
    const template =
      '{"contract_hash":"a"b\\c","initiator_submission_hash":"cccc","output_hash":"eeee",' +
      '"prompt_template_hash":"bbbb","receipt_signing_pubkey_hex":"ffff",' +
      '"responder_submission_hash":"dddd","version":"av-tee-transcript-v1"}';
    expect(computeTranscriptHashHex(inputs)).toBe(bytesToHex(sha512(utf8ToBytes(template))));
  });
});

describe('transcript v2 golden vector', () => {
  it('matches the tee-transcript golden_fixture_parity_v2 value', () => {
    expect(
      computeTranscriptHashV2Hex({
        contract_hash: 'aaaa',
        prompt_template_hash: 'bbbb',
        initiator_submission_hash: 'cccc',
        responder_submission_hash: 'dddd',
        output_hash: 'eeee',
        receipt_signing_pubkey_hex: 'ffff',
        model_identity_asserted: 'anthropic/test-model',
      }),
    ).toBe(
      '2731b2be1576ab14e1f94543ccbd60ae8185591f9d097aec6536fd1fe5a28178' +
        '3933c46970696dd02891c7ca123adf0afcd7bb10bf2589fd76c3350a49c3dc65',
    );
  });

  it('differs from v1 even with an empty model identity', () => {
    const base = v1Golden.inputs;
    expect(computeTranscriptHashV2Hex({ ...base, model_identity_asserted: '' })).not.toBe(
      computeTranscriptHashHex(base),
    );
  });
});

describe('relay config golden vectors', () => {
  expect(v3Golden.relay_config_version).toBe('av-tee-relay-config-v1');
  for (const v of v3Golden.relay_config_vectors) {
    it(`${v.name}: encoding and hash match`, () => {
      const config = relayConfig(v.relay_config);
      expect(bytesToHex(encodeRelayConfig(config))).toBe(v.expected_encoding_hex);
      expect(computeRelayConfigHashHex(config)).toBe(v.expected_hash_hex);
    });
  }

  it('the transcript vectors use the default relay config hash', () => {
    const config = relayConfig(v3Golden.relay_config_vectors[0].relay_config);
    expect(v3Golden.transcript_vectors[0].inputs.relay_config_hash).toBe(
      computeRelayConfigHashHex(config),
    );
  });

  it('rejects unknown members and wrongly typed values', () => {
    const base = v3Golden.relay_config_vectors[0].relay_config;
    expect(() => assertRelayConfig({ ...base, extra: true })).toThrow(TypeError);
    expect(() => assertRelayConfig({ ...base, echo_mode: 'false' })).toThrow(TypeError);
    const { env: _env, ...missingEnv } = base;
    expect(() => assertRelayConfig(missingEnv)).toThrow(TypeError);
  });

  it('rejects strings that are not well-formed UTF-16', () => {
    const base = v3Golden.relay_config_vectors[0].relay_config;
    // A lone surrogate would otherwise encode as U+FFFD, the same bytes as '\uFFFD'.
    expect(() => assertRelayConfig({ ...base, env: 'a\uD800' })).toThrow(TypeError);
    expect(() => assertRelayConfig({ ...base, env: '\uDC00b' })).toThrow(TypeError);
    expect(() => assertRelayConfig({ ...base, env: 'ok \u{1F600}' })).not.toThrow();
  });
});

describe('transcript v3 golden vectors', () => {
  expect(v3Golden.transcript_version).toBe('av-tee-transcript-v3');
  for (const v of v3Golden.transcript_vectors) {
    it(`${v.name}: hash matches`, () => {
      const inputs: TranscriptInputsV3 = v.inputs;
      const hash = computeTranscriptHashV3(inputs);
      expect(hash.length).toBe(64);
      expect(bytesToHex(hash)).toBe(v.expected_hash_hex);
    });
  }

  it('rejects inputs that are not well-formed UTF-16', () => {
    const inputs: TranscriptInputsV3 = v3Golden.transcript_vectors[0].inputs;
    expect(() =>
      computeTranscriptHashV3({ ...inputs, model_identity_asserted: 'anthropic/m\uD800' }),
    ).toThrow(TypeError);
  });

  it('differs from v2 for the same inputs', () => {
    const inputs: TranscriptInputsV3 = v3Golden.transcript_vectors[0].inputs;
    expect(computeTranscriptHashV3Hex(inputs)).not.toBe(computeTranscriptHashV2Hex(inputs));
  });
});

describe('negative vectors: quote and delimiter characters', () => {
  expect(v3Golden.negative_vectors.length).toBeGreaterThanOrEqual(3);
  for (const v of v3Golden.negative_vectors) {
    it(`${v.name}: distinct inputs get distinct hashes`, () => {
      if (v.kind === 'transcript') {
        const a = computeTranscriptHashV3Hex(v.a);
        const b = computeTranscriptHashV3Hex(v.b);
        expect(a).not.toBe(b);
        expect(a).toBe(v.expected_hash_hex_a);
        expect(b).toBe(v.expected_hash_hex_b);
        // The legacy v2 encoding interpolates values without escaping, so the
        // pair has the same v2 hash (as in the Rust crate).
        expect(computeTranscriptHashV2Hex(v.a)).toBe(computeTranscriptHashV2Hex(v.b));
      } else if (v.kind === 'relay_config') {
        const a = computeRelayConfigHashHex(relayConfig(v.a));
        const b = computeRelayConfigHashHex(relayConfig(v.b));
        expect(a).not.toBe(b);
        expect(a).toBe(v.expected_hash_hex_a);
        expect(b).toBe(v.expected_hash_hex_b);
      } else {
        throw new Error(`unknown negative vector kind ${v.kind}`);
      }
    });
  }
});
