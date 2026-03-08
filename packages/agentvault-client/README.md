# agentvault-client

Standalone HTTP client for the [AgentVault](https://github.com/vcav-io/agentvault) relay. Fetch-based, no dependencies on the orchestrator, AFAL, vault-runtime, or autopilot. Designed to run in any Node.js environment or browser that supports the Fetch API.

## Install

```bash
# local monorepo checkout
npm install file:../agentvault-client
```

For external consumers, install from a checkout of the repository. The package is
not yet published on npm.

## Exported modules

| Module | Contents |
|--------|----------|
| `agentvault-client` (default) | High-level API: `createAndSubmit`, `joinAndWait`, `pollUntilDone` |
| `agentvault-client/types` | TypeScript types: `RelayClientConfig`, `SessionState`, `AbortReason`, `CreateSessionResponse`, `SessionOutputResponse` |
| `agentvault-client/contracts` | Contract helpers: `buildRelayContract`, `computeRelayContractHash`, `listRelayPurposes`, `RelayContract` type |
| `agentvault-client/http` | Low-level fetch wrappers: `createSession`, `submitInput`, `getStatus`, `getOutput` |

## Usage

```typescript
import { createAndSubmit, pollUntilDone } from 'agentvault-client';
import { buildRelayContract } from 'agentvault-client/contracts';

const config = { relay_url: 'http://localhost:8080' };

// Initiator: create a session and submit input
const contract = buildRelayContract('COMPATIBILITY', ['agent-alice', 'agent-bob']);
const session = await createAndSubmit(config, contract, { context: '...' }, 'agent-alice');

// Share session.sessionId, session.responderSubmitToken, session.responderReadToken,
// and session.contractHash with the responder out-of-band.

// Initiator: poll until the session completes
const result = await pollUntilDone(config, session.sessionId, session.initiatorReadToken);
if (result.state === 'COMPLETED') {
  console.log(result.output);
}
```

For responder-side usage, use `joinAndWait` with the tokens received from the initiator.

## See also

[AgentVault repository](https://github.com/vcav-io/agentvault)
