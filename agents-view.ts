/**
 * `/agents`: the read-only renderer for this session's delegated children.
 *
 * Pure like `view.ts`: the caller injects the theme, the width and the clock, so
 * the command, the exit summary and the tests all print the same rows. Two
 * views:
 *
 * - the list: running first, then finished (the registry's `list()` order),
 *   each row numbered so `/agents 2` means the row the user just read;
 * - one child's transcript: its journal events in the transcript's own row
 *   style (assistant text, `⬢ tool → args`, `⎿ ✓/✗`, `⬡` interruptions, the
 *   terminal row), behind a header with the grant, steps and elapsed time.
 *
 * A child's tool calls are printed here and only here: the parent transcript
 * keeps one `subagent` row (the #1 complaint across Zed/Claude/opencode was
 * inlining them).
 */

import {
  entryElapsed,
  elapsedLabel,
  grantLabel,
  shortRunId,
  stepLabel,
  type AgentEntry,
  type AgentOutcome,
  type AgentResolution,
} from './agents.ts'
import { clip } from './width.ts'
import { callLine } from './tool-label.ts'
import type { ViewTheme } from './view.ts'
import { shortError } from './view.ts'

/** The colours a row may use; the same set `view.ts` takes. */
export interface AgentsTheme extends ViewTheme {}

/** One run event as the transcript view reads it (the `RunEvent` subset). */
export type AgentEventRow =
  | { type: 'node.started'; path: string }
  | { type: 'node.stream'; path: string; port: string; chunk: unknown }
  | {
      type: 'node.completed'
      path: string
      durationMs: number
      outputs: Record<string, unknown>
    }
  | { type: 'node.failed'; path: string; error: string }
  | { type: 'run.completed' }
  | { type: 'run.failed'; error: string }
  | { type: 'run.cancelled' }
  | { type: 'run.suspended'; path: string }
  | { type: string }

/** The header's facts; they come from the registry, never from the journal. */
export interface AgentViewOptions {
  readonly entry: AgentEntry
  readonly events: readonly AgentEventRow[]
  readonly now: number
  readonly width: number
  readonly theme: AgentsTheme
}

const OUTCOME_MARK: Readonly<Record<AgentOutcome, string>> = {
  running: '◷',
  completed: '✓',
  failed: '✗',
  cancelled: '⬡',
  timeout: '✗',
  partial: '◐',
}

/** The word a status column prints for each outcome. */
export const outcomeLabel = (entry: AgentEntry): string => {
  if (entry.outcome === 'timeout') return 'timed out'
  if (entry.outcome === 'failed' && entry.errorCode === 'child_timeout') return 'timed out'
  if (entry.outcome === 'failed' && entry.errorCode === 'child_cancelled') return 'cancelled'
  return entry.outcome
}

const statusText = (entry: AgentEntry, theme: AgentsTheme): string => {
  const label = outcomeLabel(entry)
  switch (entry.outcome) {
    case 'running':
      return theme.cyan(label)
    case 'completed':
      return theme.green(label)
    case 'partial':
      return theme.yellow(label)
    case 'cancelled':
      return theme.dim(label)
    default:
      return theme.red(label)
  }
}

/** Colour an already padded label by the entry's outcome. */
const styledStatus = (entry: AgentEntry, padded: string, theme: AgentsTheme): string => {
  switch (entry.outcome) {
    case 'running':
      return theme.cyan(padded)
    case 'completed':
      return theme.green(padded)
    case 'partial':
      return theme.yellow(padded)
    case 'cancelled':
      return theme.dim(padded)
    default:
      return theme.red(padded)
  }
}

/**
 * One agent row: index, status glyph, description, `background`/`wait`, elapsed,
 * steps, run id.
 *
 * The printed list and the composer's picker both render through this, so the
 * two can never disagree about what a row says - only about the pointer and the
 * selected accent, which `selected` controls.
 */
