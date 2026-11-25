# z1-cli

A local terminal UI for the **z1 graph agent**. It is a thin console around
[`z1-sdk`](https://github.com/ayzitix/z1-sdk): the SDK provides the agent graph, runtime, tools and
storage; this repository provides the interactive terminal experience — a pinned
composer, streamed markdown, slash commands, approvals and a pipeable one-shot
mode.

It is **not** the SDK, a package, or a server. There is no build step: `chat.ts`
is executed directly by `tsx` and imports the SDK from a local checkout.

```
z1-cli/
├── chat.ts          the CLI: composer, transcript, markdown renderer, commands
├── view.ts          pure `/view` formatter: families, groups, compact plate
├── view-prefs.ts    the global `/view` preference file
├── tools.ts         `z1 tools` — list tools exposed by installed modules
├── tool-policy.ts   enabled / disabled / deleted overlay shared by both
├── README.md
└── .gitignore
```

Runtime data (SQLite database, installed modules, proposals) is **not** part of
this repository. By default it lives in `~/.local/share/z1/`.

## Status

Working and used daily, but the UI is still under active iteration. See
[What works](#what-works) and [Still raw](#still-raw) for the honest split.

## Clone

Keep the two checkouts side by side; that layout is discovered at runtime, not
compiled into the source:

```bash
git clone https://github.com/ayzitix/z1-sdk z1-sdk
git clone https://github.com/ayzitix/z1-cli z1-cli
```

`z1-cli` finds the SDK through `Z1_SDK_REPO`, then a sibling `../z1-sdk`, then
`./z1-sdk` under the current directory. No absolute path is compiled in; a
checkout moved elsewhere only needs `Z1_SDK_REPO` (or the sibling layout).

## Requirements

- **Node.js 24.9+** (the SDK's `engines` requirement).
- A **built `z1-sdk` checkout** containing `z1/packages/bootstrap`, `agent`,
  `runtime`, `graph` and the rest, plus `node_modules` and `lib/`
  (`pnpm install`, then `pnpm -C z1 build`).
- **`tsx`**, taken from the SDK checkout's `node_modules/tsx/dist/cli.mjs`.
- An API key in the environment — `RIVER_API_KEY` (default provider) or
  `OPENAI_API_KEY`. Keys are read from the environment only; never put them in
  this repository.
- The external `~/.local/bin/z1` launcher reads `~/.config/z1/env` if it exists
  (outside the repo); the repository launchers do not.

## Install / launcher

The repository ships two launchers that resolve the same SDK:

```bash
./z1                 # POSIX
z1.cmd               # Windows (Node 24 on PATH, or set Z1_NODE)
```

Set `Z1_SDK_REPO` when the two checkouts are not siblings:

```powershell
$env:Z1_SDK_REPO = "C:\path\to\z1-sdk"
.\z1.cmd --once "hello"
```

Without a launcher, run the file directly (the runtime config keeps the
`@z1/*` type-only imports out of module resolution):

```bash
"${Z1_SDK_REPO:-../z1-sdk}/node_modules/tsx/dist/cli.mjs" \
  --tsconfig tsconfig.runtime.json chat.ts
```

## Run

```bash
z1                  # interactive console
z1 chat             # same
z1 "prompt"         # one turn, same UI, then exit
z1 ask "prompt"     # same, explicit
z1 tools            # names, or name<TAB>disabled|deleted, from installed modules
z1 run ...          # full SDK CLI (run, tree, fork, memory, module, serve, ...)
z1 --view compact   # start in a density; also works with --once
z1 --help           # usage, including the subagent and --once behaviour
```

A pipe works too:

```bash
printf 'summarise this repo\n/exit\n' | z1
```

## Tools from z2q

`tool.create` builds a tool proposal; installing one is a person's step, and the
command it prints (`z1 tool install <proposalDir>`) is the one that works: `z1`
finds the z2q checkout the same way `tool.create` does — `Z1_TOOL_SDK_PATH`,
then a sibling `../z1-tool-sdk`, then `./z1-tool-sdk` — and runs its CLI, so
`z1-tool` never has to be on `PATH`.

```bash
z1 tool --help
z1 tool installed
z1 tool build examples/find-todos
z1 tool run examples/find-todos --args '{"glob":"**/*.ts"}' --workspace .
z1 tool install .z2q/proposals/tool.find-todos-1-1795640390307
```

A proposal is untrusted content: it is model-written source that passed a static
review and a sandboxed smoke test. Read its capability lines (what it may read,
write, run, fetch from the network, which environment variables it may see)
before installing.

## Subagents

The `subagent` tool delegates one task to a child agent with its own tool grant.
The child's approvals are always denied, and it cannot nest.

**Background is the default.** A `subagent` call returns at once with
`{ runId, status: "running" }` and the child keeps working after the turn that
started it has ended. Its answer is not the call's result: it arrives as one
block, marked as subagent output, at the start of your next message. A child
that settles during a turn is delivered at the next turn, never mid-turn.

Pass `"wait": true` in the call to block the turn until the child finishes and
return its result directly — the behaviour before background children existed.
A background child is not tied to the turn's `Ctrl-C`; `wait: true` is.

| Command | What it does |
| --- | --- |
| `/agents` | Opens the agents picker: `↑`/`↓` or a digit selects, `⏎` opens that child's transcript, `x`/`Delete` stops the selected child (staying open), `Esc` closes and leaves the draft untouched. It opens **while a turn runs**, so background work is visible without waiting. Without a terminal it prints the list instead: running first, then finished, each marked `background` or `wait`. |
| `/agents <n\|runId>` | Opens one child's transcript (read-only). |
| `/agents stop <n\|runId>` (or `x`) | Cancels a running background child. A finished child is refused; a `wait: true` child is stopped with `Ctrl-C` in its turn. |

`/new` keeps a running child (it belongs to the session, not the conversation);
`/exit` cancels every running child and waits up to five seconds for them to
settle before leaving.

With `--once` there is no next turn, so a background child's answer could never
be delivered. By default `--once` waits for every background child, prints each
one's final status on stderr, and exits; the exit code is still the main run's.
Set `Z1_NO_WAIT=1` to leave them running instead: the run ids are printed and
the process exits at once, and the rows stay `running` until the next start
reaps them.

## Configuration

All configuration is environment variables; there are no config files in the
repo.

| Variable | Meaning |
| --- | --- |
| `Z1_MODEL` | `provider/model`, e.g. `river/deepseek-ai/DeepSeek-V4.1-Flash`. Defaults by available key, then `mock/mock-1`. |
| `Z1_DB` | SQLite database path. Default `~/.local/share/z1/runs.db`. |
| `Z1_MODULES_DIR` | Installed modules directory. Default `~/.local/share/z1/modules`. |
| `Z1_CONTEXT_WINDOW` | Context window in tokens (default `128000`). |
| `Z1_MAX_STEPS` | Max graph steps per turn; `0`/`off` means the SDK ceiling (10000). |
| `Z1_TOOLS_FILE` | Tool enablement overlay. Default `$XDG_CONFIG_HOME/z1/tools.json` (usually `~/.config/z1/tools.json`). |
| `Z1_VIEW` | `compact`, `medium` or `full`; overrides the preference file for this run. A bad value is an error. |
| `Z1_VIEW_FILE` | Density preference file. Default `$XDG_CONFIG_HOME/z1/view.json` (usually `~/.config/z1/view.json`). |
| `Z1_SESSIONS_DIR` | Override the session root. Default: the nearest repo’s `z1/`, else `~/.local/share/z1/projects/<name>-<hash>/z1`. |
| `NO_COLOR` | Disable all colour when set (any value). |
| `Z1_TRAY=off` | Plain readline UI instead of the pinned tray; also used for pipes. |
| `Z1_NO_WAIT=1` | `--once` does not wait for background subagents; prints their run ids and exits. Any other value (including unset) keeps the default: wait, report each child's status on stderr, then exit. |
| `Z1_PINNED=off` | Keep the tray but use normal scrollback instead of the alternate screen. |
| `Z1_UI_DEBUG` | Append UI debug events to that file path. |

## What works

- **Pinned composer** in the alternate screen: the transcript scrolls above a
  fixed status/composer area. Wheel, `PgUp`/`PgDn` scroll; `Esc` returns to the
  live edge; typed lines are queued while a turn is running. Every exit path
  (`/exit`, `Ctrl-D`, `Ctrl-C` twice, `SIGTERM`, `SIGHUP`, an uncaught error)
  leaves the alternate screen and turns mouse tracking off again.
- **Slash menu**: typing `/` filters commands; `↑`/`↓` select, `Enter` runs,
  `Tab` completes arguments, `Esc` closes. A `rest` command (`/tools`,
  `/sessions`, `/web`) owns a subcommand typed on the next line — `/tools` ↵
  `off 3` runs `/tools off 3` — while a line that is not part of its grammar is
  still the prompt under it, so `/tools` ↵ a question still asks the question,
  even when the question merely starts with a verb (`on the record, why…`).
- **Markdown output**: headings, inline bold/italic/code/links/strikethrough,
  lists, quotes, rules, fenced code blocks, and tables — wide tables fall back to
  a vertical key/value layout, narrow terminals included. Assistant text is
  sanitized: a leaked tool-call block is removed (streamed or whole), prose that
  merely mentions the tags survives, and an unclosed block — including a turn
  cut off mid-call by `max_tokens` — leaves a visible removal marker, never the
  raw arguments.
- **User messages** get a full-width background bar so turns are easy to find.
- **Context control**: `/context`, `/compact`, `/window`, `/steps`, with a live
  context percentage in the status row.
- **Tool density**: bare `/view` opens a three-row arrow picker above the
  composer (a numbered list in a pipe or `Z1_TRAY=off`); `1`/`2`/`3` and
  `c`/`m`/`f` select directly. `compact` shows only the model's prose, one live
  `⬡ working · N tools` plate, errors and the terminal row; `medium` folds
  consecutive same-family calls into one line and never folds a write; `full`
  is the per-call transcript. The choice is global in `~/.config/z1/view.json`
  (default `medium`); a pipe gets plain `full` unless `Z1_VIEW`/`--view` says
  otherwise.
- **Approvals**: tool approval requests appear inline as a `y/n` question and the
  draft is restored afterwards. In `--once`/non-interactive mode approvals are
  declined rather than blocking.
- **Background processes**: tools installed from modules (including background
  process control) are surfaced like any other tool call.
- **Web backend**: `/web` reports the SearXNG state and `Z1_SEARX_STATE` says
  `up` only for a process z1 started and verified (`searxng.json` identity); a
  listener z1 cannot claim is left to the module's own `/healthz` probe. A
  verified start that never answers leaves a failure marker, so `/web status`
  says `failed` instead of `starting` for as long as the process lives. The
  backend runs in z1's process tree; a parent watchdog stops it when z1 exits
  (including a force kill), and `/web down` kills the whole tree. On Windows,
  provisioning needs `uv` on PATH and `Z1_PYTHON` pointing at a Python 3.10+
  executable; z1 writes the `pwd` shim and skips the tarball's Apache template
  symlink automatically.
- **Tool control**: `/tools` opens a picker over the composer, styled like the
  slash menu: `↑`/`↓` select, `Enter` toggles `on`/`off` (and restores a deleted
  tool), `Delete` (or `Backspace`) asks before tombstoning, `Esc` closes. The
  picker shows live counts and descriptions. `off` and `delete` hide a tool from
  the model and make the guard reject a hallucinated call; `on` and `restore`
  bring it back. The choice is written atomically to `~/.config/z1/tools.json`
  and shared by every session. The footer shows `tools <enabled>/<installed>`,
  or `?` when the inventory could not be read.
  Pipes and `Z1_TRAY=off` keep a numbered text list instead of the picker.
- **Tool awareness**: every turn's system prompt lists the enabled tool names
  with a count, or says `None` when everything is off. The wire `tools` array
  carries the full schemas only when at least one tool is enabled; with none
  enabled the key is absent from the request. The model can now answer "what
  tools do you have?" and cannot invent a disabled one. Names only, so the block
  is about 40 tokens.
- **Reply language**: the same prompt names the language of this turn's message
  when its script decides it — Ukrainian or Russian by their own letters, and
  Japanese, Chinese, Korean, Arabic, Hebrew, Greek, Thai or Hindi by their
  alphabet. A Cyrillic message with neither `і/ї/є/ґ` nor `ы/э/ё/ъ` gets the pair
  said out loud instead of a guess, and a Latin-script message gets no line at
  all (English, Spanish, Polish and French share the alphabet). It repeats the
  SDK's own rule rather than replacing it; the point is that a small model read
  an eight-kilobyte English prompt as a reason to answer in English. Code,
  paths and URLs are stripped first, so a Ukrainian sentence about `git status`
  is still Ukrainian.
- **Sessions**: every turn is appended to `z1/sessions/<id>/{meta,events.jsonl}`
  in the project (ignored through `.git/info/exclude`). `/sessions` opens an
  arrow picker; `new`, `rename`, `delete`, `archive` and `--all` are the text
  subcommands. A new session is named by the model from its first message (the
  store's `Session <timestamp>` default is the fallback if that call fails); the
  first prompt is never stored as the name. The next prompt
  after `/new` or a delete starts a new one. `/clear` empties the current
  conversation in place: same session id, name and colour, `messageCount: 0`,
  and the next prompt appends to that same session. The transcript is authoritative;
  `runs.db` is only provenance. `--once` never creates a session.
- **Pipes and `Z1_TRAY=off`**: readline path with `\` line continuation, no
  alternate screen and no escape sequences emitted; `Ctrl-C` cancels a run.

## Sessions

The transcript lives with the project:

```
<project>/z1/
  .gitignore          # "*" + "!.gitignore"
  .z1-sessions        # ownership marker
  latest.json
  sessions/<id>/
    meta.json         # model, cwd, context, max steps, run ids, message count
    events.jsonl      # append-only user/assistant/tool messages, or one snapshot
  .trash/             # deleted sessions, never erased by /sessions delete
```

`z1/` is added to `.git/info/exclude`, so sessions never dirty `git status`.
If a repo already has a non-session `z1/` (the SDK source tree is the real
example), the store falls back to
`~/.local/share/z1/projects/<name>-<hash>/z1` instead of writing into it.
`Z1_SESSIONS_DIR` overrides both. Messages are the source of truth; `runs.db`
is linked through `meta.runs` but is never replayed to rebuild a chat. The
system prompt's own-state section names the same root the store uses — the
override when set, and the per-project data directory when the repo's `z1/`
belongs to something else — because that is the path the model needs when it is
asked where transcripts live.

In a terminal, `/sessions` opens the same kind of arrow picker as `/tools`:
`↑`/`↓` select, `Enter` switches, `r` renames, `d`/`Delete` deletes (after a
confirmation), `Esc` closes. Pipes and `Z1_TRAY=off` get the numbered text list
instead. Each row starts with a coloured `⬢`; a new session stores its colour in
`meta.color`, and an older transcript gets a stable colour derived from its id
on first open. The first `z1` turn asks the current model for a
2–6 word title from the first user message; a failed or too-long answer keeps
the readable first-line fallback. Titles are stored in `meta.json`, so they
survive a restart. Switching a session replays its user and assistant messages
into the visible transcript (tool results stay in the JSONL), so the opened
conversation is readable instead of a blank screen. Selecting the session that
is already open is a no-op — it does not append a second copy — and opening a
different session replaces the pinned transcript instead of stacking both.
With `Z1_PINNED=off` the terminal owns scrollback, so switching appends there;
selecting the same session is still a no-op.

## Still raw

- A density change affects future events only; already-printed tool lines are
  not reflowed. `/clear`, `/new` or a session switch re-renders the visible
  transcript under the new mode.
- A pipe has no plate, so compact there simply omits tool lines; medium still
  buffers groups, so a line appears only when the group closes.
- Compact hides every tool line, including `write`/`edit`/`shell`, by design.
  Medium is the default because it never collapses a write.
- No native scrollback or search in the default alternate-screen mode. Use
  `Z1_PINNED=off` to keep output in the terminal's own scrollback.
- Mouse selection requires `Shift`+drag; plain drag is captured by the app.
- Resizing clears the app's history/scrollback; only the live tray is reflowed.
- Markdown has no syntax highlighting inside code fences.
- A very long single-line stream waits for a newline before it is committed.
- CJK and emoji widths are approximations. `fit`/`clip` now budget in terminal
  cells and never split a surrogate pair or a combining mark, but a joined
  emoji sequence can be over-counted, so some lines still waste a column.
- Nested tables and very wide tables are best-effort; the vertical fallback is
  the escape hatch.
- Windows is tested for the console with Node 24 and `z1.cmd`; the SDK's
  symlink-heavy tests still assume a POSIX host.
- `z1-cli` is a workspace tool, not a published package: it loads the built
  `z1-sdk` checkout and is relocatable through `Z1_SDK_REPO`, but it is not
  installable from npm.
- `delete` in `/tools` is a tombstone, not an uninstall: the module still ships
  the tool and one module can own many tools, so removing code would break the
  others. `/tools restore` clears it.
- Tool policy is enforced by this CLI's tool service. `z1 run`, the HTTP server,
  Studio and other hosts do not read `~/.config/z1/tools.json`, so the same
  disabled tool can still be reached there.
- Tool names are global. Two modules exposing the same name share one
  `on`/`off`/`delete` decision.
- Tool preferences are a whole-file atomic replace: two sessions writing at the
  same instant keep the last write. The next command re-reads the file, so
  ordinary sequential edits in two windows do merge.
- A corrupt preferences file is reported and repaired by `/tools reset`. Until
  then this process keeps the last policy it read successfully (or enables
  everything on a fresh start), and an `on`/`off`/`delete` is refused instead of
  being merged onto that fallback: merging would replace the file and silently
  wipe the decisions it still held.
- Disabling every tool leaves the model request without a `tools` array. Some
  OpenAI-compatible providers dislike tool history without tool declarations;
  re-enable one tool if a provider rejects it.
- Slash commands are interactive. `--once "/tools ..."` is rejected with exit
  code 2 instead of being sent to the model.
- Session storage is M1: the picker switches, renames and deletes; `archive`,
  `unarchive` and `--all` are still text subcommands. No lock file, blob spill
  for huge tool output, rebuildable index, fork or retention. A session from a
  different `cwd` is refused because the runtime is bound to this directory.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | send |
| `Shift+Enter`, `Ctrl+J`, `Alt+Enter` | newline |
| `↑` / `↓` | history (or menu selection); `Ctrl+P` / `Ctrl+N` |
| `←` / `→`, `Home` / `End`, `Ctrl+A` / `Ctrl+E` | move cursor |
| `Ctrl+K` / `Ctrl+U` / `Ctrl+W` | kill to end / start / previous word |
| `Alt+B` / `Alt+F` / `Alt+D` | word left / right / delete forward |
| `Tab` | complete slash command |
| `PgUp` / `PgDn`, wheel | scroll transcript |
| `Esc` | interrupt a turn, close menu, or return to the live edge (twice clears the draft) |
| `Ctrl+C` | interrupt; twice in a row exits |
| `Ctrl+D` | exit |
| `Ctrl+L` | clear screen |

## Slash commands

```
/help              show help
/new               start a fresh conversation (a new session on the next prompt)
/clear             empty this conversation, keep the session (id, name, colour)
/model <p/m>       switch model
/tools             interactive picker: ↑↓, Enter toggle, Delete remove, Esc close
/tools off <n|name|all>  hide a tool (or all) from the agent
/tools delete <n|name>   hide it and keep a restorable tombstone
/tools on <n|name|all>   enable a tool (also restores a tombstone)
/tools restore <n|name|all>  clear a tombstone
/tools reset             clear every tool preference
/tools refresh           re-read the installed module inventory
/tools --all             include stale entries for tools no longer installed
/sessions          arrow picker: ↑↓ select, Enter switch, r rename, d delete, Esc close
/sessions --all    include archived sessions
/sessions new [name]     create and switch to a new session
/sessions rename <n|id> <name>  rename
/sessions delete <n|id>  confirm, then move to .trash
/sessions archive <n|id> / unarchive <n|id>
/context           show context usage
/compact           compact the next turn
/window <tokens>   set the context window
/steps <n|off>     set the step limit
/view [compact|medium|full]  picker; bare opens it (numbered list in a pipe); c|m|f, 1|2|3
/exit, /quit       quit
```

## Tests

Sixteen dependency-free checks live in `tests/` (no framework, no external
network; the density pty case uses a loopback OpenAI-compatible server):

```bash
SDK="${Z1_SDK_REPO:-../z1-sdk}"
for test in tests/*.test.mts; do
  node "$SDK/node_modules/tsx/dist/cli.mjs" --tsconfig tsconfig.runtime.json "$test"
done
tests/pipe-smoke.sh
tests/session-smoke.sh
tests/clear-wipe.sh
tests/sigterm-restore.sh
tests/view-density.sh
tests/view-picker.sh
```

`view.test.mts` is the pure formatter matrix: mode parsing, every family, the
exact full-mode strings, medium grouping (writes, failures, cancellation,
text/notice boundaries, widths and CJK), the compact plate and one-line
failures, and replay grouping. `view-prefs.test.mts` covers path precedence, the
safe `medium` fallback, atomic writes and `0600`, and `resolveViewMode`
including the pipe rule. `view-density.sh` drives a pipe and a pty: compact
hides the call, full keeps it, and `tests/fake-openai.py` returns three `read`
calls so medium must fold them into `reads · 3`; it also covers a failed read
and replay under each mode. `view-picker.sh` drives the interactive picker:
`↓`+`Enter` persists `full`, `Esc` leaves the file untouched, `1` selects
`compact`, `f` selects `full`, and a pipe / `Z1_TRAY=off` print the numbered
list.

`pipe-smoke.sh` pipes `/tools` and `/exit` through the console with a temp
database and tool overlay and fails on a non-zero exit, any ESC byte, or a
missing `tools ·`. `session-smoke.sh` saves, lists and resumes a session in a
temp git repo, checks `git status` stays clean and that `--once` leaves no
`z1/`. `sigterm-restore.sh` drives a pty through `/exit`, `Ctrl-D`, `Ctrl-C`
twice, `SIGTERM` and `SIGHUP` and asserts the alternate screen and mouse
tracking are given back each time. `tool-state.test.mts` covers snapshot
revisions, orphan entries, guard `list()`/`call()` parity, failed writes,
corrupt-file reset, and the refusal to merge onto a corrupt overlay.
See `tests/README.md` for what is not covered.

Manual checks:

```bash
# Pipe: must exit 0 and emit no ESC bytes. An empty XDG_CONFIG_HOME keeps
# ~/.config/z1/env from overriding the mock model.
printf '/exit\n' | XDG_CONFIG_HOME=/tmp/z1-empty Z1_MODEL=mock/mock-1 \
  Z1_DB=/tmp/z1-test.db Z1_MODULES_DIR=/tmp/z1-modules z1 | grep -c $'\033' || true

# Interactive: banner/composer appear, /exit leaves cleanly.
script -qec 'XDG_CONFIG_HOME=/tmp/z1-empty Z1_MODEL=mock/mock-1 Z1_DB=/tmp/z1-test.db z1' /dev/null
```

Use a throwaway `Z1_DB` and `Z1_MODULES_DIR` for smoke tests. The real database
and modules under `~/.local/share/z1/` are runtime state, not source.

## Security

- No credentials are stored in this repository. Keys come from the environment
  (`RIVER_API_KEY`, `OPENAI_API_KEY`), usually via `~/.config/z1/env`, which is
  outside the repo and git-ignored here.
- `.gitignore` excludes the database (`runs.db*`), `modules/`, `proposals/`,
  `.env*`, logs and `node_modules/`.
- The full commit history has been scanned for common credential shapes:
  provider API keys, GitHub/Slack/Google/AWS/GitLab/Hugging Face/npm tokens,
  bearer headers, populated `*_API_KEY=` assignments, and private-key blocks;
  no values were found.

## License

No license file is included. `z1-sdk` is MIT-licensed, but that does not by
itself license this repository; add a license before distributing it.
