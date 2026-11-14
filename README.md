# z1-cli

A local terminal UI for the **z1 graph agent**. It is a thin console around
[`z1-sdk`](../z1-sdk): the SDK provides the agent graph, runtime, tools and
storage; this repository provides the interactive terminal experience — a pinned
composer, streamed markdown, slash commands, approvals and a pipeable one-shot
mode.

It is **not** the SDK, a package, or a server. There is no build step: `chat.ts`
is executed directly by `tsx` and imports the SDK from a local checkout.

```
z1-cli/
├── chat.ts      the CLI: composer, transcript, markdown renderer, commands
├── tools.ts     `z1 tools` — list tools exposed by installed modules
├── README.md
└── .gitignore
```

Runtime data (SQLite database, installed modules, proposals) is **not** part of
this repository. By default it lives in `~/.local/share/z1/`.

## Status

Working and used daily, but the UI is still under active iteration. See
[What works](#what-works) and [Still raw](#still-raw) for the honest split.

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
z1 tools            # list tools from installed modules
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
| `NO_COLOR` | Disable all colour when set (any value). |
| `Z1_TRAY=off` | Plain readline UI instead of the pinned tray; also used for pipes. |
| `Z1_PINNED=off` | Keep the tray but use normal scrollback instead of the alternate screen. |
| `Z1_UI_DEBUG` | Append UI debug events to that file path. |

## What works

- **Pinned composer** in the alternate screen: the transcript scrolls above a
  fixed status/composer area. Wheel, `PgUp`/`PgDn` scroll; `Esc` returns to the
  live edge; typed lines are queued while a turn is running.
- **Slash menu**: typing `/` filters commands; `↑`/`↓` select, `Enter` runs,
  `Tab` completes arguments, `Esc` closes.
- **Markdown output**: headings, inline bold/italic/code/links/strikethrough,
  lists, quotes, rules, fenced code blocks, and tables — wide tables fall back to
  a vertical key/value layout, narrow terminals included.
- **User messages** get a full-width background bar so turns are easy to find.
- **Context control**: `/context`, `/compact`, `/window`, `/steps`, with a live
  context percentage in the status row.
- **Approvals**: tool approval requests appear inline as a `y/n` question and the
  draft is restored afterwards. In `--once`/non-interactive mode approvals are
  declined rather than blocking.
- **Background processes**: tools installed from modules (including background
  process control) are surfaced like any other tool call.
- **Pipes and `Z1_TRAY=off`**: readline path with `\` line continuation, no
  alternate screen and no escape sequences emitted; `Ctrl-C` cancels a run.

## Still raw

- No native scrollback or search in the default alternate-screen mode. Use
  `Z1_PINNED=off` to keep output in the terminal's own scrollback.
- Mouse selection requires `Shift`+drag; plain drag is captured by the app.
- Resizing clears the app's history/scrollback; only the live tray is reflowed.
- Markdown has no syntax highlighting inside code fences.
- A very long single-line stream waits for a newline before it is committed.
- CJK and emoji widths are approximations; some lines can misalign.
- Nested tables and very wide tables are best-effort; the vertical fallback is
  the escape hatch.
- Windows is untested. The launcher is bash; absolute SDK paths are macOS/Linux
  oriented.
- The SDK is imported by absolute local path, so this is a workspace tool rather
  than a relocatable package.

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
/new               start a fresh conversation
/model <p/m>       switch model
/tools             list installed tools
/context           show context usage
/compact           compact the next turn
/window <tokens>   set the context window
/steps <n|off>     set the step limit
/exit, /quit       quit
```

## Development and verification

There is no test suite in this repository; the verification harness used during
development lives outside it. Manual checks:

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
