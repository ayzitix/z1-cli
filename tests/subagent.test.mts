import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createBuiltinRegistry } from '../../z1-sdk/z1/packages/nodes/lib/index.js'
import { createMockRuntimeServices } from '../../z1-sdk/z1/packages/runtime/lib/index.js'

import {
  SUBAGENT_TOOL_NAME,
  SubagentError,
  createSubagentTool,
  denyApprovalService,
  subagentToolSchema,
  withSubagentTool,
} from '../sdk.ts'
import {
  composeSubagentService,
  hasSubagentCollision,
  subagentInventory,
} from '../subagent-host.ts'
import { ToolState } from '../tool-state.ts'

const dir = mkdtempSync(join(tmpdir(), 'z1-subagent-cli-'))
process.env['Z1_TOOLS_FILE'] = join(dir, 'tools.json')

const schema = (name: string) => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
})
const MODEL = { provider: 'mock', model: 'mock-1' } as const
const args = (enable: readonly string[], disable?: readonly string[]) => ({
  description: 'one task',
  prompt: 'do the task',
  tools: { enable, ...(disable === undefined ? {} : { disable }) },
})

/**
 * The v1 blocking call. 2b made background the default, so a test that needs
 * the child's result in hand (not a launch) opts in explicitly.
 */
const waitArgs = (enable: readonly string[]) => ({ ...args(enable), wait: true })

/** Event-only journal: no run recorder, so the package skips run rows. */
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
  }
}

/**
 * A structural runtime over the real mock services and builtin registry: the
 * package's own child graph runs, but `beginRun` is observable and no provider
 * or network is involved.
 */