export const agentRow = (
  entry: AgentEntry,
  index: number,
  options: {
    readonly cols: number
    readonly now: number
    readonly theme: AgentsTheme
    readonly statusWidth: number
    /** The picker's highlighted row: a `❯` pointer and a bold, cyan label. */
    readonly selected?: boolean
  },
): string => {
  const { cols, now, theme, statusWidth } = options
  const selected = options.selected === true
  const mark = entry.outcome === 'running' ? theme.cyan(OUTCOME_MARK.running) : theme.dim(OUTCOME_MARK[entry.outcome])
  // Pad the plain label, then style it: padding a styled string would count
  // escape bytes and misalign every row.
  const plain = outcomeLabel(entry).padEnd(statusWidth)
  const status = styledStatus(entry, plain, theme)
  const raw = entry.description.length === 0 ? '(no description)' : entry.description
  const description = selected ? theme.bold(raw) : raw
  const mode = theme.dim(entry.mode === 'wait' ? 'wait' : 'background')
  const tail = theme.dim(
    `${mode} · ${elapsedLabel(entryElapsed(entry, now))} · ${stepLabel(entry.steps)} · ${shortRunId(entry.runId)}`,
  )
  const pointer = selected ? `${theme.cyan('❯')} ` : '  '
  return clip(
    `${pointer}${String(index).padStart(2)}. ${mark} ${status}  ${description}  ${tail}`,
    Math.max(10, cols - 1),
  )
}

const row = (entry: AgentEntry, index: number, cols: number, now: number, theme: AgentsTheme, statusWidth: number): string =>
  agentRow(entry, index, { cols, now, theme, statusWidth })

/**
 * The list view. An empty list is one dim line, not an empty screen; the
 * caller prints a header line above it either way.
 */
export const agentListLines = (input: {
  readonly entries: readonly AgentEntry[]
  readonly now: number
  readonly columns: number
  readonly theme: AgentsTheme
}): readonly string[] => {
  const { entries, now, columns, theme } = input
  if (entries.length === 0) {
    return [theme.dim('  no subagents in this session · the model calls subagent to delegate')]
  }
  const running = entries.filter((entry) => entry.outcome === 'running').length
  const heading =
    running === 0
      ? `agents · ${String(entries.length)} this session`
      : `agents · ${String(entries.length)} this session · ${String(running)} running`
  // One status column width for every row, so descriptions line up.
  const statusWidth = Math.max(...entries.map((entry) => outcomeLabel(entry).length))
  return [
    heading,
    ...entries.map((entry, index) => row(entry, index + 1, columns, now, theme, statusWidth)),
  ]
}

/** The notice a picker shows in place of a row when a key was refused. */
export interface AgentPickerNotice {
  readonly text: string
}

/**
 * The pure row model for the composer's `/agents` picker.
 *
 * It is `agentListLines`' content (same `agentRow`, same order, same heading)
 * plus a pointer on the selected row and one optional refusal line, so the
 * overlay and the printed fallback cannot drift apart. The composer only draws
 * these strings; it decides nothing about what a row says.
 */
export const agentPickerLines = (input: {
  readonly entries: readonly AgentEntry[]
  readonly index: number
  readonly now: number
  readonly columns: number
  readonly theme: AgentsTheme
  /** A refused key (`x` on a finished child): shown, the picker stays open. */
  readonly notice?: AgentPickerNotice
  /**
   * Entries shown are a window into a longer list, and `entries[0]` is row
   * `firstIndex + 1` - the row number `/agents <n>` takes. Default 0.
   */
  readonly firstIndex?: number
}): readonly string[] => {
  const { entries, now, columns, theme } = input
  const first = Math.max(0, input.firstIndex ?? 0)
  const running = entries.filter((entry) => entry.outcome === 'running').length
  const counts = `${String(entries.length)} this session${running === 0 ? '' : ` · ${String(running)} running`}`
  const lines: string[] = [
    clip(`  ${theme.bold('agents')} · ${counts}`, Math.max(1, columns - 1)),
  ]
  if (input.notice !== undefined) {
    lines.push(clip(`  ${theme.yellow(input.notice.text)}`, Math.max(1, columns - 1)))
  }
  if (entries.length === 0) {
    lines.push(theme.dim('  no subagents in this session · the model calls subagent to delegate'))
    return lines
  }
  // One status column width for every row, so descriptions line up - the same
  // rule the printed list uses.
  const statusWidth = Math.max(...entries.map((entry) => outcomeLabel(entry).length))
  const selected = Math.max(0, Math.min(input.index, entries.length - 1))
  return [
    ...lines,
    ...entries.map((entry, offset) =>
      agentRow(entry, first + offset + 1, {
        cols: columns,
        now,
        theme,
        statusWidth,
        selected: offset === selected,
      }),
    ),
  ]
}

