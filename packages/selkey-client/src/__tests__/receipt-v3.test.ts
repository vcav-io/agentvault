/**
 * Receipt v3: salted input commitments, the own-input check, output and
 * contract checks, and the client's commitment nonce on submission.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { hashV3, sha256Hex, canonicalizeV3 } from '../jcs-v3.js';
import {
  computeInputCommitmentV3,
  generateCommitmentNonce,
  isValidCommitmentNonce,
  parseCommitmentNonce,
  verifyInputCommitmentV3,
} from '../commitment-v3.js';
import { computeContractHashV2 } from '../contract-hash-v2.js';
import { type ReceiptV3, signingDigestV3, verifyReceiptV3 } from '../receipt-v3.js';
import { verifyReceipt } from '../verify-receipt.js';
import { submitInput } from '../http.js';
import { createAndSubmit, joinAndWait } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keypair() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  return { seed, publicKeyHex: bytesToHex(ed25519.getPublicKey(seed)) };
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

const contract = {
  purpose_code: 'COMPATIBILITY',
  output_schema_id: 'urn:test:schema',
  output_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['decision'],
    properties: { decision: { type: 'string', enum: ['PROCEED', 'DECLINE'] } },
  },
  participants: ['alice', 'bob'],
  prompt_template_hash: 'a'.repeat(64),
  entropy_budget_bits: 8,
};

const aliceContext = { salary_band: 3 };
const bobContext = 'open to offers';

function buildReceipt(
  seed: Uint8Array,
  publicKeyHex: string,
  opts: { aliceNonce: string; bobNonce: string; output?: unknown },
): ReceiptV3 {
  const output = opts.output ?? { decision: 'PROCEED' };
  const unsigned = {
    receipt_schema_version: '3.0.0',
    receipt_canonicalization: 'JCS_RFC8785',
    receipt_id: 'c0ffee00-0000-4000-8000-000000000001',
    session_id: '5e551011-0000-4000-8000-000000000001',
    issued_at: '2026-10-22T12:00:00Z',
    assurance_level: 'SELF_ASSERTED',
    operator: {
      operator_id: 'relay.test',
      operator_key_fingerprint: sha256Hex(Buffer.from(publicKeyHex, 'hex')),
    },
    commitments: {
      contract_hash: computeContractHashV2(contract),
      contract_hash_alg: 'SHA256_JCS_V2',
      schema_hash: hashV3(contract.output_schema),
      output_hash: hashV3(output),
      input_commitments: [
        {
          participant_id: 'alice',
          input_commitment: computeInputCommitmentV3(opts.aliceNonce, aliceContext),
          scheme: 'SHA256_N32_JCS_V3',
        },
        {
          participant_id: 'bob',
          input_commitment: computeInputCommitmentV3(opts.bobNonce, bobContext),
          scheme: 'SHA256_N32_JCS_V3',
        },
      ],
      prompt_assembly_version: '1.0.0',
      output,
      prompt_template_hash: contract.prompt_template_hash,
    },
    claims: {
      status: 'success',
      entropy_budget_bits: 8,
      budget_usage: { scope: 'SESSION', bits_used_before: 0, bits_used_after: 1, budget_limit: 8 },
    },
  } as unknown as ReceiptV3;
  const signature = ed25519.sign(signingDigestV3(unsigned), seed);
  return {
    ...unsigned,
    signature: { alg: 'Ed25519', value: b64url(signature), signed_fields: 'ALL_EXCEPT_SIGNATURE' },
  };
}

function setup() {
  const { seed, publicKeyHex } = keypair();
  const aliceNonce = generateCommitmentNonce();
  const bobNonce = generateCommitmentNonce();
  const receipt = buildReceipt(seed, publicKeyHex, { aliceNonce, bobNonce });
  return { seed, publicKeyHex, aliceNonce, bobNonce, receipt };
}

// ---------------------------------------------------------------------------
// Nonces and commitments
// ---------------------------------------------------------------------------

describe('commitment nonce', () => {
  it('is 32 CSPRNG bytes as 64 lowercase hex, fresh per call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const n = generateCommitmentNonce();
      expect(n).toMatch(/^[0-9a-f]{64}$/);
      seen.add(n);
    }
    expect(seen.size).toBe(64);
  });

  it('rejects short, long, uppercase and non-hex nonces', () => {
    const good = generateCommitmentNonce();
    for (const bad of [
      good.slice(2),
      good + '00',
      good.toUpperCase(),
      'z'.repeat(64),
      '',
      undefined,
    ]) {
      expect(isValidCommitmentNonce(bad)).toBe(false);
      expect(() => parseCommitmentNonce(bad)).toThrow();
    }
  });
});

describe('salted input commitments', () => {
  it('the same input under different nonces gives different commitments', () => {
    const a = computeInputCommitmentV3(generateCommitmentNonce(), aliceContext);
    const b = computeInputCommitmentV3(generateCommitmentNonce(), aliceContext);
    expect(a).not.toBe(b);
  });

  it('a small input cannot be matched from its unsalted hash or by enumeration without the nonce', () => {
    const { receipt, aliceNonce } = setup();
    const committed = receipt.commitments.input_commitments[0].input_commitment;
    // Every candidate in a small input space, hashed the v2 way (no nonce),
    // and under a guessed nonce: none matches the receipt.
    const guessNonce = '0'.repeat(64);
    for (let band = 0; band < 1000; band++) {
      const candidate = { salary_band: band };
      expect(sha256Hex(canonicalizeV3(candidate))).not.toBe(committed);
      expect(computeInputCommitmentV3(guessNonce, candidate)).not.toBe(committed);
    }
    // The participant, holding the nonce, can open it.
    expect(verifyInputCommitmentV3(aliceNonce, aliceContext, committed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyReceipt on v3
// ---------------------------------------------------------------------------

describe('verifyReceipt — v3', () => {
  it('verifies a v3 receipt against the pinned key', () => {
    const { receipt, publicKeyHex } = setup();
    const result = verifyReceipt(receipt as unknown as Record<string, unknown>, publicKeyHex);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.schema_version).toBe('3.0.0');
  });

  it('rejects a v3 receipt under a different pinned key', () => {
    const { receipt } = setup();
    const other = keypair().publicKeyHex;
    expect(verifyReceiptV3(receipt as unknown as Record<string, unknown>, other)).toMatchObject({
      ok: false,
      errorClass: 'KEY_MISMATCH',
    });
  });

  it('own-input check passes with the right nonce and fails with a wrong one', () => {
    const { receipt, publicKeyHex, aliceNonce, bobNonce } = setup();
    const r = receipt as unknown as Record<string, unknown>;
    const ok = verifyReceipt(r, publicKeyHex, {
      ownInput: { participantId: 'alice', context: aliceContext, commitmentNonce: aliceNonce },
    });
    expect(ok.valid).toBe(true);
    expect(ok.commitment_checks).toEqual([
      expect.objectContaining({ field: 'input_commitments.input_commitment', match: true }),
    ]);

    for (const wrong of [bobNonce, generateCommitmentNonce()]) {
      const bad = verifyReceipt(r, publicKeyHex, {
        ownInput: { participantId: 'alice', context: aliceContext, commitmentNonce: wrong },
      });
      expect(bad.valid).toBe(false);
      expect(bad.errors.join(' ')).toMatch(/OWN_INPUT_MISMATCH/);
    }
  });

  it('own-input check fails for a different input or a missing nonce', () => {
    const { receipt, publicKeyHex, aliceNonce } = setup();
    const r = receipt as unknown as Record<string, unknown>;
    expect(
      verifyReceipt(r, publicKeyHex, {
        ownInput: {
          participantId: 'alice',
          context: { salary_band: 4 },
          commitmentNonce: aliceNonce,
        },
      }).valid,
    ).toBe(false);
    expect(
      verifyReceipt(r, publicKeyHex, {
        ownInput: { participantId: 'alice', context: aliceContext },
      }).valid,
    ).toBe(false);
    expect(
      verifyReceipt(r, publicKeyHex, {
        ownInput: { participantId: 'carol', context: aliceContext, commitmentNonce: aliceNonce },
      }).valid,
    ).toBe(false);
  });

  it('checks the received output and the contract', () => {
    const { receipt, publicKeyHex } = setup();
    const r = receipt as unknown as Record<string, unknown>;
    expect(
      verifyReceipt(r, publicKeyHex, { output: { decision: 'PROCEED' }, contract }).valid,
    ).toBe(true);
    expect(verifyReceipt(r, publicKeyHex, { output: { decision: 'DECLINE' } }).valid).toBe(false);
    expect(
      verifyReceipt(r, publicKeyHex, { contract: { ...contract, participants: ['bob', 'alice'] } })
        .valid,
    ).toBe(false);
    expect(
      verifyReceipt(r, publicKeyHex, { contract: { ...contract, entropy_budget_bits: 16 } }).valid,
    ).toBe(false);
  });

  it('accepts the contract with a stored contract_hash member removed before hashing', () => {
    const { receipt, publicKeyHex } = setup();
    const stored = { ...contract, contract_hash: computeContractHashV2(contract) };
    expect(
      verifyReceipt(receipt as unknown as Record<string, unknown>, publicKeyHex, {
        contract: stored,
      }).valid,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Submission sends the nonce
// ---------------------------------------------------------------------------

describe('submitInput — commitment nonce', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const payload = url.endsWith('/sessions')
          ? {
              session_id: 's1',
              contract_hash: 'c'.repeat(64),
              initiator_submit_token: 'ist',
              initiator_read_token: 'irt',
              responder_submit_token: 'rst',
              responder_read_token: 'rrt',
            }
          : url.endsWith('/output')
            ? { state: 'COMPLETED', output: { decision: 'PROCEED' } }
            : { state: 'COMPLETED' };
        return new Response(JSON.stringify(payload), { status: 200 });
      }),
    );
    return calls;
  }

  it('sends commitment_nonce on every submission path', async () => {
    const calls = stubFetch();
    const config = { relay_url: 'http://relay.test' };
    const n1 = generateCommitmentNonce();
    const n2 = generateCommitmentNonce();
    const n3 = generateCommitmentNonce();

    await submitInput(config, 's1', 't', 'initiator', { a: 1 }, n1, 'c'.repeat(64));
    await createAndSubmit(config, contract, { a: 2 }, 'initiator', n2);
    await joinAndWait(config, 's1', 'st', 'rt', 'c'.repeat(64), { a: 3 }, 'responder', n3, 1, 1000);

    const inputs = calls.filter((c) => c.url.endsWith('/input')).map((c) => c.body);
    expect(inputs).toEqual([
      {
        role: 'initiator',
        context: { a: 1 },
        commitment_nonce: n1,
        expected_contract_hash: 'c'.repeat(64),
      },
      { role: 'initiator', context: { a: 2 }, commitment_nonce: n2 },
      {
        role: 'responder',
        context: { a: 3 },
        commitment_nonce: n3,
        expected_contract_hash: 'c'.repeat(64),
      },
    ]);
  });

  it('refuses to submit with a malformed nonce', async () => {
    const calls = stubFetch();
    const config = { relay_url: 'http://relay.test' };
    await expect(
      submitInput(config, 's1', 't', 'initiator', {}, generateCommitmentNonce().toUpperCase()),
    ).rejects.toThrow(/commitmentNonce/);
    expect(calls).toHaveLength(0);
  });
});

describe('verifyReceipt — v3 artefact handling', () => {
  it('checks prompt_template_hash against the contract, not a recomputed program hash', () => {
    const { receipt, publicKeyHex } = setup();
    const r = receipt as unknown as Record<string, unknown>;
    expect(verifyReceipt(r, publicKeyHex, { contract }).valid).toBe(true);
    expect(
      verifyReceipt(r, publicKeyHex, {
        contract: { ...contract, prompt_template_hash: 'b'.repeat(64) },
      }).valid,
    ).toBe(false);
    const withProgram = verifyReceipt(r, publicKeyHex, { promptProgram: { system: 'x' } });
    expect(withProgram.valid).toBe(false);
    expect(withProgram.errors.join(' ')).toMatch(/contract\.prompt_template_hash/);
  });

  it('rejects unknown artefact fields such as promptTemplate instead of skipping the check', () => {
    const { receipt, publicKeyHex } = setup();
    const result = verifyReceipt(receipt as unknown as Record<string, unknown>, publicKeyHex, {
      promptTemplate: 'raw template text',
    } as never);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/promptTemplate/);
  });

  it('checks the signature before internal consistency', () => {
    const { seed, publicKeyHex, aliceNonce, bobNonce } = setup();
    const receipt = buildReceipt(seed, publicKeyHex, { aliceNonce, bobNonce });
    // Change the inline output after signing: both the signature and the
    // output hash are now wrong; the signature rule is reported first.
    const tampered = {
      ...receipt,
      commitments: { ...receipt.commitments, output: { decision: 'DECLINE' } },
    } as unknown as Record<string, unknown>;
    expect(verifyReceiptV3(tampered, publicKeyHex)).toMatchObject({
      ok: false,
      errorClass: 'SIGNATURE_INVALID',
    });
  });
});

describe('receipt v3 field privacy', () => {
  it('rejects receipts that carry assembled_prompt_hash or rejected_output_hash', () => {
    const { seed, publicKeyHex, aliceNonce, bobNonce } = setup();
    const base = buildReceipt(seed, publicKeyHex, { aliceNonce, bobNonce });
    for (const field of ['assembled_prompt_hash', 'rejected_output_hash']) {
      const { signature: _s, ...unsigned } = base;
      const withField = {
        ...unsigned,
        commitments: { ...unsigned.commitments, [field]: '7'.repeat(64) },
      } as unknown as ReceiptV3;
      // Correctly signed, so only the field rules can reject it.
      const sig = ed25519.sign(signingDigestV3(withField), seed);
      const signed = {
        ...withField,
        signature: { alg: 'Ed25519', value: b64url(sig), signed_fields: 'ALL_EXCEPT_SIGNATURE' },
      } as unknown as Record<string, unknown>;
      expect(verifyReceiptV3(signed, publicKeyHex)).toMatchObject({ ok: false });
    }
  });
});
