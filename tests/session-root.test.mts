/**
 * The prompt's session root, derived without creating it.
 *
 * The real bug: a repo with a non-session `z1/` (the SDK checkout) stores
 * transcripts under `~/.local/share/z1/projects/<name>-<hash>/z1`, but the
 * prompt's guess only looked at `<repo>/z1` and gave up. The model was then
 * told about `.z1/` and nothing else — exactly when the path mattered.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { probableSessionRoot } from '../session-root.ts'

const base = mkdtempSync(join(tmpdir(), 'z1-session-root-'))
const home = join(base, 'home')
const data = join(base, 'data')
mkdirSync(home, { recursive: true })
mkdirSync(data, { recursive: true })

const env = { HOME: home, XDG_DATA_HOME: data } as Record<string, string | undefined>

const repoWith = (name: string, files: readonly string[]): string => {
  const repo = join(base, name)
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'z1'), { recursive: true })
  for (const file of files) {
    const path = join(repo, 'z1', file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'x')
  }
  return repo
}

const expectedFallback = (repo: string): string => {
  const key = createHash('sha1').update(resolve(repo)).digest('hex').slice(0, 8)
  return join(data, 'z1', 'projects', `${basename(repo)}-${key}`, 'z1')
}

// 1. The real collision: `z1/` is a populated source tree, not a session root.
{
  const repo = repoWith('z1-sdk', ['packages/agent/src/index.ts', 'README.md'])
  const root = probableSessionRoot(repo, env)
  assert.equal(root, expectedFallback(repo), 'a foreign z1/ falls back to the per-project root')
  assert.equal(existsSync(root), false, 'resolving the prompt path created nothing')
  assert.equal(root.includes(`${basename(repo)}-`), true, 'the fallback carries the repo name')
}

// 2. A session root (the marker) is claimed as-is, even when it is populated.
{
  const repo = repoWith('marked', ['.z1-sessions', 'sessions/one/meta.json'])
  assert.equal(probableSessionRoot(repo, env), join(resolve(repo), 'z1'), 'an owned z1/ is the root')
}

// 3. An empty `z1/` is claimable: that is where the store creates the marker.
{
  const repo = join(base, 'empty-z1')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'z1'), { recursive: true })
  assert.equal(probableSessionRoot(repo, env), join(resolve(repo), 'z1'), 'an empty z1/ is the root')
}

// 4. A missing `z1/` is the root the store would create.
{
  const repo = join(base, 'no-z1')
  mkdirSync(join(repo, '.git'), { recursive: true })
  assert.equal(probableSessionRoot(repo, env), join(resolve(repo), 'z1'), 'a missing z1/ is the future root')
  assert.equal(existsSync(join(repo, 'z1')), false, 'and it was not created')
}

// 5. `Z1_SESSIONS_DIR` wins, with `~` expanded exactly like the SDK.
{
  const repo = repoWith('override-repo', ['README.md'])
  const relative = { ...env, Z1_SESSIONS_DIR: 'state/z1' }
  assert.equal(probableSessionRoot(repo, relative), resolve(repo, 'state/z1'), 'a relative override resolves against cwd')
  const tilde = { ...env, Z1_SESSIONS_DIR: '~/sessions' }
  assert.equal(probableSessionRoot(repo, tilde), join(home, 'sessions'), 'a ~ override expands against HOME')
  assert.equal(existsSync(join(home, 'sessions')), false, 'the override directory was not created')
}

// 6. A populated foreign override is refused, and the fallback is reported —
//    the same rule and warning the SDK gives the store.
{
  const repo = repoWith('foreign-override', ['README.md'])
  const foreign = join(base, 'notes')
  mkdirSync(foreign, { recursive: true })
  writeFileSync(join(foreign, 'todo.txt'), 'not sessions')
  assert.equal(
    probableSessionRoot(repo, { ...env, Z1_SESSIONS_DIR: foreign }),
    expectedFallback(repo),
    'a foreign override falls back instead of being named as the store',
  )
}

// 7. Ownership is decided by the marker, not by a `sessions/` directory alone.
{
  const repo = join(base, 'fake-sessions')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'z1', 'sessions'), { recursive: true })
  assert.equal(
    probableSessionRoot(repo, env),
    expectedFallback(repo),
    'a bare sessions/ without the marker is not ours',
  )
}

// 8. Outside a repo, the walk stops at cwd and the fallback is keyed on it.
{
  const plain = join(base, 'plain')
  mkdirSync(join(plain, 'z1'), { recursive: true })
  writeFileSync(join(plain, 'z1', 'notes.txt'), 'x')
  assert.equal(probableSessionRoot(plain, env), expectedFallback(plain), 'no repo root still has a fallback')
}

console.log('session-root tests passed (foreign z1/, override, fallback hash, no mkdir)')
