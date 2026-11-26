/**
 * One snapshot of "which tools exist, which are enabled, and at what revision".
 *
 * Everything that shows or consumes the tool set derives from this object: the
 * console footer, the `/tools` text list, the picker, the system prompt's tool
 * inventory and — through {@link ToolState.guard} — the `tools` array on the
 * wire. Before this file those were five independent copies (an installed list
 * from a probe run, a prefs copy, a printed listing, the picker items and the
 * guard's own read), so the prompt could say "you have a, b" while the request
 * advertised only `a`.
 *
 * Two kinds of freshness, deliberately separated:
 *
 * - the installed inventory (a worker RPC) is reloaded on `/tools refresh`, on
 *   an unknown selector, and once per turn — never per graph iteration;
 * - the enablement overlay (a sync, ~20 µs file read) is re-read at the top of
 *   every loop iteration and on every tool call, so another z1 session's
 *   `/tools off` takes effect without a restart.
 *
 * Numbers in `/tools off 3` are bound to the revision the list was printed at;
 * a number from an older revision is rejected instead of rebinding silently to
 * whatever the module now returns third.
 */

import type { SubagentCallGuard, ToolService } from './sdk.ts'

import {
  emptyToolPreferences,
  loadToolPreferences,
  saveToolPreferences,
  toolState,
  withToolStates,
  type LoadedToolPreferences,
  type ToolPreferences,
  type ToolState as ToolMode,
} from './tool-policy.ts'

/** The wire shape of a declared tool, exactly as the run's service returns it. */
export type ToolSchema = Awaited<ReturnType<ToolService['list']>>[number]

/**
 * Tools every listing marks as `system`: the CLI composes them, or the engine
 * adds them behind a feature switch. They can be turned **off** (hidden from the
 * model) but never deleted: a tombstone for a tool the host recreates on the
 * next start is noise, not a decision.
 *
 * `tool.create` mirrors `TOOL_CREATE_NAME` in `@z1/tool-creator`; the engine
 * adds it only when `Z1_TOOL_CREATOR` is on. `env.keys` mirrors
 * `ENV_KEYS_TOOL_NAME` in `@z1/env-keys`, which the bootstrap composes into
 * every run that has a workspace. Host schemas such as `subagent` are system by
 * construction and are added from the constructor argument.
 */
const SYSTEM_TOOL_NAMES: ReadonlySet<string> = new Set(['tool.create', 'env.keys'])

/**
 * The system tools that are not only undeletable but **always on**: `off` is
 * refused too, because the tool is composed into every run rather than restored
 * from a declaration the next start would read.
 *
 * `env.keys` manages the `.env` file a run's keys come from. Hiding it from the
 * model would not remove the file, it would only send the next person back to
 * hand-editing a secret the tool exists to keep out of source files — so the
 * only lever left is the one the refusal states: a run without a workspace.
 */
const ALWAYS_ON_TOOL_NAMES: ReadonlySet<string> = new Set(['env.keys'])

export interface ToolRecord {
  readonly name: string
  readonly description: string
  /** The stored decision for this name; `enabled` when the overlay is silent. */
  readonly state: ToolMode
  /** False for an orphan preference: a decision about a tool no module ships now. */
  readonly installed: boolean
  /**
   * True for a tool the host owns: listed and policy-controlled like the others,
   * but it cannot be deleted (only turned off, or switched off at its source).
   * See {@link SYSTEM_TOOL_NAMES}.
   */
  readonly system: boolean
  readonly schema?: ToolSchema
}

export interface ToolSnapshot {
  /** Installed tools in module order, then orphan preferences in file order. */
  readonly records: readonly ToolRecord[]
  /** `state === 'enabled'` and installed: exactly what the agent may use. */
  readonly enabled: readonly ToolRecord[]
  /**
   * The same set as wire schemas, built once: the system prompt and the
   * request's `tools` array are literally this array, so they cannot drift.
   * Includes host-composed tools such as `subagent`.
   */
  readonly enabledSchemas: readonly ToolSchema[]
  /**
   * The real module inventory, without host-composed tools. The subagent grant
   * ceiling must not treat the delegation tool as a grantable child tool.
   */
  readonly moduleSchemas: readonly ToolSchema[]
  readonly installedCount: number
  /** Bumped once per successful full inventory reload, never by a prefs re-read. */
  readonly revision: number
  readonly prefs: ToolPreferences
  /** A preference-file problem (see {@link LoadedToolPreferences.error}). */
  readonly error?: string
  readonly degraded?: 'last-good' | 'empty' | 'partial'
  /** The last full reload failed; `records` still describe the last known set. */
  readonly listError?: string
  /** `list()` has succeeded at least once in this process. */
  readonly inventoryKnown: boolean
}

