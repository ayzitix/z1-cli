#!/usr/bin/env bash
# Density: the `/view` modes through the real console.
#
# Pipe half: the stock mock is enough to prove compact hides the tool row, full
# keeps today's rows, and a pipe never emits an escape byte.
#
# Pty half: the stock mock returns one tool call per assistant message, which
# cannot prove grouping. tests/fake-openai.py answers one assistant message with
# three `read` calls, so medium must fold them into one `Read 3 files` row and full
# must print all three.
set -u -o pipefail

TSX="${Z1_SDK_REPO:-$HOME/Projects/z1-sdk}/node_modules/.bin/tsx"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAT="$(cd "$HERE/.." && pwd)/chat.ts"
PTY="$HERE/pty-run.py"
FAKE="$HERE/fake-openai.py"

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
SERVER=""
FAIL_SERVER=""
cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null
  [ -n "$FAIL_SERVER" ] && kill "$FAIL_SERVER" 2>/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

env_args=(
  "Z1_MODEL=mock/mock-1"
  "Z1_WEB_AUTOSTART=off"
  "Z1_MODULES_DIR=${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}"
)

assert_no_esc() { # file label
  local esc
  esc="$(grep -c $'\033' "$1" || true)"
  if [ "$esc" != "0" ]; then
    echo "FAIL: $2 wrote $esc lines with ESC bytes" >&2
    exit 1
  fi
}

# --- 1. pipe + stock mock: compact hides the call, full keeps it ------------
repo="$tmp/repo"
mkdir -p "$repo"
git -C "$repo" init -q

cd "$repo" || exit 1

# --- 0. bare `/view` in a pipe is the numbered list; argument applies --------
printf '/view\n/view compact\n/view\n/exit\n' | env "${env_args[@]}" \
  "Z1_VIEW_FILE=$tmp/cmd-view.json" \
  "Z1_DB=$tmp/cmd.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
  "$TSX" "$CHAT" >"$tmp/cmd.out" 2>"$tmp/cmd.err" || {
  echo "FAIL: the /view command run exited non-zero" >&2
  sed -n '1,20p' "$tmp/cmd.err" >&2
  exit 1
}
assert_no_esc "$tmp/cmd.out" "the /view command"
python3 - "$tmp/cmd.out" <<'PY' || exit 1
import sys
text = open(sys.argv[1], encoding='utf-8').read()
full = (
    'view · full\n'
    '  1. compact   prose and errors only\n'
    '  2. medium    same-family calls folded; writes never folded\n'
    '  3. full      every call and result\n'
)
compact = (
    'view · compact\n'
    '  1. compact   prose and errors only\n'
    '  2. medium    same-family calls folded; writes never folded\n'
    '  3. full      every call and result\n'
)
if full not in text:
    raise SystemExit('bare /view did not print the numbered list for the pipe default')
if compact not in text:
    raise SystemExit('bare /view did not print the list after /view compact')
if text.count('view · compact\n') < 2:
    raise SystemExit('/view compact printed no confirmation line')
PY
if ! grep -q '"mode": "compact"' "$tmp/cmd-view.json"; then
  echo "FAIL: /view compact did not persist the preference" >&2
  cat "$tmp/cmd-view.json" >&2 2>/dev/null
  exit 1
fi

printf '[[tool:todo.read]]\n/exit\n' | env "${env_args[@]}" \
  "Z1_VIEW=compact" "Z1_VIEW_FILE=$tmp/view-compact.json" \
  "Z1_DB=$tmp/compact.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
  "$TSX" "$CHAT" >"$tmp/compact.out" 2>"$tmp/compact.err" || {
  echo "FAIL: piped compact run exited non-zero" >&2
  sed -n '1,20p' "$tmp/compact.err" >&2
  exit 1
}
assert_no_esc "$tmp/compact.out" "piped compact"
if grep -q '⬢ Todo' "$tmp/compact.out"; then
  echo "FAIL: compact printed the tool call" >&2
  exit 1
