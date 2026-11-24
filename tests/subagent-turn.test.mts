/**
 * Item 1 of the 2b UX brief: a turn that only *launches* a background child must
 * not go silent.
 *
 * The bug it pins: if a background launch ended the turn, the user would see a
 * `started` row, no assistant message, and no step counter - the session would
 * look stuck until the child settled. A turn is over when the *model* stops
 * calling tools, not when a tool call happened to return a launch.
 *
 * This drives a real parent graph (`buildAgentGraph` + `runGraph`, exactly what
 * `runTurn` builds) over the mock runtime, with a model that calls `subagent`
 * without `wait`, then answers like any other turn. The composer is not
 * involved: `runTurn`'s plate and closing lines only format `RunResult`.
 *
 * Scope (M-1): this proves the *launch-then-answer* turn. If the launch were the
 * model's **last** step, the loop would hit its `maxIterations` limit (fed from
 * `buildAgentGraph`'s `maxSteps`, `packages/agent/src/index.ts:454`) and close
 * `failed` instead of with a final message - the child still runs and is
 * delivered next turn, so no work is lost, but the user sees a failure line.
 * That is existing loop behaviour, unchanged by 2b, and is not asserted here.
 *
 * Determinism (M-2): the child's model call blocks on `childGate`, released
 * only after `runGraph` returns, so "still running" is a fact about the code
 * rather than about which task won a race.
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBuiltinRegistry } from '../../z1-sdk/z1/packages/nodes/lib/index.js'
import { createMockRuntimeServices } from '../../z1-sdk/z1/packages/runtime/lib/index.js'

import {
  SUBAGENT_TOOL_NAME,
  buildAgentGraph,
  denyApprovalService,
  runGraph,
  subagentToolSchema,
} from '../sdk.ts'
import { composeSubagentService } from '../subagent-host.ts'
import { AgentRegistry } from '../agents.ts'

const dir = mkdtempSync(join(tmpdir(), 'z1-subagent-turn-'))
process.env['Z1_TOOLS_FILE'] = join(dir, 'tools.json')

const MODEL = { provider: 'mock', model: 'mock-1' } as const
const schema = (name: string) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
})

/** The launch arguments a background call uses: no `wait`. */
const launch = {
  description: 'scan the tests',
  prompt: 'do the task',
  tools: { enable: ['read'] },
}

const createJournal = () => {
  const events = new Map<string, unknown[]>()
  return {
    append(event: { runId: string }) {
      const rows = events.get(event.runId) ?? []
      rows.push(event)
      events.set(event.runId, rows)
    },
    read(runId: string) {
      return events.get(runId) ?? []
    },
    createRun(row: { runId: string }) {
      const rows = events.get(row.runId) ?? []
      rows.push({ type: 'run', ...row })
      events.set(row.runId, rows)
    },
    updateRun() {},
    listRuns() {
      return []
    },
  }
}

// Two models: the parent, which launches once and then answers; and the child,
// which answers immediately so the launch settles quickly.
let parentChats = 0
const parentLlm = {
  async chat() {
    parentChats += 1
    // One step: the model says what it is doing and launches. The turn ends on
    // the launch, so there is no second answer to produce.
    return {
      message: { role: 'assistant', content: 'Delegating; the report will arrive on its own.' },
      toolCalls: [{ id: 'call_launch', name: SUBAGENT_TOOL_NAME, arguments: launch }],
      stopReason: 'tool_calls',
    }
  },
}
/**
 * The child is held here until the test releases it, *after* the parent turn
 * has closed. Without this the "child still running when the turn ends"
 * assertion would depend on scheduler luck - three incidental properties
 * (the mock answering instantly, the settle task losing the race, and the
 * poll happening before it lands) - instead of on the behaviour under test.
 */
let releaseChild: () => void = () => {}
const childGate = new Promise<void>((resolve) => {
  releaseChild = resolve
})

const childLlm = {
  async chat() {
    await childGate
    return {
      message: { role: 'assistant', content: 'child done' },
      toolCalls: [],
      stopReason: 'stop',
    }
  },
}

/**
 * One runtime that hands the parent and the child different services: the
 * parent sees the `subagent` composite, the child sees only `read`.
 */
const journal = createJournal()
const childHandles: Array<{ disposed: boolean }> = []
const children: string[] = []
let parentHandleCalls = 0
const runtime = {
  journal,
  async beginRun(overrides: Record<string, unknown>) {
    parentHandleCalls += 1
    const isParent = parentHandleCalls === 1
    const services = createMockRuntimeServices() as unknown as Record<string, unknown>
    const handle = {
      registry: createBuiltinRegistry(),
      services,
      disposed: false,
      async dispose() {
        handle.disposed = true
      },
    }
    if (!isParent) childHandles.push(handle)
    services['llm'] = isParent ? parentLlm : childLlm
    services['approval'] = (overrides as { approval?: unknown }).approval ?? denyApprovalService
    services['tools'] = {
      async list() {
        return isParent ? [schema('read'), subagentToolSchema] : [schema('read')]
      },
      async call(name: string) {
        if (name === SUBAGENT_TOOL_NAME) return { ok: true, name }
        children.push(name)
        return { ok: true, name }
      },
    }
    return handle
  },
}

