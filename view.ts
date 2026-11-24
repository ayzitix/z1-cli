/**
 * Tool-activity density: a pure formatter for the three `/view` modes.
 *
 * This module owns everything that decides *what a turn looks like*: the family
 * table, the medium-mode grouping window, the compact plate label, the line
 * templates, and the sizes/durations those lines print. It has no `process`, no
 * `stdout`, no tail and no timer; the caller injects the theme, the terminal
 * width and the clock. `chat.ts` keeps only the SDK-event mapping, the
 * tail/markdown/spinner adapter, and the command wiring.
 *
 * Full mode is a move, not a redesign: the strings below are the ones the
 * console printed at HEAD. Medium buffers a group until it closes, because a
 * committed row cannot be retracted; compact hides the rows and leaves the
 * live plate alone.
 */

import { clip } from './width.ts'
import { callLine, resultSummary, toolTarget, toolVerb } from './tool-label.ts'

export type ViewMode = 'compact' | 'medium' | 'full'

/** The accents a line may use; the plain theme is the identity. */
export interface ViewTheme {
  dim: (text: string) => string
  bold: (text: string) => string
  cyan: (text: string) => string
  green: (text: string) => string
  red: (text: string) => string
  yellow: (text: string) => string
}

/** Everything the formatter cannot know without a terminal. */
export interface ViewContext {
  columns: number
  now: number
  /** False in a pipe or with `Z1_TRAY=off`: no plate, no escapes. */
  tty: boolean
  theme: ViewTheme
}

export type ViewEvent =
  | { type: 'tool.start'; path: string; name: string; args: string }
  | {
      type: 'tool.end'
      path: string
      ok: boolean
      error?: string
      durationMs: number
      size: number
      /** The raw result, for the compact background-process notice. */
      result?: unknown
      /**
       * An extra, dim tail for this one row (e.g. `started · /agents` after a
       * background `subagent` launch). Never a child tool call: the row stays
       * one line.
       */
      hint?: string
      /**
       * The delegating call started a background child. The row then reads
       * `started` (it is neither `✓` nor `✗`) and names `/agents`; `wait: true`
       * keeps the ordinary completed/failed row.
       */
      started?: boolean
    }
  | { type: 'node.failed'; path: string; error: string }
  | { type: 'run.failed'; error: string }

export type ViewAction =
  | { type: 'line'; text: string }
  | { type: 'activity'; text: string | undefined }

export interface ViewCall {
  name: string
  args: string
  summary: string | undefined
  family: string | undefined
}

export interface ViewGroup {
  family: string
  count: number
  pending: number
  durationMs: number
  size: number
  failures: number
  names: string[]
  summaries: (string | undefined)[]
  /** What the last result of the group was, for a one-call group's detail. */
  detail?: string
  failureName?: string
  failureError?: string
}

export interface ViewState {
  readonly mode: ViewMode
  readonly startedAt: number
  /** Calls that have started and not ended yet, keyed by graph path. */
  readonly calls: Map<string, ViewCall>
  group: ViewGroup | undefined
  toolCount: number
  assistantStarted: boolean
  /** Errors already printed as a detail row, so `settle` does not repeat them. */
  readonly shown: Set<string>
  runError: string | undefined
}

/** Argument payloads are one line; the cap keeps a tool call from flooding it. */
const MAX_ARGS = 120

/** Compact, single-line JSON of a tool argument payload, truncated to fit a row. */
export const compactArgs = (value: unknown): string => {
  let raw: string
  if (value === undefined || value === null) raw = '{}'
  else if (typeof value === 'string') raw = value
  else {
    try {
      raw = JSON.stringify(value) ?? '{}'
    } catch {
      raw = String(value)
    }
  }
  raw = raw.replace(/\s+/g, ' ').trim()
  if (raw.length === 0) raw = '{}'
  return raw.length <= MAX_ARGS ? raw : `${raw.slice(0, MAX_ARGS - 1)}…`
}

