> **Note:** This file tracks internal development status and is intended for contributors. It may reference plans, experiments, or in-progress work that has not yet shipped.

# AgentVault Status

**Last Updated:** 2026-03-01

## Current Capabilities

| Component | Description | Status |
|-----------|-------------|--------|
| Relay | Bilateral API-mediated inference with Anthropic + OpenAI | Complete |
| Client | `agentvault-client` — standalone fetch-based relay client | Complete |
| MCP Server | `agentvault-mcp-server` — FSM with resume tokens, AFAL shapes | Complete |
| Inbox | Async relay-mediated invites with SSE, 7-day TTL | Complete |
| Enforcement | Content-addressed policy engine with lockfile validation | Complete |
| Schema Versioning | Content-addressed output schemas, versioning policy | Complete |
| Docker | Multi-stage Dockerfile, GHCR workflow, demo docker-compose | Complete |
| Testing | Category C driver, paraphrase stability, session metadata endpoint | Complete |
| Red Team | 7 adversarial scenarios, 20/20 pass rate, canary-guarded | Complete |

## Open Work

| Issue | Description | Size | Status |
|-------|-------------|------|--------|
| [#81](https://github.com/vcav-io/agentvault/issues/81) | Responder read token test for metadata endpoint | S | Ready |
| [#82](https://github.com/vcav-io/agentvault/issues/82) | HTTP status checks on drive-catc.sh curls | S | Ready |
| [#83](https://github.com/vcav-io/agentvault/issues/83) | Exclude aborted sessions from timing data | S | Ready |
| [#84](https://github.com/vcav-io/agentvault/issues/84) | stability.sh verdict parsing diagnostics | S | Ready |
| [#79](https://github.com/vcav-io/agentvault/issues/79) | Wave 8 follow-up: live verification of testing tooling | M | Ready |
| [#80](https://github.com/vcav-io/agentvault/issues/80) | Pre-publication cleanup: tracked internal files | M | Ready |
| [#77](https://github.com/vcav-io/agentvault/issues/77) | README problem motivation for public launch | M | Ready |
| [#76](https://github.com/vcav-io/agentvault/issues/76) | Pre-publication: package.json metadata and CI | M | Ready |

## Completed Feature Archive

Detailed descriptions of all completed features (live test suite, red team, multi-provider,
schema v2, enforcement policy, inbox, heartbeat integration, schema content-addressing)
are in [archive/2026-03-01-status-archive.md](archive/2026-03-01-status-archive.md).
