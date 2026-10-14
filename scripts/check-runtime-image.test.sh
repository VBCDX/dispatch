#!/bin/bash
# Self-test for check-runtime-image.sh, run in CI. Feeds synthetic image
# listings (real tar streams) to the guard and checks pass/fail.
set -u
here=$(cd "$(dirname "$0")" && pwd)
guard="$here/check-runtime-image.sh"
fails=0

mk() { # whitespace-separated entries on stdin -> tar stream on stdout
  python3 -c "
import sys, tarfile
t = tarfile.open(fileobj=sys.stdout.buffer, mode='w|')
for l in sys.stdin.read().split():
    ti = tarfile.TarInfo(l)
    ti.type = tarfile.DIRTYPE if l.endswith('/') else tarfile.REGTYPE
    t.addfile(ti)
t.close()"
}

BASE="etc/ usr/ usr/local/ usr/local/bin/ usr/local/bin/dispatch data/ etc/ssl/certs/ca-certificates.crt"

check() { # label, want-rc, entries
  local label=$1 want=$2 entries=$3 rc
  echo "$entries" | mk | "$guard" >/dev/null 2>&1; rc=$?
  if [ "$rc" = "$want" ]; then echo "ok   $label"; else echo "FAIL $label (rc=$rc, want $want)"; fails=$((fails+1)); fi
}

check "clean distroless image"                      0 "$BASE"
check "bin/sh"                                      1 "$BASE bin/sh"
check "zsh under usr/bin (name outside old list)"   1 "$BASE usr/bin/zsh"
check "ksh outside any bin dir (name tripwire)"     1 "$BASE opt/tools/ksh"
check "toybox"                                      1 "$BASE opt/toybox"
check "fish outside any bin dir (widened list)"     1 "$BASE opt/tools/fish"
check "nc outside any bin dir (widened list)"       1 "$BASE usr/lib/nc"
check "openssl outside any bin dir (widened list)"  1 "$BASE opt/ssl/openssl"
check "renamed binary in bin dir (class check)"     1 "$BASE usr/local/bin/mytool"
check "busybox dir"                                 1 "$BASE busybox/anything"
check "sbin entry"                                  1 "$BASE usr/sbin/anything"
check "empty listing"                               1 ""
check "app binary missing (truncated listing)"     1 "etc/ data/"

# A failed export must fail the guard even when tar can parse what arrived.
(echo "$BASE" | mk | head -c 1024; exit 1) | "$guard" >/dev/null 2>&1
rc=$?; if [ "$rc" = 1 ]; then echo "ok   truncated tar stream"; else echo "FAIL truncated tar stream (rc=$rc)"; fails=$((fails+1)); fi

[ "$fails" = 0 ] || { echo "$fails check(s) failed"; exit 1; }
echo "all runtime-image guard checks passed"
