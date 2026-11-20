/**
 * The session root the prompt should name, derived read-only.
 *
 * The SDK owns the real decision (`resolveSessionRoot`): `Z1_SESSIONS_DIR`, then
 * `<repo>/z1`, then `~/.local/share/z1/projects/<name>-<hash>/z1`. That function
 * creates the directory it returns, which is fine for the store but not for a
 * prompt section: a one-shot run must not leave a store behind just to print a
 * path. This module mirrors the same precedence and the same fallback hash
 * without calling `mkdir`, and answers the path the store *would* use.
 *
 * "Would use" is exact for an existing root and for the fallback. One case is
 * deliberately optimistic: a `<repo>/z1` that does not exist is reported as the
 * project root, because that is where the store creates it; if the checkout is
 * read-only the store itself falls back, and no read-only check can see that.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { findRepoRoot } from '/home/oleksii/Projects/z1-sdk/z1/packages/session/src/index.ts'

type Env = Record<string, string | undefined>

/** Owner marker; its presence means "these sessions are ours" (SDK rule). */
const MARKER_FILE = '.z1-sessions'

const homeOf = (env: Env): string => {
  const fromEnv = env['HOME']?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : homedir()
}

/** `~/x` — the same single expansion the SDK applies to an env path. */
const expandHome = (value: string, env: Env): string => {
  if (value === '~') return homeOf(env)
  if (value.startsWith('~/')) return join(homeOf(env), value.slice(2))
  return value
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const isEmptyDirectory = (path: string): boolean => {
  try {
    return readdirSync(path).length === 0
  } catch {
    return false
  }
}

/**
 * True when the store may claim this directory: it is already ours, is empty,
 * or does not exist yet. A populated foreign folder (the SDK source tree is the
 * real case) is never claimed, and this check never creates anything.
 */
const claimable = (dir: string): boolean => {
  if (!existsSync(dir)) return true
  if (!isDirectory(dir)) return false
  if (existsSync(join(dir, MARKER_FILE))) return true
  return isEmptyDirectory(dir)
}

/** `<dataHome>/z1/projects/<basename>-<sha1(repoRoot)[0:8]>/z1`. */
const fallbackRoot = (repoRoot: string, env: Env): string => {
  const key = createHash('sha1').update(repoRoot).digest('hex').slice(0, 8)
  const name = repoRoot.split(sep).filter((part) => part !== '').pop() ?? 'root'
  const override = env['XDG_DATA_HOME']?.trim()
  const dataHome =
    override !== undefined && override !== ''
      ? resolve(expandHome(override, env))
      : join(homeOf(env), '.local', 'share')
  return join(dataHome, 'z1', 'projects', `${name}-${key}`, 'z1')
}

/**
 * The root the store would use for `cwd`, without opening or creating anything.
 * The override is a claim too: a populated foreign directory falls back, which
 * is what the SDK does and what the user needs to be told.
 */
export const probableSessionRoot = (cwd: string, env: Env = process.env): string => {
  const start = resolve(cwd)
  const repoRoot = findRepoRoot(start) ?? start
  const override = env['Z1_SESSIONS_DIR']?.trim()
  if (override !== undefined && override !== '') {
    const candidate = resolve(start, expandHome(override, env))
    return claimable(candidate) ? candidate : fallbackRoot(repoRoot, env)
  }
  const candidate = join(repoRoot, 'z1')
  return claimable(candidate) ? candidate : fallbackRoot(repoRoot, env)
}
