# Testing

## Unit and integration tests

### Rust (relay)

```bash
cargo test --workspace
```

This runs all unit tests in the relay crate including session lifecycle, contract hashing, entropy calculation, enforcement policy validation, and receipt construction.

### TypeScript (client + MCP server)

```bash
cd packages/agentvault-client && npm install && npm test
cd packages/agentvault-mcp-server && npm install && npm test
```

The MCP server tests use Vitest with mocked HTTP calls. No running relay is required.

## CI checks

Before submitting a PR, ensure all CI checks pass locally:

```bash
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
cd packages/agentvault-client && npm test
cd packages/agentvault-mcp-server && npm run build
```

## Live test suite

The live test suite runs full end-to-end sessions against a running relay. Located in `tests/live/`.

### Prerequisites

- A built relay binary (`cargo build --workspace`)
- An API key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`), or use `--mock` mode
- Node.js (for the mock Anthropic server)

### Running scenarios

```bash
# Run a single scenario with mock provider (no API key needed)
./tests/live/prep.sh --mock <scenario-name>

# Run the smoke scenario
./tests/live/prep.sh --smoke

# Run all scenarios
./tests/live/prep.sh --all

# Run with a specific provider
./tests/live/prep.sh --provider openai <scenario-name>
```

### Direct HTTP driver

`drive.sh` drives relay sessions via curl, bypassing MCP. Useful for testing the relay directly.

```bash
# Run a scenario with 3 sessions
./tests/live/drive.sh --scenario 06-accumulation-naive --sessions 3

# Run without starting a relay (use an already-running one)
./tests/live/drive.sh --scenario 06-accumulation-naive --no-relay

# Run with a specific provider
./tests/live/drive.sh --scenario 06-accumulation-naive --provider openai
```

### Verification

After a session completes, verify the receipt:

```bash
./tests/live/verify.sh <result-directory>
```

### Accumulation analysis

For multi-session scenarios, analyse entropy accumulation:

```bash
./tests/live/accumulate.sh <result-directory>
```

### Mock mode

The `--mock` flag starts a local mock Anthropic server (`harness/mock-anthropic.mjs`) that returns deterministic responses. This is useful for CI and for testing the relay's session lifecycle without consuming API credits.

### Scenarios

Scenarios are defined in `tests/live/scenarios/`. Each scenario directory contains input files and expected output schemas. Available scenarios include:

- Compatibility assessments (co-founder, employment reference, M&A)
- Adversarial extraction attempts (prompt injection, credential exfiltration)
- Accumulation attacks (naive and systematic)
- Social engineering attempts

### Results

Test results are written to `tests/live/results/`. Each run creates a timestamped directory containing the relay output, receipt, and verification results.

## Red team testing

The red team test suite evaluates the relay's resistance to adversarial inputs. See:

- [Red Team Evaluation Notes](red-team-evaluation-notes.md) — full methodology, results, and analysis
- [Red Team Test Plan](plans/agent_vault_red_team_test_plan_v_1.md) — threat model and test protocol
