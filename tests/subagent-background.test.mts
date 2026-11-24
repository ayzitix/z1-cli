/**
 * 2b - the three CLI policies around a background child, each tested where the
 * behaviour actually lives: stopping one child (`agents-command.ts`), leaving
 * the session (`exit-policy.ts`), and the one-shot exit (`once-policy.ts`).
 *
 * The brief's bullets this file answers, by name:
 *
 * - "Stopping child A leaves concurrent child B running"
 * - "A background child survives `/new` but not `/exit`"
 * - "`--once` waits by default, and `Z1_NO_WAIT=1` does not"
 *
 * The `/exit` half that has to be asserted **on the process** - that the
 * child's `shell` process really dies - is in `subagent-exit.test.mts`; here the
 * registry and the bound are checked, because a timer cannot be observed from a
 * promise.
 */

import assert from 'node:assert/strict'

import { AgentRegistry } from '../agents.ts'
import { stopAgent } from '../agents-command.ts'
import { EXIT_CHILD_WAIT_MS, stopChildrenOnExit } from '../exit-policy.ts'
import { onceDetachLines, oncePolicy, onceStatusLine } from '../once-policy.ts'

// ---------------------------------------------------------------- helpers

/** A child whose settle is under the test's control. */
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

interface Started {
  readonly store: AgentRegistry
  readonly cancels: readonly string[]
  readonly settles: ReadonlyArray<() => void>
}

/**
 * A registry with `count` running background children. Each has a `cancel` that
 * records the call and a `promise` the test settles by hand; settling the
 * promise also records the row's end, which is what the real host's `onFinish`
 * does. Without that, `settleAll` would resolve while the row still said
 * `running`, and `/exit`'s "still settling" count would be a lie.
 */
const runningChildren = (count: number): Started => {
  const store = new AgentRegistry({ now: () => 1_000 })
  const cancels: string[] = []
  const settles: Array<() => void> = []
  for (let index = 1; index <= count; index += 1) {
    const gate = deferred()
    const runId = `run_${String(index).padStart(4, '0')}`
    settles.push(() => {
      store.finish(runId, { outcome: 'cancelled', errorCode: 'child_cancelled' })
      gate.resolve()
    })
    store.start({
      runId,
      description: `child ${String(index)}`,
      mode: 'background',
      cancel: () => {
        cancels.push(runId)
      },
      promise: gate.promise,
    })
  }
  return { store, cancels, settles }
}

// ------------------------------------- stopping one child leaves the other

// The brief's "Stopping child A leaves concurrent child B running": `stop` is
// per-child, through that child's own controller, and never a sweep.
{
  const { store, cancels, settles } = runningChildren(2)
  const a = 'run_0001'
  const b = 'run_0002'

  const decision = stopAgent(store, '1')
  assert.equal(decision.kind, 'stop', 'stop on a running child is accepted')
  assert.equal(decision.kind === 'stop' ? decision.runId : undefined, a, 'it resolves the index to the child')
  assert.deepEqual(cancels, [a], 'only child A was cancelled')
  assert.match(decision.line, /agents · stopping run_0001 · child 1/, 'the line says which one')

  // A's row is not finished by the *request*: it settles through its own
  // promise, so right after the cancel both are still `running`.
  assert.equal(store.get(a)?.outcome, 'running', 'cancelling does not finish the row by itself')
  assert.equal(store.get(b)?.outcome, 'running', 'child B is untouched')
  assert.equal(store.running().length, 2, 'both are still live until they settle')

  // A settles; B must not. This is the bullet, stated as facts.
  settles[0]?.()
  await Promise.resolve()
  assert.equal(store.get(a)?.outcome, 'cancelled', 'child A settled as cancelled')
  assert.equal(store.get(b)?.outcome, 'running', 'child B is still running after A ended')
  assert.deepEqual(cancels, [a], 'and B was never cancelled')
  settles[1]?.() // release B so nothing is left pending
}

// A finished child is refused with a line that says so, never cancelled.
{
  const { store, cancels } = runningChildren(1)
  store.finish('run_0001', { outcome: 'completed' })
  const decision = stopAgent(store, 'run_0001')
  assert.equal(decision.kind, 'refused', 'a finished child cannot be stopped')
  assert.match(decision.line, /already completed · nothing to stop/, 'the refusal names its state')
  assert.equal(cancels.length, 0, 'and nothing was cancelled')
}

// A `wait: true` child belongs to its turn: stop refuses and says how instead.
{
  const store = new AgentRegistry({ now: () => 1_000 })
  store.start({ runId: 'run_0007', description: 'inline', mode: 'wait', cancel: () => assert.fail('not cancelable') })
  const decision = stopAgent(store, '1')
  assert.equal(decision.kind, 'refused', 'a wait child is refused')
  assert.match(decision.line, /is a wait call · stop it with Ctrl-C in that turn/)
}

// Bad references are messages, never throws.
{
  const { store } = runningChildren(1)
  assert.match(stopAgent(store, '').line, /stop which one\?/)
  assert.match(stopAgent(store, '99').line, /\/agents 99 is out of range/, 'an out-of-range index names itself')
  assert.equal(stopAgent(new AgentRegistry(), '1').kind, 'refused', 'an empty session is refused')
}

