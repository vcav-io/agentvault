/**
 * Receipts produced by the Rust relay (test-vectors/relay/relay_receipts.json,
 * written by selkey-relay tests/receipt_v3.rs write_relay_receipt_fixture)
 * verified with the TypeScript verifier.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseJsonStrict, sha256Hex } from '../jcs-v3.js';
import { verifyReceiptV3 } from '../receipt-v3.js';
import { verifyReceipt } from '../verify-receipt.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture: any = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../test-vectors/relay/relay_receipts.json'), 'utf8'),
);
const key: string = fixture.relay_verifying_key_hex;

describe('relay-produced receipts', () => {
  it('has a success and a failure case', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(fixture.cases.map((c: any) => c.name).sort()).toEqual(['failure', 'success']);
  });

  for (const c of fixture.cases) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = parseJsonStrict(c.output_response_json) as any;
    const contract = parseJsonStrict(c.contract_json);

    it(`${c.name}: the receipt verifies against the relay key`, () => {
      const result = verifyReceiptV3(JSON.stringify(response.receipt), key);
      expect(result).toMatchObject({ ok: true });
      expect(response.receipt.receipt_schema_version).toBe('3.0.0');
      expect(response.receipt.commitments).not.toHaveProperty('assembled_prompt_hash');
      expect(response.receipt.commitments).not.toHaveProperty('rejected_output_hash');
    });

    it(`${c.name}: each participant opens its own commitment, the contract matches`, () => {
      for (const p of c.participants_private) {
        const result = verifyReceipt(response.receipt, key, {
          contract,
          ...(c.name === 'success' ? { output: response.output } : {}),
          ownInput: {
            participantId: p.participant_id,
            context: parseJsonStrict(p.context_json),
            commitmentNonce: p.nonce_hex,
          },
        });
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      }
    });

    it(`${c.name}: a participant cannot open the other participant's commitment`, () => {
      const [a, b] = c.participants_private;
      const result = verifyReceipt(response.receipt, key, {
        ownInput: {
          participantId: b.participant_id,
          context: parseJsonStrict(b.context_json),
          commitmentNonce: a.nonce_hex,
        },
      });
      expect(result.valid).toBe(false);
    });
  }

  it('failure: no output was released, so output_hash is H("")', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failure = fixture.cases.find((c: any) => c.name === 'failure');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = parseJsonStrict(failure.output_response_json) as any;
    expect(response.state).toBe('ABORTED');
    expect(response.receipt.commitments.output_hash).toBe(sha256Hex(''));
    expect(response.receipt.commitments).not.toHaveProperty('output');
  });
});
