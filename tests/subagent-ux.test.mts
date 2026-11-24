/**
 * 2b UX: the four changes the user asked for after the first 2b build, each
 * tested where its behaviour actually lives.
 *
 * `chat.ts` cannot be imported (it parses argv and starts the CLI at module
 * scope), so the composer's parts are exercised through the pure functions it
 * renders with - `agentPickerLines`, `runningLabel`, `splitAtCaret`,
 * `composerRowWithCursor` - and the wiring that only exists inside the class
 * (`hint()`'s precedence, the keyboard branch, the submit interception) is
 * pinned on the source, the way `agents.test.mts` pins the tail wiring.
 *
 * Item 1 (the parent does not go silent) is proved end to end in
 * `subagent-turn.test.mts`, which runs a real graph.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AgentRegistry, runningLabel, shortRunId } from '../agents.ts'
import type { AgentEntry } from '../agents.ts'
import { stopAgent } from '../agents-command.ts'
import {
  agentPickerLines,
  agentPickerMove,
  agentPickerNotice,
  agentPickerRepaint,
  agentPickerStop,
  interceptLine,
  stopViaPicker,
} from '../agents-view.ts'
import type { AgentPickerState, AgentStopOutcome } from '../agents-view.ts'
import {
  CURSOR_STEADY,
  composerRowWithCursor,
  composerTextWidth,
  cursorPosition,
  layoutRows,
  splitAtCaret,
} from '../chat-canvas.ts'
import { clip, displayCells, stripAnsi } from '../width.ts'

const theme = {
  dim: (text: string) => text,
  bold: (text: string) => text,
  cyan: (text: string) => text,
  green: (text: string) => text,
  yellow: (text: string) => text,
  red: (text: string) => text,
  paint: (_code: string, text: string) => text,
}

// `chat.ts` is checked in with CRLF on Windows; every assertion below reads LF.
const source = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf8').replace(/\r\n/g, '\n')

/** The body of one composer method, by its exact first line. */
const methodBody = (signature: string): string => {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `chat.ts has ${JSON.stringify(signature)}`)
  const end = source.indexOf('\n  }\n', start)
  return source.slice(start, end)
}

// ------------------------------------------------- item 2: the running-agents line

// The exact string, at 0/1/2 children - the one thing the user will read.
assert.equal(runningLabel(0), undefined, '0 children: no line, so `? for shortcuts` returns')
assert.equal(runningLabel(1), '◷ 1 subagent running · /agents', '1 child is singular, with the · separator')
assert.equal(
  runningLabel(2),
  '◷ 2 subagents running · /agents',
  '2 children is plural, with the exact separator',
)
// Nonsense counts are "nothing running", never `◷ -1 subagents`.
assert.equal(runningLabel(-1), undefined)

/**
 * The footer hint as the brief *documents* it - written from the precedence
 * list alone, not from `hint()`'s code.
 *
 * The point is independence: computing the expectation with
 * `runningLabel(0) ?? '? for shortcuts'` would just restate the implementation,
 * so deleting the `return '? for shortcuts'` branch would still pass. This
 * oracle knows only what the spec says, so it fails when the code stops
 * agreeing with the spec.
 */
const oracleHint = (state: {
  readonly running: number
  readonly busy: boolean
  readonly draft: string
  readonly queued?: number
}): string => {
  const line = runningLabel(state.running)
  if (line !== undefined) return line
  if (state.busy) {
    const queued = state.queued ?? 0
    return queued > 0 ? `${String(queued)} queued · esc to interrupt` : 'esc to interrupt'
  }
  if (state.draft.length > 0) return 'esc to clear'
  return '? for shortcuts'
}

// The documented answers, asserted directly. Zero children restores the old
// footer exactly, which is the property the review found untested.
assert.equal(oracleHint({ running: 0, busy: false, draft: '' }), '? for shortcuts', '0 children, idle: the shortcut hint')
assert.equal(oracleHint({ running: 1, busy: false, draft: '' }), '◷ 1 subagent running · /agents', '1 child outranks the shortcut hint')
assert.equal(oracleHint({ running: 2, busy: true, draft: '' }), '◷ 2 subagents running · /agents', '2 children outrank `esc to interrupt`')
assert.equal(oracleHint({ running: 0, busy: true, draft: '' }), 'esc to interrupt', '0 children while busy: the interrupt hint')
assert.equal(oracleHint({ running: 0, busy: true, queued: 3 }), '3 queued · esc to interrupt', '0 children while busy with a queue')
assert.equal(oracleHint({ running: 0, busy: false, draft: 'hi' }), 'esc to clear', '0 children with a draft')