// ------------------------------- `/new` keeps a running child, `/exit` ends it

// The brief's "survives `/new` but not `/exit`": `/new` is `clearFinished` on a
// session-scoped registry, and a running child is exactly what it keeps.
{
  const { store } = runningChildren(1)
  store.finish('run_0001', { outcome: 'completed' })
  store.start({ runId: 'run_0002', description: 'still going', mode: 'background' })
  store.start({ runId: 'run_0003', description: 'also done', mode: 'background' })
  store.finish('run_0003', { outcome: 'failed' })

  const removed = store.clearFinished()
  assert.equal(removed, 2, '`/new` clears the finished rows')
  assert.deepEqual(
    store.list().map((entry) => entry.runId),
    ['run_0002'],
    'and keeps the running child, so its answer is delivered into the new conversation',
  )
  assert.equal(store.running().length, 1, 'the surviving child is still running')
}

{
  const { store, cancels, settles } = runningChildren(2)
  const exit = stopChildrenOnExit(store)
  assert.deepEqual(cancels, ['run_0001', 'run_0002'], '`/exit` cancels every running child')

  // Both settle; the policy resolves once it has waited for them.
  for (const settle of settles) settle()
  const result = await exit
  assert.equal(result.cancelled, 2, 'both were cancelled')
  assert.equal(result.stillRunning, 0, 'and both settled in time')
  assert.deepEqual(result.lines, ['exit · stopping 2 running subagents…'], 'one line, no timeout notice')
}

// The bound is real: a child that never settles cannot hold the process open,
// and the result says so instead of hanging.
{
  const { store, settles } = runningChildren(1)
  // The exit deadline is `unref`'d on purpose (a settled exit cannot be held
  // open by a stuck child), so it only fires while this process has other work.
  // A short *referenced* timer stands in for the rest of a real session and
  // keeps the loop alive long enough to observe the bound.
  const keepAlive = setTimeout(() => {}, 1_000)
  try {
    const started = Date.now()
    const result = await stopChildrenOnExit(store, 50)
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 40, `waited about the bound (${String(elapsed)} ms)`)
    assert.ok(elapsed < 2_000, 'and no longer than the bound')
    assert.equal(result.stillRunning, 1, 'the stuck child is reported as still running')
    assert.match(result.lines.at(-1) ?? '', /still settling after .* · leaving/, 'the last line explains the exit')
  } finally {
    clearTimeout(keepAlive)
    settles[0]?.() // release the gate so nothing is left pending
  }
}

// Nothing running: no lines, no cancel calls, an immediate result.
{
  const result = await stopChildrenOnExit(new AgentRegistry())
  assert.deepEqual(result, { cancelled: 0, stillRunning: 0, lines: [] })
}

// The default bound is the documented five seconds.
assert.equal(EXIT_CHILD_WAIT_MS, 5_000, '`/exit` waits five seconds by default')

// ------------------------------- `--once` waits by default, detaches on demand

// The brief's "`--once` waits by default, and `Z1_NO_WAIT=1` does not".
assert.equal(oncePolicy({}), 'wait', 'no variable: wait for the children')
assert.equal(oncePolicy({ Z1_NO_WAIT: '1' }), 'detach', 'Z1_NO_WAIT=1: do not wait')
// Only `1` detaches: a child nobody waits for is a process the user did not
// ask to keep, so every ambiguous value keeps the safe default.
for (const value of ['0', 'true', 'yes', '', ' 1']) {
  assert.equal(oncePolicy({ Z1_NO_WAIT: value }), 'wait', `Z1_NO_WAIT=${JSON.stringify(value)} still waits`)
}

// The stable lines themselves.
{
  const { store } = runningChildren(1)
  const entry = store.get('run_0001') as never
  assert.equal(onceStatusLine(entry, 1_500), 'subagent running · run_0001 · 0 steps · 1.5s')
  store.finish('run_0001', { outcome: 'completed', steps: 2 })
  assert.equal(
    onceStatusLine(store.get('run_0001') as never, 12_000),
    'subagent completed · run_0001 · 2 steps · 12s',
  )
  store.finish('run_0002', { outcome: 'timeout', errorCode: 'child_timeout' })
  const timeoutEntry = new AgentRegistry()
  timeoutEntry.start({ runId: 'run_0002', description: 'slow', mode: 'background' })
  timeoutEntry.finish('run_0002', { outcome: 'timeout', errorCode: 'child_timeout' })
  assert.match(onceStatusLine(timeoutEntry.get('run_0002') as never, 1_000), /timeout · child_timeout/)
}

// Detaching names the children that are still running, and only those.
{
  const { store } = runningChildren(2)
  store.finish('run_0002', { outcome: 'completed' })
  const lines = onceDetachLines(store.list())
  assert.equal(lines.length, 1, 'a settled child is not detached from anything')
  assert.match(lines[0] ?? '', /^subagent still running · run_0001 · not waiting \(Z1_NO_WAIT=1\)$/)
}

console.log('PASS: subagent-background (stop A keeps B, /new keeps running, /exit bounded, --once policy)')
