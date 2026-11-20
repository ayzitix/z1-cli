/**
 * The global `/view` preference.
 *
 * A display choice is orthogonal to a transcript, so it lives in its own small
 * file next to `tools.json` rather than in a session's `meta.json`: reopening a
 * session must not change how the whole app renders. The file is a whole-file
 * atomic replace, and a broken one is safe to reset to `medium` — unlike the
 * tool policy, a corrupt display preference has no security consequence.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { parseViewMode, type ViewMode } from './view.ts'

export interface ViewPreference {
  schemaVersion: 1
  mode: ViewMode
  updatedAt?: number
}

export interface LoadedViewPreference {
  mode: ViewMode
  path: string
  /** False when the file is absent, so `resolveViewMode` can say "default". */
  found: boolean
  /** Set when the file exists but could not be read, parsed, or understood. */
  error?: string
}

const expandHome = (value: string): string =>
  value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value

/**
 * `Z1_VIEW_FILE` overrides the location; otherwise
 * `$XDG_CONFIG_HOME/z1/view.json`, falling back to `~/.config/z1/view.json`.
 */
export const viewPreferencePath = (env: Record<string, string | undefined> = process.env): string => {
  const override = env['Z1_VIEW_FILE']
  if (override !== undefined && override.trim().length > 0) return resolve(expandHome(override.trim()))
  const configHome = env['XDG_CONFIG_HOME']
  const base =
    configHome !== undefined && configHome.trim().length > 0
      ? expandHome(configHome.trim())
      : join(homedir(), '.config')
  return join(base, 'z1', 'view.json')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Read the preference. A broken file is reported, not thrown: there is no
 * `lastGood` here because falling back to `medium` is always safe.
 */
export const loadViewPreference = (
  env: Record<string, string | undefined> = process.env,
): LoadedViewPreference => {
  const path = viewPreferencePath(env)
  if (!existsSync(path)) return { mode: 'medium', path, found: false }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return {
      mode: 'medium',
      path,
      found: true,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!isRecord(value)) {
    return { mode: 'medium', path, found: true, error: 'not an object' }
  }
  if (value['schemaVersion'] !== 1) {
    return { mode: 'medium', path, found: true, error: `unsupported schemaVersion ${String(value['schemaVersion'])}` }
  }
  const raw = value['mode']
  const mode = typeof raw === 'string' ? parseViewMode(raw) : undefined
  if (mode === undefined) {
    return { mode: 'medium', path, found: true, error: `unknown mode ${JSON.stringify(raw)}` }
  }
  return { mode, path, found: true }
}

/** Replace the preference atomically, so a crash never leaves half a JSON file. */
export const saveViewPreference = (
  mode: ViewMode,
  env: Record<string, string | undefined> = process.env,
): { ok: boolean; path: string; error?: string } => {
  const path = viewPreferencePath(env)
  let temporary: string | undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
    temporary = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`
    const body: ViewPreference = { schemaVersion: 1, mode, updatedAt: Date.now() }
    writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    return { ok: true, path }
  } catch (error) {
    if (temporary !== undefined) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // The error we report is the write failure, not cleanup.
      }
    }
    return { ok: false, path, error: error instanceof Error ? error.message : String(error) }
  }
}

export type ViewModeSource = 'flag' | 'env' | 'file' | 'default' | 'pipe'

export interface ResolvedViewMode {
  mode: ViewMode
  source: ViewModeSource
  /** A bad `Z1_VIEW` or a corrupt file; the mode is still usable. */
  error?: string
}

/**
 * `--view` > `Z1_VIEW` > the file > `medium`.
 *
 * A non-TTY stdout with no explicit source gets `full`: a pipe is a log, and a
 * group line silently replaces records a script may be reading. An explicit
 * `Z1_VIEW` is the opt-in, and is validated rather than silently ignored.
 */
export const resolveViewMode = (options: {
  env?: Record<string, string | undefined>
  flag?: ViewMode
  tty?: boolean
} = {}): ResolvedViewMode => {
  const env = options.env ?? process.env
  if (options.flag !== undefined) return { mode: options.flag, source: 'flag' }
  const raw = env['Z1_VIEW']
  if (raw !== undefined && raw.trim().length > 0) {
    const mode = parseViewMode(raw)
    if (mode === undefined) {
      return {
        mode: 'medium',
        source: 'env',
        error: `Z1_VIEW must be compact, medium or full (got "${raw.trim()}")`,
      }
    }
    return { mode, source: 'env' }
  }
  if (options.tty === false) return { mode: 'full', source: 'pipe' }
  const loaded = loadViewPreference(env)
  if (loaded.error !== undefined) {
    return {
      mode: 'medium',
      source: 'file',
      error: `view · preferences problem (${loaded.path}): ${loaded.error} · using medium`,
    }
  }
  return { mode: loaded.mode, source: loaded.found ? 'file' : 'default' }
}
