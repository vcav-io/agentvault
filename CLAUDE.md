# AgentVault

Open agent-native bounded-disclosure coordination protocol.

## Build & Test

```bash
# Rust (relay)
cargo build --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check

# TypeScript (client)
cd packages/agentvault-client && npm install && npm test

# TypeScript (MCP server)
cd packages/agentvault-mcp-server && npm install && npm run build
```

Requires Rust 1.88.0+ (pinned in `rust-toolchain.toml`).

## Packages

| Package | Language | Description |
|---------|----------|-------------|
| `packages/agentvault-relay` | Rust | Stateless API-mediated relay with receipt signing |
| `packages/agentvault-client` | TypeScript | Standalone relay client library (fetch-based) |
| `packages/agentvault-mcp-server` | TypeScript | MCP server exposing `agentvault.*` tools |
| `packages/agentvault-demo-ui` | TypeScript | Three-panel protocol observatory (demo/debugging) |

## Dependencies

- **vault-family-core** (git dep) -- shared IFC vocabulary, receipt envelope, escalation interface
- MCP server depends on `agentvault-client` via `file:` link
- **av-tee/tee-verifier** — TEE receipt verification (Rust). The TS client surfaces TEE fields for introspection; full cryptographic verification requires tee-verifier. Intended path: published crate or VFC-hosted. Do not let this calcify as a git dep.

## Key Directories

- `docs/` — architecture docs, threat model, guides, `environment-variables.md` for relay config
- `schemas/output/` — content-addressed output schemas (registry lookup by hash)
- `prompt_programs/` — model profiles and enforcement policies with lockfile validation

## CI

GitHub Actions (`ci.yml`) runs fmt, clippy, build, and test for Rust.
TypeScript packages are covered by `ci-typescript.yml`.
