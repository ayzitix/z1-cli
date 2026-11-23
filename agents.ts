/**
 * This session's delegated children, as the UI sees them.
 *
 * v1 children are synchronous: `subagent` call returns when the child is done,
 * so the parent transcript already has one row for the delegation. What is
 * missing is the *read side*: which children did this session spawn, what did
 * each one do, and how far along is a running one. `/agents` answers that from
 * an in-memory registry plus the child's own journal events; nothing here is
 * persisted (SUBAGENT-DESIGN-2, 1.5b — a journal table is a later migration).
 *
 * Scope, by design:
 *
 * - The key is the child `runId`. `RunRecord.parentRunId` is fork lineage, not
 *   delegation lineage, and is never used here.
 * - Only children this process started are listed. An older child cannot be
 *   found again after a restart; `/agents <runId>` then says so instead of
 *   guessing.
 * - A child is "running" until its completion is recorded. `runSubagent`
 *   returns for *every* outcome (1.5c made a finished child a result, not a
 *   throw), so one completion path covers success, failure, timeout, cancel
 *   and step exhaustion.
 *
 * The module is pure: no `process`, no `stdout`, no clock, no SDK import. The
 * CLI injects `now`, the theme and the tail width, which is what lets the
 * renderer and the tests share one implementation.
 */

/** A child's outcome as the UI names it (the package's tool status). */
export type AgentOutcome = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'partial'

/** One delegation this session started. */
export interface AgentEntry {
  readonly runId: string
  /** The model-supplied label; `''` when it sent none. */
  readonly description: string
  readonly startedAt: number
  finishedAt?: number
  outcome: AgentOutcome
  /** Granted and denied tool names, resolved by the package before the child ran. */
  tools: readonly string[]
  denied: readonly string[]
  /** Model turns the child completed (`loop/<n>/chat` `node.started` events). */
  steps: number
  /** The package's error code, e.g. `child_timeout`; only for a non-completed end. */
  errorCode?: string
  /** One sentence describing the end; shown in the header and a transcript row. */
  detail?: string
}

/** Start a child. The id is allocated by the package, so it arrives here. */
export interface AgentStart {
  readonly runId: string
  readonly description?: string
  readonly tools?: readonly string[]
  readonly denied?: readonly string[]
  readonly startedAt?: number
}

/** How a child ended, as the runner reported it. */
export interface AgentFinish {
  readonly outcome: Exclude<AgentOutcome, 'running'>
  readonly errorCode?: string
  readonly detail?: string
  readonly tools?: readonly string[]
  readonly denied?: readonly string[]
  readonly steps?: number
  readonly finishedAt?: number
}

/** The subset of `RunEvent` the registry needs: a step is a model turn start. */
export interface AgentEvent {
  readonly type: string
  readonly path?: string
}

/** Child loop iterations: `loop/<n>/chat` is the model call of one step. */
export const STEP_PATH = /^loop\/\d+\/chat$/

/** A compact, unambiguous reference for a row: `run_1a2b3c4d`. */
export const shortRunId = (runId: string): string => (runId.length <= 12 ? runId : `${runId.slice(0, 12)}`)

/** `12 steps`, `1 step`, `0 steps`: the count is always present, never a dash. */
export const stepLabel = (steps: number): string => `${String(Math.max(0, steps))} ${steps === 1 ? 'step' : 'steps'}`

