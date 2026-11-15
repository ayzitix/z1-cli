import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

console.log('tool-state tests passed')
