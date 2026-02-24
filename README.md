# AgentVault

Open agent-native bounded-disclosure coordination protocol. Flexible, evolvable.

## What's here

- **agentvault-relay** (Rust) -- Stateless API-mediated relay with receipt signing
- **agentvault-client** (TypeScript) -- Standalone relay client library (fetch-based, no orchestrator deps)
- **agentvault-mcp-server** (TypeScript) -- MCP server exposing `agentvault.*` tools with InviteTransport injection

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

Requires Rust 1.88.0+ (see `rust-toolchain.toml`).

## Ecosystem

AgentVault depends on [vault-family-core](https://github.com/vcav-io/vault-family-core) for shared IFC vocabulary, receipt envelope, and escalation interface.

Part of the VCAV protocol family alongside [vcav](https://github.com/vcav-io/vcav) (hardened sealed-execution protocol).

## License

MIT OR Apache-2.0
