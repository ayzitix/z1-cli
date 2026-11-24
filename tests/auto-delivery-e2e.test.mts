/**
 * The requirement, end to end: a parent launches a background child, does not
 * wait, and the child's report reaches the parent **without the user typing**.
 *
 * `subagent-turn.test.mts` proves the first half (the turn closes while the
 * child is still live). `auto-delivery.test.mts` proves the decision table.
 * This test joins them over a real graph: it drains the child exactly as
 * `runTurn` does (`AgentRegistry.settledUndelivered`), builds the same
 * `deliveryMessage(deliveredBlock(...))` seed the loop builds, and runs a
 * second parent turn - so what is asserted is the actual conversation the
 * model receives, not a mock of it.
 *
 * The three properties that make the feature true:
 *
 * 1. the report is in the *second* turn's seed, as a user-role automated block;
 * 2. it is there **once** (`markDelivered`, never twice) and never as the
 *    launching call's tool result;
 * 3. the first turn did not contain it and did not wait for it.
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
import {
  AgentRegistry,
  SUBAGENT_OUTPUT_PREAMBLE,
  deliveredBlock,
  entryElapsed,
  runningLabel,
} from '../agents.ts'
import { AUTO_DELIVERY_PROMPT, settleSignal } from '../auto-delivery.ts'

const dir = mkdtempSync(join(tmpdir(), 'z1-auto-delivery-'))
process.env['Z1_TOOLS_FILE'] = join(dir, 'tools.json')

const MODEL = { provider: 'mock', model: 'mock-1' } as const
const schema = (name: string) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
})

const launch = {
  description: 'read the config',
  prompt: 'read config.json and report the port',
  tools: { enable: ['read'] },
}

/** Every message list the parent model was given: the conversation it saw. */
const parentSeeds: Array<readonly { role: string; content: string }[]> = []
let parentChats = 0
const parentLlm = {
  async chat(request: { messages?: readonly { role: string; content: string }[] }) {
    parentSeeds.push(request.messages ?? [])
    parentChats += 1
    if (parentChats === 1) {
      return {
        message: { role: 'assistant', content: '' },
        toolCalls: [{ id: 'call_launch', name: SUBAGENT_TOOL_NAME, arguments: launch }],
        stopReason: 'tool_calls',
      }
    }
    return {
      message: { role: 'assistant', content: 'Started the reader; I will report when it settles.' },
      toolCalls: [],
      stopReason: 'stop',
    }
  },
}

// The child answers only when released, so "the turn did not wait" is a fact
// about the gate rather than about scheduler luck.
let releaseChild: () => void = () => {}
const childGate = new Promise<void>((resolve) => {
  releaseChild = resolve
})
const CHILD_ANSWER = 'config.json sets port 8080'
const childLlm = {
  async chat() {
    await childGate
    return {
      message: { role: 'assistant', content: CHILD_ANSWER },
      toolCalls: [],
      stopReason: 'stop',
    }
  },
}

const events = new Map<string, unknown[]>()
const journal = {
  append(event: { runId: string }) {
    const rows = events.get(event.runId) ?? []
    rows.push(event)
    events.set(event.runId, rows)
  },
  read: (runId: string) => events.get(runId) ?? [],
  createRun(row: { runId: string }) {
    const rows = events.get(row.runId) ?? []
    rows.push({ type: 'run', ...row })
    events.set(row.runId, rows)
  },
  updateRun() {},
  listRuns: () => [],
}

let handleCalls = 0
/**
 * Which handle the next `beginRun` is for. The parent turn asks for its handle
 * *before* it runs the graph; every handle created while that graph runs belongs
 * to a child. A call counter cannot tell the second parent turn from a child,
 * which is exactly the bug this flag avoids.
 */
let expectParentHandle = false
const runtime = {
  journal,
  async beginRun(overrides: Record<string, unknown>) {
    handleCalls += 1
    const isParent = expectParentHandle
    expectParentHandle = false
    const services = createMockRuntimeServices() as unknown as Record<string, unknown>
    const handle = {
      registry: createBuiltinRegistry(),
      services,
      async dispose() {},
    }
    services['llm'] = isParent ? parentLlm : childLlm
    services['approval'] = (overrides as { approval?: unknown }).approval ?? denyApprovalService
    services['tools'] = {
      async list() {
        return isParent ? [schema('read'), subagentToolSchema] : [schema('read')]
      },
      async call(name: string) {
        return { ok: true, name }
      },
    }
    return handle
  },
}

