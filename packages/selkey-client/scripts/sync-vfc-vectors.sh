#!/usr/bin/env bash
# Copy the receipt v3 golden vectors from a vault-family-core checkout into
# test-vectors/vfc/ and record the source revision.
#
# Usage: scripts/sync-vfc-vectors.sh <path-to-vault-family-core-checkout>
#
# Keep the recorded revision in step with the VFC rev pinned in Cargo.toml
# (packages/selkey-relay). The conformance suite in
# src/__tests__/vfc-vectors.test.ts runs every file listed here.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <vault-family-core checkout>" >&2
  exit 2
fi

VFC_DIR="$1"
SRC="$VFC_DIR/data/test-vectors"
DEST="$(cd "$(dirname "$0")/.." && pwd)/test-vectors/vfc"

FILES=(
  jcs_rfc8785_testdata.json
  jcs_rfc8785_numbers.json
  jcs_v3_profile.json
  input_commitment_v3.json
  contract_hash_v2.json
  receipt_v3_positive_01.json
  receipt_v3_positive_02.json
  receipt_v3_negative.json
)

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  cp "$SRC/$f" "$DEST/$f"
done

REV="$(git -C "$VFC_DIR" rev-parse HEAD)"
printf '%s\n' "$REV" > "$DEST/VFC_REVISION"
echo "Synced ${#FILES[@]} vector files from vault-family-core $REV"