fi
if grep -q '  ⎿  ✓' "$tmp/compact.out"; then
  echo "FAIL: compact printed a tool success row" >&2
  exit 1
fi
for needle in '⬢ done' 'mock: done'; do
  if ! grep -q "$needle" "$tmp/compact.out"; then
    echo "FAIL: compact lost '$needle'" >&2
    sed -n '1,20p' "$tmp/compact.out" >&2
    exit 1
  fi
done

printf '[[tool:todo.read]]\n/exit\n' | env "${env_args[@]}" \
  "Z1_VIEW=full" "Z1_VIEW_FILE=$tmp/view-full.json" \
  "Z1_DB=$tmp/full.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
  "$TSX" "$CHAT" >"$tmp/full.out" 2>"$tmp/full.err" || {
  echo "FAIL: piped full run exited non-zero" >&2
  sed -n '1,20p' "$tmp/full.err" >&2
  exit 1
}
assert_no_esc "$tmp/full.out" "piped full"
for needle in '⬢ Todo' '  ⎿  ✓'; do
  if ! grep -qF "$needle" "$tmp/full.out"; then
    echo "FAIL: full lost '$needle'" >&2
    sed -n '1,20p' "$tmp/full.out" >&2
    exit 1
  fi
done

# Medium in a pipe is explicit; one call still renders its own name plus target.
printf '[[tool:todo.read]]\n/exit\n' | env "${env_args[@]}" \
  "Z1_VIEW=medium" "Z1_VIEW_FILE=$tmp/view-medium.json" \
  "Z1_DB=$tmp/medium.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
  "$TSX" "$CHAT" >"$tmp/medium.out" 2>"$tmp/medium.err" || {
  echo "FAIL: piped medium run exited non-zero" >&2
  sed -n '1,20p' "$tmp/medium.err" >&2
  exit 1
}
assert_no_esc "$tmp/medium.out" "piped medium"
if ! grep -q '⬢ Todo · ✓' "$tmp/medium.out"; then
  echo "FAIL: medium did not print one call line" >&2
  sed -n '1,20p' "$tmp/medium.out" >&2
  exit 1
fi

# --- 1b. `--once` rejects slash commands; Z1_VIEW is the only lever -------
( cd "$repo" && env "${env_args[@]}" "Z1_VIEW=compact" "Z1_TRAY=off" \
    "Z1_DB=$tmp/once-compact.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
    "$TSX" "$CHAT" --once '[[tool:todo.read]]' >"$tmp/once-compact.out" 2>"$tmp/once-compact.err" ) || {
  echo "FAIL: --once compact exited non-zero" >&2
  sed -n '1,20p' "$tmp/once-compact.err" >&2
  exit 1
}
assert_no_esc "$tmp/once-compact.out" "--once compact"
if grep -q '⬢ Todo' "$tmp/once-compact.out"; then
  echo "FAIL: --once compact printed the tool call" >&2
  exit 1
fi
if ! grep -q 'mock: done' "$tmp/once-compact.out"; then
  echo "FAIL: --once compact lost the answer" >&2
  exit 1
fi
( cd "$repo" && env "${env_args[@]}" "Z1_VIEW=full" "Z1_TRAY=off" \
    "Z1_DB=$tmp/once-full.db" "Z1_TOOLS_FILE=$tmp/tools.json" \
    "$TSX" "$CHAT" --once '[[tool:todo.read]]' >"$tmp/once-full.out" 2>"$tmp/once-full.err" ) || {
  echo "FAIL: --once full exited non-zero" >&2
  sed -n '1,20p' "$tmp/once-full.err" >&2
  exit 1
}
for needle in '⬢ Todo' '  ⎿  ✓'; do
  if ! grep -qF "$needle" "$tmp/once-full.out"; then
    echo "FAIL: --once full lost '$needle'" >&2
    sed -n '1,20p' "$tmp/once-full.out" >&2
    exit 1
  fi
done

