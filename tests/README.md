# z1 CLI tests

Sixteen dependency-free checks: no test framework, no external network, nothing
installed — and deliberately **not** a full CLI suite. The density pty case
starts a loopback OpenAI-compatible server in `tests/fake-openai.py`.

Prerequisites: `z1-sdk` at `~/Projects/z1-sdk` (or `Z1_SDK_REPO`), Node 24.9+,
`git` for the session smoke, `python3` for the pty checks,
and for the smokes an installed `com.z1.tools` in
`${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}`.
The smokes set `Z1_WEB_AUTOSTART=off`, so a test run never downloads SearXNG.

From the repo root:
```bash
~/Projects/z1-sdk/node_modules/.bin/tsx tests/web-service.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/tool-state.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/tool-inventory.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/workspace-state.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/session-root.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/input.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/output.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/width.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/view.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/view-prefs.test.mts
tests/pipe-smoke.sh
tests/session-smoke.sh
tests/clear-wipe.sh
tests/sigterm-restore.sh
tests/view-density.sh
tests/view-picker.sh
```

`web-service.test.mts`: `~`/`Z1_WEB_DIR`/`XDG_DATA_HOME` resolution against the
environment's `HOME`, the settings template (secret, loopback, `json` format, the
pinned engine set), the health probe and its deadline, pid-file staleness, the
install lock on a web dir that does not exist yet, `external`/`disabled`/
`stopped`, and the `Z1_SEARX_STATE` hint the web module reads. Every request goes
to an ephemeral local server: it never touches 8888 or the network.

It also covers process identity (`searxng.json`, `/proc` start time and cmdline),
stop refusal for a recycled pid, the live-owner lock rule (a live pid holds the
lock however old the file looks, while a dead one is stale at once), log rotation
at 5 MB with one generation kept, tarball SHA-256 verification, the download
timeout, and the no-hang guarantee for `--once`. On the ownership side, `up` is
published only for a verified pid while a stranger's healthy listener leaves the
hint unset, and a verified start that times out writes a failure marker so
`webSearchStatus` answers `failed` instead of `starting` forever.

`session-root.test.mts`: the prompt's session root, resolved read-only. A repo
whose `z1/` is a populated non-session tree (the SDK checkout) reports
`<dataHome>/z1/projects/<name>-<sha1>/z1`, an owned or empty `z1/` is reported
in place, `Z1_SESSIONS_DIR` wins with `~` expansion, a foreign override falls
back, and resolving any of them creates no directory.

`input.test.mts` covers the command-plus-prompt split: `/foo` followed by text is
reported as unknown and the text under it is still sent as a prompt, while an
unknown command with nothing under it stays a single line. A `rest: true`
command owns the lines under it when the whole block reads as its sub-grammar —
`/tools` ↵ `off 3` becomes `/tools off 3` — but `/tools` ↵ `hi` is still the
prompt `hi`, which is what the pipe smoke asserts. The real grammar
(`restArguments`) is under test directly: a sentence whose first word is a verb
(`/tools` ↵ `on the record, why is this slow?`, `/sessions` ↵ `new ideas for
the parser`, `/web` ↵ `start over with a simpler approach`) stays the prompt,
while the selector usage (`off 3`, `rename 2 mine`, `--all`, `status`) still
parses as one command.

`output.test.mts`: the assistant-text sanitizer — a leaked `<|DSML| …>` tool-call
block at every chunk split, end-of-sentence tokens, a partial token at flush,
fenced code and ordinary `<div>` untouched, the zero-tools notice policy, and the
regression that matters most: prose *describing* the format (`The element
<parameter name="id"> holds the id…`) survives whole and at every split, while a
real `<invoke>`/`<tool_call>` block is still removed. A confirmed block with no
closer leaves `UNCLOSED_BLOCK_NOTICE` rather than silently erasing its body. The
same holds when the body only *looks* incomplete so far: a line-start opener is
never released as prose when the confirm window elapses, so a real call with a
6 KB JSON body streams clean (streamed equals whole-string at 16-char chunks),
and a stream cut off mid-call leaves the removal marker at flush instead of the
half-written call; a mid-line mention keeps its short prose release.

`width.test.mts`: `fit`/`clip` budget in terminal cells. A matrix of ASCII, CJK,
emoji, skin-tone and variation-selector glyphs, combining marks, ZWJ families and
ANSI-coloured text is truncated at widths 0–14 and every result is asserted to
fit its budget, to contain no lone surrogate, and never to end on a ZWJ. Exact
checks pin the ellipsis cost and the SGR reset — including `clip`'s: plain text
truncates to a plain cut with no escape byte, coloured text still gets its
reset.

`view.test.mts`: the pure `/view` formatter, with no terminal. It pins
`parseViewMode` (full names, `c|m|f`, case, rejects), the family for every tool
(and the writes/process/status tools that are never grouped), the exact
full-mode strings moved from `chat.ts`, and the medium window: three searches
fold into one line with summed time/size, a single call uses the tool's name and
target, `read → write → read` stays three lines, a failure closes the group and
prints one detail row, the next call starts a new group, text and notices close
only when no call is pending, and a cancelled pending call renders `⬡ … cancelled`
rather than `✓`. Widths 20/80/200, a 200-character tool name, CJK arguments and
an unknown tool are clipped in cells. Compact is covered separately: no call or
success rows, the plate text, one red failure row, the `process.start`/`kill`
notice, the terminal row, and no plate when `tty: false`. Every plain-theme line
is asserted to equal `stripAnsi(line)`. The same file covers the replay grouping
helper (three stored reads → one line; a stored write is never grouped) and the
pure picker row model: three rows in order, the current one marked, the
selected one pointed at, descriptions present, and widths 20/40/80 plus a CJK
description clipped in cells. `viewListLines` pins the numbered list verbatim.

