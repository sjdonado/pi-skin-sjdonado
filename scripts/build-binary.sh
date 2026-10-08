#!/usr/bin/env sh
# Builds self-contained pi binaries for one Bun target (default: this machine).
# A future release pipeline runs this once per architecture and publishes bin/pi-*.
# Needs: bun. Produces bin/pi-<os>-<arch> and bin/pi-worker-<os>-<arch>.
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TARGET="${PI_BUILD_TARGET:-}"
if [ -z "$TARGET" ]; then
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$ARCH" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; esac
  TARGET="bun-${OS}-${ARCH}"
fi
SUFFIX="${TARGET#bun-}"
BUN_BUILD_TARGET="$TARGET" BUN_BUILD_OUTFILE="$DIR/bin/pi-$SUFFIX" bun -e '
  const r = await Bun.build({ entrypoints: ["./main.ts", "./codemode-worker.ts"],
    compile: { outfile: process.env.BUN_BUILD_OUTFILE, target: process.env.BUN_BUILD_TARGET } });
  if (!r.success) { for (const log of r.logs) console.error(String(log)); process.exit(1); }
'
bun build --compile --target="$TARGET" "$DIR/process-worker.ts" --outfile "$DIR/bin/pi-worker-$SUFFIX"
ls -la "$DIR/bin/pi-$SUFFIX" "$DIR/bin/pi-worker-$SUFFIX"