// The session registry, wired the way `runTurn` wires it: the launch is a row
// before the model is asked for its next step, and its settlement is a row too.
const agents = new AgentRegistry()
const service = await composeSubagentService({
  runtime,
  model: MODEL,
  parent: {
    async list() {
      return [schema('read')]
    },
    async call(name: string) {
      children.push(name)
      return { ok: true, name }
    },
  },
  snapshot: {
    enabled: [{ name: 'read', state: 'enabled' as const }],
    enabledSchemas: [schema('read'), subagentToolSchema],
    moduleSchemas: [schema('read')],
    inventoryKnown: true,
  } as never,
  approval: denyApprovalService,
  moduleApproval: denyApprovalService,
  onStart: (start) => {
    agents.start(start)
  },
  onFinish: (finish) => {
    agents.finish(finish.runId, {
      outcome: finish.status,
      tools: finish.tools,
      denied: finish.denied,
      ...(finish.steps === undefined ? {} : { steps: finish.steps }),
    })
  },
})

// The parent graph, built exactly as `runTurn` builds it.
const handle = await runtime.beginRun({})
const graph = buildAgentGraph({
  model: MODEL,
  maxSteps: 8,
  system: 'be brief',
  tools: [schema('read'), subagentToolSchema],
})

const result = await runGraph({
  graph: graph as never,
  input: 'start a scanner',
  registry: handle.registry,
  services: {
    ...handle.services,
    tools: service,
    approval: denyApprovalService,
  },
})

// --- the turn closed on the launch, and the prompt is free

// One model call, not two: a step that only launched a background child is a
// hand-off, so the loop closes the turn instead of asking the model for a
// "delegated, waiting" message. That second call was what kept the prompt busy
// after the work had already left.
assert.equal(parentChats, 1, 'the model was asked once: the launch, then the turn ended')
assert.equal(
  result.status,
  'completed',
  'the turn completed on its own - it did not stall waiting for the child',
)

// --- the turn's answer is what the model said in that step

// The last transcript message is the tool result (`core.last` would publish its
// JSON payload); `lastText` reads the last *assistant* message instead.
const outputs = (result as unknown as { outputs?: Record<string, unknown> }).outputs ?? {}
assert.equal(
  outputs['output'],
  'Delegating; the report will arrive on its own.',
  'the turn ends on the model’s own text, not on the tool payload',
)

// --- and the launch really happened in the background

const entry = agents.list()[0]
assert.ok(entry !== undefined, 'the session registry knows the child')
assert.equal(entry.mode, 'background', 'the call was a background launch, not `wait`')
assert.equal(entry.description, 'scan the tests')
assert.equal(children.length, 0, 'the parent never ran the child’s tool itself')
assert.equal(childHandles.length, 1, 'exactly one child was started')
// The decisive fact: the parent closed while its child was still running. That
// is what "background" means - the turn does not wait, and it does not print a
// "waiting for children" placeholder either; the child settles later.
//
// This is direct, not incidental: the child's own model call is blocked on
// `childGate`, which is still unreleased, so it *cannot* have settled yet.
assert.equal(entry.outcome, 'running', 'the turn closed with the child still running')
assert.equal(
  agents.running().length,
  1,
  'so exactly one child is still live when the next prompt is accepted',
)

// Release the child and let it report its end through the same `onFinish` hook
// the `wait` path uses.
releaseChild()
const settled = await new Promise<boolean>((resolve) => {
  const deadline = setTimeout(() => resolve(false), 10_000)
  const poll = setInterval(() => {
    if (agents.list()[0]?.outcome !== 'running') {
      clearInterval(poll)
      clearTimeout(deadline)
      resolve(true)
    }
  }, 20)
})
assert.equal(settled, true, 'the background child settles and the session registry sees it')
assert.equal(agents.list()[0]?.outcome, 'completed', 'with the child’s own outcome')
// Still one model call after the child settled: the loop did not wake up for a
// "delegated, waiting" message, and settling the child did not run the parent
// again either. The report is what the next turn carries.
assert.equal(
  parentChats,
  1,
  'one model step for the whole turn: the launch is the hand-off',
)

console.log('PASS: subagent-turn (a background launch ends the turn: one step, completed, child still live)')
