# selkey

Standalone HTTP client for the [Selkey](https://github.com/vcav-io/selkey) relay. Fetch-based, no dependencies on the orchestrator, AFAL, vault-runtime, or autopilot. Designed to run in any Node.js environment or browser that supports the Fetch API.

## Install

```bash
# local monorepo checkout
npm install file:../selkey-client
```

For external consumers, install from a checkout of the repository. The package is
not yet published on npm.

## Exported modules

| Module | Contents |
|--------|----------|
| `selkey` (default) | High-level API: `createAndSubmit`, `joinAndWait`, `pollUntilDone` |
| `selkey/types` | TypeScript types: `RelayClientConfig`, `SessionState`, `AbortReason`, `CreateSessionResponse`, `SessionOutputResponse` |
| `selkey/contracts` | Contract helpers: `buildRelayContract`, `computeRelayContractHash`, `listRelayPurposes`, `RelayContract` type |
| `selkey/http` | Low-level fetch wrappers: `createSession`, `submitInput`, `getStatus`, `getOutput` |
| `selkey/verify` | `verifyReceipt` (receipt v3, v2 and v1 against a pinned relay key, with optional commitment checks), `relayKeyId` (`"ed25519:" + hex(SHA-256(key))`), `fetchRelayPublicKey(url, expectedKeyId)` (checks a relay's `/health` key against a pinned key id; throws on mismatch) |
| `selkey/receipt-v3` | Receipt v3 verifier (`verifyReceiptV3`) and participant checks (`checkOwnInputV3`, `checkReceivedOutputV3`, `checkContractV3`) |
| `selkey/commitment` | `generateCommitmentNonce`, `computeInputCommitmentV3`, `verifyInputCommitmentV3` |
| `selkey/contract-hash` | Contract hash v2: `computeContractHashV2`, `normalizeContractV2` |
| `selkey/jcs` | RFC 8785 canonicalisation with the receipt v3 profile, strict JSON parser |

## Usage

```typescript
import { createAndSubmit, pollUntilDone, generateCommitmentNonce } from 'selkey';
import { buildRelayContract } from 'selkey/contracts';
import { verifyReceipt } from 'selkey/verify';

const config = { relay_url: 'http://localhost:8080' };
const relayKeyHex = '...'; // the relay's verifying key, pinned in your configuration

// Initiator: create a session and submit input. Every submission carries a
// fresh commitment nonce; keep it with your input, and keep both private.
const contract = buildRelayContract('COMPATIBILITY', ['agent-alice', 'agent-bob']);
const myInput = { context: '...' };
const nonce = generateCommitmentNonce();
const session = await createAndSubmit(config, contract, myInput, 'initiator', nonce);

// Share session.sessionId, session.responderSubmitToken, session.responderReadToken,
// and session.contractHash with the responder out-of-band.

// Initiator: poll until the session completes, then check the receipt.
const result = await pollUntilDone(config, session.sessionId, session.initiatorReadToken);
if (result.state === 'COMPLETED' && result.receipt) {
  const check = verifyReceipt(result.receipt, relayKeyHex, {
    output: result.output,
    contract,
    ownInput: { participantId: 'agent-alice', context: myInput, commitmentNonce: nonce },
  });
  console.log(check.valid, result.output);
}
```

For responder-side usage, use `joinAndWait` with the tokens received from the initiator
and a fresh nonce of its own.

## Receipts and commitments

Relays emit receipt v3 (`receipt_schema_version` `"3.0.0"`, specified in
vault-family-core `docs/receipt-v3.md`). Each participant's input commitment is
`SHA-256("VCAV-INPUT-COMMIT-V3:" || nonce || JCS(context))`, where the nonce is the
32 random bytes the client sent as `commitment_nonce`. Only the participant that holds
the nonce can open its commitment, so `verifyReceipt` checks your own entry when you
pass `ownInput` with the nonce. The nonce is a local secret: do not log it or share it
with the counterparty.

`verifyReceipt` uses the pinned relay key only (keys embedded in the receipt are never
trusted on their own), applies strict Ed25519 verification to v3 receipts, and keeps
verifying v2 and v1 receipts. Contracts are hashed with contract hash v2
(`computeRelayContractHash`): send contracts without a `contract_hash` member and omit
absent optional members.

### Conformance vectors

`test-vectors/vfc/` holds the receipt v3 golden vectors from vault-family-core, and
`src/__tests__/vfc-vectors.test.ts` runs every one of them. To update them after a VFC
change, run `scripts/sync-vfc-vectors.sh <path-to-vault-family-core-checkout>` with the
checkout at the revision the relay pins; the script records it in
`test-vectors/vfc/VFC_REVISION`.

## See also

[Selkey repository](https://github.com/vcav-io/selkey)
