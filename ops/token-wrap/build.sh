#!/usr/bin/env bash
# Checks out upstream token-wrap at a pinned release and rewrites its program
# ID.
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
