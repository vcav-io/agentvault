#!/usr/bin/env bash
# Copy the receipt v3, IFC grant v2 and key rotation golden vectors from a
# vault-family-core checkout into test-vectors/vfc/ (flat: subdirectories are
# dropped) and record the source revision.
#
# Usage: scripts/sync-vfc-vectors.sh <path-to-vault-family-core-checkout>
#
# Keep the recorded revision in step with the VFC rev pinned in Cargo.toml
# (packages/selkey-relay). The conformance suite in
# src/__tests__/vfc-vectors.test.ts runs the receipt v3 files; selkey-mcp's
# src/__tests__/vfc-grant-rotation-vectors.test.ts runs the grant and rotation
# files.
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
  ifc/ifc_grant_v2_positive_01.json
  ifc/ifc_grant_v2_positive_02.json
  ifc/ifc_grant_v2_negative.json
  afal-key-rotation-v1.json
  afal-key-rotation-ts-01.json
)

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  cp "$SRC/$f" "$DEST/$(basename "$f")"
done

REV="$(git -C "$VFC_DIR" rev-parse HEAD)"
printf '%s\n' "$REV" > "$DEST/VFC_REVISION"
echo "Synced ${#FILES[@]} vector files from vault-family-core $REV"
