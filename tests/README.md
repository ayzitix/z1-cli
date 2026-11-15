# z1 CLI tests

Seven dependency-free checks: no test framework, no network, nothing installed —
and deliberately **not** a full CLI suite.

Prerequisites: `z1-sdk` at `~/Projects/z1-sdk` (or `Z1_SDK_REPO`), Node 24.9+,
`git` for the session smoke,
and for the smoke an installed `com.z1.tools` in
`${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}`.
The smokes set `Z1_WEB_AUTOSTART=off`, so a test run never downloads SearXNG.

From the repo root:
```bash
~/Projects/z1-sdk/node_modules/.bin/tsx tests/web-service.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/tool-state.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/tool-inventory.test.mts
~/Projects/z1-sdk/node_modules/.bin/tsx tests/workspace-state.test.mts
tests/pipe-smoke.sh
tests/session-smoke.sh
tests/clear-wipe.sh
```

`web-service.test.mts`: `~`/`Z1_WEB_DIR`/`XDG_DATA_HOME` resolution against the
environment's `HOME`, the settings template (secret, loopback, `json` format, the
pinned engine set), the health probe and its deadline, pid-file staleness, the
install lock on a web dir that does not exist yet, `external`/`disabled`/
`stopped`, and the `Z1_SEARX_STATE` hint the web module reads. Every request goes
to an ephemeral local server: it never touches 8888 or the network.

`tool-state.test.mts`: startup revision, same-order reload keeps it, a real change
bumps/stales, `markListed`, orphan `installed: false`, guard frozen list vs
re-read `call()`, failed write leaves the snapshot, corrupt-file `reset()`.

`tool-inventory.test.mts`: the `/tools` section — counts, the enabled/off/deleted
lines, orphan and unknown-tool wording, the 24-name cap with "and N more", and a
size guard (one line per fact, <260 words for 22 tools).

`workspace-state.test.mts`: the own-state block — relative root inside the
workspace, nested and outside roots, `.z1/` always present, and the session line
staying ≤120 chars for long/Cyrillic names.

`pipe-smoke.sh`: pipes `/tools` + `/exit` with temp `Z1_DB`/`Z1_TOOLS_FILE`;
fails on a non-zero exit, any ESC byte, or a missing `tools ·`.

`session-smoke.sh`: creates a temp git repo, saves a turn under `z1/`, lists
and resumes it, asserts four messages survive, `git status` is clean, drives the
generation guard that refuses a turn read before a concurrent `/clear` in
another process, and `--once` creates no `z1/`.

`clear-wipe.sh`: through a pty (`tests/pty-run.py`) and a pipe — `/new` and
`/clear` wipe screen + scrollback and reprint the banner, `Z1_TRAY=off` stays
inert, a failed store clear keeps the transcript, and a resize after a wipe
reflows from the wiped layout.

Not covered: prompt↔wire agreement, history/seed, the full `/tools` and
`/sessions` grammar matrices, pty/composer, foreign-cwd refusal and corrupt
session metadata. Also not covered: a real SearXNG install/start (needs ~120 MB
and port 8888) — that is an end-to-end check, not a unit test.

