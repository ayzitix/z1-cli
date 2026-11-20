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

```bash
git clone https://github.com/ayzitix/z1-sdk ~/Projects/z1-sdk
git clone https://github.com/ayzitix/z1-cli ~/Projects/z1-cli
```

The CLI imports the SDK by absolute path; keep the SDK at
`~/Projects/z1-sdk` (the default) or edit the imports.

## Requirements

- **Node.js 24.9+** (the SDK's `engines` requirement).
- **`tsx`**, normally taken from the SDK checkout's `node_modules/.bin/tsx`.
- A **`z1-sdk` checkout**, by default `~/Projects/z1-sdk`, containing
  `z1/packages/bootstrap`, `agent`, `runtime` and `graph`.
- An API key in the environment — `RIVER_API_KEY` (default provider) or
  `OPENAI_API_KEY`. Keys are read from the environment only; never put them in
  this repository.
- The launcher reads `~/.config/z1/env` if it exists (outside the repo).

`chat.ts` currently imports the SDK through **absolute paths**
(`/home/oleksii/Projects/z1-sdk/...`). Another checkout needs those imports
edited, or `Z1_SDK_REPO` support added to the launcher.

## Install / launcher

`~/.local/bin/z1` is a small shell launcher (kept outside this repository). It
resolves the SDK, sources `~/.config/z1/env`, then execs `tsx` on this repo:

```bash
CHAT="$HOME/Projects/z1-cli/chat.ts"
TOOLS="$HOME/Projects/z1-cli/tools.ts"
exec "$TSX" "$CHAT"          # z1, z1 chat
exec "$TSX" "$TOOLS"         # z1 tools
```

Without the launcher, run the file directly:

```bash
~/Projects/z1-sdk/node_modules/.bin/tsx ~/Projects/z1-cli/chat.ts
```

## Run

```bash
z1                  # interactive console
z1 chat             # same
z1 "prompt"         # one turn, same UI, then exit
z1 ask "prompt"     # same, explicit
z1 tools            # names, or name<TAB>disabled|deleted, from installed modules
z1 run ...          # full SDK CLI (run, tree, fork, memory, module, serve, ...)
```

A pipe works too:

```bash
printf 'summarise this repo\n/exit\n' | z1
```

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
| `Z1_SESSIONS_DIR` | Override the session root. Default: the nearest repo’s `z1/`, else `~/.local/share/z1/projects/<name>-<hash>/z1`. |
| `NO_COLOR` | Disable all colour when set (any value). |
| `Z1_TRAY=off` | Plain readline UI instead of the pinned tray; also used for pipes. |
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
  still the prompt under it, so `/tools` ↵ a question still asks the question.
- **Markdown output**: headings, inline bold/italic/code/links/strikethrough,
  lists, quotes, rules, fenced code blocks, and tables — wide tables fall back to
  a vertical key/value layout, narrow terminals included. Assistant text is
  sanitized: a leaked tool-call block is removed, prose that merely mentions the
  tags survives, and an unclosed block leaves a visible removal marker.
- **User messages** get a full-width background bar so turns are easy to find.
- **Context control**: `/context`, `/compact`, `/window`, `/steps`, with a live
  context percentage in the status row.
- **Approvals**: tool approval requests appear inline as a `y/n` question and the
  draft is restored afterwards. In `--once`/non-interactive mode approvals are
  declined rather than blocking.
- **Background processes**: tools installed from modules (including background
  process control) are surfaced like any other tool call.
- **Web backend**: `/web` reports the SearXNG state and `Z1_SEARX_STATE` says
  `up` only for a process z1 started and verified (`searxng.json` identity); a
  listener z1 cannot claim is left to the module's own `/healthz` probe. A
  verified start that never answers leaves a failure marker, so `/web status`
  says `failed` instead of `starting` for as long as the process lives.
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
- Windows is untested. The launcher is bash; absolute SDK paths are macOS/Linux
  oriented.
- The SDK is imported by absolute local path, so this is a workspace tool rather
  than a relocatable package.
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
/exit, /quit       quit
```

## Tests

Twelve dependency-free checks live in `tests/` (no framework, no network):

```bash
~/Projects/z1-sdk/node_modules/.bin/tsx tests/output.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/width.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/input.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/tool-state.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/tool-inventory.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/workspace-state.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/session-root.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/web-service.test.mts
tests/pipe-smoke.sh
tests/session-smoke.sh
tests/clear-wipe.sh
tests/sigterm-restore.sh
```

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
