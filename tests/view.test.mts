/**
 * The pure `/view` formatter: mode parsing, the family table, the exact
 * full-mode strings (moved, not redesigned), the medium grouping window, the
 * compact plate/line matrix, and replay grouping.
 *
 * No terminal is involved: every case supplies the theme, width and clock, so a
 * failure names the line and the event that produced it.
 */
import assert from 'node:assert/strict'

import { displayCells, stripAnsi } from '../width.ts'
import {
  byteSize,
  compactArgs,
  createViewState,
  durationLabel,
  elapsedLabel,
  errorText,
  familyOf,
  groupStoredCalls,
  parseViewChoice,
  parseViewMode,
  resultLine,
  resultSize,
  sizeLabel,
  toolSummary,
  viewActivity,
  viewEvent,
  viewListLines,
  viewMenuItems,
  viewMenuRow,
  viewNotice,
  viewSettle,
  viewStatus,
  viewTextStart,
  VIEW_DESCRIPTIONS,
  VIEW_MODES,
} from '../view.ts'
import type { ViewAction, ViewContext, ViewMode, ViewState, ViewTheme } from '../view.ts'

const plain: ViewTheme = {
  dim: (text) => text,
  bold: (text) => text,
  cyan: (text) => text,
  green: (text) => text,
  red: (text) => text,
  yellow: (text) => text,
}

const ctx = (overrides: Partial<ViewContext> = {}): ViewContext => ({
  columns: 80,
  now: 1000,
  tty: true,
  theme: plain,
  ...overrides,
})

const state = (mode: ViewMode): ViewState => createViewState(mode, 0)

const lines = (actions: readonly ViewAction[]): string[] =>
  actions
    .filter((action): action is Extract<ViewAction, { type: 'line' }> => action.type === 'line')
    .map((action) => action.text)

const start = (
  s: ViewState,
  name: string,
  path = `loop/1/toolMap/${String(s.calls.size + 1)}`,
  args = '{}',
  c = ctx(),
): readonly ViewAction[] => viewEvent(s, { type: 'tool.start', path, name, args }, c)

const end = (
  s: ViewState,
  path: string,
  options: {
    ok?: boolean
    error?: string
    durationMs?: number
    size?: number
    result?: unknown
    /** 2b: a background launch, not an outcome. */
    started?: boolean
    hint?: string
  } = {},
  c = ctx(),
): readonly ViewAction[] =>
  viewEvent(
    s,
    {
      type: 'tool.end',
      path,
      ok: options.ok ?? true,
      ...(options.error === undefined ? {} : { error: options.error }),
      durationMs: options.durationMs ?? 12,
      size: options.size ?? 0,
      ...(options.result === undefined ? {} : { result: options.result }),
      ...(options.started === undefined ? {} : { started: options.started }),
      ...(options.hint === undefined ? {} : { hint: options.hint }),
    },
    c,
  )

// ---------------------------------------------------------------- parseViewMode
assert.equal(parseViewMode('compact'), 'compact')
assert.equal(parseViewMode('medium'), 'medium')
assert.equal(parseViewMode('full'), 'full')
assert.equal(parseViewMode('c'), 'compact')
assert.equal(parseViewMode('m'), 'medium')
assert.equal(parseViewMode('f'), 'full')
assert.equal(parseViewMode('  MEDIUM  '), 'medium')
assert.equal(parseViewMode(''), undefined, 'empty is not a mode')
assert.equal(parseViewMode('off'), undefined)
assert.equal(parseViewMode('3'), undefined)
assert.equal(parseViewMode('verbose'), undefined)
assert.equal(parseViewMode('medium mode'), undefined)

// ------------------------------------------------------------------ family table
const grouped: Record<string, string> = {
  read: 'reads',
  stat: 'reads',
  list: 'scans',
  glob: 'scans',
  grep: 'scans',
  tree: 'scans',
  'web.search': 'searches',
  'web.fetch': 'searches',
  'stack.search': 'searches',
  'github.issues': 'searches',
  'git.status': 'git',
  'git.diff': 'git',
  'git.log': 'git',
  'todo.read': 'todos',
}
const ungrouped = [
  'write',
  'edit',
  'apply_patch',
  'mkdir',
  'move',
  'todo.write',
  'shell',
  'process.start',
  'process.output',
  'process.kill',
  'process.list',
  'system.info',
  'web.status',
  'mystery.tool',
]
assert.equal(
  Object.keys(grouped).length + ungrouped.length,
  28,
  'the matrix covers the 27 known names plus one unknown',
)
for (const [name, family] of Object.entries(grouped)) {
  assert.equal(familyOf(name), family, `${name} groups as ${family}`)
}
for (const name of ungrouped) {
  assert.equal(familyOf(name), undefined, `${name} is never grouped`)
}

