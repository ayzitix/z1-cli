/**
 * `/agents stop <ref>` (2b): the decision, separated from the terminal.
 *
 * Stopping a child is the one `/agents` verb that changes state, and almost all
 * of it is *refusal*: a finished child has nothing to stop, a `wait: true` child
 * belongs to the turn waiting for it, an unknown reference is a typo. Keeping
 * the decision here - a pure function over the registry - is what lets those
 * refusals be tested without a terminal, and keeps the handler in `chat.ts` to
 * "print the line, or call `cancel`".
 *
 * `cancel` is the registry's own, so the child is stopped through its own
 * controller (never the parent turn's) and its row settles through the normal
 * settle path; the caller only reports the request.
 */

import type { AgentRegistry } from './agents.ts'
import { shortRunId } from './agents.ts'
import { agentRefusal } from './agents-view.ts'

/** What `/agents stop <ref>` decided. */
export type StopDecision =
  | { readonly kind: 'stop'; readonly runId: string; readonly line: string }
  | { readonly kind: 'refused'; readonly runId?: string; readonly line: string }

/**
 * Decide what `stop <ref>` does, and do the stopping.
 *
 * It is written as a total function over the reference: every input produces a
 * line, so the handler never has to invent one.
 */
export const stopAgent = (agents: AgentRegistry, ref: string): StopDecision => {
  const trimmed = ref.trim()
  if (trimmed === '') {
    return { kind: 'refused', line: 'agents · stop which one? · /agents stop <n|runId>' }
  }
  const target = agents.resolveRef(trimmed)
  if (!target.ok) {
    return { kind: 'refused', line: agentRefusal(trimmed, target) }
  }
  const entry = target.entry
  // A finished child is not a mistake to fix: say what it is and stop.
  if (entry.outcome !== 'running') {
    return {
      kind: 'refused',
      runId: entry.runId,
      line: `agents · ${shortRunId(entry.runId)} already ${entry.outcome} · nothing to stop`,
    }
  }
  // A `wait: true` child belongs to the turn waiting for it; its own Ctrl-C is
  // its cancel. Refusing says how, instead of pretending.
  if (entry.mode === 'wait') {
    return {
      kind: 'refused',
      runId: entry.runId,
      line: `agents · ${shortRunId(entry.runId)} is a wait call · stop it with Ctrl-C in that turn`,
    }
  }
  if (!agents.cancel(entry.runId)) {
    return {
      kind: 'refused',
      runId: entry.runId,
      line: `agents · ${shortRunId(entry.runId)} cannot be stopped · no controller`,
    }
  }
  return {
    kind: 'stop',
    runId: entry.runId,
    line: `agents · stopping ${shortRunId(entry.runId)} · ${entry.description || '(no description)'}`,
  }
}
