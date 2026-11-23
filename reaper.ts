/**
 * Startup reaper for orphaned run rows.
 *
 * A run row is created as `running` and updated when its run ends. If the
 * process dies first (SIGKILL, a crash, a closed terminal), nothing ever
 * reconciles the row, so the journal keeps it `running` forever. The runner has
 * no `orphaned` status; `failed` is the honest terminal state here.
 *
 * Scope and limits:
 *
 * - Only rows whose `createdAt` is strictly before this process started are
 *   reaped. A row created by *this* process can still be legitimately running.
 * - Rows created after `processStart` belong to another live process (or were
 *   started by this one) and are never touched. A row created *before*
 *   `processStart` but still live in another process cannot be told apart from
 *   an orphan: two z1 processes sharing one journal, started at different
 *   times, make the newer process reap the older one's live runs. This is a
 *   known limitation of a timestamp-only rule; no column marks the owner.
 * - It runs once per process, and a missing `listRuns`/`updateRun` (an
 *   event-only journal) is a no-op rather than an error.
 */

/** The run-record surface the reaper needs; `SqliteJournal` satisfies it. */
export interface OrphanedRunJournal {
  listRuns(): readonly {
    readonly runId: string
    readonly status: string
    readonly createdAt: number
  }[]
  updateRun(runId: string, patch: { status: 'failed'; updatedAt: number }): void
}

export interface ReapOrphanedRunsOptions {
  /** Epoch ms; rows created before this instant are candidates. */
  readonly processStart: number
  /** Called once per reaped row: `· reaped orphaned run run_… (started …)`. */
  readonly onLine?: (line: string) => void
  /** Injectable clock, so a test does not depend on wall time. */
  readonly now?: () => number
}

export interface ReapResult {
  readonly reaped: readonly string[]
}

const timestamp = (at: number): string => {
  try {
    return new Date(at).toISOString()
  } catch {
    return String(at)
  }
}

const hasReapCapability = (journal: unknown): journal is OrphanedRunJournal =>
  typeof (journal as Partial<OrphanedRunJournal> | null)?.listRuns === 'function' &&
  typeof (journal as Partial<OrphanedRunJournal> | null)?.updateRun === 'function'

/**
 * Mark every `running` row created before `processStart` as `failed`. Returns
 * the reaped ids; a journal without run rows returns an empty list.
 */
export function reapOrphanedRuns(
  journal: unknown,
  options: ReapOrphanedRunsOptions,
): ReapResult {
  if (!hasReapCapability(journal)) return { reaped: [] }
  const now = options.now ?? (() => Date.now())
  const reaped: string[] = []
  let rows: ReturnType<OrphanedRunJournal['listRuns']>
  try {
    rows = journal.listRuns()
  } catch {
    // A broken journal at startup is not a reason to refuse to start; the
    // first turn will report the real error.
    return { reaped }
  }

  for (const row of rows) {
    if (row.status !== 'running') continue
    if (!(row.createdAt < options.processStart)) continue
    try {
      journal.updateRun(row.runId, { status: 'failed', updatedAt: now() })
    } catch {
      continue
    }
    reaped.push(row.runId)
    options.onLine?.(`· reaped orphaned run ${row.runId} (started ${timestamp(row.createdAt)})`)
  }
  return { reaped }
}
