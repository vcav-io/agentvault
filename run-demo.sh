#!/usr/bin/env bash
# Run the Selkey demo UI (builds relay + demo server, opens browser).
# See docs/getting-started.md for full instructions.
set -euo pipefail
exec "$(dirname "$0")/packages/selkey-demo-ui/run.sh" "$@"
