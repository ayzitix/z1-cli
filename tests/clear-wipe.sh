#!/usr/bin/env bash
# Clear wipe: `/new` and `/clear` reset the conversation, so they must also
# reset the screen. In a terminal (native scrollback) that is the `2J`/`3J` wipe
# plus a fresh banner; without a terminal nothing may be emitted at all.
#
# The UI only exists on a tty, so the destructive path is checked through a pty
# (tests/pty-run.py) and the plain path through a pipe.
set -u -o pipefail

TSX="${Z1_SDK_REPO:-$HOME/Projects/z1-sdk}/node_modules/.bin/tsx"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAT="$(cd "$HERE/.." && pwd)/chat.ts"
PTY="$HERE/pty-run.py"

if [ ! -x "$TSX" ]; then
  echo "FAIL: tsx not found at $TSX (set Z1_SDK_REPO)" >&2
  exit 1
fi
if [ ! -f "$CHAT" ]; then
  echo "FAIL: chat.ts not found at $CHAT" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 is required for the pty checks" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

repo="$tmp/repo"
mkdir -p "$repo"
git -C "$repo" init -q

env_args=(
  "Z1_MODEL=mock/mock-1"
  "Z1_MODULES_DIR=${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}"
)

# --- 1. a pipe has no screen: the commands must stay byte-free of escapes ----
cd "$repo" || exit 1
out="$tmp/pipe.out"
printf '/new\n/clear\n/exit\n' | env "${env_args[@]}" \
  "Z1_DB=$tmp/pipe.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
  "$TSX" "$CHAT" >"$out" 2>"$tmp/pipe.err" || {
  echo "FAIL: piped /new + /clear exited non-zero" >&2
  sed -n '1,20p' "$tmp/pipe.err" >&2
  exit 1
}
esc="$(grep -c $'\033' "$out" || true)"
if [ "$esc" != "0" ]; then
  echo "FAIL: piped /new + /clear wrote $esc lines with ESC bytes" >&2
  exit 1
fi
for needle in 'new conversation' 'already empty'; do
  if ! grep -q "$needle" "$out"; then
    echo "FAIL: piped run lost the '$needle' message" >&2
    sed -n '1,30p' "$out" >&2
    exit 1
  fi
done

printf '/new\n/clear\n/exit\n' >"$tmp/clear-input.txt"
printf '/exit\n' >"$tmp/exit-input.txt"

run_pty() { # out-file input-file extra-env...
  local out="$1" input="$2"
  shift 2
  ( cd "$repo" && PTY_INPUT_FILE="$input" python3 "$PTY" "$out" 70 \
      env "${env_args[@]}" "Z1_DB=$tmp/pty.db" "Z1_TOOLS_FILE=$tmp/tools.json" "$@" "$TSX" "$CHAT" ) || {
    echo "FAIL: pty run ($out) did not exit" >&2
    exit 1
  }
}

# --- 2. Z1_TRAY=off on a tty: the tail is inert, so no screen control at all ----
run_pty "$tmp/off-clear.raw" "$tmp/clear-input.txt" Z1_TRAY=off
run_pty "$tmp/off-exit.raw" "$tmp/exit-input.txt" Z1_TRAY=off
python3 - "$tmp/off-clear.raw" "$tmp/off-exit.raw" <<'PY' || exit 1
import re, sys
clear = open(sys.argv[1], 'rb').read()
base = open(sys.argv[2], 'rb').read()
# readline repaints the echoed command line (`ESC[1G`, `ESC[0J`, SGR), so the
# byte streams cannot be compared whole; what must never appear is the tail's
# screen control: a screen/scrollback erase, a row address, or a second reset of
# the scrolling region (the exit restore writes exactly one).
row = re.compile(rb'\x1b\[[0-9]+;[0-9]+H')
for name, data in (('with /new + /clear', clear), ('/exit only', base)):
    for bad in (b'\x1b[2J', b'\x1b[3J', b'\x1b[H'):
        if bad in data:
            raise SystemExit(f'Z1_TRAY=off on a tty: {name} wrote {bad!r}')
    address = row.search(data)
    if address is not None:
        raise SystemExit(f'Z1_TRAY=off on a tty: {name} addressed a row: {address.group()!r}')
    if data.count(b'\x1b[r') != 1:
        raise SystemExit(f'Z1_TRAY=off on a tty: {name} reset the scroll region {data.count(b"\x1b[r")} times')
PY