const createFakeRuntime = (options: {
  tools?: readonly ReturnType<typeof schema>[]
  llm?: unknown
} = {}) => {
  const journal = createJournal()
  const beginCalls: Array<Record<string, unknown>> = []
  const handles: Array<{ disposed: boolean; services: Record<string, unknown> }> = []
  const toolCalls: Array<{ name: string; args: unknown }> = []
  const runtime = {
    journal,
    async beginRun(overrides: Record<string, unknown>) {
      beginCalls.push(overrides)
      const services = createMockRuntimeServices() as unknown as Record<string, unknown>
      const source = options.tools ?? []
      services['tools'] = {
        async list() {
          return source
        },
        async call(name: string, toolArgs: unknown) {
          toolCalls.push({ name, args: toolArgs })
          return { ok: true, name }
        },
      }
      if (options.llm !== undefined) services['llm'] = options.llm
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
  return { runtime, beginCalls, handles, toolCalls, journal }
}

const parentService = (schemas: readonly ReturnType<typeof schema>[]) => {
  const calls: string[] = []
  const listCalls: string[] = []
  return {
    calls,
    listCalls,
    async list() {
      listCalls.push('list')
      return schemas
    },
    async call(name: string, toolArgs: unknown) {
      calls.push(name)
      return { ok: true, name, args: toolArgs }
    },
  }
}

// ------------------------------------------------- schema and `/tools` policy
assert.equal(subagentToolSchema.name, SUBAGENT_TOOL_NAME)
assert.equal(SUBAGENT_TOOL_NAME, 'subagent')
const parameters = subagentToolSchema.parameters as Record<string, any>
assert.deepEqual(parameters['required'], ['description', 'prompt', 'tools'])
assert.deepEqual(parameters['properties']['tools']['required'], ['enable'])

const raw = [schema('read'), schema('shell')]
const store = new ToolState(() => Promise.resolve(raw), [subagentToolSchema])
let snapshot = await store.reload()
assert.equal(snapshot.inventoryKnown, true)
assert.deepEqual(
  snapshot.enabled.map((record) => record.name),
  ['read', 'shell', 'subagent'],
  'the ToolState snapshot lists the host-composed subagent tool',
)
assert.deepEqual(
  snapshot.moduleSchemas.map((entry) => entry.name),
  ['read', 'shell'],
  'the package inventory stays the raw modules',
)
assert.equal(snapshot.installedCount, 3)
assert.equal(snapshot.records.find((record) => record.name === 'subagent')?.installed, true)

let off = store.apply([SUBAGENT_TOOL_NAME], 'disabled')
assert.equal(off.ok, true)
snapshot = store.current
assert.deepEqual(
  snapshot.enabled.map((record) => record.name),
  ['read', 'shell'],
  '`/tools off subagent` removes it from the model tools and run allowlist',
)
assert.equal(
  snapshot.enabledSchemas.some((entry) => entry.name === SUBAGENT_TOOL_NAME),
  false,
)
const offParent = parentService(raw)
const offComposed = await composeSubagentService({
  runtime: createFakeRuntime().runtime,
  model: MODEL,
  parent: offParent,
  snapshot: store.current,
  guardCall: store.guardCall(),
})
assert.equal(offComposed, offParent, 'a disabled subagent tool is not composed')
assert.equal(offParent.listCalls.length, 0, 'composition did not call the parent list()')
const offService = store.guard(offComposed)
assert.deepEqual(
  (await offService.list()).map((entry) => entry.name),
  ['read', 'shell'],
  'the turn service hides a disabled subagent tool',
)
await assert.rejects(async () => await offService.call(SUBAGENT_TOOL_NAME, args(['read'])), /disabled/)
assert.deepEqual(offParent.calls, [], 'a disabled subagent tool never reaches the parent service')
// Restore it for the composition tests below.
assert.equal(store.apply([SUBAGENT_TOOL_NAME], 'enabled').ok, true)

// ---------------------------------------------------------- grant ceiling
off = store.apply(['shell'], 'disabled')
assert.equal(off.ok, true)
const inventory = subagentInventory(store.current)
assert.deepEqual(inventory.installed.map((entry) => entry.name), ['read', 'shell'])
assert.deepEqual(
  inventory.enabled.map((entry) => entry.name),
  ['read'],
  'the ceiling is the enabled `/tools` set, not every installed module tool',
)

const blockedHost = createFakeRuntime({ tools: raw })
const blocked = createSubagentTool({
  model: MODEL,
  host: blockedHost.runtime,
  inventory,
  approval: denyApprovalService,
  moduleApproval: denyApprovalService,
})
await assert.rejects(
  () => blocked.call(args(['shell'])),
  (error: unknown) =>
    error instanceof SubagentError &&
    error.code === 'disabled_tool' &&
    /not enabled for the parent/.test(error.message),
  'a grant naming a parent-disabled tool fails before child creation',
)
assert.equal(blockedHost.beginCalls.length, 0, 'invalid grant has no side effects')
assert.equal(blockedHost.handles.length, 0)

// A `*` grant expands to the same ceiling: read only, never the disabled shell.
const starHost = createFakeRuntime({ tools: [schema('read')] })
const star = createSubagentTool({
  model: MODEL,
  host: starHost.runtime,
  inventory,
  approval: denyApprovalService,
  moduleApproval: denyApprovalService,
})
const starResult = await star.call(args(['*']))
assert.deepEqual(starResult.tools, ['read'])
assert.deepEqual(starResult.denied, [])

// ------------------------------------------------ child guard revokes mid-run
off = store.apply(['read'], 'enabled')
assert.equal(off.ok, true)
off = store.apply(['shell'], 'disabled')
assert.equal(off.ok, true)
assert.deepEqual(
  store.current.enabled.map((record) => record.name),
  ['read', 'subagent'],
  'read is on; the delegation tool is still listed for the parent',
)

const guardCall = store.guardCall()
await guardCall('read', {})
let childChats = 0
const revokingLlm = {
  async chat() {
    childChats += 1
    if (childChats === 1) {
      // The child already has the grant; the user turns the tool off while it
      // is running, before its first tool call is forwarded.
      assert.equal(store.apply(['read'], 'disabled').ok, true)
      return {
        message: { role: 'assistant', content: '' },
        toolCalls: [{ id: 'call_1', name: 'read', arguments: {} }],
        stopReason: 'tool_calls',
      }
    }
    return {
      message: { role: 'assistant', content: 'child done' },
      toolCalls: [],
      stopReason: 'stop',
    }
  },
}
const revokeHost = createFakeRuntime({ tools: [schema('read')], llm: revokingLlm })
const parent = parentService(raw)
const composed = await composeSubagentService({
  runtime: revokeHost.runtime,
  model: MODEL,
  parent,
  snapshot: store.current,
  guardCall,
})
// The revoked-tool path, in its v1 blocking form: `wait: true` keeps the
// child's result on the call, so this test still proves what it was written
// for (the revoked grant), not the 2b launch.
const revoked = await composed.call(SUBAGENT_TOOL_NAME, waitArgs(['read']))
assert.equal((revoked as { output: string }).output, 'child done')
assert.equal(revokeHost.handles.length, 1)
assert.equal(revokeHost.handles[0]?.disposed, true, 'the child handle is disposed')
assert.deepEqual(
  revokeHost.toolCalls,
  [],
  'the child restricted service never forwarded a revoked call',
)
await assert.rejects(async () => guardCall('read', {}), /disabled/)
assert.equal(parent.calls.length, 0, 'the parent service did not receive the child call')

// A second call cannot even start a child after `/tools off read`.
const afterOff = await createSubagentTool({
  model: MODEL,
  host: revokeHost.runtime,
  inventory: subagentInventory(store.current),
  approval: denyApprovalService,
  moduleApproval: denyApprovalService,
})
  .call(args(['read']))
  .then(
    () => 'started',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
assert.match(String(afterOff), /not enabled for the parent/)
assert.equal(revokeHost.handles.length, 1, 'no second child was created')

// -------------------------------- `/tools off subagent` while a child runs
// The turn starts with the composite enabled; the guard must stop advertising
// and calling it after the user turns it off, while the running child's own
// restricted service keeps the grants it resolved at child start.
const midRaw = [schema('read')]
const sharedPrefs = process.env['Z1_TOOLS_FILE']
process.env['Z1_TOOLS_FILE'] = join(dir, 'mid-tools.json')
const midStore = new ToolState(() => Promise.resolve(midRaw), [subagentToolSchema])
const midSnapshot = await midStore.reload()
assert.deepEqual(
  midSnapshot.enabled.map((record) => record.name),
  ['read', 'subagent'],
)
let midChats = 0
const midLlm = {
  async chat() {
    midChats += 1
    if (midChats === 1) {
      assert.equal(midStore.apply([SUBAGENT_TOOL_NAME], 'disabled').ok, true)
      return {
        message: { role: 'assistant', content: '' },
        toolCalls: [{ id: 'call_1', name: 'read', arguments: {} }],
        stopReason: 'tool_calls',
      }
    }
    return {
      message: { role: 'assistant', content: 'child ran' },
      toolCalls: [],
      stopReason: 'stop',
    }
  },
}
const midHost = createFakeRuntime({ tools: [schema('read')], llm: midLlm })
const midParent = parentService(midRaw)
const midComposed = await composeSubagentService({
  runtime: midHost.runtime,
  model: MODEL,
  parent: midParent,
  snapshot: midSnapshot,
  guardCall: midStore.guardCall(),
})
assert.notEqual(midComposed, midParent, 'the turn started with subagent enabled')
const midGuarded = midStore.guard(midComposed)
assert.deepEqual(
  (await midGuarded.list()).map((entry) => entry.name),
  ['read', 'subagent'],
  'the turn service advertises subagent before it is turned off',
)
// The child is already running when `/tools off subagent` lands; `wait: true`
// keeps its result on the call so this still asserts the child path (2b).
const midResult = await midGuarded.call(SUBAGENT_TOOL_NAME, waitArgs(['read']))
assert.equal((midResult as { output: string }).output, 'child ran')
assert.deepEqual(
  midHost.toolCalls.map((call) => call.name),
  ['read'],
  'the child restricted service is unaffected by the parent composite turning off',
)
assert.deepEqual(
  (await midGuarded.list()).map((entry) => entry.name),
  ['read'],
  'the outer guard hides subagent after `/tools off subagent` mid-run',
)
await assert.rejects(
  async () => await midGuarded.call(SUBAGENT_TOOL_NAME, args(['read'])),
  /disabled/,
)
assert.equal(midHost.beginCalls.length, 1, 'the revoked composite cannot start another child')
assert.ok(sharedPrefs)
process.env['Z1_TOOLS_FILE'] = sharedPrefs

// ------------------------------------------------- no duplicate subagent schema
off = store.apply(['read'], 'enabled')
assert.equal(off.ok, true)
snapshot = store.current
const duplicates = snapshot.enabledSchemas.filter((entry) => entry.name === SUBAGENT_TOOL_NAME)
assert.equal(duplicates.length, 1, 'the snapshot has one subagent schema')

const uniqueHost = createFakeRuntime({ tools: [schema('read')] })
const uniqueParent = parentService([schema('read'), schema('shell')])
const unique = await composeSubagentService({
  runtime: uniqueHost.runtime,
  model: MODEL,
  parent: uniqueParent,
  snapshot,
  guardCall: store.guardCall(),
})
const listed = await unique.list()
assert.deepEqual(
  listed.map((entry) => entry.name),
  ['read', 'shell', 'subagent'],
  'composition adds the host tool exactly once',
)
await assert.rejects(
  () => withSubagentTool(unique, { schema: subagentToolSchema, call: async () => { throw new Error('unused') } }),
  (error: unknown) => error instanceof SubagentError && error.code === 'duplicate_tool',
  'the package rejects a second subagent schema',
)

// A real module tool named `subagent` owns the name; the host never shadows it.
const collisionStore = new ToolState(
  () => Promise.resolve([schema('read'), schema('subagent')]),
  [subagentToolSchema],
)
const collisionSnapshot = await collisionStore.reload()
assert.deepEqual(
  collisionSnapshot.records
    .filter((record) => record.installed)
    .map((record) => record.name),
  ['read', 'subagent'],
  'the host schema is not appended over a real tool with that name',
)
assert.equal(hasSubagentCollision(collisionSnapshot), true)
const collisionParent = parentService([schema('read'), schema('subagent')])
assert.equal(
  await composeSubagentService({
    runtime: createFakeRuntime().runtime,
    model: MODEL,
    parent: collisionParent,
    snapshot: collisionSnapshot,
    guardCall: collisionStore.guardCall(),
  }),
  collisionParent,
  'composition leaves the real module tool untouched',
)

// ---------------------------------------------- one-shot never asks approval
// `--once` uses the same per-turn composition. The delegation path offers no
// parent approval prompt: the only approval services the child host receives
// are the package's deny services, and no parent lineage is synthesized.
const onceHost = createFakeRuntime({ tools: [schema('read')] })
const once = await composeSubagentService({
  runtime: onceHost.runtime,
  model: MODEL,
  parent: parentService([schema('read')]),
  snapshot: store.current,
  guardCall: store.guardCall(),
})
const emptyGrant = await once.call(SUBAGENT_TOOL_NAME, args([]))
assert.equal((emptyGrant as { tools: string[] }).tools.length, 0)
const begin = onceHost.beginCalls[0]
assert.ok(begin, 'the child run started')
assert.equal(begin['approval'], denyApprovalService, 'child node approval is deny')
assert.equal(begin['moduleApproval'], denyApprovalService, 'child module approval is deny')
assert.deepEqual(
  Object.keys(begin).sort(),
  ['approval', 'moduleApproval', 'runId'],
  'no parent approval or parent lineage reaches beginRun',
)
assert.equal('parentRunId' in begin, false, 'child runs carry no parentRunId')
assert.equal(
  await (begin['approval'] as typeof denyApprovalService).request(
    { action: 'tool.call' } as never,
    { runId: 'run_child', nodeId: 'child' } as never,
  ),
  'rejected',
  'the child approval rejects without consulting a terminal',
)

for (const call of [
  ...revokeHost.beginCalls,
  ...midHost.beginCalls,
  ...onceHost.beginCalls,
]) {
  assert.equal('parentRunId' in call, false, 'child beginRun never carries parentRunId')
}

// ------------------- `wait: true` at the CLI is still the v1 blocking call

// The brief's "`wait: true` behaves exactly like v1", asserted on the composed
// service (the layer the CLI actually installs): the call blocks and returns
// the child's result, it never looks like a launch, and the background hook is
// not involved at all.
const finishingLlm = {
  async chat() {
    return {
      message: { role: 'assistant', content: 'child done' },
      toolCalls: [],
      stopReason: 'stop',
    }
  },
}
{
  const v1Host = createFakeRuntime({ tools: [schema('read')], llm: finishingLlm })
  const background: unknown[] = []
  const finished: { runId: string; status: string }[] = []
  const started: { runId: string; mode?: string }[] = []
  const service = await composeSubagentService({
    runtime: v1Host.runtime,
    model: MODEL,
    parent: parentService(raw),
    snapshot: store.current,
    guardCall,
    onStart: (start) => {
      started.push(start)
    },
    onFinish: (finish) => {
      finished.push({ runId: finish.runId, status: finish.status })
    },
    onBackground: (launch) => {
      background.push(launch)
    },
  })

  const result = (await service.call(SUBAGENT_TOOL_NAME, waitArgs(['read']))) as Record<string, unknown>

  // The v1 shape: a finished result on the call, never a launch.
  assert.notEqual(result['status'], 'running', 'a `wait: true` call does not return a launch')
  assert.equal(result['status'], 'completed', 'it returns the child outcome')
  assert.equal(result['output'], 'child done', 'with the child text, in hand')
  assert.equal(result['isError'], false, 'as a non-error result')
  assert.equal(typeof result['runId'], 'string', 'and the run id')
  assert.ok('steps' in result, 'plus the v1 fields the tool row reads (`steps`, `elapsedMs`, …)')

  // The hooks: the child is a `wait` row, it ends through `onFinish`, and the
  // background path is never entered for a blocking call.
  assert.deepEqual(started.map((entry) => entry.mode), ['wait'], 'the row knows it was a wait call')
  assert.deepEqual(
    finished.map((entry) => entry.status),
    ['completed'],
    'the end is reported once, through onFinish',
  )
  assert.equal(background.length, 0, 'a `wait: true` call never takes the background path')
}

console.log('subagent tests passed')
