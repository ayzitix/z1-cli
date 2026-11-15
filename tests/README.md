# z1 CLI tests

Two dependency-free checks: no test framework, no network, nothing installed —
and deliberately **not** a full CLI suite.

Prerequisites: `z1-sdk` at `~/Projects/z1-sdk` (or `Z1_SDK_REPO`), Node 24.9+,
and for the smoke an installed `com.z1.tools` in
`${Z1_MODULES_DIR:-$HOME/.local/share/z1/modules}`.

From the repo root:
```bash
~/Projects/z1-sdk/node_modules/.bin/tsx tests/tool-state.test.mts
tests/pipe-smoke.sh
```

`tool-state.test.mts`: startup revision, same-order reload keeps it, a real change
bumps/stales, `markListed`, orphan `installed: false`, guard frozen list vs
re-read `call()`, failed write leaves the snapshot, corrupt-file `reset()`.

`pipe-smoke.sh`: pipes `/tools` + `/exit` with temp `Z1_DB`/`Z1_TOOLS_FILE`;
fails on a non-zero exit, any ESC byte, or a missing `tools ·`. Not covered:
prompt↔wire agreement, history/seed, the `/tools` grammar matrix, pty/composer.
