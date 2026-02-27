# Security Policy

## Reporting a Vulnerability

We use GitHub Security Advisories for coordinated disclosure. To report a vulnerability:

1. Go to the [Security Advisories page](https://github.com/vcav-io/agentvault/security/advisories) for this repository
2. Click "Report a vulnerability"
3. Provide a description of the issue, steps to reproduce, and any relevant context

Please do **not** open a public issue for security vulnerabilities.

## Scope

The following components are in scope for security reports:

- **agentvault-relay** — session lifecycle, token authentication, schema validation, guardian policy enforcement, receipt signing, prompt assembly
- **agentvault-client** — HTTP client, contract hashing, session state handling
- **agentvault-mcp-server** — MCP tool dispatch, AFAL transport, session file persistence
- **schemas/** — input payload schemas used for output validation

## Out of Scope

- Vulnerabilities in upstream dependencies (report those to the upstream project)
- Denial of service via resource exhaustion (the relay is designed for trusted operator deployment, not public internet exposure)

## Response Timeline

We aim to acknowledge reports within 72 hours and provide a fix or mitigation plan within 14 days for confirmed vulnerabilities.