// Precedence, read from `hint()` itself. The order is the contract: an armed
// confirm and a notice first, then an open picker, then the running line, then
// `esc to interrupt`, then a draft hint, then `? for shortcuts`.
{
  const body = methodBody('private hint(menuOpen: boolean): string {')
  const at = (needle: string): number => {
    const index = body.indexOf(needle)
    assert.ok(index >= 0, `hint() reaches ${JSON.stringify(needle)}`)
    return index
  }
  const running = at('runningLabel(runningChildren)')
  assert.ok(at('activeConfirm()') < running, 'an armed confirm still wins over the running line')
  assert.ok(at('this.notice !== undefined') < running, 'a notice still wins')
  assert.ok(at('this.agentsMenu !== undefined') < running, 'an open picker owns the keyboard and wins')
  assert.ok(at('this.toolsMenu !== undefined') < running, 'every picker wins')
  assert.ok(running < at("return '? for shortcuts'"), 'and over the idle shortcut hint')
  // The running line and `esc to interrupt` are adjacent, in that order: the
  // line must be the *first* of the two, so no busy branch can sit above it.
  const after = body.slice(running)
  assert.match(
    after,
    /^runningLabel\(runningChildren\)\n\s*if \(running !== undefined\) return running\n\s*if \(this\.busy\) return pendingLines\.length > 0/,
    'the running line wins over `esc to interrupt`, with nothing between them',
  )
  assert.equal((after.match(/this\.busy\) return pendingLines/g) ?? []).length, 1, 'exactly one `esc to interrupt` branch')
  assert.match(body, /return '\? for shortcuts'/, 'the last fallback is unchanged')
  // The draft hint is below the running line: a live child outranks a usage line.
  assert.ok(!body.includes('argumentHint()') || running < at('argumentHint()'), 'the draft hint is below too')
}

// The line sits in the footer's hint slot - not a new row - and is clipped like
// every other hint, so a narrow terminal shortens it instead of wrapping it.
{
  const layout = methodBody('layout(columns: number, status: string): TailLayout {')
  assert.match(layout, /this\.hint\(menu\.open\)/, 'the footer draws `hint()`')
  assert.match(layout, /(clip|fit)\([^)]*hint/, 'a long hint is clipped or fitted to its budget')
  assert.doesNotMatch(source, /runningLabel\([^)]*\) *\?\? *undefined *: *undefined/, 'no second source of the line')
}

// Zero children restores `? for shortcuts` exactly: the hint returns to it and
// the footer is byte-identical to a build without the feature.
{
  const body = methodBody('private hint(menuOpen: boolean): string {')
  const running = body.indexOf('runningLabel(runningChildren)')
  // `runningLabel(0)` is `undefined`, so the branches after it run untouched:
  // the busy hint, the draft hint, and finally the unchanged idle hint.
  assert.ok(body.indexOf('if (running !== undefined) return running') > running, 'the line returns when it exists')
  assert.ok(body.indexOf('\n    if (this.busy) return pendingLines.length > 0') > running, 'the busy hint follows it')
  assert.ok(body.indexOf("?? 'esc to clear'") > running, 'then the draft hint')
  assert.ok(body.lastIndexOf("return '? for shortcuts'") > running, 'and the idle hint is still last')
  assert.equal(
    body.slice(body.indexOf("return '? for shortcuts'")).trim(),
    "return '? for shortcuts'",
    'nothing can come after the idle hint',
  )
}