/**
 * What pressing `x` on a row produced.
 *
 * `line` is the message the user must see either way: for a stop it is the
 * confirmation, for a refusal it is the reason. The picker never prints to the
 * transcript, so this string is the only place either fact can appear.
 */
export interface AgentStopOutcome {
  /** True when the child was told to stop (the request was accepted). */
  readonly stopped: boolean
  readonly line: string
}

/**
 * The notice an `x` press leaves in the picker, or `undefined` for nothing to say.
 *
 * Both outcomes need a line, and both were previously dropped:
 *
 * - **refused** (a finished child, a `wait` child, no controller): the reason.
 *   For a `wait` child this is the *only* way the user learns it must be
 *   stopped with Ctrl-C in its own turn, so it must be shown, not just painted
 *   over a row that still says `running`.
 * - **accepted**: a confirmation, because a stop that ends `failed`/`timeout`
 *   later would otherwise look like nothing happened.
 *
 * A child that has since settled is reported as settled by `agentPickerNotice`
 * below, which outranks a stale confirmation.
 */
export const agentStopNotice = (outcome: AgentStopOutcome): AgentPickerNotice => ({
  text: outcome.line,
})

/**
 * The notice to keep on screen for the selected row, given what an `x` press
 * returned and whether the row has settled since.
 *
 * A stop is only a request: the child ends later, possibly `failed` or
 * `timeout`. Showing "stopping …" beside a finished row (and a footer still
 * offering `x stop`) would be a lie, so once the row is no longer running the
 * confirmation is replaced by what actually happened.
 */
export const agentPickerNotice = (input: {
  /** What the last `x` returned, if it is still relevant. */
  readonly stop?: AgentStopOutcome
  /** The row the pointer is on, after the refresh. */
  readonly selected?: AgentEntry
}): AgentPickerNotice | undefined => {
  const { stop, selected } = input
  if (selected !== undefined && selected.outcome !== 'running') {
    // Settled: report the row's real state, not the request that was accepted.
    // A refusal on a finished row already names that state, so it is kept.
    if (stop !== undefined && !stop.stopped) return agentStopNotice(stop)
    return { text: agentSettledLine(selected) }
  }
  return stop === undefined ? undefined : agentStopNotice(stop)
}

/** `agents · run_x finished · failed · nothing to stop` for a settled row. */
const agentSettledLine = (entry: AgentEntry): string => {
  const detail = entry.detail === undefined ? '' : ` · ${entry.detail}`
  return `agents · ${shortRunId(entry.runId)} ${entry.outcome}${detail} · nothing left to stop`
}

/**
 * The picker's own state, separated from the composer so its transitions can be
 * tested: which rows, which is pointed at, and what the last `x` said.
 *
 * `stop` is the *raw* outcome of the last press and `notice` is what is drawn
 * from it. Keeping both is what makes the two rules below expressible:
 *
 * - **a move drops the stop** (`agentPickerMove`): the notice describes one
 *   child and must never be re-derived against another. Clearing only the text
 *   and keeping `stop` looks identical until the next repaint, which would then
 *   recompute the old row's line for the new selection - the defect this field
 *   exists to prevent.
 * - **a repaint re-derives the notice** (`agentPickerRepaint`): a stop is only a
 *   request, so the child may have settled since; the notice must follow the
 *   row's real state, not the press.
 */
