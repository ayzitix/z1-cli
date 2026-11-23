import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SqliteJournal } from '../../z1-sdk/z1/packages/journal/lib/index.js'
import { createBuiltinRegistry } from '../../z1-sdk/z1/packages/nodes/lib/index.js'
import { createMockRuntimeServices } from '../../z1-sdk/z1/packages/runtime/lib/index.js'

import { composeSubagentService } from '../subagent-host.ts'
import { ToolState } from '../tool-state.ts'
import { subagentToolSchema } from '../sdk.ts'
import { reapOrphanedRuns } from '../reaper.ts'

// ---------------------------------------------------------------- helpers

const schema = (name: string) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
})

const args = (enable: readonly string[]) => ({
  description: 'one task',
  prompt: 'do the task',
  tools: { enable },
})

/**
 * Same structural runtime shape as `subagent.test.mts`: a real child graph over
 * the builtin registry and mock services, with `beginRun` observable. The
 * journal is a complete `SqliteJournal(:memory:)`, so the package writes real
 * run rows the cancellation test can read back.
 */
const createFakeRuntime = (options: {
  tools: readonly ReturnType<typeof schema>[]
  llm: unknown
  journal: SqliteJournal
}) => {
  const handles: Array<{ disposed: boolean }> = []
  const runtime = {
    journal: options.journal,
    async beginRun(overrides: Record<string, unknown>) {
      const services = createMockRuntimeServices() as unknown as Record<string, unknown>
      services['tools'] = {
        async list() {
          return options.tools
        },
        async call(name: string, toolArgs: unknown) {
          return { ok: true, name, args: toolArgs }
        },
      }
      services['llm'] = options.llm
      services['approval'] = overrides['approval']
      const handle = {
        registry: createBuiltinRegistry(),
        services,
        disposed: false,
        async dispose() {
          handle.disposed = true
        },
      }
      handles.push(handle)
      return handle
    },
  }
  return { runtime, handles }
}