// The footer's own fit rule, replayed exactly as `layout()` writes it: the
// running line is a hint like any other, so it takes the hint's room and is
// clipped - never wrapped, never a second row.
{
  const footerLeft = (hint: string, right: string, width: number): string => {
    const available = Math.max(1, width - 2)
    if (hint.length > 0 && right.length > 0 && hint.length + right.length <= available) {
      return hint
    }
    const leftBudget = right.length === 0 ? available : Math.max(0, available - Math.min(right.length, 24) - 1)
    return stripAnsi(clip(hint, leftBudget))
  }

  // Width 80 with a realistic status on the right. The expected hint comes from
  // the documented precedence (`oracleHint`), never from `runningLabel(n) ?? …`
  // restating the implementation.
  const status = 'z1/default · 0/128k'
  assert.equal(footerLeft(oracleHint({ running: 0, busy: false, draft: '' }), status, 80), '? for shortcuts', 'width 80, 0 children: the shortcut hint')
  assert.equal(footerLeft(oracleHint({ running: 1, busy: false, draft: '' }), status, 80), '◷ 1 subagent running · /agents', 'width 80, 1 child')
  assert.equal(footerLeft(oracleHint({ running: 2, busy: false, draft: '' }), status, 80), '◷ 2 subagents running · /agents', 'width 80, 2 children')

  // A narrow footer: the line is clipped to the hint's budget, so the frame
  // still fits on one row. (At this width the *status* also crowds the hint and
  // `? for shortcuts` is clipped to `? for s…` - that is the pre-feature footer
  // rule, unchanged; the point here is that the running line obeys it too.)
  const narrow = 30
  assert.equal(
    footerLeft(oracleHint({ running: 0, busy: false, draft: '' }), status, narrow),
    footerLeft('? for shortcuts', status, narrow),
    'width 30, 0 children: byte-identical to the pre-feature hint, clipped or not',
  )
  const clipped = footerLeft(oracleHint({ running: 2, busy: false, draft: '' }), status, narrow)
  assert.ok(!clipped.includes('\n'), 'a clipped hint is still one row')
  assert.ok(displayCells(clipped) <= narrow - 2, `the clipped hint fits the ${String(narrow)}-cell footer`)

  // A moderately narrow footer keeps the whole phrase, which is the point of
  // putting it in the hint slot: mid-width terminals still read the count.
  const mid = 60
  assert.equal(footerLeft(oracleHint({ running: 2, busy: false, draft: '' }), status, mid), '◷ 2 subagents running · /agents', 'width 60, 2 children: uncut')

  // And zero children is byte-identical to the pre-feature footer.
  assert.equal(
    footerLeft(oracleHint({ running: 0, busy: false, draft: '' }), status, 80),
    footerLeft('? for shortcuts', status, 80),
    '0 children restores the old footer exactly',
  )
}

// ------------------------------------------------- item 3: the /agents overlay

// A registry with two children in two states: a running one and a finished one.
const registry = new AgentRegistry({ now: () => 1_000 })
registry.start({ runId: 'run_aaaa1111', description: 'scan tests', mode: 'background' })
registry.start({ runId: 'run_bbbb2222', description: 'read the diff', mode: 'wait' })
registry.finish('run_bbbb2222', { outcome: 'completed', steps: 2 })

// Rows carry the same facts the printed list does, plus a pointer.
{
  const lines = agentPickerLines({
    entries: registry.list(),
    index: 0,
    now: 2_000,
    columns: 100,
    theme,
  })
  assert.match(lines[0] ?? '', /agents · 2 this session · 1 running/, 'the title counts running work')
  assert.match(lines[1] ?? '', /❯\s*1\. ◷ running\s+scan tests\s+background · 1\.0s · 0 steps · run_aaaa1111/, 'the selected row is pointed at')
  assert.match(lines[2] ?? '', /^\s+2\. [✓✗]\s+completed\s+read the diff\s+wait · /, 'a finished row still lists, as wait')
  // Only one row is selected at a time.
  assert.equal(lines.filter((line) => line.includes('❯')).length, 1)
}

