#!/usr/bin/env bash
# Builds upstream token-wrap at a pinned release with one change: the program
# ID.
#
# The logic is not modified. The whole fork is the sed below, and the script
# refuses to continue if the patch touched anything else.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"

# program@v1.0.0, 2025-09-11 — the latest program release, and what crates.io
# publishes as spl-token-wrap 1.0.0.
UPSTREAM=https://github.com/solana-program/token-wrap.git
COMMIT=4e4e1d0ed63e1e49d43de2db9ad533c2863b3598
CANONICAL_ID=TwRapQCDhWkZRrDaHfZGuHxkZ91gHDRkyuzNqeU5MgR

program_id="$(solana-keygen pubkey "$here/program-keypair.json")"
src="$here/src"

if [ ! -d "$src/.git" ]; then
    git clone --quiet "$UPSTREAM" "$src"
fi
git -C "$src" fetch --quiet origin "$COMMIT"
git -C "$src" checkout --quiet --force "$COMMIT"

sed -i.orig "s/declare_id!(\"$CANONICAL_ID\")/declare_id!(\"$program_id\")/" "$src/program/src/lib.rs"
rm "$src/program/src/lib.rs.orig"

changed="$(git -C "$src" diff --numstat)"
if [ "$changed" != "$(printf '1\t1\tprogram/src/lib.rs')" ]; then
    echo "the patch changed more than the one declare_id! line:" >&2
    git -C "$src" diff >&2
    exit 1
fi
git -C "$src" diff

cargo-build-sbf --manifest-path "$src/program/Cargo.toml" --sbf-out-dir "$here/target"

echo
echo "built   $here/target/spl_token_wrap.so"
echo "id      $program_id"
shasum -a 256 "$here/target/spl_token_wrap.so"