export interface AgentPickerState {
  readonly entries: readonly AgentEntry[]
  readonly index: number
  readonly stop?: AgentStopOutcome
  readonly notice?: AgentPickerNotice
}

const clampIndex = (index: number, length: number): number => Math.max(0, Math.min(index, Math.max(0, length - 1)))

/**
 * Move the pointer and drop the previous row's report.
 *
 * `stop` is set to `undefined` *and* the notice is recomputed from the new row,
 * so nothing about row A can survive onto row B - not even after a repaint.
 */
export const agentPickerMove = (state: AgentPickerState, index: number): AgentPickerState => {
  const next = clampIndex(index, state.entries.length)
  const selected = state.entries[next]
  const notice = agentPickerNotice({ ...(selected === undefined ? {} : { selected }) })
  return {
    entries: state.entries,
    index: next,
    stop: undefined,
    ...(notice === undefined ? {} : { notice }),
  }
}

/**
 * Replace the rows (a child started, stepped or settled) and re-derive the
 * notice against the row now under the pointer.
 */
export const agentPickerRepaint = (
  state: AgentPickerState,
  entries: readonly AgentEntry[],
): AgentPickerState => {
  const index = clampIndex(state.index, entries.length)
  const selected = entries[index]
  const notice = agentPickerNotice({ stop: state.stop, ...(selected === undefined ? {} : { selected }) })
  return {
    entries,
    index,
    ...(state.stop === undefined ? {} : { stop: state.stop }),
    ...(notice === undefined ? {} : { notice }),
  }
}

/** Record an `x` outcome and show its line. The picker stays open. */
export const agentPickerStop = (state: AgentPickerState, outcome: AgentStopOutcome): AgentPickerState => {
  const selected = state.entries[state.index]
  const notice = agentPickerNotice({ stop: outcome, ...(selected === undefined ? {} : { selected }) })
  return {
    ...state,
    stop: outcome,
    ...(notice === undefined ? {} : { notice }),
  }
}

/**
 * What an `x` press does with `stopAgent`'s decision, as a value.
 *
 * The picker's rule is "the line is shown in the picker, never printed to the
 * transcript": a printed line would scroll the display out from under an open
 * overlay, and would be the wrong place for a key press the user is looking at.
 * That promise was only implied by the caller ignoring it; `print` states it as
 * a value a test can assert, and the caller acts on it, so it cannot rot.
 */
export interface PickerStopResult {
  /** True when the child was told to stop (the registry must be repainted). */
  readonly stopped: boolean
  /** The line for the picker's notice row. */
  readonly notice: AgentPickerNotice
  /** Always false: the picker owns the line. Here so the rule is executable. */
  readonly print: boolean
}

/** Turn a `/agents stop` decision into the picker's result. Pure. */
export const stopViaPicker = (decision: StopDecisionLike): PickerStopResult => ({
  stopped: decision.kind === 'stop',
  notice: { text: decision.line },
  print: false,
})

/**
 * The part of `stopAgent`'s `StopDecision` this module needs, restated locally
 * so `agents-view.ts` does not import the command module (and the cycle that
 * would create).
 */
export interface StopDecisionLike {
  readonly kind: 'stop' | 'refused'
  readonly line: string
}

/**
 * What a submitted line means to the composer (2b): open the `/agents` overlay,
 * or hand the line to the normal submit path.
 *
 * Only a bare `/agents` opens it. `/agents stop 2` and `/agents <ref>` are real
 * commands that print to the transcript and must keep working exactly as
 * before, and every other line - including a prompt that merely starts with
 * `/agents` plus text - is a normal submission. This is a pure function so the
 * decision is testable without a terminal; the composer only calls it.
 */
export const interceptLine = (text: string): 'open' | 'submit' =>
  text.trim() === '/agents' ? 'open' : 'submit'

