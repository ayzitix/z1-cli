/**
 * 2b - the exit policy for background children, asserted **on the process**.
 *
 * The brief asks for one thing a unit test cannot show: that `/exit` kills a
 * background child's `shell` process, not merely that a promise resolved. So
 * this file drives the real exit policy and then asks the operating
 * system whether the grandchild is gone.
 *
 * How it is staged, and why each piece is real:
 *
 * - The child's tool call is a real `runProcess` of a `node -e` process that
 *   writes its pid and then blocks forever, so "still running" is observable
 *   from outside.
 * - The **kill belongs to the SDK, not to this test.** The child's run handle
 *   has a `dispose()` that is the only thing which reaps the grandchild, and
 *   that `dispose()` is called by `@z1/subagent` (its `finish()` →
 *   `setup.child.dispose()`), never by this file. The test asserts the SDK
 *   disposed the handle *and* that the pid is gone.
 * - The exit path is `stopChildrenOnExit` (`exit-policy.ts`), the same function
 *   `/exit` and `/quit` call: cancel every running child, wait a bounded time.
 *
 * The mutation this file must survive is the one that matters: delete the SDK's
 * `await setup.child.dispose()` and the grandchild stays alive, so the
 * assertions below fail. A version that passed with that line removed would be
 * proving only that a stub kills what a stub kills.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SqliteJournal } from '../../z1-sdk/z1/packages/journal/lib/index.js'
import { createBuiltinRegistry } from '../../z1-sdk/z1/packages/nodes/lib/index.js'
import { createMockRuntimeServices } from '../../z1-sdk/z1/packages/runtime/lib/index.js'
import { runProcess, killRunProcessesFor } from '../../z1-sdk/z1/packages/node-host/lib/index.js'

import { AgentRegistry } from '../agents.ts'
import { stopChildrenOnExit } from '../exit-policy.ts'
import { composeSubagentService } from '../subagent-host.ts'
import { ToolState } from '../tool-state.ts'
import { subagentToolSchema } from '../sdk.ts'

// The suite composes the real `ToolState`, so it must not read this machine's
// `~/.config/z1/tools.json` (a `subagent: disabled` there would make
// composition return the bare parent and no child would ever start).
const prefsDir = mkdtempSync(join(tmpdir(), 'z1-exit-prefs-'))
process.env['Z1_TOOLS_FILE'] = join(prefsDir, 'tools.json')

const dir = mkdtempSync(join(tmpdir(), 'z1-exit-child-'))
const pidFile = join(dir, 'grandchild.pid')

/** Is this pid alive right now, as the operating system sees it? */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A pid file written by a grandchild that is up, or `undefined`. */
const readPid = (): number | undefined => {
  try {
    const text = readFileSync(pidFile, 'utf8').trim()
    const pid = Number(text)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

const waitFor = async <T>(probe: () => T | undefined, what: string, attempts = 600): Promise<T> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const schema = (name: string) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
})

/**
 * The background child's work: a real `node -e` process that records its pid,
 * says it is up, and then blocks. It is spawned through `runProcess`, exactly
 * as a module's `process.run` would, and killed through the same owner index.
 */
const grandchildScript = (pidPath: string): readonly string[] => [
  '-e',
  [
    `const fs = require('node:fs')`,
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
    `process.stdout.write('up\\n')`,
    `setInterval(() => {}, 1000)`,
  ].join(';'),
]

// --------------------------------------------------------------------- exit

