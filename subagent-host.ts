/**
 * z1-cli host side of `@z1/subagent`.
 *
 * The package owns grant resolution, the child graph and the physically
 * restricted child tool service. This module only adapts the CLI's live
 * runtime and `/tools` snapshot to it:
 *
 * - one stable host per runtime, so the package's default child budget is a
 *   session limit even though the delegation tool is rebuilt for every turn;
 * - the raw module inventory plus the `/tools` ceiling, never the host-composed
 *   `subagent` tool itself (a child cannot be granted delegation);
 * - child node and module approvals are `deny` (`@z1/subagent` has no parent
 *   delegation prompt in v1, so the host does not ask for one);
 * - the call-only `/tools` guard, which re-reads the preference file on every
 *   forwarded child call.
 *
 * The parent service is composed *inside* the caller's `ToolStore.guard`, never
 * the other way round: the outer guard keeps enforcing `/tools` for the parent,
 * and the child only ever sees the restricted service built by the package.
 */

import {
  SUBAGENT_TOOL_NAME,
  createSubagentTool,
  denyApprovalService,
  withSubagentTool,
} from './sdk.ts'
import type {
  ChatMessage,
  Json,
  ModelHandle,
  Runtime,
  RunEvent,
  SubagentCallGuard,
  SubagentHost,
  SubagentInventory,
  SubagentRunHandle,
  SubagentRunOverrides,
  SubagentTool,
  ToolService,
} from './sdk.ts'
import type { ToolSnapshot } from './tool-state.ts'

/** The parts of the bootstrap runtime the delegation host needs. */
export type SubagentRuntime = Pick<Runtime, 'beginRun' | 'journal'>

/**
 * One host per runtime. `subagentBudgetFor(host)` keys its default budget on
 * this object, so creating a fresh host per turn would reset the session cap.
 */
const hosts = new WeakMap<SubagentRuntime, SubagentHost>()

/**
 * Structural host over the CLI runtime. The event journal doubles as the run
 * recorder (`SqliteJournal` has both methods), which the package auto-detects;
 * no separate `runs` adapter is needed.
 */
export function subagentHost(runtime: SubagentRuntime): SubagentHost {
  const cached = hosts.get(runtime)
  if (cached !== undefined) return cached
  const host: SubagentHost = {
    journal: runtime.journal,
    async beginRun(overrides: SubagentRunOverrides): Promise<SubagentRunHandle> {
      return await runtime.beginRun(overrides)
    },
  }
  hosts.set(runtime, host)
  return host
}

/**
 * The package's grant context: installed module tools answer "does it exist?"
 * and the `/tools`-enabled subset is the ceiling. The host-composed `subagent`
 * schema is deliberately absent from both, matching the package contract that
 * delegation is not a grantable child tool.
 */
export function subagentInventory(snapshot: ToolSnapshot): SubagentInventory {
  const installed = snapshot.moduleSchemas
  const moduleNames = new Set(installed.map((schema) => schema.name))
  return {
    installed,
    enabled: snapshot.enabledSchemas.filter((schema) => moduleNames.has(schema.name)),
  }
}

/** A real module tool named `subagent` owns the name; do not shadow it. */
export function hasSubagentCollision(snapshot: ToolSnapshot): boolean {
  return snapshot.moduleSchemas.some((schema) => schema.name === SUBAGENT_TOOL_NAME)
}

export interface ComposeSubagentOptions {
  readonly runtime: SubagentRuntime
  readonly model: ModelHandle
  /** The raw per-turn parent tool service, before the `/tools` guard. */
  readonly parent: ToolService
  /** The turn's frozen `/tools` snapshot. */
  readonly snapshot: ToolSnapshot
  /** `ToolStore.guardCall()`: live policy for every child tool call. */
  readonly guardCall: SubagentCallGuard
  /**
   * The parent turn's `AbortController.signal`. Aborting it (Ctrl-C, Escape)
   * cancels that turn's child as a `cancelled` run instead of letting it run
   * to `timeoutMs` with nobody waiting. This is the v1-consistent behaviour
   * because v1 children are synchronous: a foreground child cannot outlive
   * the turn that is waiting for it. A future background child gets its own
   * signal and must *not* be wired to the parent turn (see SUBAGENT-DESIGN-2).
   */
  readonly signal?: AbortSignal
  /**
   * Read-side hooks for `/agents` (SUBAGENT-DESIGN-2, 1.5b).
   *
   * `onStart` fires when the package creates the child's run id, before the
   * child runs, so a running row exists from the first moment (the model's
   * `description` is known then; the effective grant follows in `onFinish`).
   * `onEvent` forwards the child's own events for live step counts, and
   * `onFinish` reports how it ended plus the grant the package resolved.
   *
   * None of these change the grant, the budget or the approval path: they only
   * observe.
   */
  readonly onStart?: (start: SubagentRunStart) => void
  readonly onEvent?: (runId: string, event: RunEvent) => void
  readonly onFinish?: (finish: SubagentRunFinish) => void
}

