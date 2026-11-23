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
  ModelHandle,
  Runtime,
  SubagentCallGuard,
  SubagentHost,
  SubagentInventory,
  SubagentRunHandle,
  SubagentRunOverrides,
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
  })
  return await withSubagentTool(options.parent, tool, {
    inventory: inventory.installed,
    guardCall: options.guardCall,
  })
}