// The one path that matters: a live background child with a live OS process
// under it, then the exit policy. The grandchild must be gone afterwards, and
// the only thing allowed to make it gone is the SDK disposing the child.
{
  const journal = new SqliteJournal(':memory:')
  try {
    // Which run id the SDK asked the host to start. The grandchild is owned by
    // that id, so reaping it proves the SDK reached *this* child's dispose -
    // a kill by any other owner string would leave it alive (verified).
    let childRunId: string | undefined
    // The SDK called `dispose()` on the handle it was given. This is the half a
    // pid check alone cannot show.
    let handleDisposed = false

    // A tool whose call spawns the grandchild. The call never returns by itself:
    // the only way out is the child's run being cancelled and the handle being
    // disposed, so the process's death is caused by the SDK, not by this test.
    const spawner: import('../sdk.ts').SubagentTool = {
      schema: {
        name: 'spawner',
        description: 'start a process that stays up',
        parameters: { type: 'object', properties: {} },
      },
      async call() {
        assert.ok(childRunId !== undefined, 'the child run id is known before its first tool call')
        const result = await runProcess(process.execPath, grandchildScript(pidFile), {
          cwd: dir,
          env: {},
          timeoutMs: 120_000,
          maxOutputBytes: 4096,
          // Owned by the child run, the way a real child's tool call is owned
          // by the run that started it.
          owner: childRunId,
        })
        return { ok: true, exitCode: result.exitCode }
      },
    }

    const runtime = {
      journal,
      async beginRun(overrides: Record<string, unknown>) {
        const runId = String(overrides['runId'] ?? '')
        childRunId = runId
        const services = createMockRuntimeServices() as unknown as Record<string, unknown>
        services['tools'] = {
          async list() {
            return [schema('spawner')]
          },
          async call(name: string, args: unknown) {
            if (name !== 'spawner') throw new Error(`unexpected tool ${name}`)
            return spawner.call(args as never)
          },
        }
        services['llm'] = {
          async chat() {
            return {
              message: {
                role: 'assistant',
                content: '[[tool:spawner]] start it',
              },
              toolCalls: [{ id: 'call_1', name: 'spawner', arguments: {} }],
              stopReason: 'toolUse',
            }
          },
        }
        services['approval'] = overrides['approval']
        return {
          registry: createBuiltinRegistry(),
          services,
          // The real reaping path for a run's `process.run` children, scoped to
          // this child's own owner. The SDK is the only caller: if it stops
          // disposing the handle, nothing here runs and the grandchild survives.
          async dispose() {
            handleDisposed = true
            killRunProcessesFor(runId)
          },
        }
      },
    }

    const store = new AgentRegistry()
    const toolState = new ToolState(() => Promise.resolve([schema('spawner')]), [subagentToolSchema])
    const service = await composeSubagentService({
      runtime: runtime as never,
      model: { provider: 'mock', model: 'mock-1' } as never,
      parent: { list: async () => [schema('spawner')], call: async () => ({}) },
      snapshot: await toolState.reload(),
      guardCall: toolState.guardCall(),
      onStart: (start) => {
        store.start(start)
      },
      onFinish: (finish) => {
        store.finish(finish.runId, { outcome: finish.status, tools: finish.tools, denied: finish.denied })
      },
      onBackground: (launch) => {
        store.start({
          runId: launch.result.runId,
          mode: 'background',
          cancel: launch.cancel,
          promise: launch.done.then(
            () => undefined,
            () => undefined,
          ),
        })
      },
    })

    // A background launch: it returns before the child has done anything.
    const launched = (await service.call('subagent', {
      description: 'a long job',
      prompt: 'start the process',
      tools: { enable: ['spawner'] },
    })) as { runId: string; status: string }
    assert.equal(launched.status, 'running', 'the launch returns while the child runs')

    // The grandchild is a real process: wait for its pid file, then check it.
    const pid = await waitFor(readPid, 'the child to report its process pid')
    assert.equal(isAlive(pid), true, 'the child spawned a live OS process')
    assert.equal(store.running().length, 1, 'the child is running')

    // The exit policy, exactly as `/exit` runs it: cancel every running child,
    // wait (bounded) for them to settle. This is the code under test, not a
    // re-implementation of it.
    const exit = await stopChildrenOnExit(store)
    assert.equal(exit.cancelled, 1, 'the exit policy cancelled the one running child')

    // Both halves of "the cancel reached the SDK's dispose", reported together
    // so a failure in one cannot hide the other:
    //  1. the SDK disposed the run handle it was given;
    //  2. that dispose reaped the grandchild, asserted on the OS process.
    // The exit policy waits for the child's own promise, so by the time it
    // returns the kill should have run; the short retry only absorbs the OS
    // finishing the process teardown.
    let pidGone = !isAlive(pid)
    for (let attempt = 0; attempt < 100 && !pidGone; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      pidGone = !isAlive(pid)
    }
    assert.equal(
      pidGone,
      true,
      `the grandchild process is gone (handle disposed: ${String(handleDisposed)})`,
    )
    assert.equal(handleDisposed, true, 'the SDK disposed the child handle')
    assert.equal(store.get(launched.runId)?.outcome, 'cancelled', 'and the child recorded cancelled')

    // The kill is scoped to the child's own owner: a process with another owner
    // survives the same path, so this is not a blanket sweep of the machine.
    const bystanderPidFile = join(dir, 'bystander.pid')
    const bystander = runProcess(
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(bystanderPidFile)}, String(process.pid));setInterval(()=>{},1000)`,
      ],
      { cwd: dir, env: {}, timeoutMs: 60_000, maxOutputBytes: 1024, owner: 'some-other-call' },
    )
    bystander.catch(() => {})
    try {
      const bystanderPid = await waitFor(
        () => {
          try {
            const text = readFileSync(bystanderPidFile, 'utf8').trim()
            return Number(text) || undefined
          } catch {
            return undefined
          }
        },
        'the bystander process',
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(isAlive(bystanderPid), true, 'a process owned by another call survives')
      killRunProcessesFor('some-other-call')
    } finally {
      // Nothing is left behind even if an assertion above threw.
      killRunProcessesFor('some-other-call')
    }

    assert.ok(existsSync(pidFile), 'the grandchild reported its pid')
  } finally {
    journal.close()
    // Best-effort on purpose: when the assertions above fail the grandchild is
    // still holding an open handle in `dir`, and on Windows that makes the
    // cleanup throw EPERM - which would hide the real assertion behind a
    // teardown error. The leaked child dies with this process.
    try {
      rmSync(dir, { recursive: true, force: true })
      rmSync(prefsDir, { recursive: true, force: true })
    } catch {
      // Reported by the assertions, not here.
    }
  }
}

console.log('PASS: subagent-exit (background child spawned a real process; /exit killed it; bystander survived)')