/** Coarse elapsed time the way a status row reads: `4s`, `1m12s`, `2h03m`. */
export const elapsedLabel = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 100) / 10)
  if (total < 60) return `${total < 10 ? total.toFixed(1) : String(Math.round(total))}s`
  const seconds = Math.round(total)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return `${String(minutes)}m${String(rest).padStart(2, '0')}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** What a `/agents` reference named: one child, or why it named none. */
export type AgentResolution =
  | { readonly ok: true; readonly entry: AgentEntry }
  | { readonly ok: false; readonly reason: 'missing' }
  | { readonly ok: false; readonly reason: 'unknown' }
  | { readonly ok: false; readonly reason: 'index'; readonly count: number }
  | { readonly ok: false; readonly reason: 'ambiguous'; readonly matches: readonly string[] }

/** The per-session registry. One instance lives as long as the chat. */
export class AgentRegistry {
  readonly #now: () => number
  readonly #entries = new Map<string, AgentEntry>()
  #order: string[] = []

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now())
  }

  /** A child was started (the package created its run id). */
  start(input: AgentStart): AgentEntry {
    const existing = this.#entries.get(input.runId)
    if (existing !== undefined) return existing
    const entry: AgentEntry = {
      runId: input.runId,
      description: (input.description ?? '').trim(),
      startedAt: input.startedAt ?? this.#now(),
      outcome: 'running',
      tools: [...(input.tools ?? [])],
      denied: [...(input.denied ?? [])],
      steps: 0,
    }
    this.#entries.set(entry.runId, entry)
    this.#order.push(entry.runId)
    return entry
  }

  /**
   * Record the child's end. Idempotent: a second report does not move the
   * finish time, so a row cannot keep growing after the run is over.
   */
  finish(runId: string, input: AgentFinish): AgentEntry | undefined {
    const entry = this.#entries.get(runId)
    if (entry === undefined) return undefined
    if (entry.outcome !== 'running') return entry
    entry.outcome = input.outcome
    entry.finishedAt = input.finishedAt ?? this.#now()
    if (input.tools !== undefined) entry.tools = [...input.tools]
    if (input.denied !== undefined) entry.denied = [...input.denied]
    if (input.steps !== undefined) entry.steps = Math.max(entry.steps, input.steps)
    if (input.errorCode !== undefined) entry.errorCode = input.errorCode
    if (input.detail !== undefined) entry.detail = input.detail
    return entry
  }

  /** One forwarded child event: a model-turn start is one step. */
  observe(runId: string, event: AgentEvent): void {
    if (event.type !== 'node.started') return
    const entry = this.#entries.get(runId)
    if (entry === undefined || entry.outcome !== 'running') return
    if (event.path === undefined || !STEP_PATH.test(event.path)) return
    entry.steps += 1
  }

  get(runId: string): AgentEntry | undefined {
    return this.#entries.get(runId)
  }

  /**
   * A `/agents` reference, with the list's own numbering.
   *
   * A bare integer is the 1-based index in `list()` order - the number the
   * user just read on screen - and nothing else is: `run_2` is an id, and a
   * prefix is a prefix. An index out of range, an ambiguous id prefix and an
   * unknown reference are three distinct refusals so the message can say which
   * mistake it was.
   */
  resolveRef(ref: string): AgentResolution {
    const value = ref.trim()
    if (value === '') return { ok: false, reason: 'missing' }
    if (/^\d+$/.test(value)) {
      const index = Number(value)
      const entries = this.list()
      const entry = entries[index - 1]
      if (entry === undefined) return { ok: false, reason: 'index', count: entries.length }
      return { ok: true, entry }
    }
    const exact = this.#entries.get(value)
    if (exact !== undefined) return { ok: true, entry: exact }
    const matches = this.#all().filter((entry) => entry.runId.startsWith(value))
    if (matches.length === 1) return { ok: true, entry: matches[0] as AgentEntry }
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous', matches: matches.map((entry) => entry.runId) }
    }
    return { ok: false, reason: 'unknown' }
  }

  /**
   * The list order: running first (oldest start first, so the longest-running
   * child is at the top), then finished (most recently started first, because
   * that is the one the user is most likely asking about).
   */
  list(): readonly AgentEntry[] {
    const running = this.#all().filter((entry) => entry.outcome === 'running')
    const finished = this.#all().filter((entry) => entry.outcome !== 'running').reverse()
    return [...running, ...finished]
  }

  /** Children still in flight; the status line and the exit path read this. */
  running(): readonly AgentEntry[] {
    return this.#all().filter((entry) => entry.outcome === 'running')
  }

  get size(): number {
    return this.#entries.size
  }

  /** Drop every finished child; running ones stay. Used by `/new` and `/clear`. */
  clearFinished(): number {
    const keep = this.#order.filter((runId) => this.#entries.get(runId)?.outcome === 'running')
    const removed = this.#order.length - keep.length
    for (const runId of this.#order) {
      if (!keep.includes(runId)) this.#entries.delete(runId)
    }
    this.#order = keep
    return removed
  }

  #all(): AgentEntry[] {
    return this.#order.flatMap((runId) => {
      const entry = this.#entries.get(runId)
      return entry === undefined ? [] : [entry]
    })
  }
}

/** Elapsed for a row: finished children freeze at their finish time. */
export const entryElapsed = (entry: AgentEntry, now: number): number =>
  Math.max(0, (entry.finishedAt ?? now) - entry.startedAt)

/** The grant summary a header prints: `enable read, grep · denied shell`. */export const grantLabel = (entry: AgentEntry): string => {
  const enabled = entry.tools.length === 0 ? '(none)' : entry.tools.join(', ')
  return entry.denied.length === 0 ? `enable ${enabled}` : `enable ${enabled} · denied ${entry.denied.join(', ')}`
}

/** The transient line under the tail; `undefined` when nothing runs. */
export const runningLabel = (count: number): string | undefined =>
  count <= 0 ? undefined : `◷ ${String(count)} ${count === 1 ? 'subagent' : 'subagents'} running · /agents`
