#!/usr/bin/env bash
# Exit restore: whichever way the console ends, it must give the terminal back.
# Pinned mode owns the alternate screen and enables mouse tracking, so every
# exit path — `/exit`, Ctrl-D, Ctrl-C twice, SIGTERM, SIGHUP — has to emit
# `?1049l` and `?1000l`. The signal paths are the interesting ones: they call
# `process.exit()` and skip the normal `finally`.
#
# Driven through a pty (tests/pty-run.py); a pipe never enters the alternate
# screen, so a byte-free pipe is already covered by clear-wipe.sh.
set -u -o pipefail

TSX="${Z1_SDK_REPO:-$HOME/Projects/z1-sdk}/node_modules/.bin/tsx"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAT="$(cd "$HERE/.." && pwd)/chat.ts"
PTY="$HERE/pty-run.py"

if [ ! -x "$TSX" ]; then
  echo "FAIL: tsx not found at $TSX (set Z1_SDK_REPO)" >&2
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
  "Z1_WEB_AUTOSTART=off"
  "Z1_MODULES_DIR=${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}"
)

run_pty() { # out-file input-file
  local out="$1" input="$2"
  ( cd "$repo" && PTY_INPUT_FILE="$input" python3 "$PTY" "$out" 40 \
      env "${env_args[@]}" "Z1_DB=$tmp/pty.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
      "$TSX" "$CHAT" ) || {
    echo "FAIL: pty run ($out) did not exit" >&2
    exit 1
  }
}

# `?1049h` proves the app took the screen; the close sequence must come after it.
assert_restored() { # raw-file label
  python3 - "$1" "$2" <<'PY' || exit 1
import sys
data = open(sys.argv[1], 'rb').read()
label = sys.argv[2]
entered = data.find(b'\x1b[?1049h')
if entered < 0:
    raise SystemExit(f'{label}: the app never entered the alternate screen')
if b'\x1b[?1000h' not in data:
    raise SystemExit(f'{label}: the app never enabled mouse tracking')
for seq in (b'\x1b[?1049l', b'\x1b[?1000l'):
    at = data.find(seq, entered)
    if at < 0:
        raise SystemExit(f'{label}: {seq!r} was not emitted after entering')
for seq in (b'\x1b[?2004l', b'\x1b[?25h'):
    if data.find(seq, entered) < 0:
        raise SystemExit(f'{label}: {seq!r} was not emitted after entering')
PY
}

printf '/exit\n' >"$tmp/exit-input.txt"
printf '\x04\n' >"$tmp/ctrl-d-input.txt"
printf '\x03\n\x03\n' >"$tmp/ctrl-c-input.txt"
printf '@signal TERM\n' >"$tmp/term-input.txt"
printf '@signal HUP\n' >"$tmp/hup-input.txt"

run_pty "$tmp/exit.raw" "$tmp/exit-input.txt"
assert_restored "$tmp/exit.raw" '/exit'

run_pty "$tmp/ctrl-d.raw" "$tmp/ctrl-d-input.txt"
assert_restored "$tmp/ctrl-d.raw" 'Ctrl-D'

run_pty "$tmp/ctrl-c.raw" "$tmp/ctrl-c-input.txt"
assert_restored "$tmp/ctrl-c.raw" 'Ctrl-C twice'

run_pty "$tmp/term.raw" "$tmp/term-input.txt"
assert_restored "$tmp/term.raw" 'SIGTERM'

run_pty "$tmp/hup.raw" "$tmp/hup-input.txt"
assert_restored "$tmp/hup.raw" 'SIGHUP'

echo "PASS: /exit, Ctrl-D, Ctrl-C twice, SIGTERM and SIGHUP all leave the alternate screen and disable mouse tracking"
