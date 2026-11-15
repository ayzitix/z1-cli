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
  # No SearXNG provisioning in a test: the default would download ~120 MB.
  "Z1_WEB_AUTOSTART=off"
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

# Remember the session before /clear: the command must keep its directory and
# its name, and only the turns may go.
python3 - "$repo" "$tmp/before.json" <<'PY'
import glob, json, sys
metas = glob.glob(sys.argv[1] + '/z1/sessions/*/meta.json')
meta = json.load(open(metas[0]))
json.dump({'id': meta['id'], 'name': meta['name']}, open(sys.argv[2], 'w'))
PY

# /clear empties a 4-message session in place: 1 session, messageCount 0,
# events.jsonl 0 bytes, name unchanged.
run_chat "$repo" "$tmp/runs-d.db" $'/sessions 1\n/clear\n/exit\n' >"$tmp/d.out" 2>"$tmp/d.err" || {
  echo "FAIL: /clear run exited non-zero" >&2
  sed -n '1,20p' "$tmp/d.err" >&2
  exit 1
}
for needle in 'cleared' 'same session'; do
  if ! grep -q "$needle" "$tmp/d.out"; then
    echo "FAIL: /clear output missing '$needle'" >&2
    sed -n '1,30p' "$tmp/d.out" >&2
    exit 1
  fi
done
python3 - "$repo" "$tmp/before.json" <<'PY'
import glob, json, os, sys
before = json.load(open(sys.argv[2]))
metas = glob.glob(sys.argv[1] + '/z1/sessions/*/meta.json')
if len(metas) != 1:
    raise SystemExit(f'after /clear expected one session, found {len(metas)}')
meta = json.load(open(metas[0]))
if meta['id'] != before['id']:
    raise SystemExit(f"/clear changed the id: {before['id']} -> {meta['id']}")
if meta['name'] != before['name']:
    raise SystemExit(f"/clear changed the name: {before['name']!r} -> {meta['name']!r}")
if meta.get('messageCount') != 0:
    raise SystemExit(f"expected messageCount 0, found {meta.get('messageCount')}")
events = metas[0].replace('meta.json', 'events.jsonl')
size = os.path.getsize(events)
if size != 0:
    raise SystemExit(f'expected events.jsonl to be 0 bytes, found {size}')
PY
if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "FAIL: /clear dirtied git status" >&2
  exit 1
fi

# The next prompt after /clear appends to the same session again.
run_chat "$repo" "$tmp/runs-e.db" $'/sessions 1\nthird\n/exit\n' >"$tmp/e.out" 2>"$tmp/e.err" || {
  echo "FAIL: post-clear resume exited non-zero" >&2
  sed -n '1,20p' "$tmp/e.err" >&2
  exit 1
}
python3 - "$repo" "$tmp/before.json" <<'PY'
import glob, json, sys
before = json.load(open(sys.argv[2]))
metas = glob.glob(sys.argv[1] + '/z1/sessions/*/meta.json')
if len(metas) != 1:
    raise SystemExit(f'after post-clear prompt expected one session, found {len(metas)}')
meta = json.load(open(metas[0]))
if meta['id'] != before['id']:
    raise SystemExit(f"post-clear prompt moved to {meta['id']}, expected {before['id']}")
if meta.get('messageCount') != 2:
    raise SystemExit(f'expected messageCount 2 after one prompt, found {meta.get("messageCount")}')
PY

# /new drops the live transcript and creates an unnamed session with the next
# prompt: the old one keeps its count, and the prompt is not used as the name.
prompt='a prompt that must never become the session name, not even its first part'
input=$'/new\n'"$prompt"$'\n/exit\n'
run_chat "$repo" "$tmp/runs-f.db" "$input" >"$tmp/f.out" 2>"$tmp/f.err" || {
  echo "FAIL: /new run exited non-zero" >&2
  sed -n '1,20p' "$tmp/f.err" >&2
  exit 1
}
python3 - "$repo" "$tmp/before.json" "$prompt" <<'PY'
import glob, json, re, sys
before = json.load(open(sys.argv[2]))
prompt = sys.argv[3]
metas = glob.glob(sys.argv[1] + '/z1/sessions/*/meta.json')
if len(metas) != 2:
    raise SystemExit(f'after /new expected two sessions, found {len(metas)}')
rows = [json.load(open(path)) for path in metas]
ids = {row['id'] for row in rows}
if len(ids) != 2:
    raise SystemExit(f'expected different ids, found {sorted(ids)}')
old = next((row for row in rows if row['id'] == before['id']), None)
new = next((row for row in rows if row['id'] != before['id']), None)
if old is None or new is None:
    raise SystemExit('/new lost the previous session or reused it')
if old.get('messageCount') != 2:
    raise SystemExit(f"old session count changed: {old.get('messageCount')} != 2")
if new.get('messageCount') != 2:
    raise SystemExit(f"expected new session to hold 2 messages, found {new.get('messageCount')}")
fallback = re.sub(r'\s+', ' ', prompt).strip()[:60]
if new['name'] == fallback:
    raise SystemExit(f"the first prompt became the session name: {new['name']!r}")
PY