// ------------------------------------------------------------- moved helpers
assert.equal(compactArgs({ path: 'a.ts' }), '{"path":"a.ts"}')
assert.equal(compactArgs('  a \n b  '), 'a b')
assert.equal(compactArgs(undefined), '{}')
assert.equal(compactArgs('x'.repeat(200)).length, 120, 'compactArgs caps at 120 characters')
assert.equal(compactArgs('x'.repeat(200)).endsWith('…'), true)
assert.equal(errorText('boom'), 'boom')
assert.equal(errorText({ error: 'ENOENT' }), 'ENOENT')
assert.equal(errorText({ code: 1 }), '{"code":1}')
assert.equal(resultSize('abcd'), 4)
assert.equal(resultSize({ a: 1 }), 7)
assert.equal(sizeLabel(4), '4 B')
assert.equal(sizeLabel(1024), '1.0 KB')
assert.equal(byteSize('abcd'), '4 B')
assert.equal(byteSize('x'.repeat(1536)), '1.5 KB')
assert.equal(durationLabel(999), '999ms')
assert.equal(durationLabel(1000), '1.0s')
assert.equal(durationLabel(12_000), '12s')
assert.equal(elapsedLabel(800), '0.8s')
assert.equal(elapsedLabel(12_000), '12s')

// --------------------------------------------------------------- toolSummary
assert.equal(toolSummary('read', '{"path":"src/a.ts"}'), 'src/a.ts')
assert.equal(toolSummary('write', '{"path":"src/c.ts","content":"…"}'), 'src/c.ts')
assert.equal(toolSummary('move', '{"from":"a.ts","to":"b.ts"}'), 'a.ts → b.ts')
assert.equal(toolSummary('grep', '{"pattern":"foo"}'), 'foo')
assert.equal(toolSummary('web.search', '{"query":"tsx 4"}'), 'tsx 4')
assert.equal(toolSummary('web.fetch', '{"url":"https://example.test"}'), 'https://example.test')
assert.equal(toolSummary('shell', '{"command":"npm test"}'), 'npm test')
assert.equal(toolSummary('process.start', '{"id":"dev"}'), 'dev')
assert.equal(toolSummary('read', '{}'), undefined)
assert.equal(toolSummary('read', ''), undefined)
assert.equal(toolSummary('mystery.tool', 'not json'), 'not json')
assert.equal(resultLine('started dev — running (pid 1234)'), 'started dev — running (pid 1234)')
assert.equal(resultLine({ output: 'line one\nline two' }), 'line one')
assert.equal(resultLine({ ok: true }), undefined)

// ---------------------------------------------------------- full-mode strings
{
  const s = state('full')
  // A call reads as a verb and its target, never as the argument JSON.
  assert.deepEqual(lines(start(s, 'read', 'p1', '{"path":"a.ts"}')), ['⬢ Read a.ts'])
  assert.deepEqual(lines(end(s, 'p1', { durationMs: 12, size: 4 })), ['  ⎿  ✓ 12ms · 4 B'])
  assert.deepEqual(lines(start(s, 'todo.read', 'p2', '{}')), ['⬢ Todo'])
  assert.deepEqual(lines(end(s, 'p2', { ok: false, error: 'ENOENT', durationMs: 12 })), ['  ⎿  ✗ ENOENT · 12ms'])
  assert.deepEqual(lines(viewEvent(s, { type: 'node.failed', path: 'loop/1/chat', error: 'boom' }, ctx())), [
    '  ⎿  ✗ loop/1/chat · boom',
  ])
  assert.deepEqual(lines(viewSettle(s, 'completed', ctx({ now: 800 }))), ['⬢ done · 0.8s'])
}
{
  const s = state('full')
  assert.deepEqual(lines(viewSettle(s, 'cancelled', ctx({ now: 1200 }))), ['⬡ cancelled · 1.2s'])
}
{
  const s = state('full')
  assert.deepEqual(
    lines(viewSettle(s, 'failed', ctx({ now: 800 }))),
    ['⬢ failed · 0.8s'],
    'a failure with no message prints the terminal row only',
  )
}
{
  const s = state('full')
  s.runError = 'step limit reached'
  assert.deepEqual(lines(viewSettle(s, 'failed', ctx({ now: 800 }))), [
    '⬢ failed · 0.8s',
    '  ⎿  step limit reached',
    '  ⎿  step limit reached — say "continue" to resume, or /new',
  ])
}
{
  const s = state('full')
  s.runError = 'TIMEOUT after 30s'
  assert.deepEqual(lines(viewSettle(s, 'failed', ctx({ now: 800 }))), [
    '⬢ failed · 0.8s',
    '  ⎿  TIMEOUT after 30s',
    '  ⎿  turn timed out — say "continue" to resume, or /new',
  ])
}
{
  // The old dedupe: a stored run error is added to `shown`, so settle does not
  // repeat it; the hint still prints.
  const s = state('full')
  viewEvent(s, { type: 'run.failed', error: 'TIMEOUT after 30s' }, ctx())
  assert.deepEqual(lines(viewSettle(s, 'failed', ctx({ now: 800 }))), [
    '⬢ failed · 0.8s',
    '  ⎿  turn timed out — say "continue" to resume, or /new',
  ])
}