/** A child that exists now; the effective grant is not known yet. */
export interface SubagentRunStart {
  readonly runId: string
  readonly description: string
}

/**
 * How one delegation ended, mapped to the host's vocabulary. A finished child
 * is a *result* in 1.5c (timeouts, cancellations and step caps included), so a
 * throw here is a pre-run failure: an invalid grant, a full budget, a
 * `beginRun` error. Those already have their own message; this hook is for the
 * journal row the user opens with `/agents`.
 */
export interface SubagentRunFinish {
  readonly runId: string
  readonly description: string
  readonly status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'partial'
  readonly tools: readonly string[]
  readonly denied: readonly string[]
  readonly errorCode?: string
  readonly detail?: string
  readonly steps?: number
}

/**
 * Build the per-turn delegation tool and compose it with `parent`.
 *
 * A snapshot with `subagent` off returns `parent` unchanged before the
 * composition's live `list()` call: the model is not offered the tool this
 * turn, so there is no reason to build a child runner. If the snapshot was
 * enabled at turn start and `/tools off subagent` happens mid-turn, the outer
 * `ToolStore.guard` still hides and rejects the composite.
 *
 * A collision with a real module tool named `subagent` also returns `parent`
 * unchanged instead of failing every turn; `/tools` then controls that module
 * tool normally. When composed, `guardCall` is installed both on the
 * composite's own name (mid-run `/tools off subagent`) and on the child's
 * restricted service (mid-run `/tools off <granted tool>`).
 */
export async function composeSubagentService(
  options: ComposeSubagentOptions,
): Promise<ToolService> {
  const listed =
    options.snapshot.enabled.some((record) => record.name === SUBAGENT_TOOL_NAME) ||
    options.snapshot.enabledSchemas.some((entry) => entry.name === SUBAGENT_TOOL_NAME)
  if (!listed) return options.parent
  if (hasSubagentCollision(options.snapshot)) return options.parent

  const inventory = subagentInventory(options.snapshot)
  // Calls of one turn can overlap (the parent may delegate twice), and the
  // package allocates each run id inside its own `call`. `onEvent` fires
  // synchronously within that call, so a FIFO of the descriptions handed to
  // `call`, plus the ids already announced, is enough to bind id → label.
  const descriptions: string[] = []
  const started = new Set<string>()
  const announce = (runId: string, description: string): void => {
    if (started.has(runId)) return
    started.add(runId)
    try {
      options.onStart?.({ runId, description })
    } catch {
      // Observation only; a broken registry must not fail a child.
    }
  }
  const tool = createSubagentTool({
    model: options.model,
    host: subagentHost(options.runtime),
    inventory,
    depth: 0,
    approval: denyApprovalService,
    moduleApproval: denyApprovalService,
    guardCall: options.guardCall,
    // `exactOptionalPropertyTypes`: omit rather than pass `undefined`.
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // `onStart` needs the run id, and the first event that carries it is this
    // hook, so it is always installed (the registry's announce is cheap and
    // idempotent); `options.onEvent` is an additional consumer, not the source.
    onEvent: (event) => {
      const runId = (event as { runId?: unknown }).runId
      if (typeof runId !== 'string') return
      announce(runId, descriptions.at(-1) ?? '')
      try {
        options.onEvent?.(runId, event as RunEvent)
      } catch {
        // Observation only; a broken consumer must not fail a child.
      }
    },
  })
  const inner: SubagentTool = {
    schema: tool.schema,
    async call(args: Json) {
      const description = descriptionOf(args)
      descriptions.push(description)
      try {
        const result = await tool.call(args)
        // A journal-less child, or one that fails before its first event, never
        // reaches the hook above; finishing proves the child existed, so it is
        // announced here too (idempotent through `started`).
        announce(result.runId, description)
        try {
          options.onFinish?.({
            runId: result.runId,
            description,
            status: result.status,
            tools: result.tools,
            denied: result.denied,
            ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
            ...(result.detail === undefined ? {} : { detail: result.detail }),
            ...(result.steps === undefined ? {} : { steps: result.steps }),
          })
        } catch {
          // Observation only.
        }
        return result
      } finally {
        const index = descriptions.lastIndexOf(description)
        if (index >= 0) descriptions.splice(index, 1)
      }
    },
  }
  return await withSubagentTool(options.parent, inner, {
    inventory: inventory.installed,
    guardCall: options.guardCall,
  })
}

/** The model-supplied description, read exactly as the package will read it. */
function descriptionOf(args: Json): string {
  if (typeof args !== 'object' || args === null) return ''
  const value = (args as { description?: unknown }).description
  return typeof value === 'string' ? value.trim() : ''
}