# /clear with no session at all says so and creates no session directory.
empty="$tmp/empty"
mkdir -p "$empty"
git -C "$empty" init -q
run_chat "$empty" "$tmp/runs-g.db" $'/clear\n/exit\n' >"$tmp/g.out" 2>"$tmp/g.err" || {
  echo "FAIL: empty /clear run exited non-zero" >&2
  sed -n '1,20p' "$tmp/g.err" >&2
  exit 1
}
if ! grep -q 'already empty' "$tmp/g.out"; then
  echo "FAIL: /clear with no session did not say 'already empty'" >&2
  sed -n '1,30p' "$tmp/g.out" >&2
  exit 1
fi
if [ -d "$empty/z1/sessions" ] && find "$empty/z1/sessions" -name meta.json -print -quit | grep -q .; then
  echo "FAIL: /clear with no session created a session directory" >&2
  find "$empty/z1/sessions" -name meta.json >&2
  exit 1
fi

# A turn is read at one transcript generation and saved at the end of the run.
# If another z1 process clears the conversation in between, that save must be
# refused rather than resurrecting the cleared turns — this is the guard the
# CLI's autosave relies on. The real race (two processes, one turn) cannot be
# timed from a shell, so the guard is driven directly with saveTurn's own calls:
# append at the generation the handle was read at, clear from "the other
# process", then re-offer the stale transcript.
SDK="${Z1_SDK_REPO:-$HOME/Projects/z1-sdk}"
guard="$tmp/guard"
mkdir -p "$guard"
git -C "$guard" init -q
cat >"$tmp/generation-guard.mts" <<MTS
import {
  SessionClearedError,
  createSessionStore,
} from '$SDK/z1/packages/session/src/index.ts'

const cwd = process.argv[2]
if (cwd === undefined) throw new Error('usage: generation-guard.mts <cwd>')
const store = createSessionStore({ cwd, env: process.env })
const created = store.create({
  name: 'generation guard',
  cwd,
  model: { provider: 'mock', model: 'mock-1' },
  contextWindow: 1000,
  maxSteps: 4,
})
const id = created.meta.id
const first = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
]
store.appendTurn(id, first, { runId: 'run_a', generation: 0 })
const saved = store.load(id)
if (saved === undefined || saved.messages.length !== 2) throw new Error('first turn did not save')
if ((saved.meta.generation ?? 0) !== 0) throw new Error('an ordinary save advanced the generation')

// "the other process": the same id, emptied while this handle still holds 0.
store.clear(id)
const cleared = store.load(id)
if (cleared === undefined) throw new Error('clear dropped the session')
if ((cleared.meta.generation ?? 0) !== 1) throw new Error('clear did not advance the generation')
if (cleared.messages.length !== 0) throw new Error('clear left messages behind')

const stale = [
  ...first,
  { role: 'user', content: 'second question' },
  { role: 'assistant', content: 'second answer' },
]
let rejected: SessionClearedError | undefined
try {
  store.appendTurn(id, stale, { runId: 'run_b', generation: 0 })
} catch (error) {
  if (!(error instanceof SessionClearedError)) throw error
  rejected = error
}
if (rejected === undefined) throw new Error('a stale append resurrected the cleared transcript')
if (rejected.id !== id) throw new Error('SessionClearedError named ' + rejected.id)
if (rejected.generation !== 1) throw new Error('SessionClearedError reported generation ' + rejected.generation)
const afterStale = store.load(id)
if (afterStale === undefined || afterStale.messages.length !== 0) {
  throw new Error('the rejected turn was written to disk anyway')
}

// What saveTurn does next: reload, then the next prompt saves at the new
// generation — from ord 0, not on top of the cleared turns.
const reloaded = store.load(id)
if (reloaded === undefined) throw new Error('reload after a clear returned nothing')
store.appendTurn(id, first, { runId: 'run_c', generation: reloaded.meta.generation ?? 0 })
const final = store.load(id)
if (final === undefined || final.messages.length !== 2) throw new Error('the reloaded handle could not append')
if (final.messages[0]?.content !== 'first question') throw new Error('the reloaded append did not start at ord 0')
console.log('generation guard ok')
MTS
if ! (cd "$guard" && "$TSX" "$tmp/generation-guard.mts" "$guard" >"$tmp/guard.out" 2>"$tmp/guard.err"); then
  echo "FAIL: the generation guard did not reject a stale append" >&2
  sed -n '1,20p' "$tmp/guard.err" >&2
  exit 1
fi
for needle in \
  'generation: session.meta.generation ?? 0' \
  'error instanceof SessionClearedError' \
  'this conversation was cleared elsewhere'; do
  if ! grep -qF "$needle" "$CHAT"; then
    echo "FAIL: chat.ts no longer guards the autosave with the generation ('$needle')" >&2
    exit 1
  fi
done

# `--once` is a one-liner and must not leave a z1/ directory.
once="$tmp/once"
mkdir -p "$once"
git -C "$once" init -q
run_once "$once" "$tmp/runs-c.db" >/dev/null 2>&1 || true
if [ -e "$once/z1" ]; then
  echo "FAIL: --once created z1/" >&2
  exit 1
fi

echo "PASS: sessions save, list, resume, /clear in place, /new unnamed, a stale turn is refused after a concurrent clear, stay out of git; --once leaves no z1/"