// ------------------------------------------------- a background launch row (2b)

// A `subagent` call without `wait: true` is a *launch*, not an outcome: the
// child is still running when the call returns. The row has to say that instead
// of `✓`, and point at `/agents`, in every mode. The `wait: true` half of each
// block pins that the v1 ✓/✗ rows are unchanged.
{
  const s = state('full')
  start(s, 'subagent', 'p1', '{"description":"scan tests"}')
  assert.deepEqual(
    lines(
      end(s, 'p1', {
        started: true,
        result: { status: 'running', runId: 'run_x' },
        hint: 'agents run_x',
        durationMs: 40,
      }),
    ),
    ['  ⎿  started 40ms · agents run_x'],
    'full: a launch reads `started`, never ✓/✗, and carries the /agents hint',
  )
  // The label is the tool's own, so a row cannot be mistaken for `read`.
  assert.match(lines(start(s, 'subagent', 'p2', '{}'))[0] ?? '', /^⬢ Subagent/)

  // `wait: true`: an ordinary finished child, exactly as before 2b.
  const w = state('full')
  start(w, 'subagent', 'p1', '{"description":"scan tests"}')
  assert.deepEqual(
    lines(end(w, 'p1', { result: { status: 'completed', runId: 'run_x' }, durationMs: 120, size: 8, hint: 'agents run_x' })),
    ['  ⎿  ✓ 120ms · 8 B · agents run_x'],
    'full: a `wait: true` child still renders ✓ with its hint',
  )
  assert.deepEqual(
    lines(end(w, 'p2', { ok: false, error: 'child_failed', durationMs: 120 })),
    ['  ⎿  ✗ child_failed · 120ms'],
    'full: and a failed `wait: true` child still renders ✗',
  )
}

{
  const s = state('medium')
  start(s, 'subagent', 'p1', '{"description":"scan tests"}')
  assert.deepEqual(
    lines(
      end(s, 'p1', {
        started: true,
        result: { status: 'running', runId: 'run_x' },
        hint: 'agents run_x',
        durationMs: 40,
      }),
    ),
    ['⬢ Subagent scan tests · started 40ms · agents run_x'],
    'medium: a launch reads `started` with the /agents hint, not ✓',
  )
  // `wait: true` keeps the v1 row - and its summary is the delegation's own
  // description, not the raw argument JSON it used to print.
  const w = state('medium')
  start(w, 'subagent', 'p1', '{"description":"scan tests"}')
  assert.deepEqual(
    lines(end(w, 'p1', { result: { status: 'completed', runId: 'run_x' }, durationMs: 120 })),
    ['⬢ Subagent scan tests · ✓'],
    'medium: a `wait: true` child is a normal ✓ row named by its description',
  )
}