# --- 2. fake provider: three reads in one assistant message ----------------
for file in a.txt b.txt c.txt; do
  printf '%s\n' "content of $file" >"$repo/$file"
done
printf 'read the three files\n/exit\n' >"$tmp/turn-input.txt"
printf '/sessions 1\n/exit\n' >"$tmp/replay-input.txt"

python3 "$FAKE" "$tmp/port" >"$tmp/fake.log" 2>&1 &
SERVER=$!
for _ in $(seq 1 100); do
  [ -s "$tmp/port" ] && break
  sleep 0.05
done
if [ ! -s "$tmp/port" ]; then
  echo "FAIL: the fake provider did not start" >&2
  sed -n '1,20p' "$tmp/fake.log" >&2
  exit 1
fi
PORT="$(cat "$tmp/port")"
FAKE_ENV=(
  "Z1_MODEL=fake/fake-1"
  "FAKE_API_KEY=x"
  "Z1_PROVIDERS=[{\"id\":\"fake\",\"envKey\":\"FAKE_API_KEY\",\"baseURL\":\"http://127.0.0.1:$PORT/v1\"}]"
  "Z1_WEB_AUTOSTART=off"
  "Z1_MODULES_DIR=${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}"
)

run_pty() { # repo out input mode db view-file
  local repo="$1" out="$2" input="$3" mode="$4" db="$5" view="$6"
  ( cd "$repo" && PTY_INPUT_FILE="$input" PTY_SIZE=24x80 python3 "$PTY" "$out" 70 \
      env "${FAKE_ENV[@]}" "Z1_VIEW=$mode" "Z1_VIEW_FILE=$view" \
      "Z1_PINNED=off" "Z1_DB=$db" "Z1_TOOLS_FILE=$tmp/fake-tools.json" \
      "$TSX" "$CHAT" ) || {
    echo "FAIL: pty run ($mode, $out) did not exit" >&2
    exit 1
  }
}

run_pty "$repo" "$tmp/medium.raw" "$tmp/turn-input.txt" medium "$tmp/fake-medium.db" "$tmp/fake-view-medium.json"
run_pty "$repo" "$tmp/full.raw" "$tmp/turn-input.txt" full "$tmp/fake-full.db" "$tmp/fake-view-full.json"
run_pty "$repo" "$tmp/compact.raw" "$tmp/turn-input.txt" compact "$tmp/fake-compact.db" "$tmp/fake-view-compact.json"

python3 - "$tmp/medium.raw" "$tmp/full.raw" "$tmp/compact.raw" <<'PY' || exit 1
import re
import sys

medium, full, compact = (open(path, 'rb').read() for path in sys.argv[1:4])

def clean(data):
    return re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', data).decode('utf-8', 'replace')

text = clean(medium)
if text.count('⬢ Read 3 files') != 1:
    raise SystemExit(f'medium: expected one committed "⬢ Read 3 files", found {text.count("⬢ Read 3 files")}')
if 'read({"path"' in text:
    raise SystemExit('medium printed a per-call row')
match = re.search(r'⬢ Read 3 files[^\n⬢⬡│]*', text)
if match is None or len(match.group(0)) > 80:
    raise SystemExit(f'medium: the group row did not fit 80 cells: {match.group(0) if match else None!r}')
if 'The three reads are done.' not in text:
    raise SystemExit('medium lost the model answer')
if '⬢ done' not in text:
    raise SystemExit('medium lost the terminal row')

text = clean(full)
if text.count('⬢ Read ') != 3:
    raise SystemExit(f'full: expected three per-call rows, found {text.count("⬢ read({\"path\"")}')
if '⬢ Read 3 files' in text:
    raise SystemExit('full folded a group')

text = clean(compact)
if '⬢ read' in text or 'read({"path"' in text or '  ⎿  ✓' in text:
    raise SystemExit('compact leaked a tool line')
if 'The three reads are done.' not in text or '⬢ done' not in text:
    raise SystemExit('compact lost the answer or the terminal row')
PY

