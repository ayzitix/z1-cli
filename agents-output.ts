/**
 * What the user reads about a background child, per `/view` mode.
 *
 * `deliveredBlock` (`agents.ts`) is two things at once and they must not be
 * confused: it is the **contract with the model** - it is injected into the
 * turn's seed, so its bytes are prompt, and they must not vary with a display
 * setting - and it is also what the user sees, because printing what the model
 * reads is the honest default. Those two goals conflict the moment `/view`
 * exists: `compact` promises prose and errors only, while the model's block is
 * five lines of metadata before the answer.
 *
 * So the *screen* gets its own renderer here and the seed keeps
 * `deliveredBlock` unchanged. Each mode says the same facts at a different
 * density:
 *
 * - **compact** - one row: the outcome, the elapsed time and the child's own
 *   answer, no metadata. The run id is one `/agents` away.
 * - **medium** - the compact row, then the answer indented under it, so a
 *   one-line answer stays one line and a long one is not reflowed into the
 *   metadata.
 * - **full** - the model's own block, byte for byte. Nothing is hidden: this is
 *   the mode that exists to show what was actually sent.
 *
 * The child's text is still untrusted in all three: `neutraliseChildText` runs
 * before anything is printed, so a child cannot forge a row of ours.
 */

import {
  MAX_SUBAGENT_OUTPUT_TEXT,
  neutraliseChildText,
  shortRunId,
  truncateOutput,
  type AgentEntry,
} from './agents.ts'
import { outcomeLabel } from './agents-view.ts'
import { clip, displayCells } from './width.ts'
import type { ViewMode, ViewTheme } from './view.ts'

/**
 * The header every mode prints: what finished and how long it ran.
 *
 * The mark keeps the distinction the rest of the UI keeps: a child the user
 * stopped is `⬡` like any other interruption, never `✗`. "Did not finish" and
 * "went wrong" are different facts, and a cancelled child is the first.
 */
const headline = (entry: AgentEntry, elapsedMs: number, theme: ViewTheme): string => {
  const label = outcomeLabel(entry)
  const mark =
    label === 'completed'
      ? theme.green('✓')
      : label === 'running'
        ? theme.cyan('◷')
        : label === 'cancelled'
          ? theme.dim('⬡')
          : theme.red('✗')
  const name = entry.description.length === 0 ? '(no description)' : entry.description
  const seconds = `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`
  return `${theme.dim('⬡')} ${theme.bold(theme.dim('subagent'))} ${mark} ${theme.dim(seconds)} ${name}`
}

/**
 * The one-line tail that names the run without spending a row on metadata.
 *
 * It says the id once. The earlier form repeated it - `· run_ab · /agents run_ab`
 * - which cost 23 cells of the row and pushed the child's own answer off the
 * end, the one thing compact exists to show.
 */
const tail = (entry: AgentEntry, theme: ViewTheme): string => theme.dim(`· ${shortRunId(entry.runId)}`)

/**
 * The child's own answer, cut the same way the delivered block cuts it. `text`
 * is the package's model-facing block, which starts with its own preamble; for
 * a display row the preamble is noise, so `output` (the raw answer) is
 * preferred and `text` is the fallback when a child produced no answer.
 */
const answerOf = (entry: AgentEntry): string | undefined => {
  const output = entry.output?.trim()
  if (output !== undefined && output.length > 0) return output
  const text = entry.text?.trim()
  return text !== undefined && text.length > 0 ? text : undefined
}

/** A child that produced no text still owes the user a row that says so. */
const emptyAnswer = (entry: AgentEntry, theme: ViewTheme): string => {
  if (entry.outcome === 'cancelled') return theme.dim('(stopped before it answered)')
  if (entry.outcome === 'failed' || entry.outcome === 'timeout') {
    const detail = entry.detail?.trim()
    return theme.dim(detail !== undefined && detail.length > 0 ? `(no answer · ${detail})` : '(no answer)')
  }
  return theme.dim('(the subagent produced no text)')
}

/**
 * The compact form: one row, and the answer only if it fits on that row.
 *
 * A compact transcript is a log of outcomes, so a long answer is *not* inlined -
 * it is named as available, which is the same choice `compact` makes for every
 * other tool. The count of lines says how much is waiting, so a truncated answer
 * is visible rather than surprising.
 *
 * The run id is reserved *before* the answer is measured. Clipping the finished
 * row would take it first, because it is last - and then the one pointer that
 * finds the full text is gone exactly when the answer was too long to show.
 */
const compactLines = (
  entry: AgentEntry,
  elapsedMs: number,
  columns: number,
  theme: ViewTheme,
): readonly string[] => {
  const width = Math.max(20, columns - 1)
  const head = headline(entry, elapsedMs, theme)
  const tailText = tail(entry, theme)
  const answer = answerOf(entry)
  // Exactly the cells between the answer and the tail: ` → ` plus, when the
  // answer continues, ` +N`. A blanket reserve costs an answer that would have
  // fit, which is the whole point of putting it on the row.
  const more = answer === undefined ? 0 : answer.split('\n').length - 1
  const room = (): number =>
    // One cell is the ellipsis `truncateOutput` adds when it cuts.
    Math.max(4, width - displayCells(head) - displayCells(tailText) - 3 - (more > 0 ? 4 : 0) - 1)
  if (answer === undefined) {
    return [clip(`${head} ${emptyAnswer(entry, theme)} ${tailText}`, width)]
  }
  const first = answer.split('\n').find((line) => line.trim().length > 0)?.trim() ?? ''
  const shown = truncateOutput(neutraliseChildText(first), room())
  const suffix = more > 0 ? ` ${theme.dim(`+${String(more)}`)}` : ''
  return [clip(`${head} ${theme.dim('→')} ${shown}${suffix} ${tailText}`, width)]
}

/**
 * The medium form: the same head, then the answer as an indented block.
 *
 * This is the mode that reads like prose, so the answer is shown - but under
 * the head, not merged into it, because a multi-line answer on one row was the
 * density problem this mode exists to fix.
 */
const mediumLines = (
  entry: AgentEntry,
  elapsedMs: number,
  columns: number,
  theme: ViewTheme,
): readonly string[] => {
  const width = Math.max(20, columns - 1)
  const head = clip(`${headline(entry, elapsedMs, theme)} ${tail(entry, theme)}`, width)
  const answer = answerOf(entry)
  if (answer === undefined) return [clip(`${head} ${emptyAnswer(entry, theme)}`, width)]
  const kept = truncateOutput(neutraliseChildText(answer), MAX_SUBAGENT_OUTPUT_TEXT)
  const lines = kept.split('\n').flatMap((line) => (line.length === 0 ? [] : [clip(`  ${theme.dim('│')} ${line}`, width)]))
  return [head, ...lines]
}

/**
 * What the user reads for one settled child, in the current view mode.
 *
 * `full` returns the model's own block, because that mode's promise is "what
 * was actually sent" - it is the one place the raw contract is on screen.
 */
export const deliveredLines = (input: {
  readonly entry: AgentEntry
  readonly elapsedMs: number
  readonly mode: ViewMode
  readonly columns: number
  readonly theme: ViewTheme
  readonly block: string
}): readonly string[] => {
  const { entry, elapsedMs, mode, columns, theme, block } = input
  const dim = block.split('\n').map((line) => theme.dim(line))
  if (mode === 'full') return dim
  if (mode === 'compact') return compactLines(entry, elapsedMs, columns, theme)
  return mediumLines(entry, elapsedMs, columns, theme)
}