/** The header above one child's transcript. */
export const agentHeader = (input: AgentViewOptions): string => {
  const { entry, now, width, theme } = input
  const mark = entry.outcome === 'running' ? theme.cyan(OUTCOME_MARK.running) : theme.dim(OUTCOME_MARK[entry.outcome])
  const description = entry.description.length === 0 ? '(no description)' : entry.description
  const grant = `grant ${theme.dim(grantLabel(entry))}`
  const facts = theme.dim(
    `run ${entry.runId} · ${statusText(entry, theme)} · ${entry.mode === 'wait' ? 'wait' : 'background'} · ${elapsedLabel(entryElapsed(entry, now))} · ${stepLabel(entry.steps)}`,
  )
  return clip(`${mark} ${theme.bold(description)}  ${grant}  ${facts}`, Math.max(10, width - 1))
}

/** A tool call's one-line summary: its `path`, `command`, `pattern`, else compact JSON. */
const summarize = (value: unknown): string => {
  if (value === undefined || value === null) return ''
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return value.replace(/\s+/g, ' ').trim()
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return String(parsed)
  const record = parsed as Record<string, unknown>
  for (const key of ['path', 'command', 'pattern', 'query', 'url', 'name']) {
    const text = record[key]
    if (typeof text === 'string' && text.length > 0) return text
  }
  try {
    return JSON.stringify(parsed)
  } catch {
    return ''
  }
}