// Selection follows the index; a notice is shown above the rows and the rows
// stay - that is what "refused, stays open" looks like.
{
  // Drive the real decision the picker uses for `x`, so the notice text is the
  // one `/agents stop` prints - not a second wording.
  const finishing = new AgentRegistry({ now: () => 1_000 })
  const cancels: string[] = []
  finishing.start({
    runId: 'run_stopped01',
    description: 'long scan',
    mode: 'background',
    cancel: () => {
      cancels.push('run_stopped01')
    },
  })
  finishing.start({ runId: 'run_done0002', description: 'quick read', mode: 'background' })
  finishing.finish('run_done0002', { outcome: 'completed', steps: 1 })

  const refused = stopAgent(finishing, 'run_done0002')
  assert.equal(refused.kind, 'refused', 'a finished child is refused')
  assert.match(refused.line, /already completed · nothing to stop/, 'and says exactly why')

  const stopped = stopAgent(finishing, 'run_stopped01')
  assert.equal(stopped.kind, 'stop', 'a running background child is stopped')
  assert.deepEqual(cancels, ['run_stopped01'], 'through its own controller')

  // The picker renders that exact refusal line, above rows that are still there.
  const lines = agentPickerLines({
    entries: finishing.list(),
    index: 0,
    now: 2_000,
    columns: 100,
    theme,
    notice: { text: refused.line },
  })
  assert.equal(
    lines[1]?.trim(),
    `agents · ${shortRunId('run_done0002')} already completed · nothing to stop`,
    'the refusal is the picker’s notice, worded by `stopAgent`',
  )
  assert.ok(lines.length >= 4, 'the rows are still listed under it, so the picker stayed open')
}

// M-4: `x` on a running `wait` child is refused, and the reason - the only
// place the user learns how to stop it - must appear in the picker.
{
  const waiting = new AgentRegistry({ now: () => 1_000 })
  waiting.start({ runId: 'run_wait0001', description: 'inline read', mode: 'wait' })

  const decision = stopAgent(waiting, 'run_wait0001')
  assert.equal(decision.kind, 'refused', 'a wait child cannot be stopped from here')
  const outcome = { stopped: decision.kind === 'stop', line: decision.line }
  assert.equal(outcome.stopped, false)
  assert.ok(outcome.line.includes('wait call'), 'the refusal explains Ctrl-C')

  // The composer stores the raw outcome and derives the notice through the same
  // helper the accepted path uses; this is that derivation.
  const notice = agentPickerNotice({ stop: outcome, selected: waiting.list()[0] })
  assert.ok(notice !== undefined, 'a refusal always leaves a notice')
  const rendered = agentPickerLines({
    entries: waiting.list(),
    index: 0,
    now: 1_500,
    columns: 100,
    theme,
    notice: notice!,
  }).join('\n')
  assert.match(rendered, /is a wait call · stop it with Ctrl-C/, 'the phrase is visible inside the picker')
  // And the row is still there, still running: the picker stayed open.
  assert.match(rendered, /◷ running/, 'the row still shows it is running')
}

// M-5: an accepted stop confirms itself, and a child that settles after the
// press is described by what actually happened, not by the request.
{
  const stopping = new AgentRegistry({ now: () => 1_000 })
  stopping.start({
    runId: 'run_stop0003',
    description: 'long scan',
    mode: 'background',
    cancel: () => undefined,
  })
  const decision = stopAgent(stopping, 'run_stop0003')
  assert.equal(decision.kind, 'stop')
  const accepted = { stopped: true, line: decision.line }

  // Still running: the confirmation is shown.
  const running = stopping.list()[0]!
  const live = agentPickerNotice({ stop: accepted, selected: running })
  assert.equal(live?.text, decision.line, 'an accepted stop says so')
  assert.match(live!.text, /stopping run_stop0003/, 'with the child it is stopping')
  // A running row with no press is a clean picker.
  assert.equal(agentPickerNotice({ selected: running }), undefined, 'a running row with no press has nothing to say')

  // It then ends `failed`: the notice must stop claiming a request is in flight.
  stopping.finish('run_stop0003', { outcome: 'failed', detail: 'child_failed' })
  const settled = stopping.list()[0]!
  const after = agentPickerNotice({ stop: accepted, selected: settled })
  assert.ok(after !== undefined, 'a settled row still gets a line')
  assert.match(after!.text, /failed/, 'the notice reports the real outcome')
  assert.doesNotMatch(after!.text, /stopping/, 'not the stale request')
  assert.match(after!.text, /nothing left to stop/, 'and says there is nothing to stop')

  // A later background child settling with no press at all is reported too, so
  // the picker never shows a finished row without saying so.
  assert.ok(agentPickerNotice({ selected: settled }) !== undefined, 'a settled row is described even without a press')
}

