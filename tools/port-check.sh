#!/usr/bin/env bash
# Checks the gno port of the physics engine against this one, at scale.
#
#   tools/port-check.sh [cases] [seed]        # default 20000 kicks, seed 7
#
# The gno package's own tests (gno test) replay a few hundred golden kicks
# inside the gno VM. This script runs the same Go code natively on many
# thousands more, which is quick: it mirrors the .gno files into a scratch Go
# module and builds for amd64, because Go on arm64 fuses multiply-adds (one
# rounding instead of two) and would not reproduce JavaScript's arithmetic;
# gno, like amd64 Go, never fuses. On Apple silicon it runs under Rosetta.
# It also checks the port's square root against math.Sqrt on 100M+ values.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
pkg="${PHYSICS_DIR:-$here/../gno-shots-realm/gno.land/p/clockwork/penalty/physics/v0}"
cases="${1:-20000}"
seed="${2:-7}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for f in "$pkg"/*.gno; do
  b="$(basename "$f" .gno)"
  case "$b" in adapter|engine_test|golden_cases_test|gas*) continue ;; esac
  cp "$f" "$work/$b.go"
done
printf 'module physics\n\ngo 1.22\n' > "$work/go.mod"
printf 'package physics\n\nconst goldenCases = ""\n' > "$work/golden_cases_test.go"
echo "generating $cases golden kicks (seed $seed)…"
node "$here/tools/golden.mjs" --cases "$cases" --seed "$seed" > "$work/golden.txt" 2>/dev/null

cat > "$work/native_test.go" <<'EOF'
package physics

import (
	"math"
	"math/rand"
	"os"
	"testing"
)

func TestNativeGolden(t *testing.T) {
	b, err := os.ReadFile("golden.txt")
	if err != nil {
		t.Fatal(err)
	}
	n, fails := checkGolden(t, string(b), 0)
	t.Logf("%d kicks, %d differ from the browser engine", n, fails)
	if fails > 0 {
		t.Fail()
	}
}

func TestNativeSqrt(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	bad := 0
	check := func(x float64) {
		g, w := fsqrt(x), math.Sqrt(x)
		if math.Float64bits(g) != math.Float64bits(w) && !(math.IsNaN(g) && math.IsNaN(w)) {
			bad++
			if bad < 10 {
				t.Errorf("fsqrt(%x) = %x want %x", math.Float64bits(x), math.Float64bits(g), math.Float64bits(w))
			}
		}
	}
	for i := 0; i < 100_000_000; i++ {
		check(math.Float64frombits(r.Uint64() & 0x7fffffffffffffff))
	}
	for i := 0; i < 5_000_000; i++ {
		k := float64(r.Int63n(1 << 26))
		s := k * k
		for d := uint64(0); d < 4; d++ {
			check(math.Float64frombits(math.Float64bits(s) + d))
			check(math.Float64frombits(math.Float64bits(s) - d))
		}
	}
	for i := 0; i < 20_000_000; i++ {
		check(math.Float64frombits(math.Float64bits(1.0) + uint64(r.Int63n(1<<20)) - 1<<19))
		check(math.Float64frombits(math.Float64bits(math.Ldexp(1, r.Intn(2000)-1000)) + uint64(r.Int63n(64)) - 32))
	}
	for e := -1074; e <= 1023; e++ {
		p := math.Float64bits(math.Ldexp(1, e))
		for d := int64(-2); d <= 2; d++ {
			check(math.Float64frombits(uint64(int64(p) + d)))
		}
	}
	for _, x := range []float64{0, math.Copysign(0, -1), -1, math.Inf(1), math.Inf(-1), math.NaN(), math.MaxFloat64, math.SmallestNonzeroFloat64} {
		check(x)
	}
	t.Logf("square root: %d mismatches", bad)
	if bad > 0 {
		t.Fail()
	}
}
EOF

cd "$work"
GOARCH=amd64 go test -count=1 -run 'TestNative' -v . 2>&1 | grep -E 'kicks|square root|case [0-9]|fsqrt|^(ok|FAIL|---)'