{
  const s = state('compact')
  start(s, 'subagent', 'p1', '{"description":"scan tests"}')
  assert.deepEqual(
    lines(
      end(s, 'p1', {
        started: true,
        result: { status: 'running', runId: 'run_x' },
        hint: 'agents run_x',
        durationMs: 40,
      }),
    ),
    ['  ⎿  started subagent · agents run_x'],
    'compact: a launch breaks through as `started` and says where to look',
  )
  // A launch is a normal result (`isError: false`), so `ok` is true and the
  // row is `started`, never a failure. With no hint it still says `started`.
  const bare = state('compact')
  start(bare, 'subagent', 'p1', '{}')
  assert.deepEqual(
    lines(end(bare, 'p1', { started: true, result: { status: 'running' }, durationMs: 40 })),
    ['  ⎿  started subagent'],
    'compact: `started` needs no hint to show',
  )
  // `wait: true` in compact is an ordinary success: no row at all, before 2b
  // and after. The launch above is the one thing that breaks through.
  const w = state('compact')
  start(w, 'subagent', 'p1', '{"description":"scan tests"}')
  assert.deepEqual(
    lines(end(w, 'p1', { result: { status: 'completed', runId: 'run_x' }, durationMs: 120 })),
    [],
    'compact: a `wait: true` child stays silent, like any successful call',
  )
}

// ----------------------------------------------------------- medium grouping
{
  const s = state('medium')
  const paths = ['p1', 'p2', 'p3']
  const sizes = [20_000, 20_000, 3_100]
  const durations = [420, 610, 370]
  ;['web.search', 'web.fetch', 'stack.search'].forEach((name, index) => {
    start(s, name, paths[index]!, '{"query":"tsx 4"}')
    end(s, paths[index]!, { durationMs: durations[index]!, size: sizes[index]! })
  })
  assert.deepEqual(lines(viewNotice(s, ctx())), ['⬢ Searched 3 lookups · ✓'])
  assert.deepEqual(lines(viewSettle(s, 'completed', ctx({ now: 800 }))), ['⬢ done · 0.8s'])
}
{
  const s = state('medium')
  start(s, 'read', 'p1', '{"path":"src/a.ts"}')
  end(s, 'p1', { durationMs: 12, size: 4 })
  assert.deepEqual(lines(viewNotice(s, ctx())), ['⬢ Read src/a.ts · ✓'])
}
{
  const s = state('medium')
  start(s, 'read', 'p1', '{"path":"src/a.ts"}')
  end(s, 'p1', { durationMs: 12 })
  // A write is a barrier: the read closes as a single line, the write is never
  // folded, and the next read starts a fresh group.
  const barrier = start(s, 'write', 'p2', '{"path":"src/c.ts"}')
  end(s, 'p2', { durationMs: 12 })
  start(s, 'read', 'p3', '{"path":"src/b.ts"}')
  end(s, 'p3', { durationMs: 12 })
  assert.deepEqual(lines(barrier), ['⬢ Read src/a.ts · ✓'], 'the barrier closes the read group first')
  assert.deepEqual(lines(viewNotice(s, ctx())), ['⬢ Read src/b.ts · ✓'])
}
{
  const s = state('medium')
  start(s, 'read', 'p1', '{"path":"a.ts"}')
  end(s, 'p1', { durationMs: 12 })
  start(s, 'read', 'p2', '{"path":"missing.ts"}')
  const failed = end(s, 'p2', { ok: false, error: 'ENOENT: no such file', durationMs: 12 })
  assert.deepEqual(lines(failed), [
    '⬢ Read 2 files · ✗ 1',
    '  ⎿  ✗ read · ENOENT: no such file',
  ])
  // A failure never sits inside a later ✓ line: the third call starts a new group.
  start(s, 'read', 'p3', '{"path":"c.ts"}')
  end(s, 'p3', { durationMs: 12 })
  assert.deepEqual(lines(viewNotice(s, ctx())), ['⬢ Read c.ts · ✓'])
}
{
  const s = state('medium')
  start(s, 'read', 'p1', '{"path":"a.ts"}')
  end(s, 'p1', { durationMs: 12 })
  start(s, 'read', 'p2', '{"path":"b.ts"}')
  end(s, 'p2', { durationMs: 12 })
  // The first committed assistant row closes the group *before* the text row.
  assert.deepEqual(lines(viewTextStart(s, ctx())), ['⬢ Read 2 files · ✓'])
  assert.deepEqual(lines(viewTextStart(s, ctx())), [], 'only the first text row is a boundary')
}
{
  const s = state('medium')
  start(s, 'read', 'p1', '{"path":"a.ts"}')
  assert.deepEqual(lines(viewNotice(s, ctx())), [], 'a notice while a call is pending never claims ✓')
  end(s, 'p1', { durationMs: 12 })
  assert.deepEqual(lines(viewNotice(s, ctx())), ['⬢ Read a.ts · ✓'])
}
{
  const s = state('medium')
  start(s, 'read', 'p1', '{"path":"a.ts"}')
  end(s, 'p1', { durationMs: 12 })
  start(s, 'read', 'p2', '{"path":"b.ts"}')
  end(s, 'p2', { durationMs: 12 })
  assert.deepEqual(lines(viewSettle(s, 'completed', ctx({ now: 800 }))), [
    '⬢ Read 2 files · ✓',
    '⬢ done · 0.8s',
  ])
}
{
  const s = state('medium')
  start(s, 'read', 'p1', '{"path":"a.ts"}')
  const actions = lines(viewSettle(s, 'cancelled', ctx({ now: 1200 })))
  assert.deepEqual(actions, ['⬡ Read a.ts · cancelled', '⬡ cancelled · 1.2s'])
  assert.equal(actions.some((line) => line.includes('✓')), false, 'a pending call never claims success')
}
{
  const s = state('medium')
  start(s, 'read', 'p1', '{"path":"a.ts"}')
  start(s, 'read', 'p2', '{"path":"b.ts"}')
  const actions = lines(viewSettle(s, 'failed', ctx({ now: 800 })))
  assert.deepEqual(actions, ['⬡ Read 2 files · failed', '⬢ failed · 0.8s'])
}