/** One line of a tool failure: strings as-is, objects by their `error` field. */
export const errorText = (value: unknown): string => {
  let raw: string
  if (typeof value === 'string') raw = value
  else if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['error'] === 'string') {
    raw = String((value as Record<string, unknown>)['error'])
  } else {
    raw = compactFailure(value)
  }
  raw = raw.replace(/\s+/g, ' ').trim()
  return raw.length === 0 ? 'error' : raw
}

/**
 * A tool result that is not a plain `{ error }`: the subagent result in 1.5c
 * is `{ status, errorCode, detail, … }`, and dumping it as JSON made a whole
 * payload land on one transcript row. A subagent failure therefore reads as
 * `partial · stopped by the step cap …` (or `timeout · child_timeout ·
 * …`), and anything else still falls back to compact JSON.
 */
const compactFailure = (value: unknown): string => {
  if (typeof value !== 'object' || value === null) return String(value)
  const record = value as Record<string, unknown>
  const status = record['status']
  if (typeof status === 'string' && record['runId'] !== undefined) {
    const code = typeof record['errorCode'] === 'string' ? ` · ${record['errorCode']}` : ''
    const detail = typeof record['detail'] === 'string' ? record['detail'].replace(/\s+/g, ' ').trim() : ''
    return detail.length === 0 ? `${status}${code}` : `${status}${code} · ${detail}`
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Payload size in characters, before it is turned into a label. */
export const resultSize = (value: unknown): number => {
  if (typeof value === 'string') return value.length
  try {
    return (JSON.stringify(value) ?? '').length
  } catch {
    return String(value).length
  }
}

/** The size the way a user reads it: characters, then kilobytes. */
export const sizeLabel = (count: number): string =>
  count < 1024 ? `${String(count)} B` : `${(count / 1024).toFixed(1)} KB`

/** Payload size the way a user reads it: characters, then kilobytes. */
export const byteSize = (value: unknown): string => sizeLabel(resultSize(value))

/** A single call's elapsed time; a group sum uses the coarser label. */
export const elapsedLabel = (ms: number): string =>
  ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 1000).toFixed(0)}s`

/** Durations below one second stay in milliseconds, as the per-call row did. */
export const durationLabel = (ms: number): string => (ms < 1000 ? `${String(Math.round(ms))}ms` : elapsedLabel(ms))

/**
 * Tool families that may be folded in medium mode.
 *
 * Writes are deliberately absent: a collapsed `write` hides which file changed,
 * which is the one fact medium exists to preserve. `web.status` is a health
 * probe, and `process.*` carries a task id, so neither is a search.
 */
const FAMILIES: Readonly<Record<string, string>> = {
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

/** The family a tool belongs to, or `undefined` when it is never grouped. */
export const familyOf = (name: string): string | undefined => FAMILIES[name]

/** Accept a full mode name or its first letter; anything else is `undefined`. */
export const parseViewMode = (raw: string): ViewMode | undefined => {
  const value = raw.trim().toLowerCase()
  if (value === 'compact' || value === 'c') return 'compact'
  if (value === 'medium' || value === 'm') return 'medium'
  if (value === 'full' || value === 'f') return 'full'
  return undefined
}

const asText = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.replace(/\s+/g, ' ').trim()
    return trimmed.length === 0 ? undefined : trimmed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/**
 * The terse target a medium row names: `package.json`, `a.ts → b.ts`, `TODO`.
 *
 * Delegates to `tool-label.ts`, so a call reads the same in every mode and an
 * unknown tool falls back to its first argument rather than to JSON.
 */
export const toolSummary = (name: string, args: string): string | undefined =>
  toolTarget(name, args)

/** The first meaningful line of a tool result, for the compact process notice. */
export const resultLine = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    return value.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['output', 'message', 'text', 'result', 'detail']) {
      const line = resultLine(record[key])
      if (line !== undefined) return line
    }
  }
  return undefined
}

const clipLine = (text: string, ctx: ViewContext): string =>
  clip(text, Math.max(1, ctx.columns - 2))

const hintTail = (hint: string | undefined, ctx: ViewContext): string =>
  hint === undefined || hint.length === 0 ? '' : ` ${ctx.theme.dim('·')} ${ctx.theme.dim(hint)}`

/**
 * The label a medium row starts with: `⬢ Read package.json`.
 *
 * The verb is the tool; the summary is what identifies this call. The old form
 * was `⬢ read → package.json` - an id in lowercase with an arrow, which read
 * as machine output rather than as a sentence.
 */
const callLabel = (name: string, summary: string | undefined, theme: ViewTheme): string =>
  `${theme.bold('⬢')} ${theme.cyan(toolVerb(name))}${summary === undefined ? '' : ` ${summary}`}`

/**
 * What a folded group of calls did, in words: `Read 3 files`, `Scanned 2
 * paths`.
 *
 * The old row was `⬢ scans · 2 · ✓ 41ms · 765 B`: a family id, a count, a
 * duration and a byte size. Three of those four are telemetry. The sentence
 * says the one thing a reader wants - what happened, and to how many things.
 */
const GROUP_NOUNS: Readonly<Record<string, string>> = {
  reads: 'files',
  scans: 'paths',
  searches: 'lookups',
  git: 'calls',
  todos: 'calls',
}

const groupLabel = (family: string, count: number, ctx: ViewContext, mark = '⬢'): string => {
  const { theme } = ctx
  const verb = family === 'reads' ? 'Read' : family === 'scans' ? 'Scanned' : family === 'searches' ? 'Searched' : family === 'git' ? 'Git' : 'Todo'
  const noun = GROUP_NOUNS[family] ?? 'calls'
  return `${mark === '⬢' ? theme.bold(mark) : theme.dim(mark)} ${theme.cyan(`${verb} ${String(count)} ${noun}`)}`
}

const singleOk = (
  name: string,
  summary: string | undefined,
  detail: string | undefined,
  ctx: ViewContext,
  hint?: string,
): string =>
  clipLine(
    `${callLabel(name, summary, ctx.theme)} ${ctx.theme.dim('·')} ${ctx.theme.green('✓')}${
      detail === undefined ? '' : ` ${ctx.theme.dim(detail)}`
    }${hintTail(hint, ctx)}`,
    ctx,
  )

const singleFail = (
  name: string,
  summary: string | undefined,
  _detail: string | undefined,
  ctx: ViewContext,
  hint?: string,
): string =>
  clipLine(
    `${callLabel(name, summary, ctx.theme)} ${ctx.theme.dim('·')} ${ctx.theme.red('✗')}${hintTail(hint, ctx)}`,
    ctx,
  )

const singleStarted = (
  name: string,
  summary: string | undefined,
  ms: number,
  ctx: ViewContext,
  hint?: string,
): string =>
  clipLine(
    `${callLabel(name, summary, ctx.theme)} ${ctx.theme.dim('·')} ${ctx.theme.cyan('started')} ${ctx.theme.dim(durationLabel(ms))}${hintTail(hint, ctx)}`,
    ctx,
  )

/**
 * A failure short enough to read.
 *
 * The error text used to carry the whole absolute path:
 *
 *     ✗ cannot read "x.txt": ENOENT: no such file or directory, lstat 'C:\Users\…
 *
 * Two things are noise on this row. The `cannot read "x.txt":` prefix repeats
 * what the call row above already says (`Read x.txt`), and the absolute path
 * spends the row's width saying where the home directory is. What identifies
 * the failure is the code and the sentence.
 *
 * Only *absolute* paths are shortened: a relative one (`tests/x.ts`) is the
 * file's own name and stays. Matching a bare `/` was how the first version
 * mangled `tests/does-not-exist.ts` into `testsdoes-not-exist.ts`.
 */
export const shortError = (error: string): string => {
  const text = error
    .replace(/\s+/g, ' ')
    // The tool's own decoration: `cannot read "<path>": `. The call row names
    // the file, so the prefix only repeats it.
    .replace(/^cannot (?:read|stat|list|write|open|rename) "[^"]*":\s*/, '')
    // An absolute Windows path (`C:\…`, `C:/…`) or POSIX path (`/…` at the
    // start of a token). Both keep their last two segments.
    .replace(/[A-Za-z]:[\\/][^'"\s]*|(?<=^|[\s'"(])\/[^\s'")]*/g, (match) => {
      const segments = match.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
      const tail = segments.slice(-2).join('/')
      return tail.length > 0 ? tail : match
    })
    .trim()
  return text.length <= 100 ? text : `${text.slice(0, 99)}…`
}

const failureDetail = (name: string, error: string, ctx: ViewContext): string =>
  clipLine(
    `  ${ctx.theme.dim('⎿')}  ${ctx.theme.red(`✗ ${name} · ${shortError(error)}`)}`,
    ctx,
  )

const groupLine = (group: ViewGroup, ctx: ViewContext): string => {
  const { theme } = ctx
  if (group.count === 1) {
    const name = group.names[0] ?? 'tool'
    const summary = group.summaries[0]
    return group.failures > 0
      ? singleFail(name, summary, undefined, ctx)
      : singleOk(name, summary, group.detail, ctx)
  }
  const label = groupLabel(group.family, group.count, ctx)
  if (group.failures > 0) {
    return clipLine(`${label} ${theme.dim('·')} ${theme.red(`✗ ${String(group.failures)}`)}`, ctx)
  }
  return clipLine(`${label} ${theme.dim('·')} ${theme.green('✓')}`, ctx)
}

const interruptedLine = (group: ViewGroup, status: string, ctx: ViewContext): string => {
  const { theme } = ctx
  if (group.count === 1) {
    const name = group.names[0] ?? 'tool'
    const summary = group.summaries[0]
    return clipLine(
      `${theme.dim('⬡')} ${theme.dim(toolVerb(name))}${summary === undefined ? '' : ` ${theme.dim(summary)}`} ${theme.dim(`· ${status}`)}`,
      ctx,
    )
  }
  return clipLine(`${groupLabel(group.family, group.count, ctx, '⬡')} ${theme.dim(`· ${status}`)}`, ctx)
}

/** Emit a buffered group once and forget it. `status` forces the interrupted form. */
const flushGroup = (
  state: ViewState,
  ctx: ViewContext,
  status?: string,
): ViewAction[] => {
  const group = state.group
  if (group === undefined) return []
  state.group = undefined
  if (status !== undefined) return [{ type: 'line', text: interruptedLine(group, status, ctx) }]
  if (group.failures > 0) {
    const actions: ViewAction[] = [{ type: 'line', text: groupLine(group, ctx) }]
    if (group.failureName !== undefined && group.failureError !== undefined) {
      actions.push({ type: 'line', text: failureDetail(group.failureName, group.failureError, ctx) })
    }
    return actions
  }
  return [{ type: 'line', text: groupLine(group, ctx) }]
}

export const createViewState = (mode: ViewMode, startedAt: number): ViewState => ({
  mode,
  startedAt,
  calls: new Map(),
  group: undefined,
  toolCount: 0,
  assistantStarted: false,
  shown: new Set(),
  runError: undefined,
})

const startEvent = (state: ViewState, event: Extract<ViewEvent, { type: 'tool.start' }>, ctx: ViewContext): ViewAction[] => {
  state.toolCount += 1
  const family = familyOf(event.name)
  const summary = toolSummary(event.name, event.args)
  state.calls.set(event.path, { name: event.name, args: event.args, summary, family })
  if (state.mode === 'full') {
    // `Read package.json`, not `read({"path":"package.json"})`: the transcript
    // is prose, and a JSON payload in the middle of it is the single loudest
    // reason the output read as machine noise.
    return [
      {
        type: 'line',
        text: `${ctx.theme.bold('⬢')} ${ctx.theme.cyan(callLine(event.name, event.args))}`,
      },
    ]
  }
  if (state.mode === 'compact') return []
  // Medium: a non-groupable call is a barrier; a different family closes first.
  const actions: ViewAction[] = []
  const close = (): ViewAction[] =>
    flushGroup(state, ctx, state.group !== undefined && state.group.pending > 0 ? 'incomplete' : undefined)
  if (family === undefined) {
    actions.push(...close())
    return actions
  }
  if (state.group !== undefined && state.group.family === family) {
    state.group.count += 1
    state.group.pending += 1
    state.group.names.push(event.name)
    state.group.summaries.push(summary)
    return actions
  }
  actions.push(...close())
  state.group = {
    family,
    count: 1,
    pending: 1,
    durationMs: 0,
    size: 0,
    failures: 0,
    names: [event.name],
    summaries: [summary],
  }
  return actions
}

const endEvent = (state: ViewState, event: Extract<ViewEvent, { type: 'tool.end' }>, ctx: ViewContext): ViewAction[] => {
  const call = state.calls.get(event.path)
  state.calls.delete(event.path)
  const name = call?.name ?? 'tool'
  const family = call?.family
  const summary = call?.summary ?? toolSummary(name, call?.args ?? '')
  const { theme } = ctx
  const error = event.error ?? 'error'
  if (state.mode === 'full') {
    const ms = `${String(event.durationMs)}ms`
    if (event.started === true) {
      return [
        {
          type: 'line',
          text: `  ${theme.dim('⎿')}  ${theme.cyan('started')} ${theme.dim(ms)}${hintTail(event.hint, ctx)}`,
        },
      ]
    }
    if (!event.ok) {
      state.shown.add(error)
      return [
        {
          type: 'line',
          text: `  ${theme.dim('⎿')}  ${theme.red(`✗ ${shortError(error)}`)} ${theme.dim(`· ${ms}`)}${hintTail(event.hint, ctx)}`,
        },
      ]
    }
    // What came back, not how long it took: `Read 120 lines` answers "did it
    // work?", where `✓ 408ms · 163 B` answers a question nobody asked. The
    // duration stays in `medium` and in the journal for anyone debugging speed.
    const result = resultSummary(name, event.result)
    return [
      {
        type: 'line',
        text: `  ${theme.dim('⎿')}  ${theme.green('✓')} ${theme.dim(result ?? `${ms} · ${sizeLabel(event.size)}`)}${hintTail(event.hint, ctx)}`,
      },
    ]
  }
  if (state.mode === 'compact') {
    if (!event.ok) {
      state.shown.add(error)
      return [{ type: 'line', text: failureDetail(name, error, ctx) }]
    }
    // A background child outlives the turn, like a background process: that is
    // the second compact break-through, and it says where to look.
    if (event.started === true) {
      return [
        {
          type: 'line',
          text: clipLine(
            `  ${theme.dim('⎿')}  ${theme.cyan(`started ${name}${event.hint === undefined ? '' : ` · ${event.hint}`}`)}`,
            ctx,
          ),
        },
      ]
    }
    // A background process outlives the turn: that is the one tool break-through.
    if (name === 'process.start' || name === 'process.kill') {
      const detail = resultLine(event.result)
      return [
        {
          type: 'line',
          text: clipLine(
            `  ${theme.dim('⎿')}  ${theme.dim(`⬡ ${name}${detail === undefined ? '' : ` · ${detail}`}`)}`,
            ctx,
          ),
        },
      ]
    }
    return []
  }
  // A background launch is neither done nor failed: it is one `started` row.
  // It never joins a group (groups are counts of finished calls) and it prints
  // its `/agents` tail on that one row.
  if (event.started === true) {
    return [{ type: 'line', text: singleStarted(name, summary, event.durationMs, ctx, event.hint) }]
  }
  // Medium.
  if (family !== undefined && state.group !== undefined && state.group.family === family) {
    const group = state.group
    group.pending = Math.max(0, group.pending - 1)
    group.durationMs += event.durationMs
    if (event.ok) {
      group.size += event.size
      // A one-call group prints its result on the line; a folded group names
      // only the count, because five different sizes on one row say nothing.
      group.detail = resultSummary(name, event.result, { verb: false })
      return []
    }
    group.failures += 1
    group.failureName = name
    group.failureError = error
    state.shown.add(error)
    return flushGroup(state, ctx)
  }
  // A solitary or ungrouped call is one line, printed when its result arrives.
  // The detail is what came back (`7 lines`), not how long it took.
  if (event.ok) {
    const detail = resultSummary(name, event.result, { verb: false })
    return [{ type: 'line', text: singleOk(name, summary, detail, ctx, event.hint) }]
  }
  state.shown.add(error)
  return [
    { type: 'line', text: singleFail(name, summary, undefined, ctx, event.hint) },
    { type: 'line', text: failureDetail(name, error, ctx) },
  ]
}

export const viewEvent = (state: ViewState, event: ViewEvent, ctx: ViewContext): readonly ViewAction[] => {
  switch (event.type) {
    case 'tool.start':
      return startEvent(state, event, ctx)
    case 'tool.end':
      return endEvent(state, event, ctx)
    case 'node.failed': {
      const actions: ViewAction[] = []
      if (state.mode === 'medium') {
        actions.push(...flushGroup(state, ctx, state.group !== undefined && state.group.pending > 0 ? 'failed' : undefined))
      }
      state.shown.add(event.error)
      actions.push({
        type: 'line',
        text: `  ${ctx.theme.dim('⎿')}  ${ctx.theme.red(`✗ ${event.path}`)} ${ctx.theme.dim(`· ${event.error}`)}`,
      })
      return actions
    }
    case 'run.failed':
      state.runError = event.error
      state.shown.add(event.error)
      return []
    default:
      return []
  }
}

/**
 * The first committed row of an assistant block. It closes a medium group only
 * when no call is still pending; the graph guarantees results arrive before the
 * next block's text, so a pending call here means the turn was cut off.
 *
 * It also sets `state.assistantStarted`, which `chat.ts` reads to decide whether
 * a blank line belongs above the block. One blank line between blocks and none
 * within one is the strongest structural cue a transcript has: without it a
 * tool row and the prose that follows read as the same paragraph.
 */
export const viewTextStart = (state: ViewState, ctx: ViewContext): readonly ViewAction[] => {
  state.assistantStarted = true
  if (state.mode !== 'medium' || state.group === undefined) return []
  if (state.group.pending > 0) return []
  return flushGroup(state, ctx)
}

/** A notice (`print`) closes a group only when no call is pending. */
export const viewNotice = (state: ViewState, ctx: ViewContext): readonly ViewAction[] => {
  if (state.mode !== 'medium' || state.group === undefined) return []
  if (state.group.pending > 0) return []
  return flushGroup(state, ctx)
}

/** The transient plate label; `undefined` means "no plate". */
export const viewActivity = (state: ViewState, ctx: ViewContext): string | undefined => {
  if (!ctx.tty) return undefined
  const elapsed = elapsedLabel(Math.max(0, ctx.now - state.startedAt))
  if (state.mode === 'compact') {
    return state.toolCount === 0
      ? `working · ${elapsed}`
      : `working · ${String(state.toolCount)} ${state.toolCount === 1 ? 'tool' : 'tools'} · ${elapsed}`
  }
  if (state.mode === 'medium') {
    if (state.group !== undefined) {
      if (state.group.count === 1) {
        const name = state.group.names[0] ?? 'tool'
        const summary = state.group.summaries[0]
        return `${name}${summary === undefined ? '' : ` → ${summary}`} · ${elapsed}`
      }
      return `${state.group.family} · ${String(state.group.count)} · ${elapsed}`
    }
    for (const call of state.calls.values()) {
      if (call.family === undefined) {
        return `${call.name}${call.summary === undefined ? '' : ` → ${call.summary}`} · ${elapsed}`
      }
    }
    return `working · ${elapsed}`
  }
  return undefined
}

/** The terminal row, the run error, and the two resume hints. */
export const viewSettle = (state: ViewState, status: string, ctx: ViewContext): readonly ViewAction[] => {
  const actions: ViewAction[] = []
  if (state.group !== undefined) {
    // Only a call whose result never arrived forces the outline form; a group
    // whose results all landed can still say ✓ even if the wider run failed.
    const forced =
      state.group.pending > 0
        ? status === 'cancelled'
          ? 'cancelled'
          : status === 'failed'
            ? 'failed'
            : 'incomplete'
        : undefined
    actions.push(...flushGroup(state, ctx, forced))
  }
  // An ungrouped call that never returned must not claim success either.
  if (state.mode === 'medium' && status !== 'completed') {
    for (const call of state.calls.values()) {
      if (call.family !== undefined) continue
      actions.push({
        type: 'line',
        text: clipLine(
          `${ctx.theme.dim('⬡')} ${ctx.theme.dim(call.name)}${
            call.summary === undefined ? '' : ` ${ctx.theme.dim('→')} ${ctx.theme.dim(call.summary)}`
          } ${ctx.theme.dim(`· ${status}`)}`,
          ctx,
        ),
      })
    }
  }
  state.calls.clear()
  const elapsed = elapsedLabel(Math.max(0, ctx.now - state.startedAt))
  if (status === 'completed') {
    actions.push({ type: 'line', text: ctx.theme.green(`⬢ done · ${elapsed}`) })
    return actions
  }
  if (status === 'cancelled') {
    actions.push({ type: 'line', text: ctx.theme.dim(`⬡ cancelled · ${elapsed}`) })
    return actions
  }
  actions.push({ type: 'line', text: ctx.theme.red(`⬢ failed · ${elapsed}`) })
  const message = state.runError
  if (message !== undefined && message.length > 0) {
    if (!state.shown.has(message)) {
      actions.push({ type: 'line', text: `  ${ctx.theme.dim('⎿')}  ${ctx.theme.red(message)}` })
    }
    if (message.includes('step limit')) {
      actions.push({
        type: 'line',
        text: `  ${ctx.theme.dim('⎿')}  ${ctx.theme.yellow('step limit reached — say "continue" to resume, or /new')}`,
      })
    } else if (message.includes('TIMEOUT')) {
      actions.push({
        type: 'line',
        text: `  ${ctx.theme.dim('⎿')}  ${ctx.theme.yellow('turn timed out — say "continue" to resume, or /new')}`,
      })
    }
  }
  return actions
}

/** `view · medium · compact | medium | full`, current mode in cyan. */
export const viewStatus = (mode: ViewMode, theme: ViewTheme): string =>
  `view · ${theme.cyan(mode)} · ${theme.dim('compact | medium | full')}`

/** The three modes, in picker order. */
export const VIEW_MODES = ['compact', 'medium', 'full'] as const

/** One line each in the picker and the numbered text list. */
export const VIEW_DESCRIPTIONS: Readonly<Record<ViewMode, string>> = {
  compact: 'prose and errors only',
  medium: 'same-family calls folded; writes never folded',
  full: 'every call and result',
}

export interface ViewMenuEntry {
  mode: ViewMode
  description: string
}

export interface ViewMenuRow extends ViewMenuEntry {
  current: boolean
  selected: boolean
  /** The styled, clipped row; the title is separate. */
  text: string
}

export const viewMenuEntries = (): readonly ViewMenuEntry[] =>
  VIEW_MODES.map((mode) => ({ mode, description: VIEW_DESCRIPTIONS[mode] }))

/**
 * One picker row: pointer for the selection, `⬢` for the current mode, the mode
 * name cyan (bold when selected), and a dim description clipped in cells.
 */
export const viewMenuRow = (
  entry: ViewMenuEntry,
  options: { current: boolean; selected: boolean; theme: ViewTheme; width: number },
): string => {
  const { theme } = options
  const pointer = options.selected ? `${theme.cyan('❯')} ` : '  '
  const mark = options.current ? theme.green('⬢') : ' '
  const name = entry.mode.padEnd(7)
  const label = options.selected ? theme.bold(theme.cyan(name)) : options.current ? theme.cyan(name) : name
  return clip(`${pointer}${mark} ${label}  ${theme.dim(entry.description)}`, Math.max(1, options.width - 1))
}

/**
 * The pure row model for the composer's `/view` picker: exactly three rows in
 * `compact`, `medium`, `full` order, the current one marked, the selected one
 * pointed at.
 */
export const viewMenuItems = (
  current: ViewMode,
  selected: number,
  theme: ViewTheme,
  width: number,
): readonly ViewMenuRow[] => {
  const index = Math.max(0, Math.min(selected, VIEW_MODES.length - 1))
  return viewMenuEntries().map((entry, offset) => ({
    ...entry,
    current: entry.mode === current,
    selected: offset === index,
    text: viewMenuRow(entry, {
      current: entry.mode === current,
      selected: offset === index,
      theme,
      width,
    }),
  }))
}

/**
 * The numbered list for `Z1_TRAY=off` and pipes. It is deliberately the same
 * order and wording as the picker, so `/view 2` means the row the user saw.
 */
export const viewListLines = (current: ViewMode, theme: ViewTheme): readonly string[] => [
  `view · ${theme.cyan(current)}`,
  ...VIEW_MODES.map(
    (mode, index) =>
      `  ${String(index + 1)}. ${mode.padEnd(10)}${theme.dim(VIEW_DESCRIPTIONS[mode])}`,
  ),
]

/** `/view 1|2|3` selects by row; names and `c|m|f` keep working. */
export const parseViewChoice = (raw: string): ViewMode | undefined => {
  const value = raw.trim().toLowerCase()
  if (value === '1') return 'compact'
  if (value === '2') return 'medium'
  if (value === '3') return 'full'
  return parseViewMode(value)
}

/**
 * Stored calls replayed under medium: group within one assistant message, no
 * result marker and no timing, because the stored message carries neither.
 */
export const groupStoredCalls = (
  calls: readonly { name: string; args: string }[],
  ctx: ViewContext,
): readonly string[] => {
  const lines: string[] = []
  let group: { family: string; count: number; names: string[]; summaries: (string | undefined)[] } | undefined
  const flush = (): void => {
    if (group === undefined) return
    const current = group
    group = undefined
    if (current.count === 1) {
      lines.push(clipLine(callLabel(current.names[0] ?? 'tool', current.summaries[0], ctx.theme), ctx))
      return
    }
    lines.push(
      clipLine(groupLabel(current.family, current.count, ctx), ctx),
    )
  }
  for (const call of calls) {
    const family = familyOf(call.name)
    const summary = toolSummary(call.name, call.args)
    if (family === undefined) {
      flush()
      lines.push(clipLine(callLabel(call.name, summary, ctx.theme), ctx))
      continue
    }
    if (group !== undefined && group.family === family) {
      group.count += 1
      group.names.push(call.name)
      group.summaries.push(summary)
      continue
    }
    flush()
    group = { family, count: 1, names: [call.name], summaries: [summary] }
  }
  flush()
  return lines
}
