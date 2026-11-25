import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolState } from '../tool-state.ts'

const dir = mkdtempSync(join(tmpdir(), 'z1-toolstate-'))
const file = join(dir, 'tools.json')
process.env['Z1_TOOLS_FILE'] = file

const schema = (name: string) => ({ name, description: `${name} desc`, parameters: { type: 'object' } })
let listed = [schema('read'), schema('shell')]
const service = {
  async list() { return listed },
  async call(name: string, args: unknown) { return { ok: true, name, args } },
}
const store = new ToolState(() => service.list())
const callGuard = (guard: ReturnType<ToolState['guard']>, name: string) => guard.call(name, {})

let snap = await store.reload()
assert.equal(snap.inventoryKnown, true)
assert.equal(snap.enabled.length, 2)
assert.equal(snap.revision, 1)
assert.equal((await store.resolve('1')).ok, true)

const off = store.apply(['shell'], 'disabled')
assert.equal(off.ok, true)
snap = store.current
assert.deepEqual(snap.enabled.map(r => r.name), ['read'])
assert.equal((await store.resolve('2')).ok, true)

// Same order -> revision stays; a listing printed earlier is still valid.
const before = store.current.revision
await store.reload()
assert.equal(store.current.revision, before)

// A real inventory change bumps the revision and makes old numbers stale.
listed = [schema('read')]
await store.reload()
assert.equal(store.current.revision, before + 1)
const stale = await store.resolve('1')
assert.equal(stale.ok, false)
if (!stale.ok) assert.match(stale.message, /list changed/)
store.markListed()
assert.equal((await store.resolve('1')).ok, true)

// Orphan preference is shown installed=false and is restorable by name.
writeFileSync(file, JSON.stringify({ schemaVersion: 1, tools: { ghost: { state: 'deleted', at: 1 } } }))
store.reloadPrefs()
const ghost = store.current.records.find(r => r.name === 'ghost')
assert.ok(ghost)
assert.equal(ghost.installed, false)
assert.equal((await store.resolve('ghost')).ok, true)

// Guard list is frozen; call re-reads the overlay and rejects a disabled tool.
writeFileSync(file, JSON.stringify({ schemaVersion: 1, tools: { shell: { state: 'disabled', at: 1 } } }))
store.reloadPrefs()
const guard = store.guard(service)
assert.deepEqual((await guard.list()).map(t => t.name), ['read'])
await assert.rejects(() => callGuard(guard, 'shell'), /disabled/)

// A failed write leaves the snapshot unchanged.
process.env['Z1_TOOLS_FILE'] = dir
const failed = store.apply(['read'], 'disabled')
assert.equal(failed.ok, false)
assert.deepEqual(store.current.enabled.map(r => r.name), ['read'])

// Reset repairs an unreadable file.
process.env['Z1_TOOLS_FILE'] = file
writeFileSync(file, '{ broken')
store.reloadPrefs()
assert.ok(store.current.error)
const reset = store.reset()
assert.equal(reset.ok, true)
assert.equal(store.current.error, undefined)
assert.equal(store.current.enabled.length, 1)

// A corrupt overlay must not be merged onto: `apply` refuses, does not touch
// the file, and names the documented repair. Merging onto the last-good/empty
// fallback would atomically replace the file and silently wipe decisions.
writeFileSync(file, '{ broken again')
store.reloadPrefs()
assert.ok(store.current.error)
const brokenBytes = readFileSync(file, 'utf8')
const refused = store.apply(['shell'], 'disabled')
assert.equal(refused.ok, false)
if (!refused.ok) assert.match(refused.message, /\/tools reset/)
assert.equal(readFileSync(file, 'utf8'), brokenBytes, 'a refused apply left the corrupt file untouched')
assert.equal(store.current.error !== undefined, true, 'the error is still surfaced after the refusal')

// `/tools reset` is the repair; the next apply merges normally.
assert.equal(store.reset().ok, true)
assert.equal(store.current.error, undefined)
const repairedApply = store.apply(['shell'], 'disabled')
assert.equal(repairedApply.ok, true)
assert.deepEqual(store.current.enabled.map((row) => row.name), ['read'])

// The fresh-start shape (`degraded: 'empty'`, no last-good read) refuses too:
// that is the case where merging would re-enable every tool.
{
  const freshFile = join(dir, 'fresh-tools.json')
  writeFileSync(freshFile, '{ definitely not json')
  process.env['Z1_TOOLS_FILE'] = freshFile
  const freshStore = new ToolState(() => service.list())
  assert.equal(freshStore.current.degraded, 'empty')
  assert.ok(freshStore.current.error)
  const refusedEmpty = freshStore.apply(['read'], 'disabled')
  assert.equal(refusedEmpty.ok, false)
  if (!refusedEmpty.ok) assert.match(refusedEmpty.message, /\/tools reset/)
  assert.equal(readFileSync(freshFile, 'utf8'), '{ definitely not json', 'the fresh corrupt file was untouched')
  assert.equal(freshStore.reset().ok, true)
  assert.equal(freshStore.current.error, undefined)
  assert.equal(freshStore.apply(['read'], 'disabled').ok, true)
}
process.env['Z1_TOOLS_FILE'] = file

// System tools: listed, policy-controlled, but never deletable. `tool.create`
// is added by the engine behind Z1_TOOL_CREATOR; `subagent` is a host schema and
// is system by construction.
{
  const systemFile = join(dir, 'system-tools.json')
  process.env['Z1_TOOLS_FILE'] = systemFile
  const hostSchema = { name: 'subagent', description: 'delegate', parameters: { type: 'object' } }
  const systemStore = new ToolState(
    async () => [schema('read'), schema('tool.create'), hostSchema],
    [hostSchema],
  )
  await systemStore.reload()
  const record = (name: string) => systemStore.current.records.find((row) => row.name === name)

  assert.equal(record('tool.create')?.system, true)
  assert.equal(record('subagent')?.system, true, 'a host schema is system by construction')
  assert.equal(record('read')?.system, false)

  const refusedCreate = systemStore.apply(['tool.create'], 'deleted')
  assert.equal(refusedCreate.ok, false, 'a system tool cannot be deleted')
  if (!refusedCreate.ok) {
    assert.match(refusedCreate.message, /system tool/)
    assert.match(refusedCreate.message, /Z1_TOOL_CREATOR=0/)
  }
  const refusedHost = systemStore.apply(['subagent'], 'deleted')
  assert.equal(refusedHost.ok, false)

  // Turning it off is allowed: the agent stops seeing it, the row stays.
  const off = systemStore.apply(['tool.create'], 'disabled')
  assert.equal(off.ok, true)
  assert.deepEqual(systemStore.current.enabled.map((row) => row.name), ['read', 'subagent'])
  assert.equal(record('tool.create')?.state, 'disabled')

  // A real tool is still deletable.
  assert.equal(systemStore.apply(['read'], 'deleted').ok, true)
  process.env['Z1_TOOLS_FILE'] = file
}

console.log('tool-state tests passed')