// ------------------------------------------------------- medium edge cases
{
  // Width clipping at 20/80/200 cells.
  const long = 'src/'.padEnd(60, 'a') + '.ts'
  for (const columns of [20, 80, 200]) {
    const s = state('medium')
    start(s, 'read', 'p1', JSON.stringify({ path: long }))
    end(s, 'p1', { durationMs: 12 })
    const text = lines(viewNotice(s, ctx({ columns })))[0] ?? ''
    assert.ok(
      displayCells(text) <= columns,
      `width ${String(columns)}: ${JSON.stringify(text)} is ${String(displayCells(text))} cells`,
    )
  }
  const wide = state('medium')
  start(wide, 'read', 'p1', JSON.stringify({ path: long }))
  end(wide, 'p1', { durationMs: 12 })
  // The row ends with the outcome, not a duration: `medium` reports what came
  // back, and the wide case must keep that whole rather than clip it.
  assert.equal(lines(viewNotice(wide, ctx({ columns: 200 })))[0]?.endsWith('✓'), true, 'wide terminals keep the line')
  const narrow = state('medium')
  start(narrow, 'read', 'p1', JSON.stringify({ path: long }))
  end(narrow, 'p1', { durationMs: 12 })
  assert.equal(lines(viewNotice(narrow, ctx({ columns: 20 })))[0]?.endsWith('…'), true, 'narrow lines are clipped')
}
{
  // A 200-character tool name is clipped, not wrapped or dropped.
  const s = state('medium')
  const name = `x${'y'.repeat(199)}`
  start(s, name, 'p1', '{}')
  const text = lines(end(s, 'p1', { durationMs: 5 }, ctx({ columns: 40 })))[0] ?? ''
  assert.ok(displayCells(text) <= 40)
  assert.ok(text.endsWith('…'))
}
{
  // CJK arguments: the summary is budgeted in cells, and no surrogate splits.
  const s = state('medium')
  start(s, 'read', 'p1', JSON.stringify({ path: '日本語/ファイル.ts' }))
  end(s, 'p1', { durationMs: 5 })
  const text = lines(viewNotice(s, ctx({ columns: 20 })))[0] ?? ''
  assert.ok(displayCells(text) <= 20)
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), false, 'no lone high surrogate')
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), false, 'no lone low surrogate')
}
{
  // Unknown tools print a humanised verb and their first argument, never the
  // payload JSON and never a fold.
  const s = state('medium')
  start(s, 'mystery.tool', 'p1', '{"x":1}')
  assert.deepEqual(lines(end(s, 'p1', { durationMs: 5 })), ['⬢ Mystery tool 1 · ✓'])
}