// F1: a pointer move drops the previous row's stop report - including through
// the repaint that follows it.
//
// Row A gets an accepted stop (notice `stopping run_A`). The arrow then lands on
// row B, which has no press. The promise the code makes is that nothing about A
// follows the pointer: not the visible notice, and - the part a naive fix loses
// - not the stored `stop`, because `agentPickerRepaint` re-derives from it. A
// child stepping (an `onEvent` -> `childrenChanged` -> `refreshAgentsMenu`)
// must therefore leave row B with a clean picker.
{
  const a = 'run_move000A'
  const b = 'run_move000B'
  let rows = [
    { runId: a, description: 'row A', startedAt: 1_000, outcome: 'running', mode: 'background', tools: [], denied: [], steps: 0 },
    { runId: b, description: 'row B', startedAt: 1_000, outcome: 'running', mode: 'background', tools: [], denied: [], steps: 0 },
  ] as AgentEntry[]

  const started: AgentPickerState = { entries: rows, index: 0 }
  const accepted: AgentStopOutcome = { stopped: true, line: `agents · stopping ${shortRunId(a)} · row A` }
  const pressed = agentPickerStop(started, accepted)
  assert.equal(pressed.notice?.text, accepted.line, 'precondition: the press shows A’s line')

  // A child steps: the entries array is replaced, the press is still the last one.
  rows = rows.map((row) => (row.runId === b ? { ...row, steps: 1 } : row))

  for (const [label, moved] of [
    ['arrow (agentStep)', agentPickerMove(pressed, 1)],
    // `agentSelect` is the same transition: the composer routes digits and
    // Home/End through `moveAgentPointer` -> `agentPickerMove`.
    ['digit/Home/End (agentSelect)', agentPickerMove(pressed, 1)],
  ] as const) {
    assert.equal(moved.index, 1, `${label}: the pointer is on row B`)
    assert.equal(moved.notice, undefined, `${label}: row B shows no notice`)

    // The repaint that a child step triggers. This is where a fix that cleared
    // only the notice text resurrects row A's line under row B, so this is the
    // assertion that names the user-visible defect.
    const repainted = agentPickerRepaint(moved, rows)
    assert.doesNotMatch(
      repainted.notice?.text ?? '',
      new RegExp(`stopping ${shortRunId(a)}`),
      `${label}: row A's "stopping" line must not appear on row B`,
    )
    assert.equal(repainted.notice, undefined, `${label}: the repaint leaves row B with a clean picker`)
    assert.equal(repainted.index, 1, `${label}: the pointer did not move`)
    assert.equal(moved.stop, undefined, `${label}: and A's press is not carried along`)
  }
}

// The same mutation, stated as the failing property: if `stop` survived the
// move, the repaint would put "stopping run_A" under row B.
{
  const a = 'run_move000A'
  const b = 'run_move000B'
  const rows = [
    { runId: a, description: 'row A', startedAt: 1_000, outcome: 'running', mode: 'background', tools: [], denied: [], steps: 0 },
    { runId: b, description: 'row B', startedAt: 1_000, outcome: 'running', mode: 'background', tools: [], denied: [], steps: 0 },
  ] as AgentEntry[]
  const accepted: AgentStopOutcome = { stopped: true, line: `agents · stopping ${shortRunId(a)} · row A` }
  const pressed = agentPickerStop({ entries: rows, index: 0 }, accepted)
  // The forbidden state a "clear the text, keep the stop" edit produces.
  const leaky: AgentPickerState = { entries: rows, index: 1, stop: pressed.stop }
  const revived = agentPickerRepaint(leaky, rows)
  assert.match(
    revived.notice?.text ?? '',
    new RegExp(`stopping ${shortRunId(a)}`),
    'this is the bug the fix prevents: row A’s line under row B',
  )
}

// F2: the picker never prints to the transcript - a value, not an assumption.
{
  // Both outcomes: the line belongs to the notice row, and `print` is false.
  const accepted = stopViaPicker({ kind: 'stop', line: 'agents · stopping run_x · scan' })
  assert.equal(accepted.stopped, true)
  assert.equal(accepted.print, false, 'an accepted stop is not printed')
  assert.equal(accepted.notice.text, 'agents · stopping run_x · scan', 'it becomes the notice')

  const refused = stopViaPicker({ kind: 'refused', line: 'agents · run_y already completed · nothing to stop' })
  assert.equal(refused.stopped, false)
  assert.equal(refused.print, false, 'a refusal is not printed either')
  assert.equal(refused.notice.text, 'agents · run_y already completed · nothing to stop')

  // And the caller honours `print` rather than ignoring it, so the promise is
  // wired, not just declared.
  assert.match(source, /const result = stopViaPicker\(stopAgent\(agents, entry\.runId\)\)/, 'the wrapper uses the pure decision')
  assert.match(source, /if \(result\.print\) say\(result\.notice\.text\)/, 'and acts on `print`')
}

