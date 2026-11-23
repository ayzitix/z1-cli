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
import type { ViewTheme } from './view.ts'

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

const row = (entry: AgentEntry, index: number, cols: number, now: number, theme: AgentsTheme, statusWidth: number): string => {
  const mark = entry.outcome === 'running' ? theme.cyan(OUTCOME_MARK.running) : theme.dim(OUTCOME_MARK[entry.outcome])
  // Pad the plain label, then style it: padding a styled string would count
  // escape bytes and misalign every row.
  const plain = outcomeLabel(entry).padEnd(statusWidth)
  const status = styledStatus(entry, plain, theme)
  const description = entry.description.length === 0 ? theme.dim('(no description)') : entry.description
  const tail = theme.dim(
    `${elapsedLabel(entryElapsed(entry, now))} · ${stepLabel(entry.steps)} · ${shortRunId(entry.runId)}`,
  )
  return clip(
    `  ${String(index).padStart(2)}. ${mark} ${status}  ${description}  ${tail}`,
    Math.max(10, cols - 1),
  )
}

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

/** The header above one child's transcript. */
export const agentHeader = (input: AgentViewOptions): string => {
  const { entry, now, width, theme } = input
  const mark = entry.outcome === 'running' ? theme.cyan(OUTCOME_MARK.running) : theme.dim(OUTCOME_MARK[entry.outcome])
  const description = entry.description.length === 0 ? '(no description)' : entry.description
  const grant = `grant ${theme.dim(grantLabel(entry))}`
  const facts = theme.dim(
    `run ${entry.runId} · ${statusText(entry, theme)} · ${elapsedLabel(entryElapsed(entry, now))} · ${stepLabel(entry.steps)}`,
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
        const summary = summarize(item.arguments)
        lines.push(
          clip(`${theme.bold('⬢')} ${theme.cyan(name)}${summary === '' ? '' : ` ${theme.dim('→')} ${summary}`}`, cols),
        )
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
            `  ${theme.dim('⎿')}  ${failed ? theme.red(`✗ ${detail}`) : theme.green('✓')}${failed || detail === '' ? '' : ` ${theme.dim(detail)}`}`,
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
