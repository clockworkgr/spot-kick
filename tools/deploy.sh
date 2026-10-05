#!/usr/bin/env bash
# Deploys the Spot Kick packages and realm to a public gno.land network, under
# the deploying key's address namespace (gno.land/{p,r}/<g1addr>/...), with
# that address as the realm's Admin, then accepts the latest implementation
# (impl/v3) unless it is already live. Upgrading an existing deployment is the
# same run: what is live is skipped, the new implementation is deployed and
# accepted (the key must then be the realm's Admin).
#
#   tools/deploy.sh <key-name>                     # onyx-1 by default
#   CHAIN_ID=... RPC=... tools/deploy.sh <key-name>
#
# The packages are staged in a temporary copy of ../gno-shots-realm with
# gno.land/{p,r}/clockwork rewritten to the key's namespace and the test1
# Admin replaced; test files are left out (they only cost storage deposit).
# Packages already live are skipped, so the script can be re-run. On a chain
# with the inert code-submission policy a deploy is parked until the chain's
# approver enables it; each package is waited for before its dependents.
#
# GNOKEY selects the gnokey binary (default: tools/bin/gnokey-onyx if present,
# else gnokey on PATH): it must match the network's release, since gnokey
# from a newer gno signs transactions an older chain cannot decode.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
realm="${REALM_DIR:-$here/../gno-shots-realm}"
key="${1:?usage: tools/deploy.sh <key-name>}"
chain="${CHAIN_ID:-onyx-1}"
rpc="${RPC:-https://rpc.onyx.testnets.gno.land:443}"
gnokey="${GNOKEY:-}"
if [ -z "$gnokey" ]; then
  if [ -x "$here/tools/bin/gnokey-onyx" ]; then gnokey="$here/tools/bin/gnokey-onyx"; else gnokey=gnokey; fi
fi
# The test1 address the source uses as Admin (see r/clockwork/shots).
test1=g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5

addr="$("$gnokey" list | awk -v k="$key" '$2 == k { for (i = 1; i <= NF; i++) if ($i == "addr:") print $(i + 1) }')"
[ -n "$addr" ] || { echo "no key named $key in the gnokey keybase" >&2; exit 1; }
echo "deploying to $chain ($rpc) as $key, namespace $addr"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pkgs=(
  p/clockwork/penalty/v0
  p/clockwork/upgradeable/v0
  p/clockwork/shootout/v0
  p/clockwork/penalty/physics/v0
  r/clockwork/shots
  r/clockwork/shots/impl/v1
  r/clockwork/shots/impl/v2
  r/clockwork/shots/impl/v3
)
for p in "${pkgs[@]}"; do
  mkdir -p "$stage/$p"
  for f in "$realm/gno.land/$p"/*.gno "$realm/gno.land/$p/gnomod.toml"; do
    case "$f" in *_test.gno | *_filetest.gno) continue ;; esac
    sed -e "s#gno\.land/p/clockwork/#gno.land/p/$addr/#g" \
      -e "s#gno\.land/r/clockwork/#gno.land/r/$addr/#g" \
      -e "s#$test1#$addr#g" "$f" >"$stage/$p/$(basename "$f")"
  done
done
if grep -rq "clockwork/\|$test1" "$stage"; then
  echo "staging left a clockwork path or the test1 address behind:" >&2
  grep -rn "clockwork/\|$test1" "$stage" >&2
  exit 1
fi
if [ -n "${STAGE_ONLY:-}" ]; then # a dry run: keep the staged packages, deploy nothing
  mkdir -p "$STAGE_ONLY/gno.land" && cp -R "$stage/." "$STAGE_ONLY/gno.land/"
  echo "staged in $STAGE_ONLY"
  exit 0
fi

status() {
  curl -sf "$rpc/abci_query?path=%22vm/qpkgmeta_json%22&data=%22$(printf '%s' "$1" | base64)%22" |
    python3 -c 'import sys, json, base64
r = json.load(sys.stdin)["result"]["response"]["ResponseBase"]
d = base64.b64decode(r["Data"] or b"").decode()
print(json.loads(d)["status"] if d else "error: " + (r["Log"] or "")[:200])'
}

read -r -s -p "Password for $key: " pw </dev/tty
echo
for p in "${pkgs[@]}"; do
  path="gno.land/${p/clockwork/$addr}"
  s="$(status "$path")"
  if [ "$s" = live ]; then
    echo "$path: already live"
    continue
  fi
  echo "$path: deploying ($s)"
  printf '%s\n' "$pw" | "$gnokey" maketx addpkg -pkgpath "$path" -pkgdir "$stage/$p" \
    -gas-fee 500000ugnot -gas-wanted 500000000 -broadcast -chainid "$chain" -remote "$rpc" \
    -insecure-password-stdin -quiet "$key"
  for _ in $(seq 1 60); do
    s="$(status "$path")"
    [ "$s" = live ] && break
    sleep 2
  done
  [ "$s" = live ] || { echo "$path: still $s after two minutes" >&2; exit 1; }
  echo "$path: live"
done

shots="gno.land/r/$addr/shots"
impl="$shots/impl/v3"
livePath="$(curl -sf "$rpc/abci_query?path=%22vm/qeval%22&data=0x$(printf '%s' "$shots.LivePath()" | xxd -p | tr -d '\n')" |
  python3 -c 'import sys, json, base64
r = json.load(sys.stdin)["result"]["response"]["ResponseBase"]
print(base64.b64decode(r["Data"] or b"").decode())')"
if [[ "$livePath" == *"\"$impl\""* ]]; then
  echo "$impl: already the live implementation"
else
  echo "accepting $impl"
  printf '%s\n' "$pw" | "$gnokey" maketx call -pkgpath "$shots" -func Accept -args "$impl" \
    -gas-fee 100000ugnot -gas-wanted 100000000 -broadcast -chainid "$chain" -remote "$rpc" \
    -insecure-password-stdin -quiet "$key"
fi
echo "done: realm $shots on $chain, live implementation $impl"