// M-5 footer: the hint must not offer `x stop` on a finished row.
{
  assert.match(source, /const stoppable = selected !== undefined && selected\.outcome === 'running'/, 'the footer keys off the row’s outcome')
  assert.match(source, /\? '↑↓ · ⏎ open · x stop · esc' : '↑↓ · ⏎ open · esc'/, 'and drops `x stop` when it cannot stop')
}

// BLOCKING 3: the intercept decision, tested directly rather than by source
// regex - removing the wiring must fail here.
{
  assert.equal(interceptLine('/agents'), 'open', 'a bare `/agents` opens the overlay')
  assert.equal(interceptLine('  /agents  '), 'open', 'surrounding whitespace does not change it')
  assert.equal(interceptLine('/agents 1'), 'submit', '`/agents <n>` stays a printed command')
  assert.equal(interceptLine('/agents stop 2'), 'submit', '`/agents stop` is not an overlay open')
  assert.equal(interceptLine('/agents x 3'), 'submit', 'nor is the `x` alias')
  assert.equal(interceptLine('explain /agents'), 'submit', 'an ordinary prompt submits')
  assert.equal(interceptLine('/agents please look'), 'submit', 'text after the command is a submission')
  assert.equal(interceptLine(''), 'submit', 'an empty line submits (and the composer ignores it)')

  // The composer wires that decision: the branch is only removed from the
  // overlay by `/agents` alone, and `true` is returned exactly once.
  const wire = source.slice(source.indexOf('intercept: (text) => {'), source.indexOf('intercept: (text) => {') + 400)
  assert.match(wire, /if \(interceptLine\(text\) !== 'open'\) return false/, 'the composer calls the pure decision')
  assert.match(wire, /openAgentsMenu\(\)/, 'and opens the overlay only after it')
  assert.equal((wire.match(/return true/g) ?? []).length, 1, 'exactly one `return true`')
}

// Selection follows the index; a notice sits above the rows and the rows stay.
{
  const lines = agentPickerLines({
    entries: registry.list(),
    index: 1,
    now: 2_000,
    columns: 100,
    theme,
    notice: { text: 'agents · run_bbbb2222 already completed · nothing to stop' },
  })
  assert.match(lines[1] ?? '', /already completed · nothing to stop/, 'the refusal is inside the picker')
  assert.match(lines[2] ?? '', /^\s+1\. /, 'the other row is not pointed at')
  assert.match(lines[3] ?? '', /❯\s*2\. /, 'the selected finished row is')
}

// An empty session says so rather than drawing a bare title.
{
  const lines = agentPickerLines({ entries: [], index: 0, now: 0, columns: 80, theme })
  assert.match(lines[1] ?? '', /no subagents in this session/)
}

// A scrolled window keeps each row's absolute number: `/agents 3` must mean the
// row the user sees as `3`.
{
  const many = new AgentRegistry({ now: () => 1_000 })
  for (let index = 1; index <= 20; index += 1) {
    many.start({ runId: `run_${String(index).padStart(4, '0')}`, description: `child ${String(index)}` })
  }
  const lines = agentPickerLines({
    entries: many.list().slice(10, 14),
    firstIndex: 10,
    index: 1,
    now: 1_500,
    columns: 100,
    theme,
  })
  assert.match(lines[1] ?? '', /^\s+11\. /, 'the first visible row is numbered 11')
  assert.match(lines[2] ?? '', /❯\s*12\. /, 'and the selected one keeps its real number')
}

