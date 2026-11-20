/**
 * The `/view` preference file: path precedence, the safe fallback, atomic
 * writes, permissions, and `resolveViewMode`'s precedence including the pipe
 * rule. No real config directory is touched.
 */
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadViewPreference, resolveViewMode, saveViewPreference, viewPreferencePath } from '../view-prefs.ts'

const base = mkdtempSync(join(tmpdir(), 'z1-view-prefs-'))
const home = join(base, 'home')
mkdirSync(home, { recursive: true })
const originalHome = process.env['HOME']
process.env['HOME'] = home

type Env = Record<string, string | undefined>

// -------------------------------------------------------------------- path
assert.equal(viewPreferencePath({ Z1_VIEW_FILE: '/tmp/custom-view.json' }), resolve('/tmp/custom-view.json'))
assert.equal(
  viewPreferencePath({ Z1_VIEW_FILE: 'relative/view.json' }),
  resolve('relative/view.json'),
  'a relative override is resolved, not joined to a config dir',
)
assert.equal(viewPreferencePath({ XDG_CONFIG_HOME: '/tmp/xdg' }), join('/tmp/xdg', 'z1', 'view.json'))
assert.equal(viewPreferencePath({ XDG_CONFIG_HOME: '' }), join(home, '.config', 'z1', 'view.json'))
assert.equal(viewPreferencePath({}), join(home, '.config', 'z1', 'view.json'))
assert.equal(
  viewPreferencePath({ Z1_VIEW_FILE: '/tmp/one.json', XDG_CONFIG_HOME: '/tmp/xdg' }),
  resolve('/tmp/one.json'),
  'Z1_VIEW_FILE wins over XDG_CONFIG_HOME',
)

// -------------------------------------------------------------------- load
const missing = join(base, 'missing.json')
assert.deepEqual(loadViewPreference({ Z1_VIEW_FILE: missing }), {
  mode: 'medium',
  path: missing,
  found: false,
})

const writeRaw = (path: string, text: string): void => writeFileSync(path, text)

const valid = join(base, 'valid.json')
writeRaw(valid, JSON.stringify({ schemaVersion: 1, mode: 'compact', updatedAt: 1 }))
assert.deepEqual(loadViewPreference({ Z1_VIEW_FILE: valid }), { mode: 'compact', path: valid, found: true })

const short = join(base, 'short.json')
writeRaw(short, JSON.stringify({ schemaVersion: 1, mode: 'f' }))
assert.equal(loadViewPreference({ Z1_VIEW_FILE: short }).mode, 'full')

const corrupt = join(base, 'corrupt.json')
writeRaw(corrupt, '{ not json')
{
  const loaded = loadViewPreference({ Z1_VIEW_FILE: corrupt })
  assert.equal(loaded.mode, 'medium')
  assert.equal(loaded.found, true)
  assert.notEqual(loaded.error, undefined, 'a parse error is reported, not thrown')
}

const badMode = join(base, 'bad-mode.json')
writeRaw(badMode, JSON.stringify({ schemaVersion: 1, mode: 'verbose' }))
{
  const loaded = loadViewPreference({ Z1_VIEW_FILE: badMode })
  assert.equal(loaded.mode, 'medium')
  assert.match(loaded.error ?? '', /unknown mode/)
}

const wrongSchema = join(base, 'schema.json')
writeRaw(wrongSchema, JSON.stringify({ schemaVersion: 2, mode: 'compact' }))
{
  const loaded = loadViewPreference({ Z1_VIEW_FILE: wrongSchema })
  assert.equal(loaded.mode, 'medium')
  assert.match(loaded.error ?? '', /schemaVersion/)
}

const notObject = join(base, 'array.json')
writeRaw(notObject, '[]')
assert.equal(loadViewPreference({ Z1_VIEW_FILE: notObject }).mode, 'medium')

// -------------------------------------------------------------------- save
const saved = join(base, 'nested', 'view.json')
assert.deepEqual(saveViewPreference('compact', { Z1_VIEW_FILE: saved }), { ok: true, path: saved })
{
  const body = JSON.parse(readFileSync(saved, 'utf8')) as { schemaVersion?: unknown; mode?: unknown; updatedAt?: unknown }
  assert.equal(body.schemaVersion, 1)
  assert.equal(body.mode, 'compact')
  assert.equal(typeof body.updatedAt, 'number')
  assert.equal(loadViewPreference({ Z1_VIEW_FILE: saved }).mode, 'compact')
  const entries = readdirSync(join(base, 'nested'))
  assert.deepEqual(entries, ['view.json'], 'the temporary file is gone after the rename')
  if (process.platform !== 'win32') {
    assert.equal(statSync(saved).mode & 0o777, 0o600, 'the preference is private')
  }
}
// A whole-file replace: saving again does not leave the old mode behind.
assert.equal(saveViewPreference('full', { Z1_VIEW_FILE: saved }).ok, true)
assert.equal(loadViewPreference({ Z1_VIEW_FILE: saved }).mode, 'full')

