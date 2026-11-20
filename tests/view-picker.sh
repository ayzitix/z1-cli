#!/usr/bin/env bash
# The `/view` picker: bare `/view` opens three rows above the composer on a TTY
# and prints a numbered list otherwise. Enter applies the highlighted row,
# Escape closes without touching the file, and digits select directly.
#
# The pty harness (`tests/pty-run.py`) gained `@key NAME` so an arrow/Enter/Esc
# can be sent without the trailing `\r` that a normal input line carries.
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
  "Z1_WEB_AUTOSTART=off"
  "Z1_MODULES_DIR=${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}"
)

set_view() { # mode
  printf '{"schemaVersion":1,"mode":"%s"}\n' "$1" >"$tmp/view.json"
}

view_mode() {
  python3 - "$tmp/view.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))['mode'])
PY
}

run_pty() { # out input extra-env...
  local out="$1" input="$2"
  shift 2
  ( cd "$repo" && PTY_INPUT_FILE="$input" PTY_SIZE=24x80 PTY_SETTLE=2.0 PTY_GAP=0.5 \
      python3 "$PTY" "$out" 40 \
      env "${env_args[@]}" "Z1_VIEW_FILE=$tmp/view.json" \
      "Z1_DB=$tmp/run.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
      "Z1_PINNED=off" "$@" "$TSX" "$CHAT" ) || {
    echo "FAIL: pty run ($out) did not exit" >&2
    exit 1
  }
}

# --- 1. open /view, ↓, Enter: medium → full and a confirmation ---------------
set_view medium
printf '/view\n@key down\n@key enter\n/exit\n' >"$tmp/down-enter.txt"
run_pty "$tmp/down-enter.raw" "$tmp/down-enter.txt"
if [ "$(view_mode)" != "full" ]; then
  echo "FAIL: ↓ + Enter did not persist full (file has $(view_mode))" >&2
  exit 1
fi
python3 - "$tmp/down-enter.raw" <<'PY' || exit 1
import re, sys
text = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', open(sys.argv[1], 'rb').read()).decode('utf-8', 'replace')
for needle in ('view · medium', '⬢ medium', 'prose and errors only', 'same-family calls folded', 'every call and result', 'view · full'):
    if needle not in text:
        raise SystemExit(f'the picker frame lost {needle!r}')
PY

# --- 2. Esc closes without touching the file and prints no confirmation -----
set_view medium
printf '/view\n@key esc\n/exit\n' >"$tmp/esc.txt"
run_pty "$tmp/esc.raw" "$tmp/esc.txt"
if [ "$(view_mode)" != "medium" ]; then
  echo "FAIL: Esc changed the preference to $(view_mode)" >&2
  exit 1
fi
python3 - "$tmp/esc.raw" <<'PY' || exit 1
import re, sys
text = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', open(sys.argv[1], 'rb').read()).decode('utf-8', 'replace')
if 'prose and errors only' not in text:
    raise SystemExit('the picker never opened, so the Esc case proved nothing')
for confirmation in ('view · full', 'view · compact'):
    if confirmation in text:
        raise SystemExit(f'Esc still printed {confirmation!r}')
PY

# --- 3. `1` selects compact directly ---------------------------------------
set_view medium
printf '/view\n@key 1\n/exit\n' >"$tmp/one.txt"
run_pty "$tmp/one.raw" "$tmp/one.txt"
if [ "$(view_mode)" != "compact" ]; then
  echo "FAIL: the 1 key did not persist compact (file has $(view_mode))" >&2
  exit 1
fi
python3 - "$tmp/one.raw" <<'PY' || exit 1
import re, sys
text = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', open(sys.argv[1], 'rb').read()).decode('utf-8', 'replace')
if 'view · compact' not in text:
    raise SystemExit('the direct 1 selection printed no confirmation')
PY

# --- 3b. `f` selects full directly (the letter form, not just the digit) ----
set_view medium
printf '/view\n@key f\n/exit\n' >"$tmp/f.txt"
run_pty "$tmp/f.raw" "$tmp/f.txt"
if [ "$(view_mode)" != "full" ]; then
  echo "FAIL: the f key did not persist full (file has $(view_mode))" >&2
  exit 1
fi
python3 - "$tmp/f.raw" <<'PY' || exit 1
import re, sys
text = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', open(sys.argv[1], 'rb').read()).decode('utf-8', 'replace')
if 'view · full' not in text:
    raise SystemExit('the direct f selection printed no confirmation')
PY

# --- 4. a pipe prints the numbered list, no ESC, and `/view 2` selects ------
out="$tmp/pipe.out"
printf '/view\n/view 1\n/view 2\n/exit\n' | ( cd "$repo" && env "${env_args[@]}" \
  "Z1_VIEW=medium" "Z1_VIEW_FILE=$tmp/view.json" "Z1_TRAY=off" \
  "Z1_DB=$tmp/pipe.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
  "$TSX" "$CHAT" ) >"$out" 2>"$tmp/pipe.err" || {
  echo "FAIL: the piped /view run exited non-zero" >&2
  sed -n '1,20p' "$tmp/pipe.err" >&2
  exit 1
}
if [ "$(grep -c $'\033' "$out" || true)" != "0" ]; then
  echo "FAIL: the piped /view list wrote ESC bytes" >&2
  exit 1
fi
python3 - "$out" <<'PY' || exit 1
import sys
text = open(sys.argv[1], encoding='utf-8').read()
block = (
    'view · medium\n'
    '  1. compact   prose and errors only\n'
    '  2. medium    same-family calls folded; writes never folded\n'
    '  3. full      every call and result\n'
)
if block not in text:
    raise SystemExit(f'the numbered list was not printed verbatim:\n{text}')
for line in ('view · compact', 'view · medium'):
    if line not in text:
        raise SystemExit(f'the pipe lost the {line!r} confirmation')
PY
if [ "$(view_mode)" != "medium" ]; then
  echo "FAIL: /view 2 did not persist medium (file has $(view_mode))" >&2
  exit 1
fi

# --- 5. Z1_TRAY=off on a tty prints the same numbered list ------------------
set_view medium
printf '/view\n/exit\n' >"$tmp/tray-off.txt"
run_pty "$tmp/tray-off.raw" "$tmp/tray-off.txt" "Z1_TRAY=off"
python3 - "$tmp/tray-off.raw" <<'PY' || exit 1
import re, sys
text = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', open(sys.argv[1], 'rb').read()).decode('utf-8', 'replace')
text = text.replace('\r\n', '\n').replace('\r', '')
block = (
    'view · medium\n'
    '  1. compact   prose and errors only\n'
    '  2. medium    same-family calls folded; writes never folded\n'
    '  3. full      every call and result\n'
)
if block not in text:
    raise SystemExit(f'Z1_TRAY=off did not print the numbered list:\n{text}')
if '⬢ medium' in text:
    raise SystemExit('Z1_TRAY=off opened the picker instead of the list')
PY

echo "PASS: bare /view opens the three-row picker on a tty (↓+Enter applies and persists full), Esc leaves the file untouched, 1 selects compact, f selects full, and a pipe / Z1_TRAY=off print the numbered list with /view 1|2|3"
