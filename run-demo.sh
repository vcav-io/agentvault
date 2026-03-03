#!/usr/bin/env bash
# Run the AgentVault demo UI (builds relay + demo server, opens browser).
# See docs/getting-started.md for full instructions.
set -euo pipefail
exec "$(dirname "$0")/packages/agentvault-demo-ui/run.sh" "$@"