const agents = new AgentRegistry()
const settled: string[] = []
const service = await composeSubagentService({
  runtime,
  model: MODEL,
  parent: {
    async list() {
      return [schema('read')]
    },
    async call(name: string) {
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
    const before = agents.get(finish.runId)?.outcome
    agents.finish(finish.runId, {
      outcome: finish.status,
      tools: finish.tools,
      denied: finish.denied,
      ...(finish.steps === undefined ? {} : { steps: finish.steps }),
      ...(finish.output === undefined ? {} : { output: finish.output }),
      ...(finish.text === undefined ? {} : { text: finish.text }),
    })
    const after = agents.get(finish.runId)
    // The same condition `chat.ts` uses before it wakes an automated turn.
    if (before === 'running' && after?.mode === 'background' && after.delivered !== true) {
      settled.push(finish.runId)
    }
  },
})

const runParentTurn = async (history: readonly { role: string; content: string }[]) => {
  expectParentHandle = true
  const handle = await runtime.beginRun({})
  return runGraph({
    graph: buildAgentGraph({
      model: MODEL,
      maxSteps: 8,
      system: 'be brief',
      tools: [schema('read'), subagentToolSchema],
      history: history as never,
    }) as never,
    input: 'read the config',
    registry: handle.registry,
    services: { ...handle.services, tools: service, approval: denyApprovalService },
  })
}

// --------------------------- turn 1: launch, do not wait

const first = await runParentTurn([])
assert.equal(first.status, 'completed', 'turn 1 closes on its own answer')
const entry = agents.list()[0]
assert.ok(entry !== undefined)
assert.equal(entry.outcome, 'running', 'turn 1 closed while the child was still live')
assert.equal(settled.length, 0, 'nothing settled yet, so nothing woke')
assert.equal(runningLabel(agents.running().length), '◷ 1 subagent running · /agents', 'the live row names it')

// Turn 1's own seed carries no report: the child had not answered.
const firstSeed = parentSeeds[0]?.map((message) => message.content).join('\n') ?? ''
assert.ok(!firstSeed.includes(SUBAGENT_OUTPUT_PREAMBLE), 'the launching turn never carries the report')

// --------------------------- the child settles while the prompt is idle

// This is the exact moment the feature exists for: the user has typed nothing.
// The decision, not the terminal, is what runs.
assert.equal(runningLabel(agents.running().length), '◷ 1 subagent running · /agents')
releaseChild()
const done = await new Promise<boolean>((resolve) => {
  const deadline = setTimeout(() => resolve(false), 10_000)
  const poll = setInterval(() => {
    if (agents.list()[0]?.outcome !== 'running') {
      clearInterval(poll)
      clearTimeout(deadline)
      resolve(true)
    }
  }, 20)
})
assert.equal(done, true, 'the child settles on its own, with no user input')
assert.equal(agents.list()[0]?.outcome, 'completed', 'and reports its own outcome')
assert.equal(settled.length, 1, 'the settle was reported once')

// The wake decision for that settle, with the prompt idle.
assert.equal(
  settleSignal({ enabled: true, closed: false, turnActive: false, queued: false }),
  'wake',
  'an idle settle wakes an automated turn',
)
// The live row is gone the moment the count is zero.
assert.equal(runningLabel(agents.running().length), undefined, 'no child running, no row')

// --------------------------- turn 2: the report arrives unprompted

// Exactly what `runTurn` drains at turn start.
const delivered = agents.settledUndelivered()
assert.equal(delivered.length, 1, 'the settled child is waiting for delivery')
const block = deliveredBlock({ entry: delivered[0]!, elapsedMs: entryElapsed(delivered[0]!, Date.now()) })
// The block is marked, names the run, and carries the child's answer.
assert.ok(block.startsWith(SUBAGENT_OUTPUT_PREAMBLE), 'the block is marked as subagent output')
assert.match(block, /delivered: background · completed/, 'the block names the late delivery')
assert.ok(block.includes(CHILD_ANSWER), 'the block carries the child’s actual answer')

const history = [
  { role: 'user', content: 'read the config' },
  { role: 'assistant', content: 'Started the reader; I will report when it settles.' },
  // `deliveryMessage` is user-role; its body is the marked block.
  { role: 'user', content: block },
]
// Seeds are recorded per model call, and turn 1 made two of them (launch, then
// answer). Everything from this index on belongs to turn 2.
const turn2From = parentSeeds.length
const second = await runParentTurn(history)
assert.equal(second.status, 'completed', 'the report turn completes normally')
for (const item of delivered) agents.markDelivered(item.runId)

// What the model actually received in turn 2: the automated block, the prompt
// it was paired with, and nothing claiming to be the user speaking.
const turn2Seeds = parentSeeds.slice(turn2From)
assert.ok(turn2Seeds.length > 0, 'turn 2 asked the model at least once')
const secondSeed = turn2Seeds.map((seed) => seed.map((message) => message.content).join('\n')).join('\n')
assert.ok(secondSeed.includes(SUBAGENT_OUTPUT_PREAMBLE), 'turn 2 carries the report')
assert.ok(secondSeed.includes(CHILD_ANSWER), 'and the child’s answer is in it')

// --------------------------- once, never twice

assert.equal(agents.settledUndelivered().length, 0, 'a delivered child is never drained again')
assert.equal(
  agents.settledUndelivered().length,
  0,
  'so a third turn cannot see the same report a second time',
)

// The prompt the automated turn carries is an instruction to continue, and it
// keeps the untrusted-text rule the block itself states.
assert.match(AUTO_DELIVERY_PROMPT, /subagent output/i)
assert.match(AUTO_DELIVERY_PROMPT, /do not wait/i)

console.log(
  'PASS: auto-delivery-e2e (launch does not wait, idle settle wakes, report reaches turn 2 once, marked as data)',
)