if (process.getuid?.() === 0) {
  console.log('skip: read-only directory check is meaningless as root')
} else {
  const locked = join(base, 'locked')
  mkdirSync(locked)
  const path = join(locked, 'view.json')
  chmodSync(locked, 0o555)
  try {
    const result = saveViewPreference('medium', { Z1_VIEW_FILE: path })
    assert.equal(result.ok, false)
    assert.equal(result.path, path)
    assert.notEqual(result.error, undefined)
    assert.equal(existsSync(path), false)
  } finally {
    chmodSync(locked, 0o755)
  }
}

// A file the process can read but not replace (its directory is read-only) is
// still loadable; only the write fails.
{
  const lockedRead = join(base, 'locked-read')
  mkdirSync(lockedRead)
  const path = join(lockedRead, 'view.json')
  writeRaw(path, JSON.stringify({ schemaVersion: 1, mode: 'compact' }))
  chmodSync(lockedRead, 0o555)
  try {
    assert.equal(loadViewPreference({ Z1_VIEW_FILE: path }).mode, 'compact')
  } finally {
    chmodSync(lockedRead, 0o755)
  }
}

// --------------------------------------------------------------- resolveViewMode
const file = join(base, 'resolve.json')
writeRaw(file, JSON.stringify({ schemaVersion: 1, mode: 'compact' }))
const envWithFile: Env = { Z1_VIEW_FILE: file }

{
  const resolved = resolveViewMode({ env: envWithFile, flag: 'full', tty: true })
  assert.deepEqual(resolved, { mode: 'full', source: 'flag' }, 'flag wins over everything')
}
{
  const resolved = resolveViewMode({ env: { ...envWithFile, Z1_VIEW: 'full' }, tty: true })
  assert.deepEqual(resolved, { mode: 'full', source: 'env' }, 'env wins over the file')
}
{
  const resolved = resolveViewMode({ env: envWithFile, tty: true })
  assert.deepEqual(resolved, { mode: 'compact', source: 'file' })
}
{
  const resolved = resolveViewMode({ env: { Z1_VIEW_FILE: join(base, 'absent.json') }, tty: true })
  assert.deepEqual(resolved, { mode: 'medium', source: 'default' })
}
{
  const resolved = resolveViewMode({ env: envWithFile, tty: false })
  assert.deepEqual(resolved, { mode: 'full', source: 'pipe' }, 'a pipe is a log and defaults to full')
}
{
  const resolved = resolveViewMode({ env: { ...envWithFile, Z1_VIEW: 'compact' }, tty: false })
  assert.deepEqual(resolved, { mode: 'compact', source: 'env' }, 'an explicit pipe opt-in is honoured')
}
{
  const resolved = resolveViewMode({ env: envWithFile, flag: 'medium', tty: false })
  assert.deepEqual(resolved, { mode: 'medium', source: 'flag' })
}
{
  const resolved = resolveViewMode({ env: { ...envWithFile, Z1_VIEW: 'verbose' }, tty: false })
  assert.equal(resolved.mode, 'medium')
  assert.equal(resolved.source, 'env')
  assert.match(resolved.error ?? '', /Z1_VIEW must be compact, medium or full/)
}
{
  const resolved = resolveViewMode({ env: { Z1_VIEW_FILE: corrupt }, tty: true })
  assert.equal(resolved.mode, 'medium')
  assert.equal(resolved.source, 'file')
  assert.match(resolved.error ?? '', /view · preferences problem/)
}
{
  const resolved = resolveViewMode({ env: { Z1_VIEW_FILE: corrupt }, tty: false })
  assert.deepEqual(resolved, { mode: 'full', source: 'pipe' }, 'a broken file is not read for a pipe')
}

if (originalHome === undefined) delete process.env['HOME']
else process.env['HOME'] = originalHome

console.log('PASS: view-prefs.test.mts (path, load, save, permissions, resolve precedence and pipe rule)')
