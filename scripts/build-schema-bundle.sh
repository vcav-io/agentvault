#!/usr/bin/env bash
# Build a schema bundle JSON for the agentvault protocol.
#
# Output: dist/schemas.json
# Format: { "protocol": "agentvault", "version": "0.1.0", "generated": "<ISO>", "files": { ... } }
#
# Usage: agentvault/scripts/build-schema-bundle.sh
#   (run from the agentvault workspace root or repo root)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEMAS_DIR="$SCRIPT_DIR/../schemas"
DIST_DIR="$SCRIPT_DIR/../dist"

if [ ! -d "$SCHEMAS_DIR" ]; then
  echo "Error: schemas directory not found: $SCHEMAS_DIR" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"

# Build JSON using python3 (universally available on macOS/Linux)
python3 -c "
import json, os, sys
from datetime import datetime, timezone

schemas_dir = sys.argv[1]
bundle = {
    'protocol': 'agentvault',
    'version': '0.1.0',
    'generated': datetime.now(timezone.utc).isoformat(),
    'files': {}
}

for name in sorted(os.listdir(schemas_dir)):
    if name.endswith('.schema.json'):
        with open(os.path.join(schemas_dir, name)) as f:
            bundle['files'][name] = f.read()

print(json.dumps(bundle, indent=2))
" "$SCHEMAS_DIR" > "$DIST_DIR/schemas.json"

COUNT=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['files']))" < "$DIST_DIR/schemas.json")
echo "Built agentvault schema bundle: $DIST_DIR/schemas.json ($COUNT schemas)"