const textOf = (value: unknown, limit = 400): string | undefined => {
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0) return undefined
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
  }
  if (typeof value === 'object' && value !== null) {
    // A tool result is usually an object (`{ output }`, `{ stdout }`, …): the
    // first useful string field is what a reader wants, else compact JSON.
    const record = value as Record<string, unknown>
    for (const key of ['output', 'stdout', 'text', 'result', 'message', 'error']) {
      const nested = record[key]
      if (typeof nested === 'string' && nested.trim().length > 0) return textOf(nested, limit)
    }
    try {
      const raw = JSON.stringify(value) ?? ''
      return raw.length === 0 ? undefined : raw.length <= limit ? raw : `${raw.slice(0, limit - 1)}…`
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * The child's transcript, rebuilt from its own journal.
 *
 * Only what a reader needs: the model's text, each tool call with its result,
 * node failures, and the terminal row. The graph's own data nodes (prompt
 * assembly, message plumbing) are skipped — they are noise here, and the
 * journal keeps them for anyone who wants them.
 */
export const agentTranscriptLines = (input: AgentViewOptions): readonly string[] => {
  const { entry, events, now, width, theme } = input
  const cols = Math.max(10, width - 1)
  const lines: string[] = [agentHeader(input), '']

  let streamed = ''
  const flush = (): void => {
    const text = textOf(streamed, 20_000)
    streamed = ''
    if (text === undefined) return
    for (const line of text.split('\n')) lines.push(clip(`  ${line}`, cols))
  }

  for (const event of events) {
    if (event.type === 'node.stream' && 'path' in event) {
      const chunk = event['chunk']
      if (event['path'].endsWith('/chat') && event['port'] === 'text' && typeof chunk === 'string') {
        streamed += chunk
      }
      continue
    }
    if (event.type === 'node.completed' && 'path' in event) {
      const path = String(event['path'])
      const outputs = (event['outputs'] ?? {}) as Record<string, unknown>
      // The assistant turn: its text, or its fallback content when no stream
      // arrived (a provider without streaming).
      if (path.endsWith('/chat')) {
        const message = outputs['message'] as { role?: unknown; content?: unknown } | undefined
        const content = typeof message?.content === 'string' ? message.content.trim() : ''
        if (content.length > 0) {
          if (streamed.length === 0) streamed = content
        }
        flush()
        continue
      }
      // `mapInput` carries the call the model made; `mapCall` its result.
      const inputCall = /toolMap\/\d+\/mapInput$/.exec(path)
      if (inputCall !== null) {
        const item = (outputs['value'] as { item?: { name?: unknown; arguments?: unknown } } | undefined)?.item ?? {}
        const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : 'tool'
        // The same `Read package.json` the parent transcript prints: a child's
        // transcript is read next to it, and two dialects would be one too many.
        lines.push(clip(`${theme.bold('⬢')} ${theme.cyan(callLine(name, item.arguments))}`, cols))
        continue
      }
      const callResult = /toolMap\/\d+\/mapCall$/.exec(path)
      if (callResult !== null) {
        const failed = outputs['isError'] === true
        const result = outputs['result']
        const detail = failed
          ? textOf((result as { error?: unknown } | undefined)?.error ?? result, 200) ?? 'error'
          : (textOf(result, 200)?.split('\n')[0] ?? '')
        lines.push(
          clip(
            `  ${theme.dim('⎿')}  ${failed ? theme.red(`✗ ${shortError(detail)}`) : theme.green('✓')}${failed || detail === '' ? '' : ` ${theme.dim(detail)}`}`,
            cols,
          ),
        )
        continue
      }
      continue
    }
    if (event.type === 'node.failed' && 'path' in event) {
      flush()
      lines.push(
        clip(
          `  ${theme.dim('⎿')}  ${theme.red(`✗ ${String(event['path'])} · ${String(event['error']) }`)}`,
          cols,
        ),
      )
      continue
    }
    if (event.type === 'run.failed' && 'error' in event) {
      flush()
      lines.push(`  ${theme.dim('⎿')}  ${theme.red(String(event['error']))}`)
      continue
    }
  }
  flush()

  if (lines.at(-1) === '') lines.pop()

  // The terminal row: the same wording `view.ts` uses, plus the code that makes
  // a timeout readable as a timeout rather than a generic failure.
  const elapsed = elapsedLabel(entryElapsed(entry, now))
  const grant = theme.dim(`${stepLabel(entry.steps)} · ${elapsed} · ${grantLabel(entry)}`)
  switch (entry.outcome) {
    case 'running':
      lines.push(theme.cyan(`◷ running · ${elapsed}`))
      break
    case 'completed':
      lines.push(theme.green(`⬢ done · ${elapsed}`))
      break
    case 'cancelled':
      lines.push(theme.dim(`⬡ cancelled · ${elapsed}`))
      break
    case 'partial':
      lines.push(theme.yellow(`◐ partial · step cap reached · ${elapsed}`))
      break
    case 'timeout':
      lines.push(theme.red(`⬢ timed out · ${elapsed}`))
      break
    default:
      lines.push(theme.red(`⬢ failed · ${elapsed}`))
      break
  }
  if (entry.detail !== undefined && entry.detail.length > 0) {
    lines.push(clip(`  ${theme.dim('⎿')}  ${theme.dim(entry.detail)}`, cols))
  }
  if (entry.errorCode !== undefined) {
    lines.push(`  ${theme.dim('⎿')}  ${theme.dim(`code ${entry.errorCode}`)}`)
  }
  lines.push(`  ${grant}`)
  return lines
}

/** The completion hint the `subagent` tool row may append: `/agents run_1a2b…`. */
export const agentHint = (runId: string): string => `/agents ${shortRunId(runId)}`

/**
 * Why a `/agents` reference named no child, as one line the user can act on.
 * Each refusal says which mistake it was: an index outside the list, a prefix
 * that fits several children, or a value that names nothing at all.
 */
export const agentRefusal = (ref: string, resolution: AgentResolution): string => {
  const value = ref.trim()
  if (resolution.ok) return ''
  switch (resolution.reason) {
    case 'missing':
      return 'agents · say which one · /agents lists them'
    case 'index':
      return resolution.count === 0
        ? 'agents · no subagents in this session yet'
        : `agents · there ${resolution.count === 1 ? 'is' : 'are'} ${String(resolution.count)} · /agents ${value} is out of range`
    case 'ambiguous':
      return `agents · "${value}" matches ${String(resolution.matches.length)} children · use a longer id: ${resolution.matches.join(', ')}`
    default:
      return `agents · no child "${value}" in this session · /agents lists them`
  }
}