// ----------------------------------------------------------- compact matrix
{
  const s = state('compact')
  assert.deepEqual(lines(start(s, 'read', 'p1', '{"path":"a.ts"}')), [], 'compact prints no call line')
  assert.deepEqual(lines(end(s, 'p1', { durationMs: 12 })), [], 'compact prints no success line')
}
{
  const s = state('compact')
  assert.equal(viewActivity(s, ctx({ now: 400 })), 'working · 0.4s')
  start(s, 'read', 'p1')
  start(s, 'stat', 'p2')
  start(s, 'grep', 'p3')
  assert.equal(viewActivity(s, ctx({ now: 1800 })), 'working · 3 tools · 1.8s')
  start(s, 'write', 'p4')
  assert.equal(viewActivity(s, ctx({ now: 1800 })), 'working · 4 tools · 1.8s')
}
{
  const s = state('compact')
  start(s, 'read', 'p1', '{"path":"a.ts"}')
  const actions = lines(end(s, 'p1', { ok: false, error: 'ENOENT: no such file', durationMs: 12 }))
  assert.deepEqual(actions, ['  ⎿  ✗ read · ENOENT: no such file'], 'exactly one red detail line')
}
{
  const s = state('compact')
  start(s, 'process.start', 'p1', '{"command":"dev"}')
  assert.deepEqual(lines(end(s, 'p1', { durationMs: 4, result: { output: 'started dev — running (pid 1234)' } })), [
    '  ⎿  ⬡ process.start · started dev — running (pid 1234)',
  ])
}
{
  const s = state('compact')
  start(s, 'process.kill', 'p1', '{"id":"dev"}')
  assert.deepEqual(lines(end(s, 'p1', { durationMs: 4, result: 'stopped dev' })), ['  ⎿  ⬡ process.kill · stopped dev'])
  start(s, 'process.start', 'p2')
  assert.deepEqual(lines(end(s, 'p2', { durationMs: 4 })), ['  ⎿  ⬡ process.start'], 'no result line is fine')
}
{
  const s = state('compact')
  start(s, 'read', 'p1')
  assert.deepEqual(lines(viewSettle(s, 'completed', ctx({ now: 800 }))), ['⬢ done · 0.8s'])
}
{
  const s = state('compact')
  start(s, 'read', 'p1')
  assert.deepEqual(lines(viewSettle(s, 'cancelled', ctx({ now: 1200 }))), ['⬡ cancelled · 1.2s'])
}
{
  const s = state('compact')
  assert.equal(viewActivity(s, ctx({ tty: false })), undefined, 'a pipe has no plate')
  start(s, 'read', 'p1', '{"path":"a.ts"}')
  assert.equal(viewActivity(s, ctx({ tty: false })), undefined)
  assert.deepEqual(lines(end(s, 'p1', { ok: false, error: 'boom' })), ['  ⎿  ✗ read · boom'])
}
{
  const s = state('compact')
  start(s, 'read', 'p1')
  s.runError = 'boom'
  assert.deepEqual(lines(viewSettle(s, 'failed', ctx({ now: 800 }))), ['⬢ failed · 0.8s', '  ⎿  boom'])
}
{
  // `Z1_TRAY=off`: no plate, but a real tty still shows failures and the row.
  const s = state('medium')
  assert.equal(viewActivity(s, ctx({ tty: false })), undefined)
  start(s, 'read', 'p1', '{"path":"a.ts"}')
  end(s, 'p1', { durationMs: 12 })
  assert.deepEqual(lines(viewNotice(s, ctx({ tty: false }))), ['⬢ Read a.ts · ✓'])
}

// ------------------------------------------------------- no ANSI with plain
{
  const s = state('medium')
  const collected: string[] = []
  start(s, 'web.search', 'p1', '{"query":"a"}')
  end(s, 'p1', { durationMs: 3, size: 4 })
  start(s, 'read', 'p2', '{"path":"日本語.ts"}')
  collected.push(...lines(end(s, 'p2', { ok: false, error: 'ENOENT', durationMs: 5 })))
  collected.push(...lines(viewSettle(s, 'failed', ctx({ now: 900 }))))
  collected.push(viewActivity(s, ctx()) ?? '')
  for (const text of collected) {
    assert.equal(text, stripAnsi(text), `plain text carries no escape: ${JSON.stringify(text)}`)
  }
}

// --------------------------------------------------------------- viewStatus
assert.equal(viewStatus('medium', plain), 'view · medium · compact | medium | full')
assert.equal(viewStatus('compact', plain), 'view · compact · compact | medium | full')
{
  const accent: ViewTheme = { ...plain, cyan: (text) => `[cyan]${text}[/cyan]` }
  assert.equal(viewStatus('full', accent), 'view · [cyan]full[/cyan] · compact | medium | full')
}