export type ToolSetResult = { ok: true; snapshot: ToolSnapshot } | { ok: false; message: string }
export type ToolResolveResult = { ok: true; record: ToolRecord } | { ok: false; message: string }

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class ToolState {
  #list: () => Promise<readonly ToolSchema[]>
  /**
   * Tools the CLI composes itself (currently only `subagent`). They are listed
   * and policy-controlled like installed tools, but are not part of the module
   * inventory: a real tool with the same name wins and suppresses the host one.
   */
  #hostSchemas: readonly ToolSchema[]
  #schemas: readonly ToolSchema[] = []
  #loaded: LoadedToolPreferences
  #inventoryKnown = false
  #listError: string | undefined
  #revision = 0
  /** The rows the user was last shown, and the revision they were shown at. */
  #listing: { revision: number; names: readonly string[] } = { revision: 0, names: [] }
  /** True once an explicit list/picker bound the numbering. */
  #listed = false
  #snapshot: ToolSnapshot
  #pending: Promise<ToolSnapshot> | undefined

  constructor(
    list: () => Promise<readonly ToolSchema[]>,
    hostSchemas: readonly ToolSchema[] = [],
  ) {
    this.#list = list
    this.#hostSchemas = hostSchemas
    this.#loaded = loadToolPreferences()
    this.#snapshot = this.#build()
    // The startup inventory is the first implicit listing: `off 1` works before
    // the user has ever run `/tools`. A refresh still invalidates it.
    this.#listing = { revision: this.#revision, names: this.#installedNames() }
  }

  /** Raw modules plus host schemas whose names are free, in listing order. */
  #installedSchemas(): readonly ToolSchema[] {
    // Host tools are composed against the live service, so only advertise them
    // when that inventory is trustworthy; an unknown inventory keeps the last
    // known module set and makes no promise about `subagent`.
    if (!this.#inventoryKnown) return [...this.#schemas]
    const schemas = [...this.#schemas]
    const names = new Set(schemas.map((tool) => tool.name))
    for (const schema of this.#hostSchemas) {
      if (names.has(schema.name)) continue
      names.add(schema.name)
      schemas.push(schema)
    }
    return schemas
  }

  #installedNames(): readonly string[] {
    return this.#installedSchemas().map((tool) => tool.name)
  }

  /** What every view renders. Frozen; identity is stable until something changes. */
  get current(): ToolSnapshot {
    return this.#snapshot
  }

  /** The overlay file this snapshot was read from. */
  get path(): string {
    return this.#loaded.path
  }

  /**
   * The names {@link SYSTEM_TOOL_NAMES} covers for this store: the built-in set
   * plus whatever the CLI composed itself (`subagent`).
   */
  #systemNames(): ReadonlySet<string> {
    if (this.#hostSchemas.length === 0) return SYSTEM_TOOL_NAMES
    const names = new Set(SYSTEM_TOOL_NAMES)
    for (const tool of this.#hostSchemas) names.add(tool.name)
    return names
  }

  #build(): ToolSnapshot {
    const prefs = this.#loaded.prefs
    const schemas = this.#installedSchemas()
    const systemNames = this.#systemNames()
    const installed = new Set<string>()
    const records: ToolRecord[] = []
    for (const schema of schemas) {
      installed.add(schema.name)
      records.push(
        Object.freeze({
          name: schema.name,
          description: schema.description ?? '',
          state: toolState(prefs, schema.name),
          installed: true,
          system: systemNames.has(schema.name),
          schema,
        }),
      )
    }
    for (const [name, entry] of Object.entries(prefs.tools)) {
      if (installed.has(name)) continue
      records.push(
        Object.freeze({
          name,
          description: '',
          state: entry.state,
          installed: false,
          system: systemNames.has(name),
        }),
      )
    }
    const enabled = records.filter((record) => record.installed && record.state === 'enabled')
    return Object.freeze({
      records: Object.freeze(records),
      enabled: Object.freeze(enabled),
      enabledSchemas: Object.freeze(enabled.map((record) => record.schema!)),
      moduleSchemas: Object.freeze([...this.#schemas]),
      installedCount: schemas.length,
      revision: this.#revision,
      prefs,
      ...(this.#loaded.error === undefined ? {} : { error: this.#loaded.error }),
      ...(this.#loaded.degraded === undefined ? {} : { degraded: this.#loaded.degraded }),
      ...(this.#listError === undefined ? {} : { listError: this.#listError }),
      inventoryKnown: this.#inventoryKnown,
    })
  }

  #refresh(): ToolSnapshot {
    // The first successful inventory is the startup listing; after that the
    // shown order is pinned, so a refresh makes old numbers stale instead of
    // silently re-binding them to the new module order.
    if (!this.#listed && this.#inventoryKnown) {
      this.#listing = { revision: this.#revision, names: this.#installedNames() }
      this.#listed = true
    }
    this.#snapshot = this.#build()
    return this.#snapshot
  }

  /**
   * Reload the installed inventory once (one `list()` call, single-flight) and
   * re-read the overlay. A failure keeps the previous schemas so the UI does not
   * go blank, records `listError` for `debugLog`, and marks the inventory
   * unknown so the prompt stops promising a complete list.
   *
   * `list` overrides the source for this call only: the console's probe stays
   * the default, so a reload triggered later never calls through a disposed
   * per-turn run handle.
   */
  async reload(list?: () => Promise<readonly ToolSchema[]>): Promise<ToolSnapshot> {
    if (this.#pending !== undefined) return this.#pending
    const source = list ?? this.#list
    const run = (async (): Promise<ToolSnapshot> => {
      try {
        const listed = await source()
        const before = this.#schemas.map((tool) => tool.name).join('\u0000')
        const after = listed.map((tool) => tool.name).join('\u0000')
        this.#schemas = Object.freeze([...listed])
        this.#inventoryKnown = true
        this.#listError = undefined
        // A per-turn reload usually returns the same order; keeping the revision
        // means a number printed before the turn is still the same row. A real
        // install/uninstall/order change bumps it and makes old numbers stale.
        if (before !== after) this.#revision += 1
      } catch (error) {
        this.#inventoryKnown = false
        this.#listError = reason(error)
      }
      this.#loaded = loadToolPreferences()
      return this.#refresh()
    })()
    this.#pending = run
    try {
      return await run
    } finally {
      if (this.#pending === run) this.#pending = undefined
    }
  }

  /** Re-read the overlay only (no RPC), keeping the installed schemas. */
  reloadPrefs(): ToolSnapshot {
    this.#loaded = loadToolPreferences()
    return this.#refresh()
  }

  /** Pin `off 3` to the rows the user is looking at, at this revision. */
  markListed(records: readonly ToolRecord[] = this.#snapshot.records): readonly ToolRecord[] {
    this.#listing = { revision: this.#revision, names: records.map((record) => record.name) }
    this.#listed = true
    return records
  }

  /**
   * Apply one state to several names in a single atomic write.
   *
   * The overlay is re-read immediately before the write (merge-on-fresh: another
   * session may have toggled a different tool since this command started) and
   * the snapshot is rebuilt from the file afterwards. A failed write leaves the
   * snapshot exactly as it was, so the list never promises a state the guard
   * would not enforce.
   */
  apply(names: readonly string[], state: ToolMode): ToolSetResult {
    const targets = [...names]
    if (targets.length === 0) return { ok: false, message: 'tools · nothing to change' }
    if (state === 'deleted' || state === 'disabled') {
      // The always-on tools are refused first, and for both states: no mode
      // removes them, so naming a lever that does not work (`off`, a tombstone)
      // would be worse than the truth — the tool exists whenever a run has a
      // workspace.
      const alwaysOn = targets.filter((name) => ALWAYS_ON_TOOL_NAMES.has(name))
      if (alwaysOn.length > 0) {
        const which = alwaysOn.join(', ')
        const one = alwaysOn.length === 1
        return {
          ok: false,
          message:
            `tools · ${which} ${one ? 'is' : 'are'} always on: ${one ? 'it' : 'they'} cannot be deleted or turned off · ` +
            `${which} is composed into every run that has a workspace, so the only way to remove it is not to have one`,
        }
      }
      if (state === 'deleted') {
        // A system tool is recreated by its host on the next start, so a
        // tombstone is either ignored or silently resurrected. Refuse, and name
        // the two levers that do work: turn it off, or switch its source off.
        const systemNames = this.#systemNames()
        const system = targets.filter((name) => systemNames.has(name))
        if (system.length > 0) {
          const which = system.join(', ')
          return {
            ok: false,
            message:
              `tools · ${which} ${system.length === 1 ? 'is a' : 'are'} system tool${system.length === 1 ? '' : 's'}: it cannot be deleted · ` +
              '/tools off hides it from the agent · Z1_TOOL_CREATOR=0 removes tool.create entirely',
          }
        }
      }
    }
    const fresh = loadToolPreferences()
    // Merging onto a fallback is not a merge: the caller would be editing the
    // last-good (or empty) policy and then atomically replacing the file, which
    // silently discards every decision the corrupt file still held. Refuse and
    // point at the documented repair instead.
    if (fresh.degraded !== undefined || fresh.error !== undefined) {
      const why = fresh.error ?? fresh.degraded ?? 'unreadable overlay'
      return {
        ok: false,
        message: `tools · preferences are not readable (${fresh.path}): ${why} · run /tools reset to repair`,
      }
    }
    const next = withToolStates(fresh.prefs, targets, state)
    const saved = saveToolPreferences(next)
    if (!saved.ok) {
      return {
        ok: false,
        message: `tools · could not save preferences (${saved.path}): ${saved.error ?? 'unknown error'}`,
      }
    }
    // The file is ours now, so a previous corrupt-file report no longer applies.
    return { ok: true, snapshot: this.reloadPrefs() }
  }

  /** The async spelling of {@link apply}, for callers that want a promise. */
  async set(names: readonly string[], state: ToolMode): Promise<ToolSetResult> {
    return this.apply(names, state)
  }

  /**
   * `/tools reset`: rewrite the overlay as empty (every tool enabled). This is
   * also the repair for an unreadable file, so it works even when the broken
   * overlay produced no names to clear.
   */
  reset(): ToolSetResult {
    const saved = saveToolPreferences(emptyToolPreferences())
    if (!saved.ok) {
      return {
        ok: false,
        message: `tools · could not save preferences (${saved.path}): ${saved.error ?? 'unknown error'}`,
      }
    }
    return { ok: true, snapshot: this.reloadPrefs() }
  }

  /**
   * Resolve a `/tools` selector to a record.
   *
   * Numbers bind to the revision of the last listing: a number printed before a
   * refresh answers "list changed" rather than guessing. Names are looked up in
   * the snapshot (orphan tombstones included) and an unknown name triggers one
   * full reload, so a tool installed since startup is usable without a manual
   * `/tools refresh`.
   */
  async resolve(selector: string): Promise<ToolResolveResult> {
    const raw = selector.trim()
    if (/^\d+$/.test(raw)) {
      if (this.#listing.revision !== this.#revision) {
        return { ok: false, message: 'tools · the tool list changed; run /tools again' }
      }
      const index = Number(raw)
      if (!Number.isInteger(index) || index < 1 || index > this.#listing.names.length) {
        return { ok: false, message: `tools · no tool at position ${raw} · /tools for the list` }
      }
      const name = this.#listing.names[index - 1]!
      const record = this.#snapshot.records.find((row) => row.name === name)
      if (record !== undefined) return { ok: true, record }
      return { ok: false, message: `tools · no tool at position ${raw} · /tools for the list` }
    }
    const known = this.#snapshot.records.find((row) => row.name === raw)
    if (known !== undefined) return { ok: true, record: known }
    await this.reload()
    const after = this.#snapshot.records.find((row) => row.name === raw)
    if (after !== undefined) return { ok: true, record: after }
    if (!this.#snapshot.inventoryKnown) {
      return {
        ok: false,
        message: `tools · no tool "${raw}" · refresh failed · /tools refresh to retry`,
      }
    }
    return { ok: false, message: `tools · no tool "${raw}" · /tools for the list` }
  }

  /** Re-read the overlay and throw unless `name` is enabled right now. */
  #assertEnabled(name: string): void {
    const { prefs } = loadToolPreferences()
    const state = toolState(prefs, name)
    if (state !== 'enabled') {
      const action = state === 'deleted' ? 'restore' : 'on'
      throw new Error(
        `tool "${name}" is ${state}. Run /tools ${action} ${name} in z1 to allow it again.`,
      )
    }
  }

  /**
   * A call-only policy hook for a child subagent's restricted tool service.
   *
   * The child keeps its own `list()` (exactly the granted schemas), so the
   * package's guard cannot advertise an ungranted tool. Every forwarded child
   * call re-reads the same overlay as the parent guard, which makes a mid-run
   * `/tools off read` revoke a tool the child was granted when it started.
   */
  guardCall(): SubagentCallGuard {
    return (name) => {
      this.#assertEnabled(name)
    }
  }

  /**
   * Wrap the run's tool service so the model and the executor share one policy.
   *
   * `list()` answers from the snapshot and does no RPC, so the advertised tools
   * are exactly the ones the prompt and footer described and the same list is
   * used on every graph iteration. `call()` re-reads the overlay (a cheap stat +
   * parse) so a `/tools off` in another session still revokes a tool mid-run. A
   * rejected call throws; `z1.tool.call` turns that into a tool result.
   */
  guard(inner: ToolService): ToolService {
    const store = this
    return {
      async list() {
        return store.#snapshot.enabledSchemas
      },
      async call(name, args) {
        store.#assertEnabled(name)
        return inner.call(name, args)
      },
    }
  }
}
