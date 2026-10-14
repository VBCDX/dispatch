#!/bin/bash
# Fails if the runtime image filesystem listing (a `tar -tf` listing on stdin)
# ships a shell, interpreter or network client.
#
#   docker export "$container" | scripts/check-runtime-image.sh
#
# Fails closed: a failed export, an empty listing, or a listing without the
# app binary (a truncated export) is a failure, not a pass.
set -o pipefail

fslist=$(mktemp)
trap 'rm -f "$fslist"' EXIT
tar -tf - > "$fslist" || { echo "could not read the image filesystem listing"; exit 1; }

[ -s "$fslist" ] || { echo "empty filesystem listing; refusing to pass"; exit 1; }
grep -qx 'usr/local/bin/dispatch' "$fslist" || { echo "listing is incomplete: the app binary is missing"; exit 1; }

# (1) By class, not by name: nothing may live in an executable-search
# directory except the app binary, whatever it is called. Directory entries
# (trailing slash) are ignored.
bindirs='^(usr/)?(local/)?s?bin/|^busybox/'
extra=$(grep -E "$bindirs" "$fslist" | grep -vE '/$' | grep -vx 'usr/local/bin/dispatch' || true)
if [ -n "$extra" ]; then
  echo "runtime image ships unexpected executables in a bin directory:"
  echo "$extra"
  exit 1
fi

# (2) Tripwire by name, anywhere in the image: shells, interpreters and
# network clients under their common names.
names='sh|bash|ash|dash|zsh|ksh|csh|tcsh|fish|busybox|toybox|wget|curl|nc|ncat|netcat|socat|openssl|python[0-9.]*|perl|ruby|php|node'
if grep -Eq "(^|/)($names)\$" "$fslist"; then
  echo "runtime image ships a shell, interpreter or network client:"
  grep -E "(^|/)($names)\$" "$fslist"
  exit 1
fi
echo "no shell and no network client in the runtime image"