# --- 3. a failed read closes its group, then the next call starts a new one --
failrepo="$tmp/failrepo"
mkdir -p "$failrepo"
git -C "$failrepo" init -q
printf 'alpha\n' >"$failrepo/a.txt"
printf 'gamma\n' >"$failrepo/c.txt"
printf 'read the three files\n/exit\n' >"$tmp/fail-input.txt"

python3 "$FAKE" "$tmp/fail-port" "$failrepo/missing.txt" >"$tmp/fail-server.log" 2>&1 &
FAIL_SERVER=$!
for _ in $(seq 1 100); do
  [ -s "$tmp/fail-port" ] && break
  sleep 0.05
done
FAIL_PORT="$(cat "$tmp/fail-port")"
( cd "$failrepo" && PTY_INPUT_FILE="$tmp/fail-input.txt" PTY_SIZE=24x80 python3 "$PTY" "$tmp/fail.raw" 70 \
    env Z1_VIEW=medium Z1_PINNED=off "Z1_MODEL=fake/fake-1" "FAKE_API_KEY=x" \
    "Z1_PROVIDERS=[{\"id\":\"fake\",\"envKey\":\"FAKE_API_KEY\",\"baseURL\":\"http://127.0.0.1:$FAIL_PORT/v1\"}]" \
    "Z1_VIEW_FILE=$tmp/fail-view.json" "Z1_DB=$tmp/fail.db" "Z1_TOOLS_FILE=$tmp/fail-tools.json" \
    "Z1_WEB_AUTOSTART=off" "Z1_MODULES_DIR=${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}" \
    "$TSX" "$CHAT" ) || {
  echo "FAIL: the failure pty run did not exit" >&2
  exit 1
}
python3 - "$tmp/fail.raw" <<'PY' || exit 1
import re
import sys
text = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', open(sys.argv[1], 'rb').read()).decode('utf-8', 'replace')
if '⬢ Read 2 files · ✗ 1' not in text:
    raise SystemExit('a failed call did not close its group with ✗ 1')
if '  ⎿  ✗ Read ·' not in text:
    raise SystemExit('the failure detail row is missing')
if 'read → c.txt' not in text:
    raise SystemExit('the call after the failure did not start a new group')
if '✓ 1' in text:
    raise SystemExit('the failure was folded into a later success line')
PY

# --- 4. replay honours the current mode -------------------------------------
# The first full turn created a session in $repo; reopen it under each mode.
run_pty "$repo" "$tmp/replay-medium.raw" "$tmp/replay-input.txt" medium "$tmp/replay-medium.db" "$tmp/replay-view-medium.json"
run_pty "$repo" "$tmp/replay-compact.raw" "$tmp/replay-input.txt" compact "$tmp/replay-compact.db" "$tmp/replay-view-compact.json"
run_pty "$repo" "$tmp/replay-full.raw" "$tmp/replay-input.txt" full "$tmp/replay-full.db" "$tmp/replay-view-full.json"

python3 - "$tmp/replay-medium.raw" "$tmp/replay-compact.raw" "$tmp/replay-full.raw" <<'PY' || exit 1
import re
import sys
medium, compact, full = (open(path, 'rb').read() for path in sys.argv[1:4])

def clean(data):
    return re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', data).decode('utf-8', 'replace')

text = clean(medium)
if '⬢ Read 3 files' not in text:
    raise SystemExit('medium replay did not group the stored calls')
if '⬢ Read 3 files · ✓' in text:
    raise SystemExit('medium replay claimed a result the stored message does not carry')

text = clean(compact)
if 'read({"path"' in text or '⬢ read' in text:
    raise SystemExit('compact replay printed a stored call')

text = clean(full)
if text.count('⬢ Read ') != 3:
    raise SystemExit(f'full replay expected three stored call rows, found {text.count("⬢ read({\"path\"")}')
PY

echo "PASS: pipe compact hides calls, full keeps them, medium groups; --once honours Z1_VIEW; pty medium folds three reads, full prints three, compact hides them; failure closes its group; replay honours the mode"