# --- 3. native scrollback: each command wipes screen + scrollback, reprints ----
# --- the banner, and only then prints its confirmation line -------------------
run_pty "$tmp/native.raw" "$tmp/clear-input.txt" Z1_PINNED=off
python3 - "$tmp/native.raw" <<'PY' || exit 1
import sys
data = open(sys.argv[1], 'rb').read()
wipe = b'\x1b[r\x1b[2J\x1b[3J\x1b[1;1H'
starts = []
index = data.find(wipe)
while index >= 0:
    starts.append(index)
    index = data.find(wipe, index + 1)
if len(starts) != 2:
    raise SystemExit(f'expected one wipe per command (2), found {len(starts)}')
segments = []
for number, start in enumerate(starts):
    end = starts[number + 1] if number + 1 < len(starts) else len(data)
    segments.append(data[start:end])
corner = b'\xe2\x94\x8c'  # box-drawing corner: the banner
startup = data.find(corner)
if startup < 0 or startup > starts[0]:
    raise SystemExit('the startup banner is missing before the first wipe')
for message, segment in (('new conversation', segments[0]), ('already empty', segments[1])):
    banner = segment.find(corner)
    text = segment.find(message.encode())
    if banner < 0:
        raise SystemExit(f'the banner was not reprinted after the wipe before "{message}"')
    if text < 0:
        raise SystemExit(f'"{message}" was not printed after the wipe')
    if banner > text:
        raise SystemExit(f'"{message}" was printed above the banner')
PY

# --- 4. pinned mode owns the alternate screen: `clear` must not disturb it ----
run_pty "$tmp/pinned.raw" "$tmp/clear-input.txt"
python3 - "$tmp/pinned.raw" <<'PY' || exit 1
import sys
data = open(sys.argv[1], 'rb').read()
for message in (b'new conversation', b'already empty'):
    if message not in data:
        raise SystemExit(f'pinned mode lost the "{message.decode()}" message')
if b'\x1b[?1049l' not in data:
    raise SystemExit('pinned mode did not leave the alternate screen on exit')
PY

# --- 5. a store that refuses to clear must leave the transcript on screen ----
# The wipe follows the transcript, not the intent: a failed `sessions.clear`
# leaves the messages on disk, so the chat that stayed must stay visible.
if [ "$(id -u)" = "0" ]; then
  echo "skip: run as root, a read-only session directory proves nothing"
else
  failrepo="$tmp/fail"
  mkdir -p "$failrepo"
  git -C "$failrepo" init -q
  printf 'hello\n/exit\n' | ( cd "$failrepo" && env "${env_args[@]}" \
    "Z1_DB=$tmp/fail-a.db" "Z1_TOOLS_FILE=$tmp/tools.json" "$TSX" "$CHAT" ) >/dev/null 2>&1
  session="$(find "$failrepo/z1/sessions" -maxdepth 1 -mindepth 1 -type d | head -1)"
  if [ -z "$session" ] || [ ! -f "$session/events.jsonl" ]; then
    echo "FAIL: the failing-store case could not create a session to protect" >&2
    exit 1
  fi
  chmod 555 "$session"
  printf '/sessions 1\n/clear\n/exit\n' >"$tmp/fail-input.txt"
  ( cd "$failrepo" && PTY_INPUT_FILE="$tmp/fail-input.txt" python3 "$PTY" "$tmp/fail.raw" 70 \
      env "${env_args[@]}" "Z1_DB=$tmp/fail-b.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
      Z1_PINNED=off "$TSX" "$CHAT" ) || {
    echo "FAIL: the failing-store pty run did not exit" >&2
    exit 1
  }
  chmod 755 "$session"
  python3 - "$tmp/fail.raw" "$session/events.jsonl" <<'PY' || exit 1
import os, sys
data = open(sys.argv[1], 'rb').read()
wipes = data.count(b'\x1b[2J')
if wipes != 1:
    # One wipe belongs to `/sessions 1`; `/clear` must not add a second.
    raise SystemExit(f'a failed /clear wiped the screen: {wipes} wipes, expected 1')
if b'could not clear' not in data:
    raise SystemExit('a failed /clear did not report the error')
if b'hello' not in data:
    raise SystemExit('a failed /clear removed the visible transcript')
if os.path.getsize(sys.argv[2]) == 0:
    raise SystemExit('the failed store clear emptied events.jsonl, so the case proved nothing')
PY
fi

echo "PASS: pipe stays escape-free, Z1_TRAY=off is inert on a tty, /new + /clear wipe screen+scrollback and reprint the banner, pinned mode intact, a failed store clear keeps the transcript visible"