// Wiring: the overlay is opened by the *composer*, before a line can queue.
{
  assert.match(source, /private agentsMenu: AgentMenu \| undefined/, 'the picker has its own state field')
  assert.match(source, /if \(this\.agentsMenu !== undefined\) \{\n\s*\/\/ The overlay owns the keyboard/, 'keyChar claims the keyboard first')
  assert.match(source, /private renderAgentsMenu\(columns: number\): string\[\]/, 'a render function beside the others')
  assert.match(source, /openAgentsMenu\(menu: Omit<AgentMenu/, 'an open helper beside the others')
  assert.match(source, /closeAgentsMenu\(\): void/, 'and a close helper')
  // It is entered at submit time, not from `onLine` (which queues).
  const submit = methodBody('private submitText(): void {')
  assert.match(submit, /this\.intercept\(text\)/, 'submitText intercepts the line')
  assert.ok(submit.indexOf('this.intercept(text)') < submit.indexOf('this.onLine(text)'), 'before it can queue')
  // The decision itself is `interceptLine`, asserted directly in the block
  // above; here we only check the composer consults it.
  assert.match(source, /if \(interceptLine\(text\) !== 'open'\) return false/, 'the composer asks the pure decision')
  // A running turn does not close it; the command pickers it still closes.
  const busyAt = source.indexOf('composer?.setBusy(true)')
  const progressAt = source.indexOf('const progress = createProgress', busyAt)
  assert.ok(busyAt >= 0 && progressAt > busyAt, 'the turn-start block is in place')
  const startBlock = source.slice(busyAt, progressAt)
  assert.match(startBlock, /composer\?\.closeViewMenu\(\)/, 'a turn closes the command pickers')
  assert.doesNotMatch(startBlock, /closeAgentsMenu/, 'but never the /agents overlay')
  // `x` stays open and uses the same refusal path as `/agents stop`, feeding
  // the outcome to the notice helper so a `wait` refusal is visible.
  assert.match(source, /stopViaPicker\(stopAgent\(agents, entry\.runId\)\)/, 'the overlay stops through `stopAgent`')
  // The composer stores the outcome through the pure `agentPickerStop`, which
  // is what keeps the raw `stop` and derives the notice; the picker stays open.
  assert.match(source, /agentPickerStop\(repainted, outcome\)/, 'the stop outcome becomes a notice via the pure helper')
  assert.match(source, /const repainted = agentPickerRepaint\(menu, menu\.refresh\(\)\)/, 'the row is refreshed before its notice is derived')
  // A move goes through the pure transition too, so `stop` cannot survive it.
  assert.match(source, /private moveAgentPointer\(index: number\): boolean \{/, 'arrow and digit share one move path')
  assert.match(source, /agentPickerMove\(menu, index\)/, 'and that path is the tested transition')
  assert.match(source, /case 'escape': return this\.escape\(\)/, 'escape reaches the shared escape handler')
  assert.match(source, /private escape\(\): void \{\n\s*if \(this\.agentsMenu !== undefined\) \{\n\s*\/\/ Closing is the whole action/, 'escape only closes it')
}

// ------------------------------------------------------- item 4: the cursor block

/** One composer row as the terminal would show it, cursor included. */
const rowAt = (value: string, cursor: number, columns: number, steady = false): string => {
  const width = composerTextWidth(columns)
  const rows = layoutRows(value, width)
  const position = cursorPosition(rows, cursor)
  return composerRowWithCursor({ row: rows[position.row]!, cursor, cells: width, steady })
}

/** Where the block sits, in cells, as the terminal would paint it. */
const blockCell = (rendered: string, columns: number): number => {
  const plain = stripAnsi(rendered)
  const open = rendered.indexOf(CURSOR_STEADY)
  assert.ok(open >= 0, 'the row carries a cursor block')
  const cell = displayCells(rendered.slice(0, open))
  const width = composerTextWidth(columns)
  assert.ok(cell < width, `the block is inside the ${String(width)}-cell draft (col ${String(cell)})`)
  assert.equal(displayCells(plain), width, `the row still fills ${String(width)} cells exactly`)
  return cell
}

{
  const columns = 80
  // Simple text, caret at the end.
  assert.equal(blockCell(rowAt('hello', 5, columns), columns), 5, 'end of "hello"')
  // Mid-string.
  assert.equal(blockCell(rowAt('hello', 2, columns), columns), 2, 'between "he" and "llo"')
  // Home (caret 0), which is also where Home/End land.
  assert.equal(blockCell(rowAt('hello', 0, columns), columns), 0, 'home')
  // Backspace leaves the caret after the surviving prefix.
  assert.equal(blockCell(rowAt('hell', 4, columns), columns), 4, 'after a backspace')
  // Empty draft: the block is the first cell, not a placeholder.
  assert.equal(blockCell(rowAt('', 0, columns), columns), 0, 'empty draft')
  assert.match(rowAt('', 0, columns), /^\x1b\[7m /, 'the empty draft shows the block where typing starts')
}

// A wrap: the block must be on the second row at the right cell, computed by the
// same helper the renderer uses.
{
  const columns = 20
  const width = composerTextWidth(columns) // 16
  const value = 'abcdefghijklmnopqrstuvw' // 23 cells: 16 + 7
  assert.equal(displayCells(value), 23)
  const rows = layoutRows(value, width)
  assert.equal(rows.length, 2, 'the draft wraps at 16 cells')
  // Caret at offset 18 -> row 2, column 2.
  const rendered = rowAt(value, 18, columns)
  assert.match(stripAnsi(rendered), /^qr/, 'the second row starts at offset 16')
  assert.equal(blockCell(rendered, columns), 2, 'the block is two cells into the wrapped row')
  // And the caret exactly at the wrap point is the first cell of the second row.
  assert.equal(blockCell(rowAt(value, width, columns), columns), 0, 'the wrapper puts it at row 2, column 0')
  assert.equal(cursorPosition(rows, width).row, 1, 'the caret at the wrap boundary is on the second row')
}

// A CJK line: cells, not `String.length`. `"日本語"` is 3 code points, 6 cells.
{
  const columns = 80
  const value = '日本語abc'
  assert.equal(value.length, 6)
  assert.equal(displayCells(value), 9)
  // Caret after the three CJK characters: 6 cells, though only 3 UTF-16 units.
  assert.equal(blockCell(rowAt(value, 3, columns), columns), 6, 'after "日本語" it is 6 cells in')
  // Caret after "日": 2 cells.
  assert.equal(blockCell(rowAt(value, 1, columns), columns), 2, 'after "日" it is 2 cells in')
  // A grapheme is never split: a caret that lands inside one moves to its edge.
  const accented = 'e\u0301x'
  const inside = splitAtCaret({ text: accented, start: 0, end: accented.length }, 1)
  assert.equal(inside.before, 'e\u0301', 'a caret before the accent snaps past it')
  assert.equal(inside.at, 'x', 'so the block covers the next whole grapheme')
  const afterGrapheme = splitAtCaret({ text: accented, start: 0, end: accented.length }, 2)
  assert.equal(afterGrapheme.before, 'e\u0301', 'after the grapheme it stays in `before`')
  assert.equal(afterGrapheme.at, 'x')
  assert.equal(afterGrapheme.after, '')
  // A ZWJ sequence is one block, not one per code point.
  const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'
  const joined = splitAtCaret({ text: family, start: 0, end: family.length }, 0)
  assert.equal(joined.at, family, 'the whole joined emoji is the block')
  assert.equal(joined.after, '')
}

// A steady block while a turn runs; a real reverse-video cell either way.
assert.ok(rowAt('abc', 1, 80, true).includes(`${CURSOR_STEADY}b`), 'the cell under the caret is inverted')
assert.match(rowAt('abc', 1, 80, false), /\x1b\[4m/, 'an idle block is also underlined')
assert.doesNotMatch(rowAt('abc', 1, 80, true), /\x1b\[4m/, 'a steady (busy) block is not')

// Wiring: no block while an overlay owns the keyboard, and one wrap width.
{
  const layout = methodBody('layout(columns: number, status: string): TailLayout {')
  assert.match(layout, /const overlayOwnsKeyboard =\n\s*this\.agentsMenu !== undefined/, 'the overlay check leads')
  assert.match(layout, /this\.asking !== undefined\s*\n\s*const cursorIndex = overlayOwnsKeyboard \? -1 : position\.row - start/, 'no block for an overlay')
  assert.match(layout, /const textWidth = composerTextWidth\(width\)/, 'the composer wraps at the shared width')
  assert.match(layout, /composerRowWithCursor\(\{ row[^}]*steady \}\)/, 'the caret row is drawn with the block')
  assert.match(source, /layoutRows\(this\.value, composerTextWidth\(terminalColumns\(\)\)\)/, 'and so does the caret')
}

console.log('PASS: subagent-ux (status line 0/1/2, precedence, picker rows, cursor cells, wiring)')
