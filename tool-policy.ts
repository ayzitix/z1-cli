/**
 * Tool enablement shared by the console (`chat.ts`) and `z1 tools`.
 *
 * The installed modules own the tool implementations; this file only keeps a
 * small, name-keyed overlay of what the agent is allowed to see and call:
 *
 * - absent from the overlay: enabled;
 * - `disabled`: hidden from the model and rejected by the tool service;
 * - `deleted`: the same, plus it stays listed as a tombstone so it can be
 *   restored. Deleting never edits or uninstalls the module that provides it.
 *
 * The file lives in the user's config directory, not next to the journal or the
 * modules, so it is shared by every session and survives a per-project database
 * or a reinstall. A missing file means every installed tool is enabled.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { ToolService } from '/home/oleksii/Projects/z1-sdk/z1/packages/runtime/src/index.ts'

/** What the agent is allowed to do with one tool. */
export type ToolState = 'enabled' | 'disabled' | 'deleted'

/** One stored decision. Absent entries are enabled, so upgrades keep working. */
export interface ToolPreference {
  state: Exclude<ToolState, 'enabled'>
  /** When the decision was made; diagnostics only. */
  at: number
}

export interface ToolPreferences {
  schemaVersion: 1
  updatedAt?: number
  tools: Record<string, ToolPreference>
}

export interface LoadedToolPreferences {
  prefs: ToolPreferences
  path: string
  /** Set when the file exists but could not be read or parsed. */
  error?: string
}

export const emptyToolPreferences = (): ToolPreferences => ({ schemaVersion: 1, tools: {} })

/**
 * The last overlay this process read successfully, per file. A corrupt or
 * unreadable file must not silently re-enable a tool that was turned off a
 * moment ago: the guard re-reads per call, so it falls back to this snapshot
 * and keeps enforcing the last known policy. A missing file still means
 * "everything enabled", which is the documented fresh-install default.
 */
const lastGood = new Map<string, ToolPreferences>()

const expandHome = (value: string): string =>
  value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value

/**
 * `Z1_TOOLS_FILE` overrides the location; otherwise
 * `$XDG_CONFIG_HOME/z1/tools.json`, falling back to `~/.config/z1/tools.json`.
 */
export const toolPreferencesPath = (env: Record<string, string | undefined> = process.env): string => {
  const override = env['Z1_TOOLS_FILE']
  if (override !== undefined && override.trim().length > 0) return resolve(expandHome(override.trim()))
  const configHome = env['XDG_CONFIG_HOME']
  const base =
    configHome !== undefined && configHome.trim().length > 0
      ? expandHome(configHome.trim())
      : join(homedir(), '.config')
  return join(base, 'z1', 'tools.json')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Accept only the fields this version understands; ignore anything else. */
const normalize = (value: unknown): ToolPreferences => {
  if (!isRecord(value) || !isRecord(value['tools'])) return emptyToolPreferences()
  const tools: Record<string, ToolPreference> = {}
  for (const [name, entry] of Object.entries(value['tools'])) {
    if (!isRecord(entry)) continue
    const state = entry['state']
    if (state !== 'disabled' && state !== 'deleted') continue
    const at = entry['at']
    tools[name] = { state, at: typeof at === 'number' && Number.isFinite(at) ? at : Date.now() }
  }
  const updatedAt = value['updatedAt']
  return {
    schemaVersion: 1,
    ...(typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? { updatedAt } : {}),
    tools,
  }
}

/**
 * Read the overlay. A broken file is reported, not thrown: the console can keep
 * working with the default (everything enabled) and tell the user how to fix it.
 */
export const loadToolPreferences = (
  env: Record<string, string | undefined> = process.env,
): LoadedToolPreferences => {
  const path = toolPreferencesPath(env)
  if (!existsSync(path)) {
    const prefs = emptyToolPreferences()
    lastGood.set(path, prefs)
    return { prefs, path }
  }
  try {
    const prefs = normalize(JSON.parse(readFileSync(path, 'utf8')))
    lastGood.set(path, prefs)
    return { prefs, path }
  } catch (error) {
    return {
      // Keep the last policy this process successfully read. At startup there
      // is none, so the file's fresh-install default (all enabled) applies and
      // `/tools` reports the problem.
      prefs: lastGood.get(path) ?? emptyToolPreferences(),
      path,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Replace the overlay atomically, so a crash never leaves half a JSON file. */
export const saveToolPreferences = (
  prefs: ToolPreferences,
  env: Record<string, string | undefined> = process.env,
): { ok: boolean; path: string; error?: string } => {
  const path = toolPreferencesPath(env)
  let temporary: string | undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
    temporary = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`
    const body: ToolPreferences = { ...prefs, schemaVersion: 1, updatedAt: Date.now() }
    writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    lastGood.set(path, body)
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

/** The effective state of a tool name; an unknown name is enabled. */
export const toolState = (prefs: ToolPreferences, name: string): ToolState =>
  prefs.tools[name]?.state ?? 'enabled'

/** Return a new overlay with one decision replaced. `enabled` removes the entry. */
export const withToolState = (
  prefs: ToolPreferences,
  name: string,
  state: ToolState,
): ToolPreferences => {
  const tools = { ...prefs.tools }
  if (state === 'enabled') delete tools[name]
  else tools[name] = { state, at: Date.now() }
  return { ...prefs, tools }
}

/** Apply one state to many names in a single write. */
export const withToolStates = (
  prefs: ToolPreferences,
  names: readonly string[],
  state: ToolState,
): ToolPreferences => names.reduce((current, name) => withToolState(current, name, state), prefs)

/**
 * Wrap the run's tool service so the model and the executor share one policy.
 *
 * `list()` is what the agent loop advertises to the model, and `call()` is the
 * only path a tool can take. Re-reading the overlay on every call lets a
 * `/tools off` in another session take effect without a restart. A rejected
 * call throws; `z1.tool.call` turns that into a normal tool result the model
 * can read and recover from.
 */
export const createGuardedTools = (
  inner: ToolService,
  env: Record<string, string | undefined> = process.env,
): ToolService => ({
  async list() {
    const { prefs } = loadToolPreferences(env)
    return (await inner.list()).filter((tool) => toolState(prefs, tool.name) === 'enabled')
  },
  async call(name, args) {
    const { prefs } = loadToolPreferences(env)
    const state = toolState(prefs, name)
    if (state !== 'enabled') {
      const action = state === 'deleted' ? 'restore' : 'on'
      throw new Error(
        `tool "${name}" is ${state}. Run /tools ${action} ${name} in z1 to allow it again.`,
      )
    }
    return inner.call(name, args)
  },
})
