# Contributing to AgentVault

## Prerequisites

- **Rust 1.88.0+** (pinned in `rust-toolchain.toml`)
- **Node.js 20+** and npm (for TypeScript packages)
- **vault-family-core** — this repo depends on [vault-family-core](https://github.com/vcav-io/vault-family-core) as a git dependency. Both repos are public and accessible.

## Building

Rust:
```bash
cargo build --workspace
cargo test --workspace
```

TypeScript:
```bash
cd packages/agentvault-client && npm install && npm test
cd packages/agentvault-mcp-server && npm install && npm run build
```

## CI Checks

All PRs must pass:

```bash
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

TypeScript packages are built and tested in CI as well.

## Submitting Changes

1. Fork the repository
2. Create a branch from `main`
3. Make your changes
4. Ensure all CI checks pass locally
5. Open a pull request with a clear description of the change

## What to Contribute

- Bug fixes with a clear reproduction case
- Documentation improvements
- New input schemas (in `schemas/`)
- Test coverage improvements

## Security

If you discover a security vulnerability, please do **not** open a public issue. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.
