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

## Dependencies

- **vault-family-core** (git dep) -- shared IFC vocabulary, receipt envelope, escalation interface
- MCP server depends on `agentvault-client` via `file:` link

## Schemas

JSON Schemas for input payloads live in `schemas/`.

## CI

GitHub Actions (`ci.yml`) runs fmt, clippy, build, and test for Rust.
TypeScript packages are not yet covered by CI.
