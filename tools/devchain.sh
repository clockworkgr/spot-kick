#!/usr/bin/env bash
# Local chain for the web UI: gnodev with the Spot Kick realm, impl/v1
# accepted, and optional extra accounts funded (e.g. your Adena address).
#
#   tools/devchain.sh [g1youraddress ...]
#
# Needs gnodev and gnokey on PATH and ../gno-shots-realm next to this repo.
# The realm's Admin is the public test1 key; it is imported into a throwaway
# keybase (never your own) to send Accept.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
realm="${REALM_DIR:-$here/../gno-shots-realm}"
rpc="${RPC:-http://127.0.0.1:26657}"
keys="$(mktemp -d)"
trap 'rm -rf "$keys"; kill $(jobs -p) 2>/dev/null || true' EXIT

accounts=()
for a in "$@"; do accounts+=(-add-account "$a=100000000000ugnot"); done

cd "$realm"
gnodev local -chain-id dev -empty-blocks \
  -paths gno.land/r/clockwork/shots,gno.land/r/clockwork/shots/impl/v1 \
  ${accounts[@]+"${accounts[@]}"} &

until curl -sf "$rpc/status" >/dev/null; do sleep 1; done
sleep 2
test1='source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast'
printf '%s\n\n\n' "$test1" | gnokey add test1 -recover -home "$keys" -insecure-password-stdin >/dev/null 2>&1 \
  || printf '%s\n' "$test1" | gnokey add test1 -recover -home "$keys" -insecure-password-stdin >/dev/null
echo '' | gnokey maketx call -pkgpath gno.land/r/clockwork/shots -func Accept \
  -args gno.land/r/clockwork/shots/impl/v1 -gas-fee 1000000ugnot -gas-wanted 50000000 \
  -broadcast -chainid dev -remote "$rpc" -home "$keys" -insecure-password-stdin test1
echo "Spot Kick realm live on $rpc (chain id dev). Ctrl-C to stop."
wait
