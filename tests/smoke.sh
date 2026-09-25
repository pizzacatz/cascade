#!/usr/bin/env bash
# Headless smoke test for the Cascade Linux build.
#
# Launches the installed binary under Xvfb with the sample .col fixture and
# verifies that the process survives startup and maps a window. This catches
# the common packaging failures (missing shared libraries, WebKitGTK not
# loading, a panic on boot). It also checks that the CLI answers --version
# without starting the GUI.
#
# Usage: tests/smoke.sh <bundles-dir> <output-dir>
set -uo pipefail

OUT_DIR="${2:-smoke-out}"
mkdir -p "$OUT_DIR"

BIN="$(command -v cascade || true)"
if [[ -z "$BIN" ]]; then
  for cand in /usr/bin/cascade /usr/local/bin/cascade; do
    [[ -x "$cand" ]] && BIN="$cand" && break
  done
fi
if [[ -z "$BIN" ]]; then
  echo "FAIL: cascade binary not found on PATH or in standard locations" >&2
  exit 1
fi
echo "Using binary: $BIN"

if ! "$BIN" --version | grep -q '^cascade '; then
  echo "FAIL: 'cascade --version' did not print a version" >&2
  exit 1
fi

FIXTURE="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures/sample.col"
WORK_FIXTURE="$OUT_DIR/sample.col"
cp "$FIXTURE" "$WORK_FIXTURE"

export DISPLAY=":99"
Xvfb "$DISPLAY" -screen 0 1600x1000x24 >"$OUT_DIR/xvfb.log" 2>&1 &
XVFB_PID=$!
# A session bus lets the single-instance plugin initialise.
eval "$(dbus-launch --sh-syntax)"
sleep 2

APP_PID=""
cleanup() {
  [[ -n "$APP_PID" ]] && kill "$APP_PID" 2>/dev/null
  kill "$XVFB_PID" 2>/dev/null
  [[ -n "${DBUS_SESSION_BUS_PID:-}" ]] && kill "$DBUS_SESSION_BUS_PID" 2>/dev/null
}
trap cleanup EXIT

echo "Launching Cascade with fixture $WORK_FIXTURE"
"$BIN" "$WORK_FIXTURE" >"$OUT_DIR/app.log" 2>&1 &
APP_PID=$!

# The window starts hidden and is shown once the frontend has painted.
WINDOW_FOUND=0
for i in $(seq 1 20); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "FAIL: process exited during startup (see app.log)" >&2
    cat "$OUT_DIR/app.log" >&2
    exit 1
  fi
  if xdotool search --onlyvisible --name "Cascade" >/dev/null 2>&1; then
    WINDOW_FOUND=1
    echo "Window mapped after ${i}s"
    break
  fi
  sleep 1
done

import -window root "$OUT_DIR/screenshot.png" 2>/dev/null || \
  xwd -root -out "$OUT_DIR/screenshot.xwd" 2>/dev/null || true

if [[ "$WINDOW_FOUND" -ne 1 ]]; then
  echo "FAIL: no visible Cascade window appeared within 20s" >&2
  cat "$OUT_DIR/app.log" >&2
  exit 1
fi

sleep 3
if ! kill -0 "$APP_PID" 2>/dev/null; then
  echo "FAIL: process died shortly after mapping its window" >&2
  cat "$OUT_DIR/app.log" >&2
  exit 1
fi

echo "PASS: Cascade launched, mapped a window, and stayed alive."
