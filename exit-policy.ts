/**
 * `/exit` and `/quit` with background children (2b): cancel, wait a bounded
 * time, never hang.
 *
 * A background child outlives the turn that launched it, so it would also
 * outlive the session. Leaving it behind is a leak - an orphaned model call and
 * whatever processes its tools started - so the exit path cancels every running
 * child and gives them a short, bounded window to settle.
 *
 * The bound is the point. Cancelling unwinds a run and kills the processes it
 * owns, and that is rarely instant; but `/exit` is the user asking this process
 * to stop, so the process must stop. Whatever has not settled in time is
 * reported and left to `runtime.close()`, which is where the node host reaps
 * anything still alive. Nothing here waits unbounded.
 */

import type { AgentEntry, AgentRegistry } from './agents.ts'

/**
 * How long `/exit` waits for cancelled background children to settle.
 * Five seconds covers the child's own cancel path (dispose, process children,
 * the terminal row); past that the process must go, not hang.
 */
export const EXIT_CHILD_WAIT_MS = 5_000

export interface ExitResult {
  /** How many children were running and were cancelled. */
  readonly cancelled: number
  /** How many were still settling when the bound elapsed (0 in the normal case). */
  readonly stillRunning: number
  /** Lines the caller prints, in order; empty when nothing was running. */
  readonly lines: readonly string[]
}

/**
 * Stop every running child and wait for them, bounded.
 *
 * `cancel` is called on the registry, so a child is stopped through its own
 * controller and its row settles through the normal settle path. The wait is
 * `Promise.race` against a timer that is `unref`'d: a settled exit cannot be
 * held open by a stuck child.
 */
export const stopChildrenOnExit = async (
  agents: AgentRegistry,
  waitMs: number = EXIT_CHILD_WAIT_MS,
): Promise<ExitResult> => {
  const running: readonly AgentEntry[] = agents.running()
  if (running.length === 0) return { cancelled: 0, stillRunning: 0, lines: [] }

  for (const entry of running) agents.cancel(entry.runId)
  const label = running.length === 1 ? 'subagent' : 'subagents'

  const timeout = new Promise<'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      resolve('timeout')
    }, waitMs)
    timer.unref?.()
  })
  const settled = await Promise.race([agents.settleAll(running).then(() => 'settled' as const), timeout])

  const lines = [`exit · stopping ${String(running.length)} running ${label}…`]
  if (settled === 'timeout') {
    const left = agents.running()
    if (left.length > 0) {
      lines.push(`exit · ${String(left.length)} child still settling after ${String(waitMs / 1000)}s · leaving`)
    }
  }
  return { cancelled: running.length, stillRunning: agents.running().length, lines }
}
