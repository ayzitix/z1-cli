/**
 * The `--once` exit policy for background children (2b).
 *
 * A one-shot process has no next turn, so a settled child's text can never be
 * delivered to a parent context. That leaves exactly two honest choices, and
 * this module owns neither of them silently:
 *
 * - **default**: wait for every background child the run started, print each
 *   one's final status on stderr, and exit. The exit code is still the main
 *   run's: a child's outcome is reported, never folded into it.
 * - **`Z1_NO_WAIT=1`**: detach. Print the run ids of the children still
 *   running and exit without waiting. Their run rows stay `running` in the
 *   journal until the next process reaps them (`reaper.ts`), which is the same
 *   contract as killing the host process.
 *
 * The policy is a pure function so the two branches are testable without a
 * terminal, a model, or a process.
 */

import type { AgentEntry } from './agents.ts'

/** What to do with a one-shot's background children when the main run ends. */
export type OncePolicy = 'wait' | 'detach'

/**
 * `Z1_NO_WAIT=1` detaches. Any other value - including `0`, `false`, an empty
 * string - keeps the default, because the default is the safe one: a child that
 * nobody waits for is a process the user did not expect to keep.
 */
export const oncePolicy = (env: Readonly<Record<string, string | undefined>>): OncePolicy =>
  env['Z1_NO_WAIT'] === '1' ? 'detach' : 'wait'

/**
 * The line `--once` prints on stderr for one settled child.
 *
 * `subagent <n> · <outcome> · <runId> · <steps> · <elapsed>`: the same facts the
 * interactive `/agents` row shows, on one line, because stderr may be captured
 * in a log and the run id is what a later `/agents` or journal read needs.
 */
export const onceStatusLine = (entry: AgentEntry, elapsedMs: number): string => {
  const steps = entry.steps === 1 ? '1 step' : `${String(entry.steps)} steps`
  const seconds = elapsedMs / 1000
  const elapsed = `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)}s`
  const code = entry.errorCode === undefined ? '' : ` · ${entry.errorCode}`
  return `subagent ${entry.outcome}${code} · ${entry.runId} · ${steps} · ${elapsed}`
}

/**
 * The lines `--once` prints when it detaches: one per child that is *still
 * running*. A settled child is not detached from anything, so it is skipped.
 */
export const onceDetachLines = (entries: readonly AgentEntry[]): readonly string[] =>
  entries
    .filter((entry) => entry.outcome === 'running')
    .map((entry) => `subagent still running · ${entry.runId} · not waiting (Z1_NO_WAIT=1)`)