`view-prefs.test.mts`: the preference path (`Z1_VIEW_FILE` → `XDG_CONFIG_HOME` →
`~/.config`), a missing file → `medium`, and corrupt JSON, an unknown mode or a
wrong `schemaVersion` → `medium` plus an error without throwing. Save round-trips,
the temp file is gone, mode `0600`, a read-only directory returns `{ ok: false }`,
and `resolveViewMode` follows flag > env > file > default; a non-TTY stdout with
no explicit source is `full`, while an explicit (even invalid) `Z1_VIEW` is
reported rather than ignored.

`tool-state.test.mts`: startup revision, same-order reload keeps it, a real change
bumps/stales, `markListed`, orphan `installed: false`, guard frozen list vs
re-read `call()`, failed write leaves the snapshot, corrupt-file `reset()`, and
the refusal to `apply()` onto a degraded overlay (the file is untouched, the
error points at `/tools reset`, `reset()` repairs, then `apply()` works).

`tool-inventory.test.mts`: the `/tools` section — counts, the enabled/off/deleted
lines, orphan and unknown-tool wording, the 24-name cap with "and N more", and a
size guard (one line per fact, <260 words for 22 tools).

`workspace-state.test.mts`: the own-state block — relative root inside the
workspace, nested and outside roots, the per-project data-home fallback shown
absolute, `.z1/` always present, and the session line staying ≤120 chars for
long/Cyrillic names.

`view-density.sh`: the real console through a pipe and a pty. It also checks that
bare `/view` prints the numbered list, `/view compact` applies, and the
preference file records `compact`. With the stock mock, `Z1_VIEW=compact` must
hide `⬢ todo.read` and every `  ⎿  ✓` row, emit no ESC byte, and still end with
`⬢ done` and the model answer; `full` must keep the call and result; `medium`
must print one `⬢ todo.read · ✓` line. `--once` cannot run slash commands, so the
same compact/full assertions are repeated with `Z1_VIEW` as the only lever. A deterministic
loopback OpenAI-compatible server (`tests/fake-openai.py`) returns three `read`
tool calls in one assistant message, so the pty cases prove medium folds them
into one `⬢ reads · 3` row (with no `read({"path"`), full prints three
`⬢ read({"path"` rows, and compact prints neither. A missing second file proves
`⬢ reads · 2 · ✗ 1` plus one detail row, then a new group for the third read.
Reopening the saved session under each mode proves replay honours the current
density (medium `⬢ reads · 3` with no `✓`, compact no stored calls, full three
rows).

`view-picker.sh`: bare `/view` in a composer opens three rows (`compact`,
`medium`, `full`) with a `⬢` on the current mode and a `❯` on the selection.
The pty cases send `↓` + `Enter` (persists `full`), `Esc` (file untouched, no
confirmation), `1` (persists `compact`) and `f` (persists `full`). A pipe and a
`Z1_TRAY=off` tty must
print the numbered list, `/view 1|2|3` applies a row, and no ESC byte may reach
the pipe. `tests/pty-run.py` gained `@key NAME` for this: a normal input line
always submits with `\\r`, which cannot express a bare arrow/Esc.

`pipe-smoke.sh`: pipes `/tools`, a prompt and `/exit` with temp
`Z1_DB`/`Z1_TOOLS_FILE`, and `/foo` + text to prove an unknown command still
sends the text under it; fails on a non-zero exit, any ESC byte, a missing
`tools ·`, or a missing `mock:` answer.

`session-smoke.sh`: creates a temp git repo, saves a turn under `z1/`, lists
and resumes it, asserts four messages survive, `git status` is clean, drives the
generation guard that refuses a turn read before a concurrent `/clear` in
another process, and `--once` creates no `z1/`.

`clear-wipe.sh`: through a pty (`tests/pty-run.py`) and a pipe — `/new` and
`/clear` wipe screen + scrollback and reprint the banner, `Z1_TRAY=off` stays
inert, a failed store clear keeps the transcript, and a resize after a wipe
reflows from the wiped layout.

`sigterm-restore.sh`: through the same pty harness — `/exit`, `Ctrl-D`,
`Ctrl-C` twice, `SIGTERM` and `SIGHUP` each enter the alternate screen and enable
mouse tracking, and each exit path emits `?1049l`, `?1000l`, `?2004l` and `?25h`
afterwards. `pty-run.py` gained `@signal NAME` for this; it sends the signal in
the input slot instead of typing.

Not covered: prompt↔wire agreement, history/seed, the full `/tools` and
`/sessions` grammar matrices, composer editing, foreign-cwd refusal and corrupt
session metadata, and the `uncaughtException`/`unhandledRejection` handlers (they
share `restoreTerminal` but the suite cannot inject a crash). Also not covered: a
real SearXNG install/start (needs ~120 MB and port 8888) — that is an end-to-end
check, not a unit test.

For `/view` specifically, the fake provider reproduces the live event order
(`mapInput` → `mapCall`, sequentially) but not real provider streaming quirks,
real tool latency, a model that interleaves prose between individual calls, or
an interactive approval prompt (z1-tools v1 makes none). A pipe has no plate, so
compact-in-a-pipe is asserted as "no tool lines", not as "a plate appeared". A
mid-turn mode switch is future-only by design, so no test asserts a reflow.
