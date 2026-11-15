#!/usr/bin/env bash
# Session smoke: save a transcript in a temp git repo, list/switch it, and
# assert the repository stays clean. A second temp repo proves `--once` does not
# create a session. Nothing here touches the real config, DB or sessions.
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

env_args=(
  "Z1_MODEL=mock/mock-1"
  "Z1_PINNED=off"
  "Z1_TRAY=off"
  "Z1_MODULES_DIR=${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}"
)

run_chat() {
  local repo="$1" db="$2" input="$3"
  printf '%s' "$input" | (cd "$repo" && env "${env_args[@]}" "Z1_DB=$db" "$TSX" "$CHAT")
}

run_once() {
  local repo="$1" db="$2"
  (cd "$repo" && env "${env_args[@]}" "Z1_DB=$db" "$TSX" "$CHAT" --once "hi")
}

repo="$tmp/repo"
mkdir -p "$repo"
git -C "$repo" init -q

# One turn creates the session file; the repository must stay clean because
# the store adds z1/ to .git/info/exclude.
run_chat "$repo" "$tmp/runs-a.db" $'hello\n/exit\n' >"$tmp/a.out" 2>"$tmp/a.err" || {
  echo "FAIL: first session run exited non-zero" >&2
  sed -n '1,20p' "$tmp/a.err" >&2
  exit 1
}
if ! find "$repo/z1/sessions" -name events.jsonl -print -quit | grep -q .; then
  echo "FAIL: no session was saved" >&2
  exit 1
fi
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "FAIL: z1/ dirtied git status" >&2
  git -C "$repo" status --porcelain >&2
  exit 1
fi

# The same session is listed, selected, and appended to.
run_chat "$repo" "$tmp/runs-b.db" $'/sessions\n/sessions 1\nsecond\n/exit\n' >"$tmp/b.out" 2>"$tmp/b.err" || {
  echo "FAIL: resume run exited non-zero" >&2
  sed -n '1,20p' "$tmp/b.err" >&2
  exit 1
}
if ! grep -q 'sessions · 1 session' "$tmp/b.out"; then
  echo "FAIL: /sessions did not list the saved session" >&2
  sed -n '1,30p' "$tmp/b.out" >&2
  exit 1
fi

python3 - "$repo" <<'PY'
import glob, json, sys
metas = glob.glob(sys.argv[1] + '/z1/sessions/*/meta.json')
if len(metas) != 1:
    raise SystemExit(f'expected one session, found {len(metas)}')
meta = json.load(open(metas[0]))
if meta.get('messageCount') != 4:
    raise SystemExit(f'expected 4 saved messages, found {meta.get("messageCount")}')
events = open(metas[0].replace('meta.json', 'events.jsonl')).read().splitlines()
if len(events) != 4:
    raise SystemExit(f'expected 4 event lines, found {len(events)}')
PY
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "FAIL: resume dirtied git status" >&2
  exit 1
fi

# `--once` is a one-liner and must not leave a z1/ directory.
once="$tmp/once"
mkdir -p "$once"
git -C "$once" init -q
run_once "$once" "$tmp/runs-c.db" >/dev/null 2>&1 || true
if [ -e "$once/z1" ]; then
  echo "FAIL: --once created z1/" >&2
  exit 1
fi

echo "PASS: sessions save, list, resume, stay out of git; --once leaves no z1/"
