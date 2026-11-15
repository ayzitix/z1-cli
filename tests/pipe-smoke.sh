#!/usr/bin/env bash
# Pipe smoke: run the real console non-interactively (`/tools`, `/exit`) against
# a temp DB and a temp tools.json, and assert the session exits cleanly with no
# terminal escapes on stdout. Nothing here touches the real config or DB.
set -u -o pipefail

TSX="${Z1_SDK_REPO:-$HOME/Projects/z1-sdk}/node_modules/.bin/tsx"
CHAT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/chat.ts"

if [ ! -x "$TSX" ]; then
  echo "FAIL: tsx not found at $TSX (set Z1_SDK_REPO)" >&2
  exit 1
fi
if [ ! -f "$CHAT" ]; then
  echo "FAIL: chat.ts not found at $CHAT" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

out="$tmp/stdout.txt"
err="$tmp/stderr.txt"

# Run from the temp dir so a repository config or workspace files can leak in.
cd "$tmp" || exit 1
# The second line is a prompt, not an argument: a command on the first line runs,
# and the rest of the submission is what the model is asked.
printf '/tools\nhi\n/exit\n' | env \
  Z1_DB="$tmp/runs.db" \
  Z1_TOOLS_FILE="$tmp/tools.json" \
  Z1_MODEL=mock/mock-1 \
  Z1_PINNED=off \
  Z1_TRAY=off \
  Z1_WEB_AUTOSTART=off \
  Z1_MODULES_DIR="${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}" \
  "$TSX" "$CHAT" >"$out" 2>"$err"
code=$?

if [ "$code" -ne 0 ]; then
  echo "FAIL: chat exited $code" >&2
  sed -n '1,20p' "$err" >&2
  exit 1
fi

esc="$(grep -c $'\033' "$out" || true)"
if [ "$esc" != "0" ]; then
  echo "FAIL: stdout contains $esc lines with ESC bytes (piped output must be plain)" >&2
  exit 1
fi

if ! grep -q 'tools ·' "$out"; then
  echo "FAIL: /tools printed no 'tools ·' summary" >&2
  sed -n '1,20p' "$out" >&2
  exit 1
fi

# The line under the command is the prompt: without the split it was read as an
# argument to `/tools` and never reached a turn.
if ! grep -q 'mock: hi' "$out"; then
  echo "FAIL: the prompt under /tools was not sent as a turn" >&2
  sed -n '1,40p' "$out" >&2
  exit 1
fi

# An unknown command is still reported as unknown, and the text under it is still
# sent: the console says what it did with the second half instead of dropping it.
out2="$tmp/stdout2.txt"
err2="$tmp/stderr2.txt"
printf '/foo\nhi\n/exit\n' | env \
  Z1_DB="$tmp/runs2.db" \
  Z1_TOOLS_FILE="$tmp/tools2.json" \
  Z1_MODEL=mock/mock-1 \
  Z1_PINNED=off \
  Z1_TRAY=off \
  Z1_WEB_AUTOSTART=off \
  Z1_MODULES_DIR="${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}" \
  "$TSX" "$CHAT" >"$out2" 2>"$err2"
code2=$?

if [ "$code2" -ne 0 ]; then
  echo "FAIL: chat exited $code2 on an unknown command" >&2
  sed -n '1,20p' "$err2" >&2
  exit 1
fi
if [ "$(grep -c $'\033' "$out2" || true)" != "0" ]; then
  echo "FAIL: unknown-command run wrote ESC bytes" >&2
  exit 1
fi
if ! grep -q 'unknown command /foo' "$out2"; then
  echo "FAIL: /foo was not reported as an unknown command" >&2
  sed -n '1,20p' "$out2" >&2
  exit 1
fi
if ! grep -q 'mock: hi' "$out2"; then
  echo "FAIL: the text under an unknown command was not sent as a prompt" >&2
  sed -n '1,40p' "$out2" >&2
  exit 1
fi

echo "PASS: pipe smoke (exit 0, no ESC bytes, 'tools ·' and the prompt under it, unknown command keeps its prompt)"