// ---------------------------------------------------------- replay grouping
{
  const calls = [
    { name: 'read', args: '{"path":"a.ts"}' },
    { name: 'read', args: '{"path":"b.ts"}' },
    { name: 'stat', args: '{"path":"c.ts"}' },
  ]
  assert.deepEqual(groupStoredCalls(calls, ctx()), ['⬢ Read 3 files'], 'a stored group makes no result claim')
}
assert.deepEqual(groupStoredCalls([{ name: 'read', args: '{"path":"src/a.ts"}' }], ctx()), ['⬢ Read src/a.ts'])
assert.deepEqual(
  groupStoredCalls(
    [
      { name: 'read', args: '{"path":"a.ts"}' },
      { name: 'write', args: '{"path":"c.ts"}' },
      { name: 'read', args: '{"path":"b.ts"}' },
    ],
    ctx(),
  ),
  ['⬢ Read a.ts', '⬢ Write c.ts', '⬢ Read b.ts'],
  'a write is never grouped in replay either',
)
assert.deepEqual(
  groupStoredCalls(
    [
      { name: 'read', args: '{"path":"a.ts"}' },
      { name: 'read', args: '{"path":"b.ts"}' },
      { name: 'write', args: '{"path":"c.ts"}' },
      { name: 'read', args: '{"path":"d.ts"}' },
      { name: 'read', args: '{"path":"e.ts"}' },
    ],
    ctx(),
  ),
  ['⬢ Read 2 files', '⬢ Write c.ts', '⬢ Read 2 files'],
)

// ------------------------------------------------------------- view picker
assert.deepEqual([...VIEW_MODES], ['compact', 'medium', 'full'])
assert.equal(parseViewChoice('1'), 'compact')
assert.equal(parseViewChoice('2'), 'medium')
assert.equal(parseViewChoice('3'), 'full')
assert.equal(parseViewChoice('c'), 'compact')
assert.equal(parseViewChoice('M'), 'medium')
assert.equal(parseViewChoice('full'), 'full')
assert.equal(parseViewChoice('4'), undefined)
assert.equal(parseViewChoice('verbose'), undefined)
assert.deepEqual(viewListLines('medium', plain), [
  'view · medium',
  '  1. compact   prose and errors only',
  '  2. medium    same-family calls folded; writes never folded',
  '  3. full      every call and result',
])
{
  const rows = viewMenuItems('medium', 1, plain, 80)
  assert.deepEqual(
    rows.map((row) => row.mode),
    ['compact', 'medium', 'full'],
    'the picker keeps compact → medium → full order',
  )
  assert.deepEqual(rows.map((row) => row.current), [false, true, false], 'only the current mode is marked')
  assert.deepEqual(rows.map((row) => row.selected), [false, true, false], 'the current mode starts selected')
  assert.equal(rows[1]?.description, VIEW_DESCRIPTIONS.medium)
  assert.ok(rows[1]?.text.includes('⬢'), 'the current row carries the glyph')
  assert.ok(rows[1]?.text.includes('❯'), 'the selected row carries the pointer')
  assert.ok(rows[0]?.text.includes('compact') && rows[0]?.text.includes('prose and errors only'))
  assert.ok(rows[2]?.text.includes('full') && rows[2]?.text.includes('every call and result'))
  assert.equal(rows[0]?.text.includes('⬢'), false, 'a non-current row has no glyph')
}
{
  const rows = viewMenuItems('medium', 2, plain, 80)
  assert.equal(rows[2]?.selected, true)
  assert.equal(rows[2]?.text.startsWith('❯'), true)
  assert.equal(rows[1]?.text.includes('⬢'), true, 'moving the pointer leaves the current marker behind')
  assert.equal(rows[1]?.text.includes('❯'), false)
}
for (const columns of [20, 40, 80]) {
  for (const row of viewMenuItems('full', 0, plain, columns)) {
    assert.ok(
      displayCells(row.text) <= columns,
      `width ${String(columns)}: ${JSON.stringify(row.text)} is ${String(displayCells(row.text))} cells`,
    )
  }
}
{
  const row = viewMenuRow(
    { mode: 'medium', description: '日本語の説明がとても長いです' },
    { current: true, selected: false, theme: plain, width: 20 },
  )
  assert.ok(displayCells(row) <= 20)
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(row), false, 'no lone high surrogate')
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(row), false, 'no lone low surrogate')
}

console.log('PASS: view.test.mts (mode parsing, families, full strings, medium groups, compact, replay, no ANSI, picker rows)')