const waitFor = async (predicate: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ------------------------------------- parent abort cancels the live child
{
  const journal = new SqliteJournal(':memory:')
  try {
    // A model that blocks until released. `LlmService.chat` has no signal
    // argument, so the abort is observed through the run: the executor races
    // each node attempt against the run signal and returns `cancelled`.
    let reads = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const blockingLlm = {
      async chat() {
        reads += 1
        await gate
        return {
          message: { role: 'assistant', content: 'child finished' },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }

    const parent = new AbortController()
    let childRunId: string | undefined
    const host = createFakeRuntime({
      tools: [schema('read')],
      llm: blockingLlm,
      journal,
    })
    const raw = [schema('read')]
    const store = new ToolState(() => Promise.resolve(raw), [subagentToolSchema])
    const snapshot = await store.reload()
    const composed = await composeSubagentService({
      runtime: host.runtime,
      model: { provider: 'mock', model: 'mock-1' } as never,
      parent: { list: async () => raw, call: async () => ({}) },
      snapshot,
      guardCall: store.guardCall(),
      signal: parent.signal,
    })

    const pending = composed.call('subagent', args(['read']))
    // Attach the handler before aborting so the cancellation can never surface
    // as an unhandled rejection.
    const settled = pending.then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    )
    await waitFor(() => reads === 1, 'the child model call')
    // Ctrl-C on the parent turn while the child's model call is in flight.
    parent.abort()
    const outcome = await settled
    release()

    // Since 1.5c a finished child is a *result*, not a throw: the cancellation
    // reaches the host as `status: 'cancelled'` plus the machine-readable code.
    assert.equal(outcome.kind, 'resolved', 'a cancelled child resolves as a result')
    const value = outcome.kind === 'resolved' ? (outcome.value as Record<string, unknown>) : {}
    assert.equal(value['status'], 'cancelled')
    assert.equal(value['errorCode'], 'child_cancelled')
    assert.match(String(value['detail']), /cancelled by the parent/)
    assert.equal(value['isError'], true)

    const rows = journal.listRuns()
    assert.equal(rows.length, 1, 'the child created one run row')
    childRunId = rows[0]?.runId
    assert.ok(childRunId)
    assert.equal(rows[0]?.status, 'cancelled', 'the row records cancelled, not failed')
    assert.equal('parentRunId' in (rows[0] ?? {}), false, 'no fork lineage on the child row')
    assert.equal(host.handles[0]?.disposed, true, 'the child handle is disposed')
    const types = journal.read(childRunId).map((event) => event.type)
    assert.ok(types.includes('run.cancelled'), 'the child journaled run.cancelled')
  } finally {
    journal.close()
  }
}

// ----------------------------- no signal: the child still runs to the end
{
  const journal = new SqliteJournal(':memory:')
  try {
    const finishingLlm = {
      async chat() {
        return {
          message: { role: 'assistant', content: 'child finished' },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }
    const host = createFakeRuntime({ tools: [schema('read')], llm: finishingLlm, journal })
    const raw = [schema('read')]
    const store = new ToolState(() => Promise.resolve(raw), [subagentToolSchema])
    const composed = await composeSubagentService({
      runtime: host.runtime,
      model: { provider: 'mock', model: 'mock-1' } as never,
      parent: { list: async () => raw, call: async () => ({}) },
      snapshot: await store.reload(),
      guardCall: store.guardCall(),
    })
    const result = (await composed.call('subagent', args(['read']))) as { status: string }
    assert.equal(result.status, 'completed')
    assert.equal(journal.listRuns()[0]?.status, 'completed')
  } finally {
    journal.close()
  }
}

// ----------------------------------------- startup reaper over a real journal
{
  const dir = mkdtempSync(join(tmpdir(), 'z1-reaper-'))
  try {
    const journal = new SqliteJournal(join(dir, 'journal.sqlite'))
    try {
      const processStart = Date.now()
      const digest = '0'.repeat(64)
      // An orphan from a dead process, and a row this (or another live) process
      // started after `processStart`.
      journal.createRun({
        runId: 'run_orphan_parent',
        graphId: 'agent.loop',
        graphDigest: digest,
        status: 'running',
        createdAt: processStart - 60_000,
        updatedAt: processStart - 60_000,
      })
      journal.createRun({
        runId: 'run_orphan_child',
        graphId: 'agent.loop',
        graphDigest: digest,
        status: 'running',
        createdAt: processStart - 30_000,
        updatedAt: processStart - 30_000,
        parentRunId: 'run_orphan_parent',
      })
      journal.createRun({
        runId: 'run_live',
        graphId: 'agent.loop',
        graphDigest: digest,
        status: 'running',
        createdAt: processStart + 1,
        updatedAt: processStart + 1,
      })
      journal.createRun({
        runId: 'run_done',
        graphId: 'agent.loop',
        graphDigest: digest,
        status: 'running',
        createdAt: processStart - 120_000,
        updatedAt: processStart - 120_000,
      })
      journal.updateRun('run_done', { status: 'completed', updatedAt: processStart - 100_000 })

      const lines: string[] = []
      const result = reapOrphanedRuns(journal, {
        processStart,
        now: () => processStart,
        onLine: (line) => lines.push(line),
      })
      assert.deepEqual(result.reaped.sort(), ['run_orphan_child', 'run_orphan_parent'])
      assert.equal(lines.length, 2, 'one line per reaped run')
      for (const line of lines) assert.match(line, /^· reaped orphaned run run_…?/)

      assert.equal(journal.getRun('run_orphan_parent')?.status, 'failed')
      // A fork child's row is reaped too: its process is gone with its parent.
      assert.equal(journal.getRun('run_orphan_child')?.status, 'failed')
      assert.equal(journal.getRun('run_orphan_child')?.parentRunId, 'run_orphan_parent')
      assert.equal(journal.getRun('run_live')?.status, 'running', 'a fresh row is left alone')
      assert.equal(journal.getRun('run_done')?.status, 'completed', 'a finished row is untouched')

      // The default clock writes `updatedAt`; nothing else changes.
      assert.equal(journal.getRun('run_orphan_parent')?.updatedAt, processStart)

      // A second run of the reaper is a no-op: no rows were reaped.
      const again = reapOrphanedRuns(journal, { processStart })
      assert.deepEqual(again.reaped, [])
    } finally {
      journal.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// An event-only journal (no run rows) is a safe no-op.
{
  const eventOnly = { append() {}, read: () => [] }
  const lines: string[] = []
  const result = reapOrphanedRuns(eventOnly, { processStart: Date.now(), onLine: (line) => lines.push(line) })
  assert.deepEqual(result.reaped, [])
  assert.deepEqual(lines, [])
}

// M-3: the reaper's message format is the one the CLI renders, and the
// interactive path routes it through the tail (`say`) rather than `console.log`.
{
  const journal = new SqliteJournal(':memory:')
  try {
    const processStart = Date.now()
    journal.createRun({
      runId: 'run_reaped_1',
      graphId: 'agent.loop',
      graphDigest: '0'.repeat(64),
      status: 'running',
      createdAt: processStart - 5_000,
      updatedAt: processStart - 5_000,
    })
    const lines: string[] = []
    reapOrphanedRuns(journal, { processStart, onLine: (line) => lines.push(line) })
    assert.equal(lines.length, 1)
    assert.match(lines[0] ?? '', /^· reaped orphaned run run_reaped_1 \(started \d{4}-\d\d-\d\dT/)
  } finally {
    journal.close()
  }

  const source = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf8')
  const interactive = source.slice(source.indexOf('const interactive = async'))
  const start = interactive.indexOf('reapOrphanedRuns(')
  assert.ok(start > 0, 'the interactive path calls the reaper')
  const call = interactive.slice(start, interactive.indexOf('\n  })', start) + 4)
  assert.match(call, /onLine: line => say\(dim\(line\)\)/, 'interactive reaper reports through the tail')
  assert.doesNotMatch(call, /console\.log/, 'interactive reaper never uses raw console.log')
}

console.log('subagent-cancel tests passed')
