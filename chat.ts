/**
 * Local console UI for z1. Not part of the repository.
 *
 * It composes the agent graph through @z1/agent, seeds the loop with the
 * previous transcript (from the journal), streams text deltas, and keeps one
 * runtime for the whole session. Every run event that says something about
 * progress prints a `·` / `→` / `✓` / `✗` line, so a tool loop never looks
 * hung: the UI always shows what the agent is doing right now.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { argv, stdin, stdout } from 'node:process'

import {
  SessionClearedError,
  SessionTooNewError,
  SUBAGENT_TOOL_NAME,
  buildAgentGraph,
  createRuntime,
  createSessionStore,
  findRepoRoot,
  graphDigest,
  loadRuntimeConfig,
  runGraph,
  subagentToolSchema,
} from './sdk.ts'
import type {
  ApprovalService,
  ChatMessage,
  ModelHandle,
  RunEvent,
  RunHandle,
  RunResult,
  Runtime,
  SubagentLaunch,
  Session,
  SessionStore,
  SessionSummary,
} from './sdk.ts'

import { ownStateText } from './workspace-state.ts'
import {
  discoverProjectContextFiles,
  projectContextBudget,
  projectContextRoot,
  projectContextSummary,
  projectContextText,
} from './project-context.ts'
import { probableSessionRoot } from './session-root.ts'
import { languageHintText } from './language.ts'
import { ensureWebSearch, stopWebSearch, webSearchStatus } from './web-service.ts'
import type { WebStatus } from './web-service.ts'
import { restArguments, splitCommandAndPrompt, splitUnknownCommand } from './input.ts'
import { charCells, clip, displayCells, fit, stripAnsi } from './width.ts'
import {
  composerRowWithCursor,
  composerTextWidth,
  cursorPosition,
  layoutRows,
} from './chat-canvas.ts'
import type { DisplayRow } from './chat-canvas.ts'
import { createOutputSanitizer, finalizeAssistantReply, sanitizeOutput } from './output.ts'
import { toolInventoryText } from './tool-inventory.ts'
import { type ToolState } from './tool-policy.ts'
import { ToolState as ToolStore } from './tool-state.ts'
import { composeSubagentService } from './subagent-host.ts'
import {
  AUTO_DELIVERY_LINE as AUTOMATED_DELIVERY_LINE,
  AUTO_DELIVERY_PROMPT,
  AUTO_DELIVERY_ROW,
  afterTurnSignal,
  settleSignal,
} from './auto-delivery.ts'
import { AgentRegistry, childStatusRow, deliveredBlock, entryElapsed, runningLabel, shortRunId } from './agents.ts'
import { deliveredLines } from './agents-output.ts'
import type { AgentEntry } from './agents.ts'
import {
  agentListLines,
  agentPickerLines,
  agentPickerMove,
  agentPickerRepaint,
  agentPickerStop,
  agentRefusal,
  agentTranscriptLines,
  interceptLine,
  stopViaPicker,
} from './agents-view.ts'
import type { AgentEventRow, AgentPickerNotice, AgentStopOutcome } from './agents-view.ts'
import { onceDetachLines, oncePolicy, onceStatusLine } from './once-policy.ts'
import type { OncePolicy } from './once-policy.ts'
import { stopAgent } from './agents-command.ts'
import { stopChildrenOnExit } from './exit-policy.ts'
import { reapOrphanedRuns } from './reaper.ts'
import { callLine } from './tool-label.ts'
import {
  compactArgs,
  createViewState,
  errorText,
  groupStoredCalls,
  parseViewChoice,
  parseViewMode,
  resultSize,
  viewActivity,
  viewEvent,
  viewListLines,
  viewMenuItems,
  viewNotice,
  viewSettle,
  viewTextStart,
  VIEW_MODES,
} from './view.ts'
import type { ViewAction, ViewContext, ViewMode, ViewTheme } from './view.ts'
import { resolveViewMode, saveViewPreference } from './view-prefs.ts'

// Keep the console clean: service-selection info goes to stderr from the SDK.
const stderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
  if (text.startsWith('z1: [info] service ')) return true
  return (stderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
}) as typeof process.stderr.write

/**
 * When this process started. The startup reaper uses it to tell an orphaned
 * `running` row (created by a process that died) from a row that is live now.
 */
const processStart = Date.now()

type ToolSchema = Awaited<ReturnType<RunHandle['services']['tools']['list']>>[number]
type MutableGraph = {
  id: string
  nodes: Array<Record<string, unknown>>
  edges: Array<{ id: string; kind: string; from: { node: string; port: string }; to: { node: string; port: string } }>
  [key: string]: unknown
}

/**
 * Env-gated diagnostics for the resize path. Off unless `Z1_UI_DEBUG` names a
 * file, so a normal session writes nothing and pays nothing.
 */
const debugLog: (line: string) => void = (() => {
  const file = process.env['Z1_UI_DEBUG']
  if (file === undefined || file.length === 0) return () => {}
  return (line: string) => {
    try {
      appendFileSync(file, `${String(Date.now())} ${line}\n`)
    } catch {
      // Diagnostics must never break the UI.
    }
  }
})()

const colorEnabled = Boolean(process.stdout.isTTY) && process.env['NO_COLOR'] === undefined
/** The Claude-style composer needs a real terminal on both ends. */
const useComposer = Boolean(stdin.isTTY) && Boolean(stdout.isTTY) && process.env['Z1_TRAY'] !== 'off'

/**
 * Pinned mode owns the whole screen (like Claude Code's fullscreen renderer):
 * Pinned mode switches to the alternate buffer and scrolls an in-memory
 * transcript, so the composer can never be scrolled away. It is the default.
 * `Z1_PINNED=off` keeps the normal buffer and native scrollback (the composer
 * then scrolls with the transcript).
 */
const pinnedMode = useComposer && process.env['Z1_PINNED'] !== 'off'
const paint = (code: string, text: string): string =>
  colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text
const dim = (text: string): string => paint('2', text)
const bold = (text: string): string => paint('1', text)
const cyan = (text: string): string => paint('36', text)
const green = (text: string): string => paint('32', text)
const red = (text: string): string => paint('31', text)
const yellow = (text: string): string => paint('33', text)
const italic = (text: string): string => paint('3', text)
const underline = (text: string): string => paint('4', text)

/**
 * Text that must reach the screen exactly as typed. A session name and a model
 * id are user/model controlled: an embedded ESC could repaint the terminal, and
 * markdown punctuation would style a line the user expects to read literally.
 * Escaping is visible but unambiguous, which is the point of a confirmation.
 */
const literalText = (text: string): string =>
  text
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/([\\`*_[\]~])/g, '\\$1')

const padTo = (text: string, width: number): string =>
  `${text}${' '.repeat(Math.max(0, width - displayCells(text)))}`

/** Rounded box, the way a terminal agent introduces itself. */
const box = (lines: readonly string[], width: number): string => {
  const inner = Math.max(4, width)
  const top = dim(`┌${'─'.repeat(inner + 2)}┐`)
  const bottom = dim(`└${'─'.repeat(inner + 2)}┘`)
  const body = lines.map((line) => `${dim('│')} ${padTo(fit(line, inner), inner)} ${dim('│')}`)
  return [top, ...body, bottom].join('\n')
}

/** Print a full-width box without letting its last cell trigger a double scroll. */
const printBox = (text: string): void => {
  if (!stdout.isTTY) {
    console.log(text)
    return
  }
  stdout.write(`${text.split('\n').join('\r\n')}\r\n`)
}

/** The accents the pure formatter may use; identity when colour is off. */
const viewTheme: ViewTheme = { dim, bold, cyan, green, red, yellow }

/** Terminal width, guarded: a pty created without a size reports `0`. */
const terminalColumns = (): number => {
  const columns = stdout.columns
  return columns === undefined || columns <= 0 ? 80 : columns
}

/**
 * The bottom tray, as a *retractable tail*: the status row plus, while a turn
 * runs, the model's uncommitted line and an activity row.
 *
 * Nothing is placed at an absolute row. The tail is the last thing written, so
 * its height is recomputed from the text on every frame and the erase is a
 * relative move: a resize, a wrapped stream line or a long prompt cannot
 * desynchronise it the way a fixed scroll region can.
 *
 * The invariant, as in Ink's live frame or prompt_toolkit's `patch_stdout`:
 * before any transcript byte is written the tail is erased, and after the byte
 * is written the tail is painted again. Complete lines are committed to the
 * terminal's own scrollback; only the open line and the status are redrawn.
 */
interface TailLayout {
  lines: string[]
  cursorRow: number
  cursorCol: number
  key: string
}

interface TailComposer {
  layout(columns: number, status: string): TailLayout
}

/** One scroll step from a key or a wheel event. */
type ScrollKind = 'lineUp' | 'lineDown' | 'pageUp' | 'pageDown' | 'top' | 'bottom'

interface Tail {
  /** True when the tail owns the screen (a terminal, and `Z1_TRAY` not `off`). */
  readonly live: boolean
  /** Replace the right side of the composer footer. */
  status(text: string): void
  /** Transient row above the composer; `undefined` removes it. */
  activity(text: string | undefined): void
  /** Append streamed text; every complete line is committed immediately. */
  stream(text: string): void
  /** Commit the open line, then `line` as its own row. */
  print(line: string): void
  /** Commit an open streamed line without adding a row of its own. */
  breakLine(): void
  /** Commit whatever is buffered and repaint the last frame. */
  flush(): void
  /** Repaint the composer (or, without one, the status line). */
  idle(): void
  /** Forget the cached frame, e.g. after a status change. */
  repaint(): void
  /** Wipe the visible transcript (and, natively, the scrollback) and repaint the banner. */
  clear(): void
  /** Banner builder, rerun at the new width after a resize clears the view. */
  setHeader(build: () => string): void
  /** The terminal changed size: clear the view and repaint header + history. */
  reflow(): void
  /** Record a SIGWINCH before the debounce: a height change must not be lost. */
  observeResize(): void
  /** Scroll the transcript in pinned mode; false when the key is not ours. */
  scroll(kind: ScrollKind): boolean
  /** Erase the tail, leaving the cursor where its first row was. */
  erase(): void
  setComposer(composer: TailComposer | undefined): void
}

/** The tail that owns the terminal right now, for the exit handlers. */
let activeTail: Tail | undefined
let terminalRestored = false
/**
 * True while the alternate screen is ours. The pinned tail sets it when it
 * paints and clears it when it erases; `restoreTerminal` reads the same flag.
 * That matters on SIGTERM/SIGHUP: `process.exit(130)` skips the `finally` that
 * would call `tail.erase()`, so without a flag here the alternate screen and
 * mouse tracking would survive the CLI. Entry and exit are both idempotent.
 */
let altScreenActive = false

const enterAppScreen = (): void => {
  if (altScreenActive) return
  stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?1000h\x1b[?1006h')
  altScreenActive = true
}

const leaveAppScreen = (): void => {
  if (!altScreenActive) return
  altScreenActive = false
  stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1049l')
}

/**
 * Undo everything the UI did to the terminal. A crash that leaves the cursor
 * hidden, raw mode on or SGR dim is as broken as a leftover scroll region.
 */
const restoreTerminal = (): void => {
  if (terminalRestored) return
  terminalRestored = true
  if (!stdout.isTTY) return
  try {
    activeTail?.erase()
    // `erase()` is the normal path; this covers a signal that arrives before
    // the tail exists (or after it stopped being live) and is a no-op otherwise.
    leaveAppScreen()
    if (stdin.isTTY) stdin.setRawMode(false)
    stdout.write('\x1b[0m\x1b[?25h\x1b[?2004l\x1b[r\r')
  } catch {
    // The terminal is already gone; there is nothing left to restore.
  }
}

const terminalRows = (): number => {
  const rows = stdout.rows
  return rows === undefined || rows <= 0 ? 24 : rows
}

/** One slash command: the menu, `/help`, dispatch, and Tab all read the same list. */
interface CommandSpec {
  name: string
  description: string
  /** Present when the command takes arguments; Enter completes instead of running. */
  args?: string
  /**
   * The exact `usage: …` body, when the grammar is longer than `args` (for
   * example an example value). Bare calls print this, so it is written once.
   */
  usage?: string
  /**
   * Any arguments belong to the handler instead of being a shape error. Only
   * `/tools` needs this: its sub-grammar is parsed by `handleTools`, and it has
   * no `args` so Enter runs the picker.
   */
  rest?: true
  /** Extra `/help` rows under the command, one indented line each. */
  help?: readonly string[]
}

/** One row of the interactive `/tools` menu. */
interface ToolMenuItem {
  name: string
  description: string
  state: ToolState
  /** False for a tombstone whose module is no longer installed. */
  installed: boolean
  /**
   * True for a tool the host owns (`tool.create`, `env.keys`). The row says so,
   * because the list is where a person decides: a tool that cannot be deleted
   * (or, for `env.keys`, not even turned off) must not look like the others and
   * refuse only after the keypress. See `SYSTEM_TOOL_NAMES` in `tool-state.ts`.
   */
  system: boolean
}

type ToolMenuAction = 'toggle' | 'delete'

/** One row of the `/sessions` picker; `detail` is rendered dim. */
interface SessionMenuItem {
  id: string
  name: string
  detail: string
  current: boolean
  archived: boolean
  color: number
}

interface SessionMenu {
  label: string
  items: readonly SessionMenuItem[]
  index: number
  onSelect: (id: string) => void
  /** `r`/`d` in the picker, passed through to the command layer. */
  onAction?: (action: 'rename' | 'delete', id: string) => void
}

interface ToolMenu {
  items: readonly ToolMenuItem[]
  index: number
  /** Set while the Delete key waits for a yes/no confirmation. */
  confirmDelete?: string
  onAction: (action: ToolMenuAction, name: string) => readonly ToolMenuItem[]
}

/** The three-row `/view` picker: Enter applies, digits select directly. */
interface ViewMenu {
  current: ViewMode
  index: number
  onSelect: (mode: ViewMode) => void
}

/**
 * The `/agents` overlay (2b): a row per child, Enter opens one transcript,
 * `x`/Delete stops the selected one.
 *
 * `entries` is a snapshot the caller refills (`refresh`) whenever the registry
 * changes, so a child that settles or is stopped repaints in place rather than
 * showing a stale outline. `notice` is a refusal that keeps the picker open
 * (`x` on a finished child); any successful action clears it.
 */
interface AgentMenu {
  entries: readonly AgentEntry[]
  index: number
  /** Refill the snapshot from the registry (outcome, steps, elapsed). */
  refresh: () => readonly AgentEntry[]
  /** Enter: close, then the caller shows that child's transcript. */
  onOpen: (entry: AgentEntry) => void
  /** `x`/Delete: the caller runs `stopAgent` and returns what it decided. */
  onStop: (entry: AgentEntry) => AgentStopOutcome
  /**
   * The last `x` on the selected row, kept raw so a later refresh can re-derive
   * the notice (a child that settles after the press must stop being described
   * as "stopping").
   */
  stop?: AgentStopOutcome
  /** The line under the title; `undefined` is a clean picker. */
  notice?: AgentPickerNotice
}

/**
 * The prompt, drawn the way Claude Code draws it (verified against the
 * recovered `PromptInput` code): a rounded rule above and below the draft, no
 * vertical sides, one footer row whose left side is the most important hint and
 * whose right side is the session status.
 *
 * The composer owns the keyboard while it is open. A lone Escape is delayed by
 * a few milliseconds so it can be told apart from an escape sequence arriving
 * in a second read.
 */
class Composer {
  private value = ''
  private cursor = 0
  private busy = false
  private asking: { label: string; resolve: (answer: string) => void } | undefined
  private askStash: { value: string; cursor: number } | undefined
  /**
   * A transient message ("3 commands") from Tab or a dismissed menu. It is
   * *not* a confirmation token: a note must never cancel a two-press Escape or
   * Ctrl-C, which is why the two slots below are separate.
   */
  private notice: { text: string; until: number } | undefined
  /** The armed second press: Escape clears the draft, Ctrl-C exits. */
  private confirm: { kind: 'clear' | 'exit'; until: number } | undefined
  private confirmTimer: NodeJS.Timeout | undefined
  private history: string[] = []
  private historyIndex = -1
  private stash = ''
  /** Selected row in the slash menu, and the draft that dismissed it. */
  private menuIndex = 0
  private menuDismissed: string | undefined
  /** Interactive `/tools` picker, independent of the slash menu. */
  private toolsMenu: ToolMenu | undefined
  /** Interactive `/sessions` picker, independent of `/tools`. */
  private sessionsMenu: SessionMenu | undefined
  /** Interactive `/view` picker, independent of the other two. */
  private viewMenu: ViewMenu | undefined
  /**
   * Interactive `/agents` picker (2b), independent of the others. It exists in
   * its own right, not as a transcript print, because a submitted command
   * queues behind a running turn - and the whole point is to see children while
   * one runs.
   */
  private agentsMenu: AgentMenu | undefined
  private buffer = ''
  private escTimer: NodeJS.Timeout | undefined
  private closed = false
  private readonly onChange: () => void
  private readonly onLine: (line: string) => void
  private readonly onAbort: () => void
  private readonly onExit: () => void
  private readonly complete: (value: string, cursor: number) => { value: string; cursor: number; message?: string } | undefined
  private readonly commands: () => readonly CommandSpec[]
  /**
   * 2b: a submitted line the composer handles itself, before it can be queued.
   * Returns `true` when it took the line (an overlay is now open).
   */
  private readonly intercept: ((text: string) => boolean) | undefined
  /** Pinned mode only: PgUp/PgDn, wheel and Esc-at-bottom drive the transcript. */
  private readonly scroll: ((kind: ScrollKind) => boolean) | undefined

  constructor(options: {
    onChange: () => void
    onLine: (line: string) => void
    onAbort: () => void
    onExit: () => void
    complete: (value: string, cursor: number) => { value: string; cursor: number; message?: string } | undefined
    commands: () => readonly CommandSpec[]
    scroll?: (kind: ScrollKind) => boolean
    intercept?: (text: string) => boolean
  }) {
    this.onChange = options.onChange
    this.onLine = options.onLine
    this.onAbort = options.onAbort
    this.onExit = options.onExit
    this.complete = options.complete
    this.commands = options.commands
    this.scroll = options.scroll
    this.intercept = options.intercept
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', this.onData)
    // Bracketed paste: a pasted block arrives as one key, not as keystrokes.
    stdout.write('\x1b[?2004h')
  }

  /** Show `label` in the footer and resolve with the next submitted line. */
  ask(label: string): Promise<string> {
    // Only one question can be shown at a time. Today the caller is
    // sequential, but an overlapping approval would otherwise overwrite
    // `asking` and leave the first promise pending forever (a deadlocked
    // console), so resolve the abandoned one as a denial first.
    this.endAsk('')
    return new Promise(resolve => {
      this.askStash = { value: this.value, cursor: this.cursor }
      this.asking = { label, resolve }
      this.value = ''
      this.cursor = 0
      this.changed()
    })
  }

  /**
   * Open the interactive `/tools` picker. Enter toggles the highlighted tool,
   * Delete asks for confirmation before tombstoning it, Escape closes.
   */
  openToolMenu(
    items: readonly ToolMenuItem[],
    onAction: (action: ToolMenuAction, name: string) => readonly ToolMenuItem[],
  ): void {
    if (this.asking !== undefined) {
      // The caller only opens this while idle; a question owns the keyboard, so
      // replacing it would hide the only prompt the user can answer.
      throw new Error('openToolMenu: an approval question is pending; answer or cancel it first')
    }
    // A queued command may open another picker after this one; only one owns
    // the keyboard at a time.
    this.viewMenu = undefined
    this.sessionsMenu = undefined
    this.toolsMenu = { items, index: 0, onAction }
    this.changed()
  }

  /** Hide the picker without touching the draft. */
  closeToolMenu(): void {
    if (this.toolsMenu === undefined) return
    this.toolsMenu = undefined
    this.changed()
  }

  /** Open the interactive `/sessions` picker; Enter switches, Escape closes. */
  openSessionMenu(
    label: string,
    items: readonly SessionMenuItem[],
    onSelect: (id: string) => void,
    index = 0,
    onAction?: (action: 'rename' | 'delete', id: string) => void,
  ): void {
    if (this.asking !== undefined) {
      throw new Error('openSessionMenu: an approval question is pending; answer or cancel it first')
    }
    this.viewMenu = undefined
    this.toolsMenu = undefined
    this.sessionsMenu = {
      label,
      items,
      index: Math.max(0, Math.min(index, Math.max(0, items.length - 1))),
      onSelect,
      ...(onAction === undefined ? {} : { onAction }),
    }
    this.changed()
  }

  /** Hide the session picker. */
  closeSessionMenu(): void {
    if (this.sessionsMenu === undefined) return
    this.sessionsMenu = undefined
    this.changed()
  }

  /**
   * Open the interactive `/view` picker. The command was submitted, so the
   * draft is normally empty already; clearing it here as well keeps the slash
   * menu and an armed Escape confirmation from competing with the picker.
   */
  openViewMenu(current: ViewMode, onSelect: (mode: ViewMode) => void): void {
    if (this.asking !== undefined) {
      throw new Error('openViewMenu: an approval question is pending; answer or cancel it first')
    }
    this.toolsMenu = undefined
    this.sessionsMenu = undefined
    this.clearDraft()
    // A lone Escape still in its disambiguation window must not close the
    // picker the command just opened.
    if (this.escTimer !== undefined) {
      clearTimeout(this.escTimer)
      this.escTimer = undefined
    }
    this.viewMenu = {
      current,
      index: Math.max(0, VIEW_MODES.indexOf(current)),
      onSelect,
    }
    this.changed()
  }

  /** Hide the view picker without applying anything. */
  closeViewMenu(): void {
    if (this.viewMenu === undefined) return
    this.viewMenu = undefined
    this.changed()
  }

  /**
   * Open the `/agents` overlay (2b).
   *
   * Unlike the other pickers this one is allowed **while a turn runs**: that is
   * the defect it exists to fix (a submitted `/agents` queues behind the turn).
   * It takes the keyboard from the others - exactly one picker owns it - and
   * leaves the draft alone, so Escape returns the user to the same text.
   */
  openAgentsMenu(menu: Omit<AgentMenu, 'index' | 'notice'> & { index?: number }): void {
    if (this.asking !== undefined) {
      throw new Error('openAgentsMenu: an approval question is pending; answer or cancel it first')
    }
    const entries = menu.entries
    this.toolsMenu = undefined
    this.sessionsMenu = undefined
    this.viewMenu = undefined
    // A lone Escape still inside its disambiguation window must not be read as
    // the first press of "clear the draft" once the picker is open.
    if (this.escTimer !== undefined) {
      clearTimeout(this.escTimer)
      this.escTimer = undefined
    }
    this.agentsMenu = {
      entries,
      index: Math.max(0, Math.min(menu.index ?? 0, Math.max(0, entries.length - 1))),
      refresh: menu.refresh,
      onOpen: menu.onOpen,
      onStop: menu.onStop,
    }
    this.changed()
  }

  /** Hide the overlay without touching the draft or any child. */
  closeAgentsMenu(): void {
    if (this.agentsMenu === undefined) return
    this.agentsMenu = undefined
    this.changed()
  }

  /** True while the `/agents` overlay owns the keyboard. */
  get agentsMenuOpen(): boolean {
    return this.agentsMenu !== undefined
  }

  /**
   * Repaint an open `/agents` overlay from the registry. Called when a child
   * starts, steps or settles, so the list is live while it is on screen.
   *
   * The notice is re-derived here rather than cached: a stop is only a request,
   * so the child may end `failed` or `timeout` after the press, and "stopping …"
   * beside a finished row would be wrong. `agentPickerNotice` is the one place
   * that decides what to say for the row now under the pointer.
   */
  refreshAgentsMenu(): void {
    const menu = this.agentsMenu
    if (menu === undefined) return
    this.agentsMenu = { ...menu, ...agentPickerRepaint(menu, menu.refresh()) }
    this.changed()
  }

  /** Resolve or cancel an approval without losing the draft it interrupted. */
  private endAsk(answer: string): void {
    const asking = this.asking
    if (asking === undefined) return
    this.asking = undefined
    this.value = this.askStash?.value ?? ''
    this.cursor = this.askStash?.cursor ?? this.value.length
    this.askStash = undefined
    asking.resolve(answer)
    this.changed()
  }

  setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    this.changed()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.escTimer !== undefined) clearTimeout(this.escTimer)
    if (this.confirmTimer !== undefined) clearTimeout(this.confirmTimer)
    this.confirmTimer = undefined
    if (stdin.isTTY) {
      stdin.setRawMode(false)
      stdin.pause()
    }
    stdin.off('data', this.onData)
    stdout.write('\x1b[?2004l\x1b[?25h')
  }

  private changed(): void {
    this.onChange()
  }

  private note(text: string, ms = 1800): void {
    this.notice = { text, until: Date.now() + ms }
    this.changed()
    // Only this note's own timer may clear it: a newer note has a later
    // `until`, so an old timer fizzles instead of eating the fresh message.
    const timer = setTimeout(() => {
      if (this.notice !== undefined && Date.now() >= this.notice.until) {
        this.notice = undefined
        this.changed()
      }
    }, ms + 20)
    timer.unref?.()
  }

  /**
   * Arm a two-press action. Arming a confirm never touches the notice and vice
   * versa, so a Tab note cannot cancel Ctrl-C-to-exit (or the reverse).
   */
  private requestConfirm(kind: 'clear' | 'exit', ms = 1800): void {
    if (this.confirmTimer !== undefined) clearTimeout(this.confirmTimer)
    this.confirm = { kind, until: Date.now() + ms }
    // Repaint when the window closes, so the footer stops advertising a press
    // that would no longer count.
    const timer = setTimeout(() => {
      this.confirmTimer = undefined
      if (this.confirm !== undefined && Date.now() >= this.confirm.until) {
        this.confirm = undefined
        this.changed()
      }
    }, ms + 20)
    timer.unref?.()
    this.confirmTimer = timer
    this.changed()
  }

  /** The armed confirm while its window is still open. */
  private activeConfirm(): 'clear' | 'exit' | undefined {
    const confirm = this.confirm
    if (confirm === undefined) return undefined
    return Date.now() < confirm.until ? confirm.kind : undefined
  }

  private onData = (chunk: string | Buffer): void => {
    if (this.closed) return
    if (this.escTimer !== undefined) {
      clearTimeout(this.escTimer)
      this.escTimer = undefined
    }
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.pump()
  }

  private pump(): void {
    while (this.buffer.length > 0) {
      if (!this.step()) return
    }
  }

  private step(): boolean {
    const buffer = this.buffer
    if (buffer.startsWith('\x1b[200~')) {
      const end = buffer.indexOf('\x1b[201~', 6)
      if (end < 0) return false
      this.insert(buffer.slice(6, end))
      this.buffer = buffer.slice(end + 6)
      return true
    }
    if (buffer[0] === '\x1b') {
      if (buffer.length === 1) {
        // A lone ESC may be the start of a sequence split across reads.
        const timer = setTimeout(() => {
          this.escTimer = undefined
          if (this.buffer === '\x1b') {
            this.buffer = ''
            this.escape()
          }
        }, 18)
        timer.unref?.()
        this.escTimer = timer
        return false
      }
      if (buffer[1] === '[') {
        let at = 2
        while (at < buffer.length && !/[\x40-\x7e]/.test(buffer[at]!)) at += 1
        if (at >= buffer.length) return false
        const sequence = buffer.slice(0, at + 1)
        this.buffer = buffer.slice(at + 1)
        this.csi(sequence)
        return true
      }
      if (buffer[1] === ']') {
        // A terminal response (OSC) is not typing: consume it whole.
        const bel = buffer.indexOf('\x07', 2)
        const st = buffer.indexOf('\x1b\\', 2)
        const ends = [bel, st].filter((at) => at >= 0)
        if (ends.length === 0) return false
        const end = Math.min(...ends)
        this.buffer = buffer.slice(end === st ? end + 2 : end + 1)
        return true
      }
      if (buffer[1] === 'O') {
        if (buffer.length < 3) return false
        const sequence = buffer.slice(0, 3)
        this.buffer = buffer.slice(3)
        const names: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }
        this.key(names[sequence[2]!] ?? '')
        return true
      }
      const letter = buffer[1]!
      this.buffer = buffer.slice(2)
      this.alt(letter)
      return true
    }
    const char = buffer[0]!
    this.buffer = buffer.slice(1)
    this.keyChar(char)
    return true
  }

  private csi(sequence: string): void {
    const body = sequence.slice(2, -1)
    const final = sequence.at(-1)!
    // SGR mouse: `\x1b[<b;x;yM`. Only wheel events matter; buttons are left to
    // the terminal (Shift+drag still selects while tracking is on).
    if (final === 'M' && body.startsWith('<')) {
      const parts = body.slice(1).split(';').map(Number)
      const button = parts[0] ?? -1
      if (button === 64) this.scroll?.('lineUp')
      else if (button === 65) this.scroll?.('lineDown')
      return
    }
    if (/^\d+(;\d+)*$/.test(body)) {
      const parts = body.split(';').map(Number)
      if (final === '~') {
        if (parts[0] === 200 || parts[0] === 201) return
        if (parts[0] === 5) return this.key('pageup')
        if (parts[0] === 6) return this.key('pagedown')
        if (parts[0] === 3) return this.key('delete')
        if (parts[0] === 1 || parts[0] === 7) return this.key('home')
        if (parts[0] === 4 || parts[0] === 8) return this.key('end')
        return
      }
      if (final === 'u') {
        // Kitty keyboard protocol: 13 = Enter, 27 = Escape, 127 = Backspace.
        if (parts[0] === 13) return parts[1] === 2 ? this.insert('\n') : this.submit()
        if (parts[0] === 27) return this.escape()
        if (parts[0] === 127) return this.key('backspace')
        return
      }
      if (final === 'A') return this.key('up')
      if (final === 'B') return this.key('down')
      if (final === 'C') return this.key('right')
      if (final === 'D') return this.key('left')
      if (final === 'H') return this.key('home')
      if (final === 'F') return this.key('end')
      if (final === 'Z') return
      return
    }
    if (final === 'u' && body === '13;2') return this.insert('\n')
    if (final === 'A') return this.key('up')
    if (final === 'B') return this.key('down')
    if (final === 'C') return this.key('right')
    if (final === 'D') return this.key('left')
    if (final === '~' && body === '27;2;13') return this.insert('\n')
  }

  private alt(letter: string): void {
    if (letter === '\r' || letter === '\n') {
      this.insert('\n')
      return
    }
    if (letter === 'b' || letter === 'B') return this.wordLeft()
    if (letter === 'f' || letter === 'F') return this.wordRight()
    if (letter === 'd' || letter === 'D') return this.deleteWordForward()
    if (letter === '\x7f' || letter === '\b') return this.deleteWordBack()
  }

  private keyChar(char: string): void {
    const code = char.charCodeAt(0)
    if (this.agentsMenu !== undefined) {
      // The overlay owns the keyboard: typing cannot edit the draft under it.
      if (code === 13) return this.openAgentNow()
      if (code === 3) return this.ctrlC()
      if (code === 4) return this.ctrlD()
      if (code === 14 && this.agentStep(1)) return
      if (code === 16 && this.agentStep(-1)) return
      // `x`, and Mac's key labelled Delete (0x7f) which is Backspace elsewhere.
      const lower = char.toLowerCase()
      if (lower === 'x') return this.stopAgentNow()
      const digit = /^[1-9]$/.test(lower) ? Number(lower) : undefined
      if (digit !== undefined && this.agentSelect(digit)) return
      return
    }
    if (this.viewMenu !== undefined) {
      // The picker owns the keyboard. Digits and letters apply immediately; the
      // three-row scale is faster to pick than to arrow through.
      if (code === 13) return this.selectViewNow()
      if (code === 3 || code === 4) return this.closeViewMenu()
      if (code === 14 && this.viewStep(1)) return
      if (code === 16 && this.viewStep(-1)) return
      const direct = char.toLowerCase()
      if (direct === '1' || direct === 'c') return this.selectViewMode('compact')
      if (direct === '2' || direct === 'm') return this.selectViewMode('medium')
      if (direct === '3' || direct === 'f') return this.selectViewMode('full')
      return
    }
    if (this.sessionsMenu !== undefined) {
      // The session picker owns the keyboard; typing cannot edit the draft.
      if (code === 13) return this.submit()
      if (code === 3) return this.ctrlC()
      if (code === 4) return this.ctrlD()
      if (code === 14 && this.sessionStep(1)) return
      if (code === 16 && this.sessionStep(-1)) return
      if (code === 114 || code === 82) return this.actionSessionNow('rename')
      if (code === 100 || code === 68) return this.actionSessionNow('delete')
      if (code === 127 || code === 8) return this.actionSessionNow('delete')
      return
    }
    if (this.toolsMenu !== undefined) {
      // The picker owns the keyboard: typing cannot edit the draft underneath.
      if (code === 13) return this.submit()
      if (code === 3) return this.ctrlC()
      if (code === 4) return this.ctrlD()
      // Mac keyboards send 0x7f for the key labelled Delete/Backspace; the
      // picker has no text to edit, so both it and CSI 3~ mean "remove".
      if (code === 127 || code === 8) return this.requestToolDelete()
      if (code === 14 && this.toolStep(1)) return
      if (code === 16 && this.toolStep(-1)) return
      return
    }
    if (code === 13) return this.submit()
    if (code === 10) return this.insert('\n')
    if (code === 127 || code === 8) return this.key('backspace')
    if (code === 9) return this.tab()
    if (code === 3) return this.ctrlC()
    if (code === 4) return this.ctrlD()
    if (code === 1) return this.lineStart()
    if (code === 5) return this.lineEnd()
    if (code === 2) return this.key('left')
    if (code === 6) return this.key('right')
    if (code === 11) return this.killToEnd()
    if (code === 12) return this.clearScreen()
    if (code === 14) {
      if (this.menuStep(1)) return
      return this.historyNext()
    }
    if (code === 16) {
      if (this.menuStep(-1)) return
      return this.historyPrev()
    }
    if (code === 21) return this.killToStart()
    if (code === 23) return this.deleteWordBack()
    if (code < 32) return
    this.insert(char)
  }

  private key(name: string): void {
    if (this.agentsMenu !== undefined) {
      // The overlay owns the keyboard; the draft below never moves or edits.
      switch (name) {
        case 'up': return void this.agentStep(-1)
        case 'down': return void this.agentStep(1)
        case 'home': return void this.agentSelect(1)
        case 'end': return void this.agentSelect(this.agentsMenu.entries.length)
        case 'delete': return this.stopAgentNow()
        case 'backspace': return this.stopAgentNow()
        case 'escape': return this.escape()
        case 'pageup': return void this.scroll?.('pageUp')
        case 'pagedown': return void this.scroll?.('pageDown')
        default: return
      }
    }
    if (this.viewMenu !== undefined) {
      switch (name) {
        case 'up': return void this.viewStep(-1)
        case 'down': return void this.viewStep(1)
        case 'escape': return this.escape()
        case 'pageup': return void this.scroll?.('pageUp')
        case 'pagedown': return void this.scroll?.('pageDown')
        default: return
      }
    }
    if (this.sessionsMenu !== undefined) {
      switch (name) {
        case 'up': return void this.sessionStep(-1)
        case 'down': return void this.sessionStep(1)
        case 'escape': return this.escape()
        case 'delete': return this.actionSessionNow('delete')
        case 'backspace': return this.actionSessionNow('delete')
        case 'pageup': return void this.scroll?.('pageUp')
        case 'pagedown': return void this.scroll?.('pageDown')
        default: return
      }
    }
    if (this.toolsMenu !== undefined) {
      // The picker owns the keyboard; the draft below never moves or edits.
      switch (name) {
        case 'up': return void this.toolStep(-1)
        case 'down': return void this.toolStep(1)
        case 'delete': return this.requestToolDelete()
        case 'backspace': return this.requestToolDelete()
        case 'escape': return this.escape()
        case 'pageup': return void this.scroll?.('pageUp')
        case 'pagedown': return void this.scroll?.('pageDown')
        default: return
      }
    }
    switch (name) {
      case 'left': return this.move(-1)
      case 'right': return this.move(1)
      case 'up':
        if (this.menuStep(-1)) return
        return this.vertical(-1)
      case 'down':
        if (this.menuStep(1)) return
        return this.vertical(1)
      case 'pageup': return void this.scroll?.('pageUp')
      case 'pagedown': return void this.scroll?.('pageDown')
      case 'home': return this.lineStart()
      case 'end': return this.lineEnd()
      case 'backspace': return this.backspace()
      case 'delete': return this.delete()
      case 'escape': return this.escape()
    }
  }

  private escape(): void {
    if (this.agentsMenu !== undefined) {
      // Closing is the whole action: the draft is left byte-identical, and the
      // next Escape is not the first press of "clear the draft".
      this.closeAgentsMenu()
      return
    }
    if (this.viewMenu !== undefined) {
      // Closing is the whole action: the next Escape must not be read as the
      // first press of "clear the draft".
      this.closeViewMenu()
      return
    }
    if (this.sessionsMenu !== undefined) {
      this.closeSessionMenu()
      return
    }
    if (this.toolsMenu !== undefined) {
      if (this.toolsMenu.confirmDelete !== undefined) {
        const rest = { ...this.toolsMenu }
        delete rest.confirmDelete
        this.toolsMenu = rest
        this.changed()
        return
      }
      this.closeToolMenu()
      return
    }
    if (this.asking !== undefined) {
      this.endAsk('')
      return
    }
    if (this.busy) {
      this.onAbort()
      return
    }
    // A scrolled-up transcript consumes the first Escape: it means "back to the
    // live edge", not "clear the draft". Only when nothing is scrolled.
    if (this.value.length === 0 && this.scroll?.('bottom') === true) return
    if (this.menu().open) {
      this.menuDismissed = this.value
      this.note('esc again to clear')
      // The dismissed menu counted as the first press before this split, so the
      // next Escape still clears. An armed Ctrl-C-to-exit keeps its priority.
      if (this.activeConfirm() !== 'exit') this.requestConfirm('clear')
      return
    }
    if (this.value.length === 0) return
    if (this.activeConfirm() === 'clear') {
      this.clearDraft()
      this.changed()
      return
    }
    this.requestConfirm('clear')
  }

  private ctrlC(): void {
    if (this.viewMenu !== undefined) {
      this.closeViewMenu()
      return
    }
    if (this.sessionsMenu !== undefined) {
      this.closeSessionMenu()
      return
    }
    if (this.toolsMenu !== undefined) {
      this.closeToolMenu()
      return
    }
    if (this.asking !== undefined) {
      this.endAsk('')
      return
    }
    if (this.busy) {
      this.onAbort()
      return
    }
    if (this.value.length > 0) {
      this.clearDraft()
      this.changed()
      return
    }
    if (this.activeConfirm() === 'exit') {
      this.onExit()
      return
    }
    this.requestConfirm('exit')
  }

  private ctrlD(): void {
    if (this.viewMenu !== undefined) {
      this.closeViewMenu()
      return
    }
    if (this.sessionsMenu !== undefined) {
      this.closeSessionMenu()
      return
    }
    if (this.toolsMenu !== undefined) {
      this.closeToolMenu()
      return
    }
    if (this.busy) return
    if (this.value.length > 0) return this.delete()
    this.onExit()
  }

  private clearDraft(): void {
    this.value = ''
    this.cursor = 0
    this.historyIndex = -1
    this.notice = undefined
    this.confirm = undefined
    if (this.confirmTimer !== undefined) {
      clearTimeout(this.confirmTimer)
      this.confirmTimer = undefined
    }
    this.menuIndex = 0
    this.menuDismissed = undefined
  }

  private submit(): void {
    if (this.asking !== undefined) {
      this.endAsk(this.value)
      return
    }
    if (this.agentsMenu !== undefined) {
      this.openAgentNow()
      return
    }
    if (this.viewMenu !== undefined) {
      this.selectViewNow()
      return
    }
    if (this.sessionsMenu !== undefined) {
      this.selectSessionNow()
      return
    }
    if (this.toolsMenu !== undefined) {
      if (this.toolsMenu.confirmDelete !== undefined) this.deleteToolNow()
      else this.toggleToolNow()
      return
    }
    const menu = this.menu()
    if (menu.open && menu.items.length > 0) {
      this.accept(menu.items[menu.index]!, 'run')
      return
    }
    this.submitText()
  }

  private selectedTool(): ToolMenuItem | undefined {
    const menu = this.toolsMenu
    if (menu === undefined || menu.items.length === 0) return undefined
    return menu.items[Math.max(0, Math.min(menu.index, menu.items.length - 1))]
  }

  private toolStep(delta: number): boolean {
    const menu = this.toolsMenu
    if (menu === undefined || menu.items.length === 0) return false
    if (menu.confirmDelete !== undefined) return false
    this.toolsMenu = {
      ...menu,
      index: (menu.index + delta + menu.items.length) % menu.items.length,
    }
    this.changed()
    return true
  }

  private toggleToolNow(): void {
    const menu = this.toolsMenu
    const item = this.selectedTool()
    if (menu === undefined || item === undefined) return
    this.toolsMenu = { ...menu, items: menu.onAction('toggle', item.name) }
    this.clampToolIndex()
    this.changed()
  }

  private requestToolDelete(): void {
    const menu = this.toolsMenu
    const item = this.selectedTool()
    if (menu === undefined || item === undefined) return
    this.toolsMenu = { ...menu, confirmDelete: item.name }
    this.changed()
  }

  private deleteToolNow(): void {
    const menu = this.toolsMenu
    if (menu === undefined) return
    const name = menu.confirmDelete
    if (name === undefined) return
    const rest = { ...menu }
    delete rest.confirmDelete
    this.toolsMenu = { ...rest, items: menu.onAction('delete', name) }
    this.clampToolIndex()
    this.changed()
  }

  private clampToolIndex(): void {
    const menu = this.toolsMenu
    if (menu === undefined) return
    const last = Math.max(0, menu.items.length - 1)
    if (menu.index <= last) return
    this.toolsMenu = { ...menu, index: last }
  }

  private selectedSession(): SessionMenuItem | undefined {
    const menu = this.sessionsMenu
    if (menu === undefined || menu.items.length === 0) return undefined
    return menu.items[Math.max(0, Math.min(menu.index, menu.items.length - 1))]
  }

  private sessionStep(delta: number): boolean {
    const menu = this.sessionsMenu
    if (menu === undefined || menu.items.length === 0) return false
    this.sessionsMenu = {
      ...menu,
      index: (menu.index + delta + menu.items.length) % menu.items.length,
    }
    this.changed()
    return true
  }

  private selectSessionNow(): void {
    const menu = this.sessionsMenu
    const item = this.selectedSession()
    this.sessionsMenu = undefined
    this.changed()
    if (menu !== undefined && item !== undefined) menu.onSelect(item.id)
  }

  /** `r`/`d`: close the picker and hand the selected id to the command layer. */
  private actionSessionNow(action: 'rename' | 'delete'): void {
    const menu = this.sessionsMenu
    const item = this.selectedSession()
    this.sessionsMenu = undefined
    this.changed()
    if (menu !== undefined && item !== undefined) menu.onAction?.(action, item.id)
  }

  private viewStep(delta: number): boolean {
    const menu = this.viewMenu
    if (menu === undefined) return false
    this.viewMenu = {
      ...menu,
      index: (menu.index + delta + VIEW_MODES.length) % VIEW_MODES.length,
    }
    this.changed()
    return true
  }

  /** The highlighted `/agents` row, or `undefined` for an empty list. */
  private selectedAgent(): AgentEntry | undefined {
    const menu = this.agentsMenu
    if (menu === undefined || menu.entries.length === 0) return undefined
    return menu.entries[Math.max(0, Math.min(menu.index, menu.entries.length - 1))]
  }

  /**
   * Repoint the picker and drop the previous row's stop report.
   *
   * Moving to another row drops it: the notice describes one child, and must
   * not appear to describe the new selection. `agentPickerMove` both clears
   * `stop` and recomputes the notice, so a later repaint cannot resurrect the
   * old line - the rule lives in one tested pure function, not here.
   */
  private moveAgentPointer(index: number): boolean {
    const menu = this.agentsMenu
    if (menu === undefined || menu.entries.length === 0) return false
    this.agentsMenu = { ...menu, ...agentPickerMove(menu, index) }
    this.changed()
    return true
  }

  /** `↑`/`↓`: move the pointer, wrapping. */
  private agentStep(delta: number): boolean {
    const menu = this.agentsMenu
    if (menu === undefined || menu.entries.length === 0) return false
    return this.moveAgentPointer((menu.index + delta + menu.entries.length) % menu.entries.length)
  }

  /** A digit (1-based row) or Home/End: select that row directly. */
  private agentSelect(oneBased: number): boolean {
    return this.moveAgentPointer(oneBased - 1)
  }

  /** Enter: close first, then the caller shows that child's transcript. */
  private openAgentNow(): void {
    const menu = this.agentsMenu
    const entry = this.selectedAgent()
    if (menu === undefined) return
    this.agentsMenu = undefined
    this.changed()
    if (entry !== undefined) menu.onOpen(entry)
  }

  /**
   * `x`/Delete: stop the selected child and **stay open**, so the row's state
   * change is what the user sees. Every outcome leaves a notice inside the
   * picker - a refusal with its reason (the only place a `wait` child's Ctrl-C
   * advice can appear) and an accepted stop with its confirmation. A child that
   * settles after the press has its notice replaced by what actually happened.
   */
  private stopAgentNow(): void {
    const menu = this.agentsMenu
    const entry = this.selectedAgent()
    if (menu === undefined) return
    if (entry === undefined) return
    const outcome = menu.onStop(entry)
    // `onStop` may have finished a child and rebuilt the snapshot; reload so the
    // row reflects it rather than the entries captured when the picker opened.
    // The raw outcome is stored and the notice derived by the pure helper, so a
    // later repaint can replace "stopping …" with what actually happened.
    const repainted = agentPickerRepaint(menu, menu.refresh())
    this.agentsMenu = { ...menu, ...agentPickerStop(repainted, outcome) }
    this.changed()
  }

  /** Enter: close the picker first, then hand the mode to the command layer. */
  private selectViewNow(): void {
    const menu = this.viewMenu
    if (menu === undefined) return
    const mode = VIEW_MODES[Math.max(0, Math.min(menu.index, VIEW_MODES.length - 1))]!
    this.viewMenu = undefined
    this.changed()
    menu.onSelect(mode)
  }

  /** `1`/`2`/`3`, `c`/`m`/`f`: apply that row directly. */
  private selectViewMode(mode: ViewMode): void {
    const menu = this.viewMenu
    if (menu === undefined) return
    this.viewMenu = undefined
    this.changed()
    menu.onSelect(mode)
  }

  /** Send the draft as one turn, leaving the composer ready for the next one. */
  /**
   * Submit the draft, or hand a line the composer owns to an overlay.
   *
   * This is where `/agents` is intercepted for 2b. A submitted line normally
   * goes to `onLine`, which queues it while a turn runs - and a command that
   * prints to the transcript would then only appear after the turn. `intercept`
   * runs *here*, synchronously, before the line ever reaches that queue: the
   * command can open its overlay immediately, exactly like pressing a key, and
   * returning `true` means "handled - do not submit".
   */
  private submitText(): void {
    const text = this.value
    if (text.trim().length === 0) return
    if (this.intercept !== undefined && this.intercept(text)) {
      // The overlay replaces the draft exactly as a submitted command does.
      this.clearDraft()
      this.changed()
      return
    }
    this.history.push(text)
    if (this.history.length > 200) this.history.shift()
    this.historyIndex = -1
    this.clearDraft()
    this.onLine(text)
    this.changed()
  }

  /**
   * The slash menu is open while the caret is inside a `/word` at the start of
   * a single-line draft. A dismissed menu stays closed for that exact draft.
   */
  private menu(): { open: boolean; items: readonly CommandSpec[]; index: number } {
    const closed = { open: false, items: [] as readonly CommandSpec[], index: 0 }
    if (this.asking !== undefined) return closed
    if (!this.value.startsWith('/')) return closed
    if (this.value.includes('\n')) return closed
    if (/\s/.test(this.value.slice(0, this.cursor))) return closed
    if (this.menuDismissed === this.value) return closed
    const query = this.value.slice(1).toLowerCase()
    const items = this.commands().filter((command) => command.name.toLowerCase().startsWith(`/${query}`))
    const index = Math.max(0, Math.min(this.menuIndex, Math.max(0, items.length - 1)))
    return { open: true, items, index }
  }

  /** Move the highlighted command, wrapping like the Claude Code menu. */
  private menuStep(delta: number): boolean {
    const menu = this.menu()
    if (!menu.open || menu.items.length === 0) return false
    const length = menu.items.length
    this.menuIndex = (menu.index + delta + length) % length
    this.changed()
    return true
  }

  /**
   * Accept the highlighted command. Enter runs a command that takes no
   * arguments; Tab (and every command with arguments) only completes it.
   */
  private accept(item: CommandSpec, mode: 'run' | 'complete'): void {
    if (mode === 'run' && item.args === undefined) {
      this.value = item.name
      this.cursor = item.name.length
      this.menuDismissed = item.name
      this.submitText()
      return
    }
    this.value = `${item.name} `
    this.cursor = this.value.length
    this.menuIndex = 0
    this.menuDismissed = this.value
    this.changed()
  }

  /**
   * One row per command, with the selected row marked by `❯` and coloured the
   * way the decompiled `wOe` renders a suggestion. The window is centred on
   * the selection and never grows past half the terminal.
   */
  private renderMenu(columns: number, menu: { open: boolean; items: readonly CommandSpec[]; index: number }): string[] {
    if (!menu.open) return []
    if (menu.items.length === 0) return [dim('  no matching commands')]
    const maxRows = Math.max(1, Math.min(Math.max(6, Math.floor(terminalRows() / 2)), terminalRows() - 3))
    let start = Math.max(0, menu.index - Math.floor(maxRows / 2))
    start = Math.min(start, Math.max(0, menu.items.length - maxRows))
    const slice = menu.items.slice(start, start + maxRows)
    const nameWidth = Math.min(18, Math.max(...slice.map((item) => item.name.length)))
    return slice.map((item, offset) => {
      const selected = start + offset === menu.index
      const pointer = selected ? `${cyan('❯')} ` : '  '
      const name = item.name.padEnd(nameWidth)
      const description = item.args === undefined ? item.description : `${item.description} ${item.args}`
      const descWidth = Math.max(0, columns - 4 - nameWidth)
      const label = selected ? bold(cyan(name)) : dim(name)
      return clip(`${pointer}${label} ${dim(clip(description, descWidth))}`, Math.max(1, columns - 1))
    })
  }

  /**
   * The `/sessions` picker: a title with the store label, then a scrolling
   * window of `name · detail` rows. The current session is marked `*`; the
   * pointer and selection colours match the slash and tool menus.
   */
  private renderSessionMenu(columns: number): string[] {
    const menu = this.sessionsMenu
    if (menu === undefined) return []
    const items = menu.items
    const lines: string[] = [
      clip(`  ${bold('sessions')} · ${menu.label}`, Math.max(1, columns - 1)),
    ]
    if (items.length === 0) {
      lines.push(dim('  none yet · one starts with your next prompt'))
      return lines
    }
    const maxRows = Math.max(1, Math.min(items.length, terminalRows() - 12))
    let start = Math.max(0, menu.index - Math.floor(maxRows / 2))
    start = Math.min(start, Math.max(0, items.length - maxRows))
    const slice = items.slice(start, start + maxRows)
    const nameWidth = Math.min(34, Math.max(4, ...items.map((item) => displayCells(item.name))))
    for (const [offset, item] of slice.entries()) {
      const selected = start + offset === menu.index
      const pointer = selected ? `${cyan('❯')} ` : '  '
      const mark = item.current ? green('*') : ' '
      const icon = paint(`38;5;${String(item.color)}`, '⬢')
      const name = padTo(fit(item.name, nameWidth), nameWidth)
      const label = selected ? bold(cyan(name)) : name
      const archived = item.archived ? dim(' · archived') : ''
      lines.push(
        clip(
          `${pointer}${mark} ${icon} ${label}  ${dim(item.detail)}${archived}`,
          Math.max(1, columns - 1),
        ),
      )
    }
    return lines
  }

  /**
   * The `/agents` overlay (2b): a title with counts, one optional refusal line,
   * then a scrolling window of rows from the pure `agentPickerLines`. It reuses
   * the pointer/selection accent of the other pickers and adds no box.
   */
  private renderAgentsMenu(columns: number): string[] {
    const menu = this.agentsMenu
    if (menu === undefined) return []
    // Leave room for the title, the notice, the composer and the tray; a 24-row
    // terminal must still show the title and one row.
    const maxRows = Math.max(1, Math.min(menu.entries.length, terminalRows() - 12))
    let start = Math.max(0, menu.index - Math.floor(maxRows / 2))
    start = Math.min(start, Math.max(0, menu.entries.length - maxRows))
    const visible: readonly AgentEntry[] =
      menu.entries.length <= maxRows ? menu.entries : menu.entries.slice(start, start + maxRows)
    // `firstIndex` keeps each row's absolute number (`/agents <n>` takes it) even
    // when the window is scrolled.
    return [
      ...agentPickerLines({
        entries: visible,
        firstIndex: start,
        index: menu.index - start,
        now: Date.now(),
        columns,
        theme: viewTheme,
        ...(menu.notice === undefined ? {} : { notice: menu.notice }),
      }),
    ]
  }

  /**
   * The `/tools` picker: a title with counts, an optional delete confirmation,
   * then a scrolling window of `on/off/del` rows. It reuses the slash menu's
   * pointer and selection colours so the two read as one control.
   */
  private renderToolMenu(columns: number): string[] {
    const menu = this.toolsMenu
    if (menu === undefined) return []
    const items = menu.items
    const on = items.filter((item) => item.state === 'enabled').length
    const off = items.filter((item) => item.state === 'disabled').length
    const deleted = items.filter((item) => item.state === 'deleted').length
    const parts = [`${green(String(on))} on`]
    if (off > 0) parts.push(`${yellow(String(off))} off`)
    if (deleted > 0) parts.push(`${red(String(deleted))} deleted`)
    const title = `${bold('tools')} · ${String(items.length)} total · ${parts.join(' · ')}`
    const lines: string[] = [clip(`  ${title}`, Math.max(1, columns - 1))]
    if (menu.confirmDelete !== undefined) {
      lines.push(
        clip(
          `  ${yellow('delete')} ${bold(`"${menu.confirmDelete}"`)}? ${dim(
            'hidden from the agent; the module keeps the code',
          )}`,
          Math.max(1, columns - 1),
        ),
      )
      lines.push(clip(`  ${dim('⏎ yes · esc cancel')}`, Math.max(1, columns - 1)))
    }
    if (items.length === 0) {
      lines.push(dim('  no tools installed'))
      return lines
    }

    // Leave room for the title, the confirmation, the composer and the
    // submitted `/tools` row; a 24-row terminal must still show the title.
    const maxRows = Math.max(1, Math.min(items.length, terminalRows() - 12))
    let start = Math.max(0, menu.index - Math.floor(maxRows / 2))
    start = Math.min(start, Math.max(0, items.length - maxRows))
    const slice = items.slice(start, start + maxRows)
    // Width across the whole list, so descriptions do not jump while scrolling.
    const nameWidth = Math.min(24, Math.max(4, ...items.map((item) => displayCells(item.name))))
    for (const [offset, item] of slice.entries()) {
      const selected = start + offset === menu.index
      const pointer = selected ? `${cyan('❯')} ` : '  '
      const state =
        item.state === 'enabled' ? green('on ') : item.state === 'disabled' ? yellow('off') : red('del')
      const name = padTo(fit(item.name, nameWidth), nameWidth)
      const label = selected ? bold(cyan(name)) : name
      const missing = item.installed ? '' : dim(' (not installed)')
      // The same marker the numbered `/tools` list prints: the row a person
      // would try to delete says it cannot be, before they try.
      const owned = item.system ? dim(' · system') : ''
      const description = (item.description.split('\n')[0] ?? '').trim()
      const room = Math.max(
        0,
        columns - 2 - 4 - 3 - nameWidth - displayCells(missing) - displayCells(owned) - 2,
      )
      const suffix = description.length > 0 ? `  ${dim(clip(description, room))}` : ''
      lines.push(
        clip(`${pointer}${state}  ${label}${missing}${owned}${suffix}`, Math.max(1, columns - 1)),
      )
    }
    return lines
  }

  /**
   * The `/view` picker: a title naming the current mode, then three rows from
   * the pure `viewMenuItems`. It reuses the pointer/selection accent of the
   * other pickers and adds no box of its own.
   */
  private renderViewMenu(columns: number): string[] {
    const menu = this.viewMenu
    if (menu === undefined) return []
    const title = `  ${bold('view')} · ${cyan(menu.current)}`
    return [
      clip(title, Math.max(1, columns - 1)),
      ...viewMenuItems(menu.current, menu.index, viewTheme, Math.max(1, columns)).map((row) => row.text),
    ]
  }

  private insert(text: string): void {
    if (
      this.toolsMenu !== undefined ||
      this.sessionsMenu !== undefined ||
      this.viewMenu !== undefined ||
      this.agentsMenu !== undefined
    ) return
    const clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    if (clean.length === 0) return
    this.value = `${this.value.slice(0, this.cursor)}${clean}${this.value.slice(this.cursor)}`
    this.cursor += clean.length
    this.historyIndex = -1
    this.changed()
  }

  private backspace(): void {
    if (this.toolsMenu !== undefined || this.viewMenu !== undefined) return
    if (this.cursor === 0) return
    const before = this.value.slice(0, this.cursor)
    const char = Array.from(before).at(-1) ?? ''
    this.value = `${before.slice(0, before.length - char.length)}${this.value.slice(this.cursor)}`
    this.cursor -= char.length
    this.historyIndex = -1
    this.changed()
  }

  private delete(): void {
    if (this.cursor >= this.value.length) return
    const after = Array.from(this.value.slice(this.cursor))
    const char = after[0] ?? ''
    this.value = `${this.value.slice(0, this.cursor)}${this.value.slice(this.cursor + char.length)}`
    this.historyIndex = -1
    this.changed()
  }

  private move(delta: number): void {
    if (delta < 0 && this.cursor > 0) {
      const before = this.value.slice(0, this.cursor)
      const char = Array.from(before).at(-1) ?? ''
      this.cursor -= char.length
    } else if (delta > 0 && this.cursor < this.value.length) {
      const after = Array.from(this.value.slice(this.cursor))
      this.cursor += (after[0] ?? '').length
    }
    this.changed()
  }

  private wordLeft(): void {
    let at = this.cursor
    while (at > 0 && /\s/.test(this.value[at - 1]!)) at -= 1
    while (at > 0 && !/\s/.test(this.value[at - 1]!)) at -= 1
    this.cursor = at
    this.changed()
  }

  private wordRight(): void {
    let at = this.cursor
    while (at < this.value.length && /\s/.test(this.value[at]!)) at += 1
    while (at < this.value.length && !/\s/.test(this.value[at]!)) at += 1
    this.cursor = at
    this.changed()
  }

  private deleteWordBack(): void {
    const end = this.cursor
    this.wordLeft()
    this.value = `${this.value.slice(0, this.cursor)}${this.value.slice(end)}`
    this.historyIndex = -1
    this.changed()
  }

  private deleteWordForward(): void {
    const start = this.cursor
    this.wordRight()
    this.value = `${this.value.slice(0, start)}${this.value.slice(this.cursor)}`
    this.cursor = start
    this.historyIndex = -1
    this.changed()
  }

  private lineStart(): void {
    const index = this.value.lastIndexOf('\n', Math.max(0, this.cursor - 1))
    this.cursor = index < 0 ? 0 : index + 1
    this.changed()
  }

  private lineEnd(): void {
    const index = this.value.indexOf('\n', this.cursor)
    this.cursor = index < 0 ? this.value.length : index
    this.changed()
  }

  private killToStart(): void {
    const index = this.value.lastIndexOf('\n', Math.max(0, this.cursor - 1))
    const start = index < 0 ? 0 : index + 1
    this.value = `${this.value.slice(0, start)}${this.value.slice(this.cursor)}`
    this.cursor = start
    this.historyIndex = -1
    this.changed()
  }

  private killToEnd(): void {
    const index = this.value.indexOf('\n', this.cursor)
    const end = index < 0 ? this.value.length : index
    this.value = `${this.value.slice(0, this.cursor)}${this.value.slice(end)}`
    this.historyIndex = -1
    this.changed()
  }

  private vertical(delta: number): void {
    const rows = layoutRows(this.value, composerTextWidth(terminalColumns()))
    if (rows.length <= 1) {
      if (delta < 0) this.historyPrev()
      else this.historyNext()
      return
    }
    const position = cursorPosition(rows, this.cursor)
    if (delta < 0 && position.row === 0) return this.historyPrev()
    if (delta > 0 && position.row === rows.length - 1) return this.historyNext()
    const target = rows[Math.max(0, Math.min(rows.length - 1, position.row + delta))]!
    this.cursor = Math.min(target.start + position.col, target.end)
    this.changed()
  }

  private historyPrev(): void {
    if (this.history.length === 0) return
    if (this.historyIndex === -1) {
      this.stash = this.value
      this.historyIndex = this.history.length - 1
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1
    }
    this.value = this.history[this.historyIndex] ?? ''
    this.cursor = this.value.length
    this.changed()
  }

  private historyNext(): void {
    if (this.historyIndex === -1) return
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1
      this.value = this.history[this.historyIndex] ?? ''
    } else {
      this.historyIndex = -1
      this.value = this.stash
    }
    this.cursor = this.value.length
    this.changed()
  }

  private tab(): void {
    const menu = this.menu()
    if (menu.open && menu.items.length > 0) {
      this.accept(menu.items[menu.index]!, 'complete')
      return
    }
    const result = this.complete(this.value, this.cursor)
    if (result === undefined) return
    this.value = result.value
    this.cursor = result.cursor
    this.historyIndex = -1
    if (result.message !== undefined) this.note(result.message)
    else this.changed()
  }

  private clearScreen(): void {
    stdout.write('\x1b[2J\x1b[H')
    this.onChange()
  }

  /**
   * The footer's left hint.
   *
   * Precedence, highest first, and why:
   *
   * 1. an open `ask` (an approval) - it is a question only the user can answer;
   * 2. an open picker - it owns the keyboard, so its keys are what to show;
   * 3. an armed confirm (`esc again to clear`, `press ctrl+c again to exit`) -
   *    it describes what the *next* press does, and the user has to be able to
   *    see that they are one key from losing their draft or the session;
   * 4. a notice - a one-off result the user just caused;
   * 5. the slash menu's own keys when it is open;
   * 6. **the running-agents line** - 2b. It outranks `esc to interrupt` and
   *    `? for shortcuts` because the user asked to see background work whenever
   *    a child runs: `esc to interrupt` describes *this turn*, not the children,
   *    and interrupt still works - only the hint yields. It is also shown while
   *    idle (between turns), where `? for shortcuts` used to be;
   * 7. `esc to interrupt` / `N queued · esc to interrupt` while a turn runs;
   * 8. the argument hint (`usage: /model …`) when the draft is a bare command;
   * 9. `esc to clear` for a non-empty draft, then `? for shortcuts`.
   *
   * The argument hint sits *below* the running line on purpose: it repeats the
   * `usage:` line the command itself prints, while a running child is live
   * state that changes on its own. Everything after 6 has a draft or a turn
   * meaning, and none of it is urgent enough to hide live work.
   */
  private hint(menuOpen: boolean): string {
    if (this.asking !== undefined) return this.asking.label
    if (this.viewMenu !== undefined) return '↑↓ · ⏎ apply · 1/2/3 · esc'
    if (this.agentsMenu !== undefined) {
      // The footer must not offer `x stop` when the row cannot be stopped: a
      // settled row has nothing to stop, and a refused press has just said why.
      // An accepted stop on a still-running child keeps offering `x` (a second
      // press is refused harmlessly, and the notice already names the stop).
      const selected = this.selectedAgent()
      const stoppable = selected !== undefined && selected.outcome === 'running'
      return stoppable ? '↑↓ · ⏎ open · x stop · esc' : '↑↓ · ⏎ open · esc'
    }
    if (this.sessionsMenu !== undefined) return '↑↓ · ⏎ switch · r rename · d delete · esc'
    if (this.toolsMenu !== undefined) {
      return this.toolsMenu.confirmDelete !== undefined
        ? '⏎ yes · esc cancel'
        : '↑↓ · ⏎ toggle · del delete · esc'
    }
    // An armed confirmation outranks a notice: it describes what the *next*
    // press does, and it is the state the user has to be able to see.
    const confirm = this.activeConfirm()
    if (confirm !== undefined) return confirm === 'exit' ? 'press ctrl+c again to exit' : 'esc again to clear'
    if (this.notice !== undefined && Date.now() < this.notice.until) return this.notice.text
    if (menuOpen) return '↑↓ select · ⏎ run · esc close'
    // 2b: live background work, in the slot `? for shortcuts` used to take.
    const running = runningLabel(runningChildren)
    if (running !== undefined) return running
    if (this.busy) return pendingLines.length > 0 ? `${String(pendingLines.length)} queued · esc to interrupt` : 'esc to interrupt'
    if (this.value.length > 0) return this.argumentHint() ?? 'esc to clear'
    return '? for shortcuts'
  }

  /** `/model ` with no argument yet: show the shape the command expects. */
  private argumentHint(): string | undefined {
    const command = this.commands().find(
      (candidate) => candidate.args !== undefined && this.value.startsWith(`${candidate.name} `),
    )
    if (command === undefined || command.args === undefined) return undefined
    const rest = this.value.slice(command.name.length + 1)
    return rest.trim().length === 0 ? `usage: ${command.name} ${command.args}` : undefined
  }

  layout(columns: number, status: string): TailLayout {
    const width = Math.max(8, columns)
    const menu = this.menu()
    const menuLines = this.renderMenu(width, menu)
    const viewLines = this.renderViewMenu(width)
    const toolLines = this.renderToolMenu(width)
    const sessionLines = this.renderSessionMenu(width)
    const agentLines = this.renderAgentsMenu(width)
    // The composer is a full sharp box: top/bottom rules and vertical sides.
    // It is accented only while the field is active (idle, asking, or a draft
    // is being edited); during a run with an empty draft it stays dim.
    // The composer is a plain, uniformly dim box; no prompt chevron and no
    // brighter edge that would read as a bold outline.
    const leftEdge = dim('│')
    const rightEdge = dim('│')
    const textWidth = composerTextWidth(width)
    const rows = layoutRows(this.value, textWidth)
    const position = cursorPosition(rows, this.cursor)
    const maxVisible = Math.max(3, Math.min(12, terminalRows() - 8))
    let start = 0
    if (rows.length > maxVisible) {
      const half = Math.floor(maxVisible / 2)
      start = Math.max(0, Math.min(rows.length - maxVisible, position.row - half))
    }
    const visible = rows.slice(start, start + maxVisible)
    // 2b/UX: a visible cursor block at the draft caret. It is drawn *into* the
    // row, so a wrap and a CJK line are the wrap helper's answer, not a second
    // width calculation. An overlay owns the keyboard, so no block is drawn for
    // it - the terminal's own caret is all the user needs there.
    const overlayOwnsKeyboard =
      this.agentsMenu !== undefined ||
      this.toolsMenu !== undefined ||
      this.sessionsMenu !== undefined ||
      this.viewMenu !== undefined ||
      this.asking !== undefined
    const cursorIndex = overlayOwnsKeyboard ? -1 : position.row - start
    const steady = this.busy
    const input: string[] = visible.map((row, offset) =>
      offset === cursorIndex
        ? `${leftEdge} ${composerRowWithCursor({ row, cursor: this.cursor, cells: textWidth, steady })} ${rightEdge}`
        : `${leftEdge} ${padTo(row.text, textWidth)} ${rightEdge}`,
    )
    if (this.value.length === 0) {
      // An empty draft still shows where typing goes: the block sits on the
      // placeholder, which is the one thing the old empty box never did.
      input[0] =
        cursorIndex === 0
          ? `${leftEdge} ${composerRowWithCursor({ row: { text: '', start: 0, end: 0 }, cursor: 0, cells: textWidth, steady })} ${rightEdge}`
          : `${leftEdge} ${padTo(dim('Ask z1…'), textWidth)} ${rightEdge}`
    }
    const rule = (left: string, right: string): string =>
      dim(`${left}${'─'.repeat(Math.max(0, width - 2))}${right}`)
    const header = rule('┌', '┐')
    const footerRule = rule('└', '┘')
    const hint = this.hint(menu.open)
    const right = status
    const available = Math.max(1, width - 2)
    // 2b: live background work is a *state*, and this theme spends hue only on
    // states - green is running. The row is the exact string `hint()` returned,
    // so this is equality with the one source, not a second copy of the rule.
    const runningHint = runningLabel(runningChildren)
    const liveChildRow = runningHint !== undefined && hint === runningHint
    let left = ''
    let after = ''
    if (this.asking !== undefined) {
      // A question owns the row: an approval must be readable before the status.
      left = clip(hint, available)
    } else if (hint.length > 0 && right.length > 0 && hint.length + right.length <= available) {
      // The happy path: hint on the left, session status on the right.
      left = hint
      after = `${' '.repeat(available - hint.length - right.length)}${right}`
    } else {
      // The hint always keeps its room; the status is truncated from the right,
      // so model and context survive. This is Claude Code's footer rule.
      const leftBudget = right.length === 0 ? available : Math.max(0, available - Math.min(right.length, 24) - 1)
      left = clip(hint, leftBudget)
      const rightBudget = Math.max(0, available - stripAnsi(left).length - (left.length > 0 ? 2 : 0))
      const rightText = clip(right, rightBudget)
      if (rightText.length > 0) {
        after = `${' '.repeat(Math.max(0, available - stripAnsi(left).length - stripAnsi(rightText).length))}${rightText}`
      }
    }
    // The frame stays dim; only the live row keeps its state hue. Everything
    // else is byte-identical to the footer without children.
    const footer =
      liveChildRow && left.length > 0 ? `  ${green(left)}${dim(after)}` : dim(`  ${left}${after}`)
    const lines = [
      ...sessionLines,
      ...toolLines,
      ...viewLines,
      ...agentLines,
      ...menuLines,
      header,
      ...input,
      footerRule,
      footer,
    ]
    const key = [
      this.value,
      String(this.cursor),
      status,
      this.busy ? '1' : '0',
      this.asking?.label ?? '',
      this.hint(menu.open),
      menu.open ? `${String(menu.index)}:${menuLines.join('\n')}` : '',
      viewLines.join('\n'),
      toolLines.join('\n'),
      sessionLines.join('\n'),
      agentLines.join('\n'),
      this.agentsMenu === undefined
        ? ''
        : `${String(this.agentsMenu.index)}:${this.agentsMenu.notice?.text ?? ''}`,
      this.sessionsMenu === undefined
        ? ''
        : `${String(this.sessionsMenu.index)}:${this.sessionsMenu.label}`,
      this.toolsMenu === undefined ? '' : String(this.toolsMenu.confirmDelete ?? ''),
      this.viewMenu === undefined
        ? ''
        : `${String(this.viewMenu.index)}:${this.viewMenu.current}`,
      String(width),
    ].join('\u0000')
    return {
      lines,
      cursorRow:
        sessionLines.length +
        toolLines.length +
        viewLines.length +
        agentLines.length +
        menuLines.length +
        1 +
        (position.row - start),
      cursorCol: 2 + position.col,
      key,
    }
  }
}

const createTail = (options: { live?: boolean; pinned?: boolean } = {}): Tail => {
  const live = options.live === true && Boolean(stdout.isTTY)
  let statusText = ''
  let activityText: string | undefined
  /** Streamed text after the last newline: shown just above the composer. */
  let pending = ''
  let timer: NodeJS.Timeout | undefined
  let composer: TailComposer | undefined
  let headerBuilder: (() => string) | undefined
  /** Committed rows, reprinted from the top after a resize. */
  let history: string[] = []
  /** Rows reserved at the bottom: pending + activity + composer. */
  let trayRows = 0
  /** Last row of the scrolling region (the tray starts right below it). */
  let scrollBottom = 0
  let regionSet = false
  let drawn = false
  let frame = ''
  let lastRows = 0
  let lastColumns = 0
  /**
   * Geometry of the last *full-screen* layout (the first paint or a reflow).
   * `lastRows` cannot answer this: a paint racing the 250 ms debounce updates
   * it with the new height, which used to hide the height change from `reflow`
   * and leave the old screen in scrollback (a duplicated session in VS Code).
   */
  let screenRows = 0
  let screenColumns = 0
  /** True when a SIGWINCH observed geometry other than `screenRows`/`screenColumns`. */
  let resizeDirty = false
  /** Next free absolute row in the scrolling region. */
  let outputRow = 1
  /** Absolute cursor row/column inside the tray. */
  let trayCursorRow = 1
  let trayCursorCol = 1
  /** Row currently showing the transient spinner, if any. */
  let activityRow: number | undefined
  /** Rows currently showing the uncommitted streamed line. */
  let pendingDrawn = 0
  let pendingStart = 0
  /**
   * Pinned mode (`Z1_PINNED=alt`): the alternate screen is app-owned, so the
   * composer is drawn at fixed rows and the transcript is a retained buffer
   * scrolled by the app. Native scrollback is not available there — the terminal
   * cannot scroll a screen the app owns.
   */
  const pinned = options.pinned === true
  /** Rows scrolled up from the live edge; 0 means "following output". */
  let viewOffset = 0
  /** Transcript rows visible above the tray at the last pinned render. */
  let bodyHeight = 0

  /** Banner + committed rows + open streamed line + spinner, wrapped. */
  const pinnedLines = (columns: number): string[] => {
    const out: string[] = []
    const header = headerBuilder?.() ?? ''
    if (header.length > 0) {
      for (const line of header.split('\n')) out.push(...wrapPlain(line, columns))
    }
    for (const line of history) out.push(...wrapPlain(line, columns))
    if (pending.length > 0) out.push(...wrapPlain(pending, columns))
    if (activityText !== undefined) out.push(clip(activityText, columns))
    return out
  }

  /**
   * Repaint the whole alternate screen: a window over the retained transcript,
   * then the tray at fixed bottom rows. No scroll region is set here, so no
   * DECSTBM state can leak into the normal buffer.
   */
  const renderPinned = (): void => {
    if (!live) return
    enterAppScreen()
    const rows = terminalRows()
    const columns = terminalColumns()
    const frameData = buildFrame()
    let lines = frameData.lines
    let cursorLine = frameData.cursorLine
    const maxTray = Math.max(1, rows - 3)
    if (lines.length > maxTray) {
      const drop = lines.length - maxTray
      lines = lines.slice(drop)
      cursorLine = Math.max(0, cursorLine - drop)
    }
    const height = Math.max(1, lines.length)
    const trayTop = rows - height + 1
    const body = Math.max(0, trayTop - 1)
    bodyHeight = body
    const all = pinnedLines(columns)
    const maxOffset = Math.max(0, all.length - body)
    viewOffset = Math.max(0, Math.min(viewOffset, maxOffset))
    const end = all.length - viewOffset
    // Scrolled up: reserve the last body row for the "back to live" hint.
    const gap = viewOffset > 0 && body > 3 ? 1 : 0
    const windowRows = Math.max(0, body - gap)
    const start = Math.max(0, end - windowRows)
    let out = '\x1b[?2026h'
    if (rows !== lastRows || columns !== lastColumns) out += '\x1b[2J\x1b[H'
    for (let index = 0; index < body; index += 1) {
      let text = index < windowRows ? (all[start + index] ?? '') : ''
      if (gap === 1 && index === body - 1) {
        text = clip(dim(`── ↓ ${String(viewOffset)} more lines · PgDn or Esc to return ──`), columns)
      }
      out += `\x1b[${String(index + 1)};1H\x1b[2K${text}`
    }
    for (let index = 0; index < lines.length; index += 1) {
      out += `\x1b[${String(trayTop + index)};1H\x1b[2K${lines[index]!}`
    }
    out += '\x1b[?2026l'
    stdout.write(out)
    trayCursorRow = trayTop + cursorLine
    trayCursorCol = Math.min(columns, frameData.cursorCol + 1)
    drawn = true
    frame = frameData.key
    lastRows = rows
    lastColumns = columns
    screenRows = rows
    screenColumns = columns
    restoreCursor()
  }

  const stopTimer = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  /** Split one physical line into rows of at most `columns` terminal cells. */
  const wrapPlain = (text: string, columns: number): string[] => {
    const rows: string[] = []
    const limit = Math.max(1, columns)
    let row = ''
    let cells = 0
    let index = 0
    while (index < text.length) {
      // SGR sequences carry colour but occupy no cells; counting them would
      // wrap the banner/progress rows mid-border.
      if (text[index] === '\x1b') {
        const sgr = /^\x1b\[[0-9;]*m/.exec(text.slice(index))
        if (sgr !== null) {
          row += sgr[0]
          index += sgr[0].length
          continue
        }
      }
      const code = text.codePointAt(index) ?? 0
      const char = String.fromCodePoint(code)
      const width = charCells(char)
      if (cells > 0 && cells + width > limit) {
        rows.push(row)
        row = ''
        cells = 0
      }
      row += char
      cells += width
      index += char.length
    }
    if (row.length > 0 || rows.length === 0) rows.push(row)
    return rows
  }

  /** Hard-wrapped rows one logical line occupies at `columns`. */
  const lineRows = (text: string, columns: number): number =>
    Math.max(1, Math.ceil(displayCells(text) / Math.max(1, columns)))

  interface Frame {
    lines: string[]
    cursorLine: number
    cursorCol: number
    key: string
  }

  const buildFrame = (): Frame => {
    const columns = terminalColumns()
    const block = composer?.layout(columns, statusText)
    const lines: string[] = []
    let cursorLine = 0
    if (block !== undefined) {
      lines.push(...block.lines)
      cursorLine = block.cursorRow
      return {
        lines,
        cursorLine,
        cursorCol: Math.max(0, Math.min(block.cursorCol, columns - 1)),
        key: `${pending}\u0000${block.key}\u0000${String(columns)}\u0000${String(terminalRows())}`,
      }
    }
    return {
      lines,
      cursorLine,
      cursorCol: 0,
      key: `${pending}\u0000${statusText}\u0000${String(columns)}\u0000${String(terminalRows())}`,
    }
  }

  const restoreCursor = (): void => {
    if (!live || !drawn) return
    stdout.write(`\x1b[${String(trayCursorRow)};${String(trayCursorCol)}H`)
  }

  const clearActivity = (): void => {
    if (activityRow === undefined) return
    stdout.write(`\x1b[${String(activityRow)};1H\x1b[2K`)
    activityRow = undefined
  }

  const clearPending = (): void => {
    if (pendingDrawn === 0) return
    for (let index = 0; index < pendingDrawn; index += 1) {
      stdout.write(`\x1b[${String(pendingStart + index)};1H\x1b[2K`)
    }
    pendingDrawn = 0
  }

  /**
   * The uncommitted streamed line lives at the end of the transcript too. It is
   * redrawn in place until a newline commits it; it is never part of the tray.
   */
  const renderPending = (): void => {
    if (!live) return
    if (pinned) {
      renderPinned()
      return
    }
    if (!regionSet) return
    clearPending()
    if (pending.length === 0) {
      restoreCursor()
      return
    }
    const columns = terminalColumns()
    let rows = wrapPlain(pending, columns)
    const available = Math.max(0, scrollBottom - outputRow + 1)
    if (available === 0) {
      restoreCursor()
      return
    }
    if (rows.length > available) rows = rows.slice(rows.length - available)
    pendingStart = outputRow
    for (let index = 0; index < rows.length; index += 1) {
      stdout.write(`\x1b[${String(outputRow + index)};1H\x1b[2K${rows[index]!}`)
    }
    pendingDrawn = rows.length
    restoreCursor()
  }

  /**
   * The spinner belongs at the end of the transcript, not inside the docked
   * tray. It is a transient row at the next output line and never enters
   * scrollback.
   */
  const renderActivity = (): void => {
    if (!live) return
    if (pinned) {
      renderPinned()
      return
    }
    const columns = terminalColumns()
    if (activityText === undefined) {
      clearActivity()
      restoreCursor()
      return
    }
    if (!regionSet) return
    if (outputRow > scrollBottom) {
      stdout.write(`\x1b[${String(scrollBottom)};1H\n`)
      outputRow = scrollBottom
    }
    const row = outputRow + pendingDrawn
    if (activityRow !== undefined && activityRow !== row) clearActivity()
    stdout.write(`\x1b[${String(row)};1H\x1b[2K${clip(activityText, columns)}`)
    activityRow = row
    restoreCursor()
  }

  /**
   * Write rows into the scrolling region. The region ends one row above the
   * tray, so a newline at its bottom margin scrolls only the transcript; the
   * tray is outside the region and never moves. Top margin 1 keeps scrollback.
   */
  const writeRows = (rows: readonly string[], remember: boolean): void => {
    if (rows.length === 0) return
    if (!live) {
      stdout.write(rows.join('\n'))
      return
    }
    if (pinned) {
      if (remember) {
        history.push(...rows)
        if (history.length > 4000) history = history.slice(-4000)
        // Keep the reader's place while output keeps arriving underneath.
        if (viewOffset > 0) {
          const columns = terminalColumns()
          let added = 0
          for (const line of rows) added += wrapPlain(line, columns).length
          viewOffset += added
        }
      }
      renderPinned()
      return
    }
    if (!regionSet) paint()
    clearPending()
    clearActivity()
    const columns = terminalColumns()
    for (const logical of rows) {
      for (const row of wrapPlain(logical, columns)) {
        if (outputRow > scrollBottom) {
          stdout.write(`\x1b[${String(scrollBottom)};1H\n`)
          outputRow = scrollBottom
        }
        stdout.write(`\x1b[${String(outputRow)};1H\x1b[2K${row}`)
        outputRow += 1
      }
    }
    if (remember) {
      history.push(...rows)
      if (history.length > 600) history = history.slice(-600)
    }
    restoreCursor()
  }

  const writeText = (text: string): void => {
    const rows = text.split('\n')
    if (rows.at(-1) === '') rows.pop()
    if (rows.length > 0) writeRows(rows, true)
  }

  const paint = (): void => {
    if (!live) return
    if (pinned) {
      renderPinned()
      return
    }
    const rows = terminalRows()
    const columns = terminalColumns()
    // A resize is in flight; the debounced reflow clears and repaints once.
    if (lastColumns !== 0 && columns !== lastColumns) {
      debugLog(`paint skip (columns ${String(columns)} != ${String(lastColumns)}) rows=${String(rows)}`)
      return
    }
    const frameData = buildFrame()
    if (drawn && frameData.key === frame) return

    let lines = frameData.lines
    let cursorLine = frameData.cursorLine
    const maxTray = Math.max(1, rows - 3)
    if (lines.length > maxTray) {
      const drop = lines.length - maxTray
      lines = lines.slice(drop)
      cursorLine = Math.max(0, cursorLine - drop)
    }
    const height = Math.max(1, lines.length)
    const bottom = Math.max(1, rows - height)
    const trayTop = bottom + 1
    const resized = rows !== lastRows
    const geometryChanged = !regionSet || bottom !== scrollBottom || height !== trayRows || resized
    debugLog(
      `paint rows=${String(rows)} prevRows=${String(lastRows)} cols=${String(columns)} region=${String(regionSet)} bottom=${String(bottom)} prevBottom=${String(scrollBottom)} height=${String(height)} prevTray=${String(trayRows)} outputRow=${String(outputRow)} geo=${String(geometryChanged)}`,
    )

    clearPending()
    clearActivity()
    if (geometryChanged) {
      // A taller tray only needs to scroll the transcript when it would cover
      // the next output row. Blank space below the output absorbs the growth,
      // so the banner does not move just because a spinner appeared.
      if (height > trayRows && regionSet) {
        const delta = Math.min(scrollBottom, Math.max(0, outputRow - trayTop + 1))
        if (delta > 0) {
          stdout.write(`\x1b[${String(scrollBottom)};1H`)
          for (let index = 0; index < delta; index += 1) stdout.write('\n')
          outputRow = Math.max(1, outputRow - delta)
        }
      }
      stdout.write('\x1b[r')
      const oldTop = rows - trayRows + 1
      const clearTop = Math.max(1, Math.min(oldTop, trayTop))
      stdout.write(`\x1b[${String(clearTop)};1H\x1b[J`)
      stdout.write(`\x1b[1;${String(bottom)}r`)
      scrollBottom = bottom
      trayRows = height
      regionSet = true
      lastRows = rows
      if (screenRows === 0) {
        screenRows = rows
        screenColumns = columns
      }
      outputRow = Math.max(1, Math.min(bottom, outputRow))
    } else {
      stdout.write(`\x1b[${String(trayTop)};1H\x1b[J`)
    }

    for (let index = 0; index < lines.length; index += 1) {
      stdout.write(`\x1b[${String(trayTop + index)};1H\x1b[2K${lines[index]!}`)
    }
    trayCursorRow = trayTop + cursorLine
    trayCursorCol = Math.min(columns, frameData.cursorCol + 1)
    drawn = true
    frame = frameData.key
    lastColumns = columns
    restoreCursor()
    renderPending()
    renderActivity()
  }

  /** Everything up to the last newline leaves for the scrolling region. */
  const takeComplete = (): string => {
    const cut = pending.lastIndexOf('\n')
    if (cut < 0) return ''
    const head = pending.slice(0, cut + 1)
    pending = pending.slice(cut + 1)
    return head
  }

  const flush = (): void => {
    stopTimer()
    const head = takeComplete()
    if (head.length > 0) writeText(head)
    paint()
  }

  const stream = (text: string): void => {
    if (text.length === 0) return
    pending += text
    if (text.includes('\n')) {
      flush()
      return
    }
    if (!live) return
    if (timer === undefined) {
      // Coalesce deltas: one frame per ~25 ms, never one per token.
      timer = setTimeout(() => {
        timer = undefined
        flush()
      }, 25)
      timer.unref?.()
    }
  }

  const print = (line: string): void => {
    stopTimer()
    const body = `${pending.length > 0 ? `${pending}\n` : ''}${line}\n`
    pending = ''
    if (!live) {
      stdout.write(body)
      return
    }
    writeText(body)
    paint()
  }

  const breakLine = (): void => {
    stopTimer()
    if (pending.length === 0) return
    const body = `${pending}\n`
    pending = ''
    if (!live) {
      stdout.write(body)
      return
    }
    writeText(body)
    paint()
  }

  const idle = (): void => {
    stopTimer()
    if (pending.length > 0) {
      const body = `${pending}\n`
      pending = ''
      writeText(body)
    }
    if (!live) {
      if (colorEnabled && statusText.length > 0) stdout.write(`${statusText}\n`)
      return
    }
    paint()
  }

  const status = (text: string): void => {
    if (text === statusText) return
    statusText = text
    paint()
  }

  const activity = (text: string | undefined): void => {
    if (text === activityText) return
    activityText = text
    if (!live) return
    if (!regionSet) paint()
    else renderActivity()
  }

  const repaint = (): void => {
    frame = ''
    paint()
  }

  /**
   * Opening another session, `/new` or `/clear` replaces the conversation, so
   * the screen has to be replaced too: an emptied `history` above the old
   * transcript reads as "nothing happened" (and a `/clear` right after `/new`
   * answered "already empty" under the previous chat).
   *
   * Pinned mode owns the alternate screen, so dropping `history` and repainting
   * is a full wipe there. Native mode does not own the terminal, so it wipes the
   * viewport *and* the scrollback and reprints the banner, the same reset a
   * width change performs: leaving the old screen one scroll up would put a
   * second banner and a second conversation in scrollback, which is the bug the
   * native `reflow` path exists to avoid. Without a live terminal there is
   * nothing to wipe, and piped output must stay free of escapes.
   */
  const clear = (): void => {
    if (!live) return
    if (pinned) {
      history = []
      viewOffset = 0
      frame = ''
      paint()
      return
    }
    // Erase the transient rows first: their absolute rows are about to go away.
    clearPending()
    clearActivity()
    stdout.write('\x1b[r\x1b[2J\x1b[3J\x1b[1;1H')
    history = []
    pending = ''
    viewOffset = 0
    frame = ''
    drawn = false
    regionSet = false
    trayRows = 0
    scrollBottom = 0
    lastRows = 0
    lastColumns = 0
    pendingDrawn = 0
    activityRow = undefined
    // The banner is not part of `history` (the caller printed it once), so it
    // has to be printed again before the first paint continues below it.
    const rows = terminalRows()
    const columns = terminalColumns()
    // The wipe replaced the screen *and* the scrollback, so the layout the tail
    // remembers has to be the wiped one. Leaving the pre-wipe `screenRows`/
    // `screenColumns` (or a `resizeDirty` raised by a SIGWINCH that arrived just
    // before the wipe) makes the next `reflow` diff the live size against a
    // screen that no longer exists: it can take the height-only branch, which
    // addresses the *old* tray rows (`oldTrayTop = screenRows - trayRows + 1`)
    // and erases above the new banner instead of replaying the screen, and a
    // stale `resizeDirty` forces a second full wipe of a screen that is already
    // clean. Recording the geometry that was actually painted is what the
    // `reflow` branch decision was always meant to compare against.
    screenRows = rows
    screenColumns = columns
    resizeDirty = false
    const header = headerBuilder?.() ?? ''
    const headerRows = header.length > 0 ? header.split('\n').length : 0
    if (header.length > 0) {
      stdout.write(`${header.split('\n').join('\r\n')}\r\n`)
    }
    outputRow = Math.min(rows, headerRows + 1)
    paint()
  }

  const reflow = (): void => {
    if (!live) return
    const columns = terminalColumns()
    const rows = terminalRows()
    if (pinned) {
      const changed = resizeDirty || screenRows === 0 || rows !== screenRows || columns !== screenColumns
      debugLog(`reflow pinned rows=${String(rows)} screenRows=${String(screenRows)} cols=${String(columns)} changed=${String(changed)} history=${String(history.length)} offset=${String(viewOffset)}`)
      if (!changed) return
      screenRows = rows
      screenColumns = columns
      resizeDirty = false
      renderPinned()
      return
    }
    // A height-only resize (a fullscreen toggle, a taller window) does not
    // invalidate a single wrapped row. Keep the screen and the terminal's
    // scrollback: clearing and replaying `history` here is what produced a
    // duplicate session, and `3J` is what left the terminal with nothing to
    // scroll at all. Only the docked tray moves.
    if (regionSet && screenRows !== 0 && rows !== screenRows && columns === screenColumns) {
      const oldRows = screenRows
      const oldTrayTop = oldRows - trayRows + 1
      debugLog(`reflow height-only rows=${String(rows)} old=${String(oldRows)} tray=${String(trayRows)} outputRow=${String(outputRow)}`)
      screenRows = rows
      resizeDirty = false
      lastRows = rows
      if (rows > oldRows) {
        // The old tray rows are above the new tray: erase them before docking.
        stdout.write(`\x1b[r\x1b[${String(Math.max(1, oldTrayTop))};1H\x1b[J`)
      } else {
        const delta = oldTrayTop - (rows - trayRows + 1)
        if (delta > 0) {
          stdout.write(`\x1b[${String(scrollBottom)};1H`)
          for (let index = 0; index < delta; index += 1) stdout.write('\n')
          outputRow = Math.max(1, outputRow - delta)
        }
        stdout.write('\x1b[r')
      }
      drawn = false
      regionSet = false
      trayRows = 0
      frame = ''
      lastColumns = 0
      paint()
      return
    }
    // A width change reflows every row; the only safe path is a fresh screen.
    // The viewport *and* the scrollback are cleared, because the transcript is
    // reprinted from `history`: keeping the previous screen in scrollback puts
    // a second banner and a second conversation there, and VS Code turns that
    // into a scrollbar that grows with every resize.
    // The decision is taken against the last *reflow* layout and any geometry a
    // SIGWINCH saw in this debounce window, never against `lastRows`: a paint
    // that won the race with the timer already updated that one.
    const changed = resizeDirty || screenRows === 0 || rows !== screenRows || columns !== screenColumns
    debugLog(
      `reflow rows=${String(rows)} screenRows=${String(screenRows)} cols=${String(columns)} screenCols=${String(screenColumns)} prevPaintRows=${String(lastRows)} changed=${String(changed)} dirty=${String(resizeDirty)} outputRow=${String(outputRow)} trayRows=${String(trayRows)} history=${String(history.length)}`,
    )
    if (!changed) return
    screenRows = rows
    screenColumns = columns
    resizeDirty = false
    stdout.write('\x1b[r\x1b[0m\x1b[?25h\x1b[2J\x1b[3J\x1b[1;1H')
    const header = headerBuilder?.() ?? ''
    const headerRows = header.length > 0 ? header.split('\n').length : 0
    if (header.length > 0) {
      stdout.write(`${header.split('\n').join('\r\n')}\r\n`)
    }
    outputRow = Math.min(rows, headerRows + 1)

    // Dock the tray at the bottom first, then replay what fits above it.
    drawn = false
    regionSet = false
    trayRows = 0
    frame = ''
    lastColumns = 0
    lastRows = 0
    pendingDrawn = 0
    activityRow = undefined
    paint()

    const block = composer?.layout(columns, statusText)
    const trayHeight = block?.lines.length ?? 1
    const bottom = Math.max(1, rows - Math.min(trayHeight, Math.max(1, rows - 3)))
    const room = Math.max(0, bottom - outputRow + 1 - 3)
    const kept: string[] = []
    let used = 0
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const line = history[index]!
      const lineHeight = lineRows(line, columns)
      if (used + lineHeight > room) break
      kept.unshift(line)
      used += lineHeight
    }
    if (kept.length > 0) writeRows(kept, false)
    paint()
    renderPending()
    renderActivity()
  }

  const erase = (): void => {
    if (!live) return
    if (pinned) {
      // Leaving the alternate screen restores the normal buffer (and whatever
      // was in it) byte for byte; nothing of ours was ever written there.
      leaveAppScreen()
      stdout.write('\x1b[r\x1b[0m\x1b[?25h\r')
      drawn = false
      regionSet = false
      trayRows = 0
      scrollBottom = 0
      frame = ''
      return
    }
    clearPending()
    clearActivity()
    stdout.write('\x1b[r')
    if (trayRows > 0) {
      const top = Math.max(1, terminalRows() - trayRows + 1)
      stdout.write(`\x1b[${String(top)};1H\x1b[J`)
    }
    drawn = false
    regionSet = false
    trayRows = 0
    scrollBottom = 0
    frame = ''
  }

  /**
   * Called on every SIGWINCH, before the debounce. A geometry change is recorded
   * here because by the time the timer fires a repaint may have updated
   * `lastRows`, and a fast grow-then-shrink burst may be back at the old size.
   */
  const observeResize = (): void => {
    if (!live || screenRows === 0) return
    if (terminalRows() !== screenRows || terminalColumns() !== screenColumns) resizeDirty = true
  }

  /**
   * Scroll the retained transcript. Only pinned mode owns a viewport; in the
   * default mode the terminal's own scrollback is the transcript and these keys
   * must pass through untouched.
   */
  const scroll = (kind: ScrollKind): boolean => {
    if (!pinned || !live || !altScreenActive) return false
    const rows = terminalRows()
    const body = Math.max(1, bodyHeight > 0 ? bodyHeight : rows - trayRows)
    const total = pinnedLines(terminalColumns()).length
    const max = Math.max(0, total - body)
    const page = Math.max(1, body - 2)
    const before = viewOffset
    switch (kind) {
      case 'lineUp': viewOffset = Math.min(max, viewOffset + 3); break
      case 'lineDown': viewOffset = Math.max(0, viewOffset - 3); break
      case 'pageUp': viewOffset = Math.min(max, viewOffset + page); break
      case 'pageDown': viewOffset = Math.max(0, viewOffset - page); break
      case 'top': viewOffset = max; break
      case 'bottom': viewOffset = 0; break
    }
    if (viewOffset === before) return false
    renderPinned()
    return true
  }

  const tail: Tail = {
    live,
    status,
    activity,
    stream,
    print,
    breakLine,
    flush,
    idle,
    repaint,
    clear,
    reflow,
    observeResize,
    scroll,
    setHeader(build) {
      headerBuilder = build
      if (pinned) {
        renderPinned()
        return
      }
      // The banner was already printed by the caller; continue after it.
      if (live && outputRow === 1) {
        const header = build()
        outputRow = Math.min(terminalRows(), header.split('\n').length + 1)
      }
    },
    erase,
    setComposer(next) {
      composer = next
      frame = ''
      paint()
    },
  }
  if (live) activeTail = tail
  return tail
}

/**
 * Turns `runGraph` events into progress lines.
 *
 * Every visible row goes through the tail: a progress line is a committed row,
 * streamed text stays in the tail until a newline arrives, and the spinner is
 * the transient activity row above the status.
 */
interface Progress {
  /**
   * Start the turn's plate. Full replaces it at the first assistant row or
   * `print`; compact/medium keep it until `settle`.
   */
  working(label: string): void
  /** Print one complete progress row, closing an open streamed line first. */
  print(line: string): void
  /** Write streamed model text without a prefix. */
  stream(text: string): void
  /** Feed one run event. */
  event(event: RunEvent): void
  /** Close the turn: terminal row, then the error and the step-limit hint. */
  settle(status: string, error: string | undefined): void
  /** Make sure the console is at column 0. */
  closeLine(): void
  /**
   * The session's child list changed (a delegation started or ended). Repaints
   * the transient "N subagents running" row; a no-op when nothing changed.
   */
  agentsChanged(): void
  /**
   * The turn that owns this progress is over (or never started painting). After
   * this the between-turns writer owns the child row, so a late
   * `agentsChanged()` (a background child settling between turns) must not
   * paint through a finished turn's plate.
   */
  finishTurn(): void
}

/**
 * One automated block from a settled child for the parent's next turn (2b).
 *
 * It is a `user`-role message on purpose: the transcript has no other role for
 * host-authored text, and it keeps the model's own assistant turns intact. The
 * body (`deliveredBlock`) is marked as subagent output, names the run, and
 * neutralises the child's text exactly like the 1.5c tool result, so a child
 * cannot forge a system or tool message through it.
 */
const deliveryMessage = (body: string): ChatMessage => ({ role: 'user', content: body })

/**
 * Take every settled background child that has not been delivered yet, oldest
 * first. The caller builds one block per entry and marks them delivered once the
 * turn has them in its seed.
 *
 * A running child is never taken (it has no answer), and a `wait: true` child
 * never is either (it already answered its launching call); `settledUndelivered`
 * filters both.
 */
const drainSettled = (agents: AgentRegistry): readonly AgentEntry[] => agents.settledUndelivered()


/**
 * Line-oriented Markdown for assistant text. Claude Code uses `marked` and a
 * token renderer; this is the terminal-sized subset that matters here: headings,
 * inline accents, lists, quotes, rules, fenced code and tables.
 *
 * It commits complete rows through `emit`, so streaming still works and the
 * tail/pinned renderer sees ordinary ANSI lines.
 */
interface MarkdownPrinter {
  push(text: string): void
  flush(): void
}

const createMarkdownPrinter = (emit: (line: string) => void): MarkdownPrinter => {
  let buffer = ''
  let inFence = false
  let fenceLang = ''
  let table: string[] = []
  let listIndent: number | undefined
  let lastBlank = false

  const blank = (): void => {
    if (lastBlank) return
    emit('')
    lastBlank = true
  }

  const write = (line: string): void => {
    emit(line)
    lastBlank = line === ''
  }

  const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\n]+\*|_[^_\n]+_)/g
  const inline = (text: string): string =>
    text.replace(INLINE, (token) => {
      if (token.startsWith('`')) return cyan(token.slice(1, -1))
      if (token.startsWith('**') || token.startsWith('__')) return bold(token.slice(2, -2))
      if (token.startsWith('~~')) return paint('9', token.slice(2, -2))
      if (token.startsWith('[')) {
        const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
        if (match !== null) return `${bold(match[1]!)} ${dim(`(${match[2]!})`)}`
      }
      return italic(token.slice(1, -1))
    })

  const cellText = (text: string): string => inline(text.trim())

  const pad = (text: string, width: number, align: 'left' | 'right' | 'center'): string => {
    const size = displayCells(text)
    const gap = width - size
    if (gap <= 0) return text
    if (align === 'right') return `${' '.repeat(gap)}${text}`
    if (align === 'center') {
      const left = Math.floor(gap / 2)
      return `${' '.repeat(left)}${text}${' '.repeat(gap - left)}`
    }
    return `${text}${' '.repeat(gap)}`
  }

  const tableRows = (raw: readonly string[]): string[][] => {
    const rows = raw.map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    return rows
  }

  const flushTable = (): void => {
    if (table.length === 0) return
    const raw = table
    table = []
    const rows = tableRows(raw)
    const separator = rows.findIndex((cells, index) => index > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell)))
    if (separator < 1) {
      for (const line of raw) write(cellText(line))
      return
    }
    const header = rows[0]!
    const body = rows.slice(separator + 1)
    const columns = Math.max(header.length, ...body.map((row) => row.length))
    if (columns === 0) return
    const cells = [header, ...body].map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? ''))
    const widths = Array.from({ length: columns }, (_, index) =>
      Math.max(3, ...cells.map((row) => displayCells(cellText(row[index]!)))),
    )
    const total = widths.reduce((sum, width) => sum + width + 3, 0) + 1
    if (total > terminalColumns() - 2) {
      // Claude Code falls back to a vertical key/value list when the table
      // cannot fit; it stays readable on a narrow terminal.
      blank()
      body.forEach((row, rowIndex) => {
        for (let index = 0; index < columns; index += 1) {
          const label = header[index] || `col ${String(index + 1)}`
          write(`${bold(label)}: ${cellText(row[index] ?? '')}`)
        }
        if (rowIndex < body.length - 1) write(dim('─'.repeat(Math.min(40, terminalColumns()))))
      })
      blank()
      return
    }
    const rule = (left: string, middle: string, right: string): string =>
      dim(`${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`)
    const rowLine = (row: readonly string[], aligns: readonly ('left' | 'right' | 'center')[]): string =>
      `${dim('│')} ${row.map((cell, index) => pad(cellText(cell), widths[index]!, aligns[index] ?? 'left')).join(` ${dim('│')} `)} ${dim('│')}`
    const numeric = Array.from({ length: columns }, (_, index) =>
      body.length > 0 && body.every((row) => /^-?[\d.,%]+$/.test((row[index] ?? '').trim())),
    )
    blank()
    write(rule('┌', '┬', '┐'))
    write(rowLine(header, Array.from({ length: columns }, () => 'center' as const)))
    write(rule('├', '┼', '┤'))
    const shown = body.slice(0, 200)
    for (const row of shown) {
      write(rowLine(row, numeric.map((value) => (value ? 'right' : 'left')) as ('left' | 'right')[]))
    }
    write(rule('└', '┴', '┘'))
    if (body.length > shown.length) write(dim(`… ${String(body.length - shown.length)} more rows`))
    blank()
  }

  const handle = (raw: string): void => {
    const line = raw.replace(/\r$/, '')
    const fence = /^\s*```\s*([^\s]*)\s*$/.exec(line)
    if (fence !== null) {
      if (!inFence) {
        if (table.length > 0) flushTable()
        inFence = true
        fenceLang = fence[1] ?? ''
        blank()
        write(dim(`┌ ${fenceLang.length > 0 ? fenceLang : 'code'}`))
      } else {
        write(dim('└'))
        inFence = false
        fenceLang = ''
        blank()
      }
      return
    }
    if (inFence) {
      write(`${dim('▏')} ${line.length > 0 ? cyan(line) : ''}`)
      return
    }
    if (line.trim().startsWith('|')) {
      table.push(line)
      return
    }
    if (table.length > 0) flushTable()

    if (line.trim() === '') {
      listIndent = undefined
      blank()
      return
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      const depth = heading[1]!.length
      const text = inline(heading[2]!)
      blank()
      write(depth === 1 ? bold(underline(text)) : depth === 2 ? bold(text) : bold(cyan(text)))
      blank()
      listIndent = undefined
      return
    }
    if (/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      blank()
      write(dim('─'.repeat(Math.min(40, terminalColumns()))))
      blank()
      listIndent = undefined
      return
    }
    if (/^\s*>/.test(line)) {
      const text = line.replace(/^\s*(>\s*)+/, '')
      write(`${dim('▏')} ${paint('2;3', inline(text))}`)
      listIndent = undefined
      return
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (list !== null) {
      const indent = Math.min(6, Math.floor(list[1]!.length / 2))
      const marker = /^[-*+]$/.test(list[2]!) ? '•' : list[2]!
      write(`${'  '.repeat(indent)}${dim(marker)} ${inline(list[3]!)}`)
      listIndent = indent
      return
    }
    if (listIndent !== undefined && /^\s+/.test(line)) {
      write(`${'  '.repeat(listIndent + 1)}${inline(line.trim())}`)
      return
    }
    listIndent = undefined
    write(inline(line))
  }

  return {
    push(text: string): void {
      if (text.length === 0) return
      buffer += text
      for (;;) {
        const cut = buffer.indexOf('\n')
        if (cut < 0) break
        const line = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 1)
        handle(line)
      }
    },
    flush(): void {
      if (inFence) {
        write(dim('└'))
        inFence = false
        fenceLang = ''
      }
      if (table.length > 0) flushTable()
      if (buffer.length > 0) {
        handle(buffer)
        buffer = ''
      }
      listIndent = undefined
    },
  }
}

/**
 * The adapter: map the SDK's graph events to `ViewEvent`, apply the pure
 * formatter's actions, and keep the tail/markdown/spinner mechanics here.
 *
 * Full mode keeps today's spinner lifetime (stop at the first assistant row and
 * on every `print`); compact and medium keep one plate for the whole turn and
 * clear it in `settle`. Event-driven rows flush markdown before they print;
 * rows produced from inside `emit` print raw, because flushing there recurses.
 */
const createProgress = (tail: Tail, mode: ViewMode): Progress => {
  const state = createViewState(mode, Date.now())
  let spinner: NodeJS.Timeout | undefined
  // The spinner alternates a bright and a dim glyph rather than moving a
  // frame: one steady mark that pulses is calmer than a rotating one at the
  // bottom of a screen the reader is trying to read. `∴` is the "therefore"
  // mark, the same one the reference CLIs use for a model that is thinking -
  // distinct from the `⬢` of a finished block and the `⬡` of an interruption.
  const frames = [paint('0', '∴'), dim('∴')]
  let frame = 0

  const ctx = (): ViewContext => ({ columns: terminalColumns(), now: Date.now(), tty: tail.live, theme: viewTheme })

  const stopSpinner = (): void => {
    if (spinner === undefined) return
    clearInterval(spinner)
    spinner = undefined
    tail.activity(undefined)
  }

  const renderPlate = (): void => {
    const label = viewActivity(state, ctx())
    // The child row is not a spinner: it stays while any child runs and is a
    // plain sentence (`◷ 2 subagents running · /agents`), appended under the
    // plate when there is one. Both writers compose it with `childStatusRow`,
    // so the plate and the between-turns row cannot disagree. Reusing
    // `tail.activity()` is the whole point.
    // A live child is a state, so this row carries the state hue (green) while
    // everything else in the plate stays dim.
    const children = childStatusRow({ running: runningChildren })
    const childRow = children === undefined ? undefined : green(children)
    if (label === undefined) {
      tail.activity(childRow)
      return
    }
    tail.activity(childRow === undefined ? `${frames[frame]} ${dim(label)}` : `${frames[frame]} ${dim(label)}\n${childRow}`)
  }

  const working = (label: string): void => {
    stopSpinner()
    // A new turn takes the child row back from the between-turns writer: in
    // compact/medium the plate is the painter from here on.
    if (mode !== 'full' && tail.live) turnPainter = renderPlate
    if (mode === 'full') {
      if (!tail.live) {
        // No cursor tricks without the tail: the label is just a line.
        tail.print(`${frames[0]} ${label}`)
        return
      }
      tail.activity(`${frames[0]} ${dim(label)}`)
      spinner = setInterval(() => {
        frame = (frame + 1) % frames.length
        tail.activity(`${frames[frame]} ${dim(label)}`)
      }, 220)
      spinner.unref?.()
      return
    }
    // Compact/medium: the plate is the turn's only status, so it lives until
    // settle. Without a tail there is nowhere to draw it.
    if (!tail.live) return
    turnPainter = renderPlate
    renderPlate()
    spinner = setInterval(() => {
      frame = (frame + 1) % frames.length
      renderPlate()
    }, 220)
    spinner.unref?.()
  }

  let markdown: MarkdownPrinter | undefined

  let assistantStarted = false
  /**
   * A tool row has been printed since the last assistant text. The next
   * assistant block then gets one blank row above it, which is what separates
   * "what the model said" from "what it did" - without it a tool result and the
   * prose after it read as one paragraph.
   */
  let toolRowPrinted = false

  /**
   * Apply formatter actions. Raw actions come from inside `emit`, where calling
   * `markdown.flush()` would re-enter the printer; everything else flushes the
   * open markdown row first so a group line cannot jump ahead of its text.
   */
  const apply = (actions: readonly ViewAction[], raw: boolean): void => {
    for (const action of actions) {
      if (action.type === 'activity') {
        tail.activity(action.text)
        continue
      }
      if (!raw) markdown?.flush()
      // A committed view row is a tool row for the purpose of block spacing:
      // the next assistant block must not butt against it.
      if (stripAnsi(action.text).trim().length > 0) toolRowPrinted = true
      tail.print(action.text)
    }
  }

  /**
   * Event-driven rows. Full mode keeps today's rule that any committed tool row
   * replaces the spinner; compact/medium must keep the plate alive.
   */
  const applyEvent = (actions: readonly ViewAction[]): void => {
    if (mode === 'full' && actions.some((action) => action.type === 'line')) stopSpinner()
    apply(actions, true)
  }

  const emit = (line: string): void => {
    if (!assistantStarted && stripAnsi(line).trim() === '') return
    apply(viewTextStart(state, ctx()), true)
    if (!assistantStarted) {
      if (mode === 'full' && spinner !== undefined) stopSpinner()
      assistantStarted = true
      if (toolRowPrinted) {
        tail.print('')
        toolRowPrinted = false
      }
      tail.print(`${bold('⬢')} ${line}`)
    } else {
      tail.print(line)
    }
  }
  markdown = createMarkdownPrinter(emit)

  const print = (line: string): void => {
    markdown?.flush()
    if (mode === 'full') stopSpinner()
    apply(viewNotice(state, ctx()), false)
    // A view line is a tool row for the purpose of block spacing: the next
    // assistant block must not butt against it.
    if (stripAnsi(line).trim().length > 0) toolRowPrinted = true
    tail.print(line)
  }

  const stream = (text: string): void => {
    if (text.length === 0) return
    markdown?.push(text)
  }

  const closeLine = (): void => {
    markdown?.flush()
    stopSpinner()
    tail.breakLine()
  }

  const event = (incoming: RunEvent): void => {
    switch (incoming.type) {
      // One `· step N` per loop iteration: `loop/<n>/chat` is the model call.
      case 'node.started': {
        // A new model turn starts a new `⬢` block. The turn number itself is
        // not shown: the tool lines already mark progress.
        if (!/^loop\/\d+\/chat$/.test(incoming.path)) return
        markdown?.flush()
        assistantStarted = false
        // The previous block may have ended without a newline.
        tail.breakLine()
        return
      }
      // Only the model's text port is user-visible; every other port is data.
      case 'node.stream': {
        if (incoming.port !== 'text' || !incoming.path.endsWith('/chat')) return
        if (typeof incoming.chunk !== 'string' || incoming.chunk.length === 0) return
        stream(incoming.chunk)
        return
      }
      case 'node.completed': {
        // `mapInput` exposes the assistant's call: name plus the raw arguments.
        const input = /^(loop\/\d+\/toolMap\/\d+)\/mapInput$/.exec(incoming.path)
        if (input !== null) {
          markdown?.flush()
          const value = incoming.outputs['value'] as { item?: { name?: unknown; arguments?: unknown } } | undefined
          const item = value?.item ?? {}
          const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : 'tool'
          const args = compactArgs(item.arguments)
          applyEvent(viewEvent(state, { type: 'tool.start', path: input[1] as string, name, args }, ctx()))
          return
        }
        // `mapCall` publishes the tool result; `isError` picks the symbol.
        const call = /^(loop\/\d+\/toolMap\/\d+)\/mapCall$/.exec(incoming.path)
        if (call !== null) {
          markdown?.flush()
          const result = incoming.outputs['result']
          const ok = incoming.outputs['isError'] !== true
          // One compact row per delegation. A background launch (2b) is not an
          // outcome: its row reads `started · /agents` and carries no duration
          // and no payload. A `wait: true` call keeps the v1 ✓/✗ row.
          const started = state.calls.get(call[1] as string)
          const launched =
            started?.name === SUBAGENT_TOOL_NAME &&
            typeof result === 'object' &&
            result !== null &&
            (result as { status?: unknown }).status === 'running'
          const runId = (result as { runId?: unknown } | undefined)?.runId
          const hint =
            started?.name === SUBAGENT_TOOL_NAME && typeof runId === 'string'
              ? `agents ${shortRunId(runId)}`
              : undefined
          applyEvent(
            viewEvent(
              state,
              {
                type: 'tool.end',
                path: call[1] as string,
                ok,
                ...(ok ? {} : { error: errorText(result) }),
                durationMs: incoming.durationMs,
                size: resultSize(result),
                result,
                ...(hint === undefined ? {} : { hint }),
                ...(launched ? { started: true } : {}),
              },
              ctx(),
            ),
          )
          return
        }
        return
      }
      case 'node.failed': {
        markdown?.flush()
        applyEvent(viewEvent(state, { type: 'node.failed', path: incoming.path, error: incoming.error }, ctx()))
        return
      }
      case 'run.failed': {
        applyEvent(viewEvent(state, { type: 'run.failed', error: incoming.error }, ctx()))
        return
      }
      default:
        return
    }
  }

  const settle = (status: string, error: string | undefined): void => {
    // Old code preferred the settle error over a stored `run.failed` one.
    if (error !== undefined) state.runError = error
    stopSpinner()
    markdown?.flush()
    apply(viewSettle(state, status, ctx()), true)
  }

  /**
   * Children started, stepped or finished. While the plate is live it owns the
   * row and repaints; otherwise (`full`, a pipe, or a settled turn) the
   * between-turns writer does, because a background child outlives its turn.
   */
  const agentsChanged = (): void => {
    repaintChildren()
  }

  /**
   * The turn is over: hand the child row to the between-turns writer. Called
   * after `settle`, so a finished turn does not leave the plate's row behind
   * and a background child that is still live keeps being shown.
   */
  const finishTurn = (): void => {
    turnPainter = undefined
    idleTail?.activity(childIdleRow())
  }

  return { working, print, stream, event, settle, closeLine, agentsChanged, finishTurn }
}

/** Abort channel of the turn that is currently running, if any. */
let activeAbort: AbortController | undefined

/**
 * The transient child row (`◷ 2 subagents running · /agents`) has two writers
 * (2b) and they must never fight:
 *
 * - the turn's plate, while a turn runs in compact/medium (its spinner is the
 *   turn's status) - `turnPainter` is that plate's `renderPlate`;
 * - the between-turns writer: a background child outlives its turn, so the row
 *   has to survive `settle()` and be repainted when a child starts or ends
 *   between prompts - `idleTail` is the tail and `childIdleRow()` the row.
 *
 * Both compose the row with `childStatusRow`, so they cannot disagree, and
 * `childrenChanged` is the one entry point that decides who paints.
 */
let runningChildren = 0
let turnPainter: (() => void) | undefined
let idleTail: Tail | undefined

/**
 * Mirror the registry's running count and repaint whichever writer owns the
 * row. Called from the delegation hooks (launch, step, settle) and from the
 * command handlers, so a child started between turns appears at once.
 */
const childrenChanged = (agents: AgentRegistry): void => {
  runningChildren = agents.running().length
  // An open `/agents` overlay is a live view: a child that starts, steps or
  // settles while it is on screen repaints in place (2b, and the reason the
  // overlay exists: it is opened *while* a turn runs).
  if (activeComposer?.agentsMenuOpen === true) activeComposer.refreshAgentsMenu()
  repaintChildren()
}

/** Repaint with the count already in sync (the settle path has no registry call). */
const repaintChildren = (): void => {
  if (turnPainter !== undefined) {
    turnPainter()
    return
  }
  idleTail?.activity(childIdleRow())
}

/** The row while no turn runs; `undefined` to clear it. Green: a live state. */
const childIdleRow = (): string | undefined => {
  const row = childStatusRow({ running: runningChildren })
  return row === undefined ? undefined : green(row)
}

let closed = false
/** Lines typed while a turn is running: Claude Code queues them, so does z1. */
const pendingLines: string[] = []
let lineWaiter: ((line: string) => void) | undefined
let activeComposer: Composer | undefined

/**
 * The automated turn for a settled background child (2b). The decision lives
 * in `auto-delivery.ts`; this block is only the mutable state around it.
 */
const AUTO_DELIVERY_LINE = AUTOMATED_DELIVERY_LINE
/** One automated turn waiting at most: several settles coalesce into it. */
let autoDeliveryQueued = false
/** A child settled while a turn ran; the turn's own drain could not see it yet. */
let settleArrivedDuringTurn = false
/** A turn owns the transcript right now: a settle during it must be deferred. */
let turnActive = false
/**
 * `interactive()` only: a one-shot has no next turn to deliver into, so its
 * settle policy stays `once-policy.ts` and never queues a sentinel line.
 */
let autoDeliveryEnabled = false

const deliverLine = (line: string): void => {
  const waiter = lineWaiter
  if (waiter !== undefined) {
    lineWaiter = undefined
    waiter(line)
    return
  }
  pendingLines.push(line)
}

/**
 * A background child settled (2b): wake an automated delivery turn, or defer it
 * to the end of the turn that is running.
 */
const wakeForSettledChild = (): void => {
  const signal = settleSignal({
    enabled: autoDeliveryEnabled,
    closed,
    turnActive,
    queued: autoDeliveryQueued,
  })
  if (signal === 'ignore') return
  if (signal === 'defer') {
    settleArrivedDuringTurn = true
    return
  }
  settleArrivedDuringTurn = false
  autoDeliveryQueued = true
  deliverLine(AUTO_DELIVERY_LINE)
}

/**
 * The top of the loop: a settle deferred from the previous turn (`runTurn`'s
 * seed already existed) is delivered now, before the prompt waits for input
 * the user may never type.
 */
const wakeDeferredSettle = (): void => {
  const signal = afterTurnSignal({
    enabled: autoDeliveryEnabled,
    closed,
    turnActive,
    queued: autoDeliveryQueued,
    deferred: settleArrivedDuringTurn,
  })
  if (signal !== 'wake') return
  settleArrivedDuringTurn = false
  autoDeliveryQueued = true
  deliverLine(AUTO_DELIVERY_LINE)
}

// A pipe (or the no-tray fallback) keeps readline: it is the right tool there,
// and it emits no escape sequences at all.
const rl = useComposer
  ? undefined
  : createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) && Boolean(stdout.isTTY) })

rl?.on('line', (line) => {
  deliverLine(line)
})
rl?.on('close', () => {
  closed = true
  if (lineWaiter !== undefined) {
    const waiter = lineWaiter
    lineWaiter = undefined
    waiter('')
  }
})
// A process-level handler, not readline's: readline only emits SIGINT for a
// terminal stdin, and Ctrl-C must cancel a run in a pipe too. In composer mode
// raw input delivers Ctrl-C as a byte, so this only fires for a pipe.
process.on('SIGINT', () => {
  if (activeAbort !== undefined) {
    activeAbort.abort()
    return
  }
  restoreTerminal()
  rl?.close()
  activeComposer?.close()
  closed = true
  if (lineWaiter !== undefined) {
    const waiter = lineWaiter
    lineWaiter = undefined
    waiter('')
  }
})

// Every exit path must give the terminal back: a crash that leaves the cursor
// hidden or SGR dim is as broken as a leftover scroll region.
process.on('exit', () => {
  restoreTerminal()
})
process.on('SIGTERM', () => {
  restoreTerminal()
  process.exit(130)
})
process.on('SIGHUP', () => {
  restoreTerminal()
  process.exit(130)
})
process.on('uncaughtException', (error) => {
  restoreTerminal()
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  restoreTerminal()
  console.error(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
  process.exit(1)
})

const nextLine = (prompt: string): Promise<string> => {
  const queued = pendingLines.shift()
  if (queued !== undefined) return Promise.resolve(queued)
  if (closed) return Promise.resolve('')
  if (activeComposer !== undefined) {
    // The composer already draws the prompt box and the footer hint.
    return new Promise(resolve => { lineWaiter = resolve })
  }
  if (rl !== undefined && rl.terminal) {
    // Readline owns the prompt text, its echo and its cursor arithmetic; the
    // app writes nothing else until this line resolves.
    rl.setPrompt(prompt)
    rl.prompt()
  } else {
    stdout.write(prompt)
  }
  return new Promise(resolve => { lineWaiter = resolve })
}

/**
 * Parse `provider/model` — the one place a model reference becomes a handle.
 *
 * A reference without a provider is rejected instead of guessed: the old
 * fallback turned `Z1_MODEL=gpt-4.1` into `mock/gpt-4.1`, so the console
 * answered from the in-process mock and the reply looked real. Every built-in
 * default contains a slash, so this can only fail on user input.
 */
const parseModelRef = (raw: string): { ok: true; model: ModelHandle } | { ok: false; error: string } => {
  const value = raw.trim()
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) {
    return { ok: false, error: `model must be provider/model, got "${raw.trim()}"` }
  }
  return { ok: true, model: { provider: value.slice(0, slash), model: value.slice(slash + 1) } }
}

/** The model for this process: `--model`, then `Z1_MODEL`, then the defaults. */
const startModel = (explicit: string | undefined): ModelHandle => {
  const flag = explicit?.trim()
  if (flag !== undefined && flag.length > 0) {
    const parsed = parseModelRef(flag)
    if (!parsed.ok) {
      console.error(`chat: --model: ${parsed.error}`)
      process.exit(2)
    }
    return parsed.model
  }
  const fromEnv = process.env['Z1_MODEL']?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const parsed = parseModelRef(fromEnv)
    if (!parsed.ok) {
      // An explicitly requested model must never silently become the mock.
      console.error(`chat: Z1_MODEL: ${parsed.error}`)
      process.exit(2)
    }
    return parsed.model
  }
  const fallback = process.env['RIVER_API_KEY']
    ? 'river/deepseek-ai/DeepSeek-V4.1-Flash'
    : process.env['OPENAI_API_KEY']
      ? 'openai/gpt-4.1-mini'
      : 'mock/mock-1'
  const parsed = parseModelRef(fallback)
  if (!parsed.ok) {
    console.error(`chat: ${parsed.error}`)
    process.exit(2)
  }
  return parsed.model
}

const modelLabel = (model: ModelHandle): string => `${model.provider}/${model.model}`

/**
 * `z1.flow.loop.maxIterations` is an integer capped at 10 000 by its schema, so
 * the graph cannot express "no limit". That ceiling is the practical one: a
 * single user turn that reaches it is a runaway, not a long task.
 */
const STEP_CEILING = 10_000

/**
 * Whether an append/reload failed because the session id no longer exists on
 * disk. The store reports that as a plain `Error` (`session: unknown session
 * <id>`) rather than a class, so the message is the only handle there is — and
 * it is the one failure that must drop the live handle instead of being
 * reported per turn.
 */
const isUnknownSessionError = (error: unknown): boolean =>
  error instanceof Error && /unknown session/.test(error.message)

/** `off`, `0` or an empty value all mean the ceiling. */
const stepLimit = (raw: string | undefined): number => {
  const value = Number(raw ?? '')
  if (!Number.isFinite(value) || value <= 0) return STEP_CEILING
  return Math.min(STEP_CEILING, Math.floor(value))
}

const stepLabel = (value: number): string =>
  value >= STEP_CEILING ? 'unlimited' : String(value)

const COMMANDS: readonly CommandSpec[] = [
  { name: '/help', description: 'show this help' },
  { name: '/new', description: 'start a fresh conversation' },
  { name: '/clear', description: 'empty this conversation, keep the session' },
  {
    name: '/model',
    description: 'switch the model',
    args: '<provider/model>',
    usage: '/model provider/model',
  },
  // No `args` here: Enter on a bare `/tools` must run the picker, not
  // complete. The sub-grammar lives in `handleTools`; `/help` spells it out.
  {
    name: '/tools',
    description: 'tool picker; on/off/delete/restore <n|name>',
    usage: '/tools [on|off|delete|restore|reset] <n|name> | /tools refresh | /tools --all',
    rest: true,
    help: ['reset · refresh · --all (all also shows stale entries)'],
  },
  { name: '/context', description: 'show context usage' },
  // Same shape as `/sessions`: no `args`, so Enter on a bare `/agents` lists
  // instead of completing. `handleAgents` parses `<n|runId>` and the verbs.
  {
    name: '/agents',
    description: 'background subagents; list them, open one, or stop one',
    usage: '/agents [<n|runId> | stop|x <n|runId>]',
    rest: true,
    help: [
      'a subagent call runs in the background by default; `wait: true` blocks',
      'bare opens the agents picker (↑↓ · ⏎ transcript · x stop · esc), even mid-turn;',
      '  without a terminal it prints the list: running first, then finished',
      '<n> or <runId> opens its transcript (read-only)',
      'stop <n|runId> (or x <n|runId>) cancels a running child',
    ],
  },
  // Same shape as `/tools`: no `args`, so Enter on a bare `/sessions` lists
  // instead of completing. `handleSessions` parses the sub-grammar.
  {
    name: '/sessions',
    description: 'list, switch, rename, delete, archive',
    usage:
      '/sessions [--all | new [name] | <n|id|prefix> | rename <n|id> <name> | delete <n|id> | archive <n|id> | unarchive <n|id>]',
    rest: true,
    help: [
      'bare lists the project’s sessions · a number switches',
      'new · rename · delete (asks) · archive · unarchive · --all',
    ],
  },
  { name: '/compact', description: 'compact the next turn' },
  // Same shape as `/tools`: no `args`, so Enter runs the bare status instead of
  // completing. `handleWeb` (a plain handler) parses the three verbs.
  {
    name: '/web',
    description: 'web search backend (SearXNG)',
    usage: '/web [status|start|down]',
    rest: true,
    help: ['bare is status · start (installs on first use) · down'],
  },
  {
    name: '/window',
    description: 'set the context window',
    args: '<tokens>',
    usage: '/window <tokens>, e.g. /window 200000',
  },
  {
    name: '/steps',
    description: 'set the step limit',
    args: '<n|off>',
    usage: '/steps <n> | /steps off',
  },
  // No `args`: Enter on a bare `/view` opens the picker, not a completion.
  {
    name: '/view',
    description: 'tool activity density: compact, medium or full',
    usage: '/view [compact|medium|full]',
    rest: true,
    help: [
      'bare opens the picker (numbered list in a pipe)',
      'compact hides tool lines · medium groups them · full is today’s transcript',
      'c | m | f also parse · 1 | 2 | 3 picks a row',
    ],
  },
  { name: '/exit', description: 'quit z1' },
  { name: '/quit', description: 'quit z1 (same as /exit)' },
]

/** The spec behind a name; dispatch and usage text both start here. */
const commandSpec = (name: string): CommandSpec | undefined =>
  COMMANDS.find((command) => command.name === name)

/**
 * Whether the spec's shape allows these arguments: a command with no `args` and
 * no `rest` takes none (`/exit now` is a shape error), and a bare call is always
 * a shape that reaches its handler so the usage text lives once, in the table.
 */
const shapeAllows = (spec: CommandSpec | undefined, rest: string): boolean =>
  rest === '' || spec?.args !== undefined || spec?.rest === true

/** The body of `usage: …` for a known command, written only in the table. */
const usageText = (name: string): string => {
  const spec = commandSpec(name)
  if (spec === undefined) return name
  return spec.usage ?? (spec.args === undefined ? spec.name : `${spec.name} ${spec.args}`)
}

const printHelp = (print: (line?: string) => void): void => {
  print('')
  for (const command of COMMANDS) {
    const label = command.args === undefined ? command.name : `${command.name} ${command.args}`
    print(`  ${label.padEnd(24)} ${dim(command.description)}`)
    for (const extra of command.help ?? []) print(`${' '.repeat(26)}${dim(extra)}`)
  }
  print(`\n  ${dim('Type / for the menu; Ctrl-D also exits.')}\n`)
}

/** Prompt for a y/N decision; `--once` has no terminal, so it always rejects. */
const consoleApproval = (ask: (question: string) => Promise<string>): ApprovalService => ({
  async request(request) {
    const detail = request.target ? ` ${request.target}` : ''
    const answer = await ask(`approve ${request.action}${detail}? [y/n]`)
    return answer.trim().toLowerCase().startsWith('y') ? 'allowed-once' : 'rejected'
  },
})

const quietApproval = (progress: Progress): ApprovalService => ({
  async request(request) {
    const detail = request.target ? ` ${request.target}` : ''
    progress.print(`· approval · ${request.action}${detail} · rejected (no terminal in --once)`)
    return 'rejected'
  },
})

interface TurnContext {
  tokens: number
  window: number
  ratio: number
  compactedTurns: number
}

interface TurnResult {
  status: string
  output: string
  error: string | undefined
  history: ChatMessage[]
  /** The journal run this turn wrote; links the session turn to its provenance. */
  runId: string
  context?: TurnContext
}

/**
 * `/compact`: add a body-only override so the budget reports `over` on the next
 * turn, even when the transcript is small.
 *
 * The window is derived from the last observed token count, so one compaction
 * brings the transcript back under the threshold instead of thrashing on every
 * iteration.
 */
const forceCompaction = (graph: unknown, tokens: number): unknown => {
  const clone = structuredClone(graph) as MutableGraph
  const loop = clone.nodes.find(node => node['type'] === 'z1.flow.loop')
  const config = loop?.['config'] as Record<string, unknown> | undefined
  const body = config?.['body'] as MutableGraph | undefined
  if (!Array.isArray(body?.nodes)) return graph
  const budget = body.nodes.find(node => node['id'] === 'budget')
  if (budget === undefined) return graph
  const reserve = 16_384
  const measured = Math.max(1, tokens)
  const window = Math.max(reserve + 2, Math.floor(measured / 0.85) + reserve + 1)
  budget['config'] = { ...(budget['config'] as Record<string, unknown> | undefined), contextWindow: window }
  return clone
}

/** `12345` → `12.3k`; the console line stays short. */
const formatTokens = (value: number): string =>
  value < 1000 ? String(Math.round(value)) : `${(value / 1000).toFixed(1)}k`

/**
 * One user prompt: print `· working`, run the agent graph while reporting every
 * progress event, then keep the transcript for the next turn.
 */
const runTurn = async (
  runtime: Runtime,
  handle: RunHandle,
  model: ModelHandle,
  history: readonly ChatMessage[],
  prompt: string,
  progress: Progress,
  options: {
    forceCompact?: boolean
    lastTokens?: number
    maxSteps?: number
    contextWindow?: number
    /** The session's snapshot; created from the run handle when absent. */
    toolState?: ToolStore
    /** The workspace the tools run in; the prompt names paths relative to it. */
    cwd?: string
    /** The store's absolute root, when one is known for this process. */
    sessionRoot?: string
    /** This chat's own identity, so the prompt can answer "what session is this?". */
    session?: { name: string; messageCount: number }
    /**
     * This session's children, for `/agents`. Observation only: the registry
     * counts steps and remembers outcomes; it never touches the grant, the
     * budget or the approvals.
     */
    agents?: AgentRegistry
    /** `/view` mode; decides how much of a delivered child reaches the screen. */
    viewMode?: ViewMode
  } = {},
): Promise<TurnResult> => {
  const maxSteps = options.maxSteps ?? stepLimit(process.env['Z1_MAX_STEPS'])
  const contextWindow =
    options.contextWindow ?? (Number(process.env['Z1_CONTEXT_WINDOW'] ?? '128000') || 128_000)
  // 2b: children this turn launched, even ones that already finished. The
  // closing row reads this, not the live count, so a fast child (it can settle
  // before the turn closes) still gets an honest line instead of "nothing ran".
  const launchedThisTurn: string[] = []
  // `/view` decides how much of a delivered child is printed. The *seed* never
  // changes with it: the model always gets the full block.
  const dashMode: ViewMode = options.viewMode ?? 'medium'

  // One inventory read for the whole turn. The prompt, the wire `tools` array
  // and the guarded service all come from this snapshot, so they cannot
  // disagree — not even when another session edits the overlay mid-turn.
  const tools =
    options.toolState ??
    new ToolStore(() => handle.services.tools.list(), [subagentToolSchema])
  const snapshot = await tools.reload(() => handle.services.tools.list())
  const enabledSchemas = snapshot.enabledSchemas
  if (!snapshot.inventoryKnown) {
    // Reported in the prompt as "inventory unknown" rather than "no tools".
    debugLog(`tool inventory unavailable: ${snapshot.listError ?? 'unknown error'}`)
  }

  // The turn's cancellation channel. It is created before the delegation
  // tool so the child runner receives this very signal: Ctrl-C/Escape aborts
  // the parent turn and its `wait: true` child together (`cancelled`, not a
  // 240 s timeout with nobody waiting). A *background* child gets its own
  // controller inside `@z1/subagent` (`onBackground` → `launch.cancel`) and is
  // deliberately not wired to this one: it outlives its turn (2b).
  const controller = new AbortController()

  // The delegation tool is rebuilt every turn with a trustworthy snapshot:
  // the ceiling is the `/tools`-enabled module set, child approvals are deny,
  // and the call-only guard re-reads the overlay per child tool call. The
  // parent `guard` stays outermost so `/tools off subagent` also revokes the
  // composite name before a child can start.
  const guardCall = tools.guardCall()
  // This turn's children (2b). Every launch goes through the session registry,
  // which is also what the next turn delivers and `/exit` stops.
  const agents = options.agents
  // 2b delivery: a background child's output reaches the parent here, once, at
  // the start of a turn - never mid-turn, never as the launching call's tool
  // result. Only children settled *before* this point are drained, so a child
  // that finishes while this turn runs waits for the next one.
  const delivered = agents === undefined ? [] : drainSettled(agents)
  const historyWithDelivery: readonly ChatMessage[] =
    delivered.length === 0
      ? history
      : [...history, ...delivered.map((entry) => deliveryMessage(deliveredBlock({ entry, elapsedMs: entryElapsed(entry, Date.now()) })))]
  const composedTools = snapshot.inventoryKnown
    ? await composeSubagentService({
        runtime,
        model: model as import('./sdk.ts').ModelHandle,
        parent: handle.services.tools,
        snapshot,
        guardCall,
        signal: controller.signal,
        contextWindow,
        ...(agents === undefined
          ? {}
          : {
              onStart: (start: {
                runId: string
                description: string
                mode?: 'background' | 'wait'
              }) => {
                agents.start({
                  runId: start.runId,
                  description: start.description,
                  ...(start.mode === undefined ? {} : { mode: start.mode }),
                })
                childrenChanged(agents)
              },
              onEvent: (runId: string, event: RunEvent) => {
                agents.observe(runId, event)
                // A step is a live count in `/agents`; repaint so the status
                // row and any open list stay honest while the child works.
                if (event.type === 'node.started') childrenChanged(agents)
              },
              onBackground: (launch: SubagentLaunch) => {
                // The row exists from `onStart`; the handle adds `cancel()` and
                // the lifetime promise `/exit` waits on. Ownership is the
                // session registry's: every child, background or `wait`, is
                // recorded here and nowhere else. A turn owns nothing, which is
                // why this entry - and its cancel/lifetime promise - survives
                // the turn that launched it (`handle.dispose()` never touches
                // it); `/exit` and the `--once` policy are what end them.
                launchedThisTurn.push(launch.result.runId)
                agents.start({
                  runId: launch.result.runId,
                  mode: 'background',
                  cancel: (reason?: unknown) => launch.cancel(reason),
                  promise: launch.done.then(
                    () => undefined,
                    () => undefined,
                  ),
                })
                childrenChanged(agents)
              },
              onFinish: (finish: {
                runId: string
                description: string
                status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'partial'
                tools: readonly string[]
                denied: readonly string[]
                errorCode?: string
                detail?: string
                steps?: number
                output?: string
                text?: string
              }) => {
                const before = agents.get(finish.runId)?.outcome
                agents.finish(finish.runId, {
                  outcome: finish.status,
                  tools: finish.tools,
                  denied: finish.denied,
                  ...(finish.errorCode === undefined ? {} : { errorCode: finish.errorCode }),
                  ...(finish.detail === undefined ? {} : { detail: finish.detail }),
                  ...(finish.steps === undefined ? {} : { steps: finish.steps }),
                  ...(finish.output === undefined ? {} : { output: finish.output }),
                  ...(finish.text === undefined ? {} : { text: finish.text }),
                })
                childrenChanged(agents)
                // 2b: the report is delivered on its own, once. Mid-turn the
                // current seed could not carry it (the drain already ran), so
                // the wake happens right after this turn instead.
                const after = agents.get(finish.runId)
                if (
                  after !== undefined &&
                  before === 'running' &&
                  after.mode === 'background' &&
                  after.delivered !== true
                ) {
                  wakeForSettledChild()
                }
              },
            }),
      })
    : handle.services.tools
  const serviceTools = tools.guard(composedTools)

  // The project's own rules, read on every turn on purpose: the system prompt is
  // rebuilt from this turn's snapshot, so an `AGENTS.md` edited mid-session
  // reaches the model on the next message without a reload command and without
  // a restart.
  const projectText =
    options.cwd === undefined
      ? ''
      : projectContextText(discoverProjectContextFiles(options.cwd), projectContextRoot(options.cwd))

  let built: unknown = buildAgentGraph({
    model,
    maxSteps,
    system: [
      // First, because it is about this very turn: the SDK core states the rule
      // in the abstract ("the user's language") and a small model read an
      // English answer into an English prompt instead. Naming the language of
      // the message it is answering removes that reading.
      languageHintText(prompt) ?? '',
      toolInventoryText(snapshot),
      // Where z1 keeps its own state, in the same slot: without it the model
      // reads the transcript folder and `.z1/` as project files.
      options.cwd === undefined
        ? ''
        : ownStateText({
            cwd: options.cwd,
            sessionRoot: options.sessionRoot,
            session: options.session,
          }),
      // The project's own rules, in the same slot.
      projectText,
    ]
      .filter(Boolean)
      .join('\n\n'),
    // The prompt stack drops the whole custom section once it passes its
    // ceiling, and the default ceiling (6000) is what an `AGENTS.md` above
    // roughly 6.5 KiB used to blow past — the tool list disappeared with it.
    // Raising the
    // ceiling by exactly this section's estimate keeps the default behaviour
    // untouched for a project without `AGENTS.md` and stops a big one from
    // costing the model its tools.
    ...(projectText === '' ? {} : { budgetTokens: projectContextBudget(projectText) }),
    // The SDK owns history placement: it drops the transcript's own `system`
    // entries and fills the loop seed, so the system prompt above is rebuilt
    // from this turn's snapshot and the full previous transcript is safe here.
    history: historyWithDelivery,
    // An empty explicit list is "no override" in the SDK, which would ask the
    // guard per iteration; the guard's empty answer is the same, so omit it.
    ...(enabledSchemas.length > 0 ? { tools: enabledSchemas } : {}),
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
  })
  if (options.forceCompact === true) built = forceCompaction(built, options.lastTokens ?? 2_000)
  const graph = built
  // The graph now carries the delivered blocks in its seed: they have been
  // handed to the parent exactly once, whether or not the run later throws.
  for (const entry of delivered) agents?.markDelivered(entry.runId)
  const runId = `run_${randomUUID()}`
  const now = Date.now()
  runtime.journal.createRun({
    runId,
    graphId: (graph as { id: string }).id,
    graphDigest: graphDigest(graph as never),
    status: 'running',
    createdAt: now,
    updatedAt: now,
  })
  progress.working('Thinking…')
  // The seed above always carries the model's own `deliveredBlock`; what is
  // printed here depends on `/view`. `full` shows that same block byte for byte
  // (this mode's promise is "what was actually sent"), while `compact` and
  // `medium` use the display renderer - `compact` promises prose and errors
  // only, and five lines of metadata before every answer breaks that promise.
  for (const entry of delivered) {
    const elapsedMs = entryElapsed(entry, Date.now())
    const block = deliveredBlock({ entry, elapsedMs })
    for (const line of deliveredLines({
      entry,
      elapsedMs,
      mode: dashMode,
      columns: terminalColumns(),
      theme: viewTheme,
      block,
    })) {
      progress.print(line)
    }
  }

  let streamed = false
  // One sanitizer per turn: every streamed delta and the final text pass
  // through it, so a block split across chunks cannot reach the screen or the
  // saved transcript. Ordinary prose is returned immediately; only a markup
  // candidate buffers.
  const sanitizer = createOutputSanitizer()
  let visible = ''
  activeAbort = controller
  let result: RunResult
  try {
    result = await runGraph({
      signal: controller.signal,
      graph: graph as never,
      input: prompt,
      registry: handle.registry,
      services: {
        ...handle.services,
        // The same snapshot the prompt was built from: `list()` does no RPC and
        // `call()` re-reads the overlay, so a cross-session revocation still
        // applies mid-turn while the advertised set stays frozen. The subagent
        // composite sits inside this guard and adds its own call-only check.
        tools: serviceTools,
        onEvent: (event) => {
          if (event.type === 'node.stream' && event.port === 'text' && event.path.endsWith('/chat')) {
            streamed = true
            const chunk = typeof event.chunk === 'string' ? event.chunk : ''
            if (chunk.length === 0) return
            const clean = sanitizer.push(chunk)
            if (clean.length === 0) return
            visible += clean
            progress.event({ ...event, chunk: clean } as RunEvent)
            return
          }
          progress.event(event)
        },
      },
      runId,
      journal: runtime.journal,
      // The same names the prompt and the wire list advertise, frozen for this
      // run: the SDK refuses `ctx.tools.call` for any other name before the
      // service is reached, so a hallucinated tool cannot route to whatever
      // the live inventory happens to hold. An empty list is "no tool in this
      // run", which is exactly what an all-disabled policy means.
      tools: enabledSchemas.map(schema => schema.name),
    })
  } catch (error) {
    // The row was created as `running` before the run; without this it would
    // stay running forever in the journal (the SDK's runGraph does not reconcile).
    activeAbort = undefined
    runtime.journal.updateRun(runId, { status: 'failed', updatedAt: Date.now() })
    throw error
  }
  // A failed/cancelled run also finishes here: `runGraph` returns the status
  // instead of throwing for a failed node, so the row must record it.
  runtime.journal.updateRun(runId, { status: result.status, updatedAt: Date.now() })

  // A completed run's answer was streamed; print it only when nothing arrived
  // (a provider without streaming, or a mock that answers in one shot).
  activeAbort = undefined
  const rest = sanitizer.flush()
  if (rest.length > 0) {
    visible += rest
    progress.stream(rest)
  }
  const rawOutput = String(result.outputs['output'] ?? '')
  if (result.status === 'completed' && !streamed && rawOutput.length > 0) {
    visible = sanitizer.push(rawOutput) + sanitizer.flush()
    if (visible.length > 0) progress.print(visible)
  }
  // Empty after sanitizing. A hand-off is its own case: the model launched
  // background work and said nothing, so the empty-turn notices would be false
  // ("nothing ran"), and a launch row here would *duplicate* the live child row
  // the footer already shows (`◷ 1 subagent running · /agents`). The turn
  // therefore prints nothing and leaves the footer to speak - which it does,
  // for as long as the child runs and again when the report arrives.
  const toolsEnabled = snapshot.enabled.length > 0
  const handOff = result.status === 'completed' && visible.trim().length === 0 && launchedThisTurn.length > 0
  const reply = handOff
    ? { text: '', notice: undefined as string | undefined }
    : result.status === 'completed'
      ? finalizeAssistantReply(visible, toolsEnabled)
      : { text: visible, notice: undefined as string | undefined }
  if (reply.notice !== undefined) {
    progress.print(toolsEnabled ? reply.notice : dim(reply.notice))
  }
  const output = reply.text

  progress.settle(result.status, result.error)
  // The turn is over; a live background child keeps its row through the
  // between-turns writer (2b). Nothing here stops, disposes or awaits a child:
  // the session owns it, not the turn.
  progress.finishTurn()

  const events = runtime.journal.ownedEvents(runId).map(entry => entry.event)
  const loopEvent = events.find(
    event => event.type === 'node.completed' && event.path === 'loop',
  )
  let next: ChatMessage[] = []
  if (loopEvent && loopEvent.type === 'node.completed') {
    const messages = (loopEvent.outputs as Record<string, unknown> | undefined)?.['result']
    if (Array.isArray(messages)) next = messages as ChatMessage[]
  }
  if (next.length === 0) {
    // A run cut by the step limit has no loop output, but the transcript of its
    // last iteration is journaled. Keeping it means "continue" resumes the task
    // instead of starting over from the prompt.
    for (const event of [...events].reverse()) {
      if (event.type !== 'node.completed' || event.nodeId !== 'messagesMerge') continue
      const value = (event.outputs as Record<string, unknown> | undefined)?.['value']
      if (Array.isArray(value) && value.length > 0) next = value as ChatMessage[]
      if (next.length > 0) break
    }
  }
  // The saved transcript is the other place markup could survive: apply the
  // same rules to every assistant text the journal hands back, then make sure
  // a markup-only turn is recorded as the notice the user actually saw.
  if (next.length > 0) {
    next = next.map((message) => {
      if (message.role !== 'assistant') return message
      const clean = sanitizeOutput(message.content).text
      return clean === message.content ? message : { ...message, content: clean }
    })
    if (reply.notice !== undefined) {
      let lastAssistant = -1
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index]?.role === 'assistant') {
          lastAssistant = index
          break
        }
      }
      if (lastAssistant >= 0) {
        const last = next[lastAssistant]!
        if (last.content.trim().length === 0) {
          next[lastAssistant] = { ...last, content: reply.text }
        }
      } else if (result.status === 'completed') {
        next.push({ role: 'assistant', content: reply.text })
      }
    }
  }
  if (next.length === 0) {
    // Never fabricate an empty assistant message: some providers reject empty
    // content, and a failed/cancelled turn has no answer to keep. A completed
    // run with a one-shot answer still records the exchange; anything else
    // leaves the previous transcript untouched (as a fresh array).
    next =
      result.status === 'completed' && output.length > 0
        ? [
            { role: 'user', content: prompt },
            { role: 'assistant', content: output },
          ]
        : [...history]
  }

  // Context telemetry: the budget node is in the loop body, so its last
  // completion is this turn's final transcript size.
  let context: TurnContext | undefined
  let budgetOutputs: Record<string, unknown> | undefined
  let compactedTurns = 0
  for (const entry of runtime.journal.ownedEvents(runId)) {
    const event = entry.event
    if (event.type !== 'node.completed') continue
    if (event.nodeId === 'budget') budgetOutputs = event.outputs as Record<string, unknown>
    if (event.nodeId === 'ctxSummary' && (event.outputs as Record<string, unknown>)['compacted'] === true) {
      compactedTurns += Number((event.outputs as Record<string, unknown>)['droppedTurns'] ?? 0)
    }
  }
  if (budgetOutputs !== undefined) {
    const tokens = Number(budgetOutputs['tokens'] ?? 0)
    const window = Number(budgetOutputs['window'] ?? 0)
    if (window > 0) {
      context = { tokens, window, ratio: tokens / window, compactedTurns }
    }
  }

  return { status: result.status, output, error: result.error, history: next, runId, ...(context === undefined ? {} : { context }) }
}

interface Options {
  once?: string
  model?: string
  view?: ViewMode
}

/**
 * `--help` and a bad argument both need to say how to call this, so the usage
 * lives in one place. Plain lines, like the argument errors above it: `--help`
 * must work before any terminal, completer or runtime exists.
 */
const printUsage = (print: (line?: string) => void): void => {
  print('chat: a terminal agent for this workspace')
  print('')
  print('  usage: z1 [--model provider/model] [--view compact|medium|full] [--help]')
  print('         z1 --once "<prompt>"')
  print('')
  print('  --model <provider/model>  model for this session (also /model)')
  print('  --view <mode>             compact, medium or full (also /view)')
  print('  --once <prompt>           answer one prompt, print it, exit')
  print('  --help                    show this and exit')
  print('')
  print('  tools from z2q')
  print('    z1 tool … runs the z2q CLI (build, test, smoke, install, installed)')
  print('    against the same checkout tool.create used, so the install command a')
  print('    proposal prints works without z1-tool on PATH.')
  print('')
  print('  subagents')
  print('    The `subagent` tool runs a child agent. It is a background launch by')
  print('    default: the call returns a run id and the child keeps working. Its')
  print('    answer is delivered back on its own - the session runs a turn for it')
  print('    as soon as the child settles, without waiting for you to type.')
  print('    Pass "wait": true in the call to block until the child finishes.')
  print('    /agents lists them; /agents stop <n|runId> stops one.')
  print('')
  print('  --once and background children')
  print('    By default --once waits for every background child, prints each final')
  print('    status on stderr, and exits. Set Z1_NO_WAIT=1 to leave them running')
  print('    and exit at once: the run ids are printed, and the rows stay `running`')
  print('    until the next start reaps them.')
  print('')
}

const parseArgs = (): Options => {
  const options: Options = {}
  // argv[0] is the interpreter and argv[1] the script, under `tsx script.ts`.
  const rest = argv.slice(2)
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? ''
    if (arg === '--help' || arg === '-h') {
      printUsage(line => {
        console.log(line ?? '')
      })
      process.exit(0)
    }
    if (arg === '--once') {
      const value = rest[index + 1]
      if (value === undefined) {
        console.error('chat: --once needs a prompt')
        process.exit(2)
      }
      options.once = value
      index += 1
      continue
    }
    if (arg === '--model') {
      const value = rest[index + 1]
      if (value === undefined) {
        console.error('chat: --model needs provider/model')
        process.exit(2)
      }
      options.model = value
      index += 1
      continue
    }
    if (arg === '--view') {
      const value = rest[index + 1]
      const mode = value === undefined ? undefined : parseViewMode(value)
      if (mode === undefined) {
        console.error('chat: --view must be compact, medium or full')
        process.exit(2)
      }
      options.view = mode
      index += 1
      continue
    }
    console.error(`chat: unknown argument ${arg}`)
    process.exit(2)
  }
  return options
}

/**
 * Resolve the startup mode and refuse a bad explicit value. `--view` is already
 * parsed; `Z1_VIEW` is validated here so a typo is an error, not a silent
 * fallback. A corrupt preference file is only a report: its fallback is safe.
 */
const startupView = (flag: ViewMode | undefined): ReturnType<typeof resolveViewMode> => {
  const resolved = resolveViewMode({ env: process.env, flag, tty: Boolean(stdout.isTTY) })
  if (resolved.error !== undefined && resolved.error.startsWith('Z1_VIEW')) {
    console.error(`chat: ${resolved.error}`)
    process.exit(2)
  }
  return resolved
}

/**
 * One shot: no banner, no prompt loop. Same progress, final answer, exit 0 on a
 * completed run and 1 otherwise.
 */
const oneShot = async (prompt: string, explicitModel: string | undefined, explicitView: ViewMode | undefined): Promise<number> => {
  // Slash commands belong to the interactive loop; sending one to the model
  // would look like a prompt and silently do nothing. A multi-line submission is
  // the exception: `/tools ↵ what is the weather` carries a command and a real
  // question, so the command is honoured and only the lines under it are asked.
  // `/tools` is the one command a one-shot can genuinely run, because its whole
  // effect is the list; `/agents` is read-only too (it lists and can open a
  // child transcript), so it is also honoured headless: a listing decides no
  // exit code, the main run still does.
  //
  // Limitation (1.5b): a one-shot runs `/agents` *before* its turn, and the
  // registry is per process, so a fresh `z1 --once "/agents"` lists nothing.
  // It is useful when the same process already delegated (a command plus a
  // prompt: `/agents\n<question>`, or a subsequent read), never as a way to
  // inspect a previous run's children - use the interactive `/agents` for that.
  const headless = (name: string, rest: string): boolean =>
    (name === '/tools' || name === '/agents') && shapeAllows(commandSpec(name), rest)
  const trimmed = prompt.trimStart()
  const split = splitCommandAndPrompt(trimmed, headless)
  // An unknown `/foo` is not an interactive command, so the error below is not
  // the answer: the question under it is. A known command with the wrong shape
  // is still the error (`splitUnknownCommand` asks only about the table).
  const unknown =
    split === undefined ? splitUnknownCommand(trimmed, (name) => commandSpec(name) !== undefined) : undefined
  const firstLine = (trimmed.split('\n', 1)[0] ?? '').trim()
  const firstName = firstLine.split(/\s+/, 1)[0] ?? firstLine
  // `/exit` and `/quit` are the user asking to stop: a one-shot has nothing
  // left to do, and it is not a prompt either.
  if (firstName === '/exit' || firstName === '/quit') return 0
  const question = split !== undefined ? split.prompt : unknown !== undefined ? unknown.prompt : prompt
  if (split !== undefined && question.length === 0) {
    console.error('chat --once: /tools alone has no question under it; add a prompt on the next line')
    return 2
  }
  if (split === undefined && unknown === undefined && trimmed.startsWith('/')) {
    console.error(`chat --once: ${firstName} is an interactive command; run z1 without --once`)
    return 2
  }
  if (unknown !== undefined) {
    // Same report as before, now followed by what actually happened to the text
    // under it: stderr, because a one-shot's stdout is the answer and may be
    // piped. The run continues with the question instead of exiting 2.
    console.error(`chat --once: unknown command ${firstName} · run z1 without --once for the menu`)
    console.error(dim('the text under it was sent as a prompt'))
  }
  const view = startupView(explicitView)
  const model = startModel(explicitModel)
  const config = loadRuntimeConfig({ cwd: process.cwd(), env: process.env, overrides: { live: true } })
  const runtime = await createRuntime(config)
  // This session's delegated children, for `/agents`. In memory on purpose:
  // the registry is read-side, and `RunRecord.parentRunId` is fork lineage, not
  // delegation lineage (SUBAGENT-DESIGN-2, 1.5b).
  const agents = new AgentRegistry()
  runningChildren = 0
  // A previous process may have died with a run row still `running`; nothing
  // else reconciles those. Cheap (one listRuns) and once per process.
  reapOrphanedRuns(runtime.journal, {
    processStart,
    onLine: line => console.error(dim(line)),
  })
  const tail = createTail()
  const progress = createProgress(tail, view.mode)
  if (view.error !== undefined) progress.print(dim(view.error))
  progress.print(`› ${question}`)
  // Same background provisioning as the interactive loop. Diagnostics go to
  // stderr here: a one-shot run's stdout is the answer and may be piped.
  void ensureWebSearch({ onLine: line => console.error(dim(line)) })
  // Without a terminal an approval would block forever, so it is declined and
  // reported instead of silently hanging the run.
  const handle = await runtime.beginRun({ approval: quietApproval(progress), model })
  try {
    const toolState = new ToolStore(() => handle.services.tools.list(), [subagentToolSchema])
    if (split !== undefined) {
      if (split.command.trim().startsWith('/agents')) {
        // Read-only: a listing decides no exit code; the run below still does.
        // stderr, like `/tools`, because stdout is the answer and may be piped.
        for (const text of oneShotAgents(split.command, agents, runtime)) console.error(text)
      } else {
        // What `/tools` prints, on stderr: stdout is the answer and may be piped.
        const snapshot = await toolState.reload()
        const names = snapshot.enabled.map((record) => record.name)
        console.error(
          dim(
            `· tools · ${snapshot.inventoryKnown ? `${String(names.length)}/${String(snapshot.installedCount)} enabled` : 'inventory unavailable'}${names.length > 0 ? ` · ${names.join(', ')}` : ''}`,
          ),
        )
      }
    }
    const outcome = await runTurn(runtime, handle, model, [], question, progress, {
      toolState,
      cwd: config.cwd,
      sessionRoot: probableSessionRoot(config.cwd),
      agents,
    })
    if (outcome.context !== undefined) {
      progress.print(
        dim(
          `⬡ ctx ${formatTokens(outcome.context.tokens)}/${formatTokens(outcome.context.window)} · ${String(Math.round(outcome.context.ratio * 100))}%`,
        ),
      )
    }
    progress.closeLine()
    // 2b exit policy: a one-shot has no next turn, so a background child's text
    // can never be delivered. Wait for it (the default Shift) and print each
    // final status on stderr, or detach under `Z1_NO_WAIT=1`. The exit code
    // stays the main run's (`outcome.status` below): a child's outcome is
    // reported, never folded into it.
    await settleOnceChildren(agents, oncePolicy(process.env), (line) => console.error(dim(line)))
    return outcome.status === 'completed' ? 0 : 1
  } finally {
    await handle.dispose()
    await runtime.close()
    rl?.close()
  }
}

/**
 * `--once`'s background children (2b).
 *
 * - `wait` (default): await every child's own promise, then print one
 *   `onceStatusLine` per settled child on stderr.
 * - `detach` (`Z1_NO_WAIT=1`): print the still-running run ids and return; the
 *   rows stay `running` until the next process reaps them, the same contract as
 *   killing the host.
 *
 * It never throws: a child that could not record its row is reported like any
 * other ended child, and the main run's exit code is not affected.
 */
const settleOnceChildren = async (
  agents: AgentRegistry,
  policy: OncePolicy,
  onLine: (line: string) => void,
): Promise<void> => {
  // Only background children: a `wait: true` child already returned its answer
  // to the launching call, so it is neither waited for here nor reported.
  const started = agents.list().filter((entry) => entry.mode === 'background')
  if (started.length === 0) return
  if (policy === 'detach') {
    for (const line of onceDetachLines(started)) onLine(line)
    return
  }
  await agents.settleAll(started)
  for (const entry of started) {
    onLine(onceStatusLine(entry, entryElapsed(entry, Date.now())))
  }
}

/** Short workspace path: `~` for home, and only the last two segments. */
const shortPath = (cwd: string): string => {
  const home = process.env['HOME'] ?? ''
  const short = home.length > 0 && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
  const parts = short.split('/').filter((part) => part.length > 0)
  return parts.length <= 2 ? short : `…/${parts.slice(-2).join('/')}`
}

/** Git branch of the workspace, or undefined outside a repository. */
const gitBranch = (cwd: string): string | undefined => {
  try {
    const name = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      // Invisible probe: without this Windows allocates a console for it.
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
    return name.length === 0 ? undefined : name
  } catch {
    return undefined
  }
}

/** `/agents` in `--once`: the same rows the interactive command prints. */
const oneShotAgents = (
  command: string,
  agents: AgentRegistry,
  runtime: Runtime,
): readonly string[] => {
  const rest = command.trim().slice('/agents'.length).trim()
  const now = Date.now()
  if (rest === '') {
    return agentListLines({ entries: agents.list(), now, columns: terminalColumns(), theme: viewTheme })
  }
  const entry = agents.resolveRef(rest)
  if (!entry.ok) return [red(agentRefusal(rest, entry))]
  let events: readonly AgentEventRow[] = []
  try {
    events = runtime.journal.read(entry.entry.runId) as unknown as readonly AgentEventRow[]
  } catch {
    events = []
  }
  return agentTranscriptLines({ entry: entry.entry, events, now, width: terminalColumns(), theme: viewTheme })
}

/**
 * The static context Claude Code keeps above its input: model, directory,
 * branch, how full the context is and the current limits. It is reprinted
 * before every prompt, so the input is always the last thing on screen.
 */
const statusBar = (input: {
  model: string
  context: TurnContext | undefined
  maxSteps: number
  tools: string
}): string => {
  const columns = Math.max(20, terminalColumns())
  const parts = [
    // The provider prefix is noise in a one-row status; the model name is what
    // changes between turns.
    input.model.slice(input.model.lastIndexOf('/') + 1),
    input.context === undefined
      ? 'ctx –'
      : `ctx ${String(Math.round(input.context.ratio * 100))}%`,
    `steps ${stepLabel(input.maxSteps)}`,
    `tools ${input.tools}`,
  ]
  // The status is a single physical row; anything wider would wrap into the
  // terminal's last row and scroll the tray away.
  const text = parts.join(' · ')
  return text.length <= columns - 1 ? text : `${text.slice(0, columns - 2)}…`
}

const interactive = async (explicitModel: string | undefined, explicitView: ViewMode | undefined): Promise<void> => {
  const startup = startupView(explicitView)
  // 2b: the interactive session is the only surface with a next turn, so it is
  // the only one where a settled child can wake the prompt by itself.
  autoDeliveryEnabled = true
  let viewMode: ViewMode = startup.mode
  let model = startModel(explicitModel)
  // `--model` and `/model` are instructions that survive a session switch; a
  // model read from a transcript must not silently replace them.
  let modelPinned = explicitModel !== undefined && explicitModel.trim().length > 0
  const config = loadRuntimeConfig({ cwd: process.cwd(), env: process.env, overrides: { live: true } })
  const runtime = await createRuntime(config)
  // This session's delegated children, for `/agents`. In memory on purpose:
  // the registry is read-side, and `RunRecord.parentRunId` is fork lineage
  // (SUBAGENT-DESIGN-2, 1.5b — rule 9 keeps the journal row free of it).
  const agents = new AgentRegistry()
  runningChildren = 0
  let history: ChatMessage[] = []
  let lastTokens = 0
  let lastContext: TurnContext | undefined
  let forceCompact = false
  let maxSteps = stepLimit(process.env['Z1_MAX_STEPS'])
  let contextWindow = Number(process.env['Z1_CONTEXT_WINDOW'] ?? '128000') || 128_000

  const branch = gitBranch(config.cwd)

  // The installed inventory lives in one snapshot (`tool-state.ts`). The
  // `tools` service only exists behind a run handle, so a short-lived probe run
  // is its list source: it never asks for approval and its handle is disposed
  // before the first turn. Every view — `/tools`, the footer, the prompt and the
  // wire `tools` array — derives from this object and nothing else.
  const probeApproval: ApprovalService = { request: async () => 'rejected' }
  const probeTools = async (): Promise<readonly ToolSchema[]> => {
    const probe = await runtime.beginRun({ approval: probeApproval })
    try {
      return await probe.services.tools.list()
    } finally {
      await probe.dispose()
    }
  }
  const tools = new ToolStore(probeTools, [subagentToolSchema])
  const started = await tools.reload()
  if (!started.inventoryKnown) {
    console.log(`tools · unavailable (${started.listError ?? 'unknown error'})`)
  }

  // The model, directory and limits live in the composer footer, so the welcome
  // box only has to greet and point at the commands.
  // The welcome box spans the terminal; its width follows the terminal so a
  // resize can reprint it at the new size.
  const buildBanner = (): string =>
    box(
      [
        `${bold('⬡')} z1`,
        dim(`${shortPath(config.cwd)}${branch === undefined ? '' : ` · ${branch}`}`),
        '',
        `${dim('/help')} for commands · ${dim('/exit')} to quit`,
      ],
      Math.max(4, terminalColumns() - 4),
    )
  // The shell line that launched z1 is exactly one row above the cursor. Only
  // pinned mode may take it: with `Z1_PINNED=off` or `Z1_TRAY=off` the banner is
  // printed into the normal buffer and erasing the row above would blank the
  // user's previous shell line for no reason.
  if (pinnedMode) stdout.write('\x1b[1A\x1b[2K\r')
  if (!pinnedMode) printBox(buildBanner())

  const tail = createTail({ live: process.env['Z1_TRAY'] !== 'off', pinned: pinnedMode })
  tail.setHeader(buildBanner)
  // The between-turns writer of the child row (2b): the tail outlives every
  // turn's plate, so it can show `◷ N subagents running · /agents` while the
  // prompt waits - which is the whole point of a background child.
  idleTail = tail
  /** Everything the user sees from here on goes through the tail. */
  const say = (line = ''): void => tail.print(line)
  // Same startup reaper as `--once`: rows from a dead process are `failed`,
  // rows this or another live process started after `processStart` are left
  // alone. It runs before the first turn and reports through the tail, never
  // `console.log`, so a live session's output stays in one place.
  reapOrphanedRuns(runtime.journal, {
    processStart,
    onLine: line => say(dim(line)),
  })
  // A corrupt display preference has no security consequence: it resets to
  // medium and names the file once, unlike a corrupt tool policy.
  if (startup.error !== undefined) say(dim(startup.error))

  // The web tools need a SearXNG backend. Provisioning it runs in the
  // background: the banner is already printed and the prompt already accepts
  // input, so a first install (or a failure) never delays the session. It
  // prints at most one line — install progress, or why it could not start —
  // and only when it actually did something.
  void ensureWebSearch({ onLine: line => say(dim(line)) })

  /**
   * An unreadable overlay degrades the whole session's policy, so it is reported
   * once at startup and not only inside `/tools`. The second line states which
   * of the two recoveries is in force: after a good read this process keeps it
   * (`lastGood`), while a fresh process with no good read really does treat
   * every tool as enabled. `/tools reset` is the repair in both cases.
   */
  let reportedPrefsError: string | undefined
  const reportPrefsError = (): void => {
    const { error, degraded } = tools.current
    if (error === undefined) {
      reportedPrefsError = undefined
      return
    }
    if (reportedPrefsError === error) return
    reportedPrefsError = error
    say(red(`tools · preferences problem (${tools.path}): ${error}`))
    const note =
      degraded === 'last-good'
        ? 'keeping the last policy this process read'
        : degraded === 'partial'
          ? 'unreadable entries are treated as disabled'
          : 'no readable policy in this process, so every tool is enabled until the file is fixed'
    say(dim(`  ${note} · /tools reset rewrites the file`))
  }
  reportPrefsError()

  /**
   * Project-local transcripts. The store is opened once — `list()` must work
   * before the first prompt, otherwise a returning user could not resume — but
   * no session is created or resumed until the user actually says something.
   *
   * Every store failure is caught: a read-only checkout, a corrupt transcript
   * or a session from a newer z1 must leave a working chat, not a crash.
   */
  let reportedSessionError: string | undefined
  const sessionFailure = (what: string, error: unknown): void => {
    const line =
      error instanceof SessionTooNewError
        ? `session · ${what}: written by a newer z1 (schemaVersion ${String(error.schemaVersion)}) and not readable here`
        : `session · ${what}: ${error instanceof Error ? error.message : String(error)}`
    // Report once per distinct problem: a read-only root would otherwise print
    // the same line before every turn.
    if (reportedSessionError === line) return
    reportedSessionError = line
    say(red(line))
    say(dim('  the chat keeps working, but this conversation is not being saved'))
  }

  let sessions: SessionStore | undefined
  try {
    sessions = createSessionStore({ cwd: config.cwd, env: process.env })
  } catch (error) {
    sessions = undefined
    sessionFailure('could not open the store', error)
  }

  let currentSession: Session | undefined
  /** Sessions created here without an explicit name; the first turn titles them. */
  const pendingTitles = new Set<string>()
  /** The rows of the last printed listing; numbers resolve against it. */
  let listedSessions: readonly SessionSummary[] = []

  /**
   * Drop the live transcript without touching the store. Used where the
   * conversation itself is gone (cleared elsewhere, deleted): the handle and
   * the in-memory copy have to go together, or the next prompt carries a dead
   * id into `appendTurn` and every later turn fails the same way behind the
   * once-per-problem dedup in `sessionFailure`. A session that can no longer be
   * *read* but whose turn was saved is different: only the handle goes there,
   * because the conversation is still here, in `history`.
   */
  const forgetLiveConversation = (): void => {
    currentSession = undefined
    history = []
    lastContext = undefined
    lastTokens = 0
    forceCompact = false
  }

  const relativeTime = (ms: number): string => {
    const delta = Date.now() - ms
    if (!Number.isFinite(delta) || delta < 45_000) return 'just now'
    const minutes = Math.round(delta / 60_000)
    if (minutes < 60) return `${String(minutes)}m ago`
    const hours = Math.round(delta / 3_600_000)
    if (hours < 24) return `${String(hours)}h ago`
    const days = Math.round(delta / 86_400_000)
    if (days < 7) return `${String(days)}d ago`
    const date = new Date(ms)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  const shortModel = (name: string): string => name.slice(name.lastIndexOf('/') + 1)

  /**
   * Distinct, readable ANSI-256 colours for session hexagons. A new session
   * stores one in `meta.color`; an older transcript without one gets a stable
   * colour derived from its id, so reopening it never changes the icon.
   */
  const SESSION_COLORS = [39, 45, 51, 75, 81, 105, 111, 141, 170, 204, 209, 214, 220, 117, 123, 159] as const
  const pickSessionColor = (): number =>
    SESSION_COLORS[Math.floor(Math.random() * SESSION_COLORS.length)] ?? 45
  const sessionColorOf = (row: { id: string; color?: number }): number => {
    if (row.color !== undefined) return row.color
    let hash = 0
    for (const char of row.id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
    return SESSION_COLORS[hash % SESSION_COLORS.length] ?? 45
  }
  const sessionIcon = (row: { id: string; color?: number }): string =>
    paint(`38;5;${String(sessionColorOf(row))}`, '⬢')

  /**
   * `/sessions`: one header with the root and its mode, then one row per
   * session. `*` is the one this process is talking to. Numbers are bound to
   * this printing, like `/tools` numbers are bound to their revision.
   */
  const printSessions = (includeArchived: boolean): void => {
    if (sessions === undefined) {
      say(red('sessions · the store is unavailable (see above)'))
      return
    }
    let rows: readonly SessionSummary[]
    try {
      rows = sessions.list({ includeArchived })
    } catch (error) {
      sessionFailure('could not list', error)
      return
    }
    listedSessions = rows
    const noun = rows.length === 1 ? 'session' : 'sessions'
    say(
      `${bold('sessions')} · ${String(rows.length)} ${noun} in ${shortPath(sessions.root)} (${sessions.mode})`,
    )
    if (rows.length === 0) {
      say(
        dim(
          includeArchived
            ? '  none yet · one starts with your next prompt'
            : '  none active · /sessions --all also shows archived ones',
        ),
      )
      return
    }
    const currentId = currentSession?.meta.id
    const indexWidth = String(rows.length).length
    const nameWidth = Math.min(34, Math.max(4, ...rows.map((row) => displayCells(row.name))))
    for (const [index, row] of rows.entries()) {
      const mark = row.id === currentId ? green('*') : ' '
      const model = shortModel(row.model.model)
      const updated = dim(relativeTime(row.updatedAt))
      const archived = row.archived ? dim(' · archived') : ''
      const otherCwd = resolve(row.cwd) !== resolve(config.cwd) ? dim(' · other cwd') : ''
      say(
        `  ${mark} ${String(index + 1).padStart(indexWidth)}  ${sessionIcon(row)} ${padTo(fit(row.name, nameWidth), nameWidth)}  ${String(row.messageCount).padStart(3)} msgs  ${dim(fit(model, 18))}  ${updated}${archived}${otherCwd}`,
      )
    }
    if (!includeArchived) say(dim('  /sessions --all includes archived · /sessions new [name] starts one'))
  }

  /** Every session, archived included — resolution must not miss one. */
  const allSessions = (): readonly SessionSummary[] => {
    if (sessions === undefined) return []
    try {
      return sessions.list({ includeArchived: true })
    } catch (error) {
      sessionFailure('could not list', error)
      return []
    }
  }

  type SessionRef = { ok: true; summary: SessionSummary } | { ok: false; message: string }

  /**
   * `n` from the last listing, else an id, else a unique id prefix, else a
   * name. Ambiguity is an error: picking the wrong transcript silently is worse
   * than making the user type six more characters.
   */
  const resolveSessionRef = (selector: string): SessionRef => {
    const wanted = selector.trim()
    if (wanted === '') return { ok: false, message: 'sessions · which one? /sessions shows the numbers' }
    if (/^\d+$/.test(wanted)) {
      // A fresh process has no printed listing, but `/sessions 1` is the first
      // thing a returning user types. Treat the current active list as the
      // implicit listing until a real print pins one.
      if (listedSessions.length === 0) {
        try {
          listedSessions = sessions?.list({ includeArchived: false }) ?? []
        } catch (error) {
          sessionFailure('could not list', error)
          listedSessions = []
        }
      }
      const number = Number(wanted)
      const hit = number >= 1 ? listedSessions[number - 1] : undefined
      if (hit === undefined) {
        return {
          ok: false,
          message:
            listedSessions.length === 0
              ? 'sessions · none yet · one starts with your next prompt'
              : `sessions · ${wanted} is not in the list (1–${String(listedSessions.length)})`,
        }
      }
      return { ok: true, summary: hit }
    }
    const pool = allSessions()
    const exact = pool.find((row) => row.id === wanted)
    if (exact !== undefined) return { ok: true, summary: exact }
    const prefixed = pool.filter((row) => row.id.startsWith(wanted))
    if (prefixed.length === 1) return { ok: true, summary: prefixed[0]! }
    if (prefixed.length > 1) {
      return {
        ok: false,
        message: `sessions · "${wanted}" matches ${String(prefixed.length)} ids · use more characters`,
      }
    }
    const named = pool.filter((row) => row.name === wanted)
    if (named.length === 1) return { ok: true, summary: named[0]! }
    if (named.length > 1) {
      return {
        ok: false,
        message: `sessions · ${String(named.length)} sessions are named "${wanted}" · use an id instead`,
      }
    }
    const loose = pool.filter((row) => row.name.toLowerCase().includes(wanted.toLowerCase()))
    if (loose.length === 1) return { ok: true, summary: loose[0]! }
    if (loose.length > 1) {
      return {
        ok: false,
        message: `sessions · "${wanted}" matches ${String(loose.length)} names · be more specific`,
      }
    }
    return { ok: false, message: `sessions · no session "${wanted}" · /sessions --all lists everything` }
  }

  /** A stored user turn, drawn with the same full-width bar as a live one. */
  const printStoredUser = (text: string): void => {
    for (const [index, part] of text.split('\n').entries()) {
      // The same band and `❯` a live prompt uses: a reopened session must look
      // like the session that produced it.
      const line = `${index === 0 ? '❯ ' : '  '}${part}`
      const bar = colorEnabled ? padTo(line, Math.max(1, terminalColumns() - 1)) : line
      say(paint('48;5;237', bar))
    }
  }

  /**
   * A stored assistant turn: markdown for the text, then the calls under the
   * current density. The stored message carries no result, so a medium group
   * line cannot claim `✓`; full keeps today's dim call rows and compact drops
   * them, leaving the prose the user asked for.
   */
  const printStoredAssistant = (message: ChatMessage, mode: ViewMode): void => {
    let first = true
    const printer = createMarkdownPrinter((line) => {
      if (line.trim() === '' && first) return
      say(first ? `${bold('⬢')} ${line}` : line)
      first = false
    })
    if (message.content.length > 0) {
      printer.push(message.content.endsWith('\n') ? message.content : `${message.content}\n`)
      printer.flush()
    }
    const calls = message.toolCalls ?? []
    if (mode === 'full') {
      for (const call of calls) {
        // The same label a live row uses: a reopened session must read like the
        // session that produced it, not like the argument JSON it stored.
        say(dim(`⬢ ${callLine(call.name, call.arguments)}`))
      }
      return
    }
    if (mode === 'medium' && calls.length > 0) {
      const ctx: ViewContext = {
        columns: terminalColumns(),
        now: Date.now(),
        tty: Boolean(stdout.isTTY),
        theme: viewTheme,
      }
      const stored = calls.map((call) => ({ name: call.name, args: compactArgs(call.arguments) }))
      for (const line of groupStoredCalls(stored, ctx)) say(line)
    }
  }

  /** A stored tool result, clipped to one readable row; full mode only. */
  const printStoredTool = (message: ChatMessage): void => {
    const text = message.content.replace(/\s+/g, ' ').trim()
    if (text.length === 0) return
    say(dim(`  ⎿ ${clip(text, Math.max(20, terminalColumns() - 5))}`))
  }

  /**
   * Replay a loaded transcript into the visible transcript. This is display
   * only: `history` was already assigned, and the SDK builds a fresh system
   * prompt on the next turn. Tool results are clipped to one row; the stored
   * JSONL keeps the full result. Density applies here, so a session switch is
   * the way history re-renders under the current mode.
   */
  const replaySession = (session: Session, mode: ViewMode): void => {
    say('')
    if (session.messages.length === 0) {
      say(dim('  (this session has no messages yet)'))
      return
    }
    for (const message of session.messages) {
      if (message.role === 'user') {
        printStoredUser(message.content)
      } else if (message.role === 'assistant') {
        printStoredAssistant(message, mode)
        say('')
      } else if (message.role === 'tool') {
        if (mode === 'full') printStoredTool(message)
      }
    }
  }

  /**
   * Make a stored transcript the live one. The runtime, its tools and its cwd
   * were built once for this directory, so a session from another checkout can
   * only be refused — never silently run against the wrong repository.
   */
  const switchSession = (summary: SessionSummary): void => {
    if (sessions === undefined) {
      say(red('sessions · the store is unavailable (see above)'))
      return
    }
    if (summary.archived) {
      say(`sessions · ${summary.name} is archived · /sessions unarchive ${summary.id} first`)
      return
    }
    let loaded: Session | undefined
    try {
      loaded = sessions.load(summary.id)
    } catch (error) {
      sessionFailure(`could not read ${summary.id}`, error)
      return
    }
    if (loaded === undefined) {
      say(red(`sessions · ${summary.id} disappeared while it was being opened`))
      return
    }
    // A transcript may be reopened from any directory in the same repository;
    // tools still run in this process's cwd, so crossing a repository boundary
    // is refused but a repo root/subdirectory move is allowed and announced.
    const currentRepo = findRepoRoot(config.cwd) ?? resolve(config.cwd)
    if (resolve(loaded.meta.repoRoot) !== resolve(currentRepo)) {
      say(red(`session · belongs to ${loaded.meta.repoRoot}`))
      say(dim('  this process is bound to the repository it started in'))
      return
    }
    if (resolve(loaded.meta.cwd) !== resolve(config.cwd)) {
      say(yellow(`session · started in ${loaded.meta.cwd}`))
      say(dim(`  tools run in ${config.cwd}`))
    }
    if (currentSession?.meta.id === loaded.meta.id) {
      // Selecting the row you are already in must not append a second copy of
      // the same transcript. The picker stays closed and the screen is untouched.
      say(`session · ${loaded.meta.name} is already open`)
      return
    }
    // Opening another chat replaces the visible one: the tail wipes the screen
    // (and the scrollback) and reprints the banner before the new transcript.
    tail.clear()
    if (loaded.meta.color === undefined) {
      // Older transcripts predate the icon; persist a stable colour once so the
      // hexagon cannot change on a later open.
      try {
        sessions.setMeta(loaded.meta.id, { color: sessionColorOf(loaded.meta) })
        loaded = sessions.load(loaded.meta.id) ?? loaded
      } catch (error) {
        sessionFailure('could not save the session colour', error)
      }
    }
    currentSession = loaded
    history = [...loaded.messages]
    lastContext = undefined
    lastTokens = 0
    forceCompact = false
    contextWindow = loaded.meta.contextWindow
    maxSteps = loaded.meta.maxSteps
    // An explicit `--model` or `/model` outlives a switch; otherwise the
    // transcript's model comes back with it.
    if (!modelPinned) model = { provider: loaded.meta.model.provider, model: loaded.meta.model.model }
    try {
      sessions.setCurrent(loaded.meta.id)
    } catch (error) {
      sessionFailure('could not mark the current session', error)
    }
    say(
      `session · ${sessionIcon(loaded.meta)} ${loaded.meta.name} · ${String(loaded.messages.length)} msgs${loaded.tornTail ? ' · the last line was incomplete and was dropped' : ''}`,
    )
    replaySession(loaded, viewMode)
    refreshStatus()
  }

  /**
   * The first prompt of a conversation creates its session. A failed create
   * (read-only root, deleted parent) leaves the chat running without one.
   *
   * The session is created unnamed on purpose: the store's `Session <timestamp>`
   * default is the fallback, and `titleSession` names it after the first
   * completed turn. The prompt must not become the name, or `/new` would leak
   * the user's first message into the session list before any title is asked for.
   */
  const ensureSession = (): Session | undefined => {
    if (currentSession !== undefined) return currentSession
    if (sessions === undefined) return undefined
    try {
      const created = sessions.create({
        name: undefined,
        cwd: config.cwd,
        gitBranch: branch,
        model: { provider: model.provider, model: model.model },
        contextWindow,
        maxSteps,
        toolPolicyRevision: tools.current.revision,
        color: pickSessionColor(),
      })
      sessions.setCurrent(created.meta.id)
      currentSession = created
      pendingTitles.add(created.meta.id)
      return created
    } catch (error) {
      sessionFailure('could not save this conversation', error)
      return undefined
    }
  }

  /**
   * Autosave one turn. Called for completed, failed and cancelled runs alike:
   * the store appends only the new tail (or one snapshot when the transcript
   * was rewritten by compaction) and ignores a no-op.
   *
   * Returns `false` only when the transcript was cleared elsewhere while the
   * turn ran, so the caller must not feed this turn's context back into the
   * conversation state.
   */
  const saveTurn = (session: Session, messages: readonly ChatMessage[], runId: string): boolean => {
    if (sessions === undefined) return true
    try {
      sessions.appendTurn(session.meta.id, messages, {
        runId,
        // The generation this handle's `messages` were read at. The store
        // refuses the append when the transcript moved on: those messages are
        // no longer a prefix of what is on disk, and appending them would
        // resurrect a conversation somebody deliberately emptied.
        generation: session.meta.generation ?? 0,
      })
    } catch (error) {
      if (error instanceof SessionClearedError) {
        // The transcript's generation moved on while this turn ran, so it was
        // cleared elsewhere: another z1 process on this repository, or a
        // hand-edited file. (`/clear` here cannot be it — a turn owns the
        // prompt.) The turn is dropped: no append, no snapshot, no
        // `sessionFailure`, because nothing failed — the conversation is gone.
        // The handle and the in-memory copy are reloaded/emptied so the next
        // prompt cannot carry the stale messages back into the fresh transcript.
        let reloaded: Session | undefined
        try {
          reloaded = sessions.load(session.meta.id)
        } catch {
          reloaded = undefined
        }
        currentSession = reloaded
        history = []
        lastContext = undefined
        lastTokens = 0
        forceCompact = false
        say(
          yellow(
            'session · this conversation was cleared elsewhere; this turn was not saved · the next prompt starts fresh',
          ),
        )
        return false
      }
      if (isUnknownSessionError(error)) {
        // The directory behind this handle is gone: `/sessions delete` from
        // another z1, a deleted `z1/sessions`, a hand-cleaned repository. Unlike
        // a cleared transcript there is nothing to reload, and it is not a
        // per-turn fluke either — every later turn would fail on the same id,
        // with `sessionFailure`'s once-per-problem dedup hiding the repeats, so
        // the chat would look like it was saving while nothing was written.
        // Drop the handle and the transcript it described, exactly as the
        // cleared-elsewhere branch does: the next prompt creates a new session.
        forgetLiveConversation()
        say(
          red('session · this session no longer exists on disk; this turn was not saved'),
        )
        say(dim('  the next prompt starts a new session'))
        return false
      }
      sessionFailure('could not save this turn', error)
      return true
    }
    let reloaded: Session | undefined
    try {
      reloaded = sessions.load(session.meta.id)
    } catch {
      // A corrupt or too-new transcript is reported by the append above; the
      // handle is dropped below for the same reason as a missing one.
      reloaded = undefined
    }
    if (reloaded !== undefined) {
      currentSession = reloaded
      return true
    }
    // The append landed, but the session it landed in can no longer be read
    // back (the directory went away, or its meta/events became unreadable).
    // Keeping `session` would pin a handle whose `messages` stop at the
    // previous turn — the same lie the `/clear` path guards against, and
    // `titleSession` would look for the first user message in that stale
    // array. So the handle goes, but only the handle: the turn *was* written,
    // and `history` already holds it, so the conversation continues in memory
    // under a fresh session on the next prompt rather than being thrown away.
    // The saved bytes stay on disk untouched.
    currentSession = undefined
    say(red('session · saved this turn, but the session can no longer be read'))
    say(
      dim(
        '  the next prompt starts a new session with this conversation; the old one is left as it is on disk',
      ),
    )
    return true
  }

  /** Strip quotes/labels so a model reply becomes a plain one-line title. */
  const cleanTitle = (raw: string): string => {
    const cleaned = raw
      .trim()
      .replace(/^(?:title|session)\s*[:\-]\s*/i, '')
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[.!?。！？]+$/g, '')
      .trim()
    // `slice` is UTF-16-based; a cut inside a surrogate pair would store half
    // an emoji as the session name. Take whole code points instead.
    return Array.from(cleaned).slice(0, 60).join('').trim()
  }

  /**
   * Ask the current model for a short title from the first user message. This
   * runs after the first successful turn, so it never delays the answer; a
   * failure leaves the readable fallback name in place. One attempt per session.
   */
  const titleSession = async (handle: RunHandle, session: Session): Promise<void> => {
    if (sessions === undefined || !pendingTitles.has(session.meta.id)) return
    pendingTitles.delete(session.meta.id)
    const first = session.messages.find((message) => message.role === 'user')?.content?.trim()
    if (first === undefined || first === '') return
    try {
      const result = await handle.services.llm.chat({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You name chat sessions. Do not answer the user’s message. Reply with only a short title of 2 to 6 words, no quotes, no trailing punctuation, in the same language as the user.\nExamples:\nUser: "Explain what a monorepo is" -> Monorepo basics\nUser: "Fix the flaky auth test" -> Flaky auth test\nUser: "Як налаштувати CI?" -> Налаштування CI',
          },
          {
            role: 'user',
            content: `Name the chat that starts with this message. Reply with the title only.\n\nMessage:\n"""${first.slice(0, 2000)}"""\n\nTitle:`,
          },
        ],
        maxTokens: 24,
        temperature: 0,
      })
      const title = cleanTitle(result.message.content)
      const words = title.split(/\s+/).filter((word) => word.length > 0)
      const promptText = first.replace(/\s+/g, ' ').trim()
      if (
        title.length === 0 ||
        title.length > 60 ||
        words.length > 8 ||
        title.toLowerCase() === promptText.toLowerCase() ||
        promptText.toLowerCase().startsWith(title.toLowerCase())
      ) {
        // A provider that answered the message instead of naming it would
        // otherwise store a paragraph as the session name; keep the fallback.
        debugLog(`session title rejected: ${JSON.stringify(title.slice(0, 80))}`)
        return
      }
      sessions.rename(session.meta.id, title)
      const updated = sessions.load(session.meta.id)
      if (updated !== undefined && currentSession?.meta.id === session.meta.id) {
        currentSession = updated
      }
    } catch (error) {
      debugLog(`session title failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const complete = (value: string, cursor: number): { value: string; cursor: number; message?: string } | undefined => {
    const before = value.slice(0, cursor)
    const match = /(^|\s)(\/\S*)$/.exec(before)
    if (!match) return undefined
    const token = match[2]!
    const hits = COMMANDS.map((command) => command.name).filter((command) => command.startsWith(token))
    if (hits.length === 0) return undefined
    if (hits.length === 1) {
      const replacement = `${hits[0]} `
      const head = before.slice(0, before.length - token.length)
      return { value: `${head}${replacement}${value.slice(cursor)}`, cursor: head.length + replacement.length }
    }
    let common = hits[0] ?? ''
    for (const hit of hits) {
      let at = 0
      while (at < common.length && at < hit.length && common[at] === hit[at]) at += 1
      common = common.slice(0, at)
    }
    if (common.length <= token.length) return { value, cursor, message: `${String(hits.length)} commands` }
    const head = before.slice(0, before.length - token.length)
    return { value: `${head}${common}${value.slice(cursor)}`, cursor: head.length + common.length }
  }

  let composer: Composer | undefined
  if (useComposer) {
    composer = new Composer({
      onChange: () => tail.repaint(),
      onLine: deliverLine,
      onAbort: () => activeAbort?.abort(),
      onExit: () => {
        closed = true
        composer?.close()
        if (lineWaiter !== undefined) {
          const waiter = lineWaiter
          lineWaiter = undefined
          waiter('')
        }
      },
      complete,
      commands: () => COMMANDS,
      scroll: (kind) => tail.scroll(kind),
      /**
       * 2b: `/agents` opens the overlay here, at submission time, so it works
       * while a turn runs. The decision itself is the pure `interceptLine`:
       * only a bare `/agents` opens it. Every other line - `/agents stop 2`,
       * `/agents <ref>`, a prompt - falls through to `onLine` exactly as
       * before, which is why the printed forms still behave identically.
       */
      intercept: (text) => {
        if (interceptLine(text) !== 'open') return false
        openAgentsMenu()
        return true
      },
    })
    activeComposer = composer
    tail.setComposer(composer)
  } else if (rl !== undefined) {
    rl.completer = (line: string) => {
      if (!line.startsWith('/')) return [[], line]
      return [COMMANDS.map((command) => command.name).filter((command) => command.startsWith(line)), line]
    }
  }

  const askLine = async (question: string): Promise<string> => {
    if (composer === undefined) return nextLine(`\n${question} `)
    say(dim(question))
    return composer.ask(question)
  }
  const approval = consoleApproval(askLine)

  /**
   * `20/22` in the footer: what the agent can use, not just what is installed.
   * `?` when the inventory could not be read, so a failed probe never renders a
   * confident zero next to messages that do carry tools.
   */
  const toolCountLabel = (): string => {
    const snapshot = tools.current
    if (!snapshot.inventoryKnown) return '?'
    return snapshot.installedCount === 0
      ? '0'
      : `${String(snapshot.enabled.length)}/${String(snapshot.installedCount)}`
  }

  const refreshStatus = (): void => {
    tail.status(
      statusBar({
        model: modelLabel(model),
        context: lastContext,
        maxSteps,
        tools: toolCountLabel(),
      }),
    )
  }

  /**
   * `/tools` keeps a numbered list so `off 3` is easy. The numbers are bound to
   * the revision the list was printed at (`tools.markListed`): after a refresh a
   * stale number is rejected instead of silently hitting whatever the module now
   * returns third. Everything printed here comes from the snapshot.
   */
  const printTools = (includeOrphans: boolean): void => {
    tools.reloadPrefs()
    const snapshot = tools.current
    const rows = tools.markListed(
      includeOrphans ? snapshot.records : snapshot.records.filter((row) => row.installed),
    )

    const live = rows.filter((row) => row.installed)
    const off = live.filter((row) => row.state === 'disabled').length
    const deleted = live.filter((row) => row.state === 'deleted').length
    const stale = rows.length - live.length
    const parts = [`${green(String(live.length - off - deleted))} enabled`]
    if (off > 0) parts.push(`${yellow(String(off))} off`)
    if (deleted > 0) parts.push(`${red(String(deleted))} deleted`)
    if (stale > 0) parts.push(`${String(stale)} stale`)
    const installedLabel = snapshot.inventoryKnown ? String(snapshot.installedCount) : '?'
    say(`${bold('tools')} · ${installedLabel} installed · ${parts.join(' · ')}`)
    reportPrefsError()
    if (rows.length === 0) {
      say(dim('  none installed'))
      return
    }

    const indexWidth = String(rows.length).length
    const nameWidth = Math.min(24, Math.max(4, ...rows.map((row) => displayCells(row.name))))
    for (const [index, row] of rows.entries()) {
      const state =
        row.state === 'enabled' ? green('on ') : row.state === 'disabled' ? yellow('off') : red('del')
      const prefix = `  ${String(index + 1).padStart(indexWidth)}  ${state}  `
      const description = (row.description.split('\n')[0] ?? '').trim()
      const room = Math.max(8, terminalColumns() - displayCells(prefix) - nameWidth - 2)
      const suffix = description.length > 0 ? `  ${dim(fit(description, room))}` : ''
      const missing = row.installed ? '' : dim(' (not installed)')
      // A system tool is listed like the others but cannot be deleted; say so
      // where the user decides, not only when a delete is refused.
      const owned = row.system ? dim(' · system') : ''
      say(`${prefix}${padTo(fit(row.name, nameWidth), nameWidth)}${suffix}${missing}${owned}`)
    }
    if (deleted > 0) {
      say(dim('  deleted tools stay installed but are hidden from the agent.'))
      say(dim('  /tools restore <n|name> brings one back; /tools --all shows stale entries.'))
    }
  }

  /**
   * Apply one decision through the snapshot. `/tools` never writes the overlay
   * itself: the store re-reads it, merges, saves atomically and rebuilds, and a
   * failed write leaves the previous snapshot in place.
   */
  const saveToolState = (names: readonly string[], state: ToolState): boolean => {
    const result = tools.apply(names, state)
    if (!result.ok) {
      // The snapshot only changes after a successful write, so the list never
      // promises a state the guard would not enforce.
      say(red(result.message))
      refreshStatus()
      return false
    }
    refreshStatus()
    return true
  }

  const toolMenuItems = (): readonly ToolMenuItem[] =>
    tools.current.records.map((record) => ({
      name: record.name,
      description: record.description,
      state: record.state,
      installed: record.installed,
      system: record.system,
    }))

  /**
   * Interactive `/tools` in the composer. Enter flips `on`/`off` (and restores
   * a tombstone); Delete asks first; the static numbered list stays for pipes.
   */
  const openToolMenu = (): void => {
    if (composer === undefined) {
      printTools(false)
      return
    }
    tools.reloadPrefs()
    // The picker is the interactive form of the numbered list; bind its order
    // once so `off 12` after closing it resolves to the row the user saw.
    tools.markListed()
    composer.openToolMenu(toolMenuItems(), (action, name) => {
      const current = tools.current.records.find((record) => record.name === name)
      const next: ToolState =
        action === 'delete' ? 'deleted' : current?.state === 'enabled' ? 'disabled' : 'enabled'
      if (current !== undefined && current.state !== next) saveToolState([name], next)
      return toolMenuItems()
    })
  }

  const handleTools = async (line: string): Promise<void> => {
    const rest = line.slice('/tools'.length).trim()
    if (rest === '') {
      openToolMenu()
      return
    }
    if (rest === '--all' || rest === 'all') {
      printTools(true)
      return
    }
    if (rest === 'refresh') {
      const snapshot = await tools.reload()
      if (!snapshot.inventoryKnown) {
        say(red(`tools · unavailable (${snapshot.listError ?? 'unknown error'})`))
        return
      }
      say(`tools · refreshed · ${String(snapshot.installedCount)} installed`)
      return
    }

    const words = rest.split(/\s+/)
    const verb = (words[0] ?? '').toLowerCase()
    const selector = words.slice(1).join(' ').trim()
    if (!['on', 'off', 'delete', 'restore', 'reset'].includes(verb)) {
      say(`usage: ${usageText('/tools')}`)
      return
    }

    tools.reloadPrefs()
    const snapshot = tools.current
    if (verb === 'reset') {
      const names = Object.keys(snapshot.prefs.tools)
      const wasBroken = snapshot.error !== undefined
      if (names.length === 0 && !wasBroken) {
        say('tools · preferences already empty')
        return
      }
      const result = tools.reset()
      if (!result.ok) {
        say(red(result.message))
        refreshStatus()
        return
      }
      refreshStatus()
      say(
        wasBroken
          ? 'tools · preferences reset · the unreadable file was replaced'
          : `tools · preferences cleared · ${String(names.length)} restored to defaults`,
      )
      return
    }
    if (selector === '' || (selector === 'all' && verb === 'delete')) {
      const all = verb === 'on' || verb === 'off' || verb === 'restore' ? '|all' : ''
      say(`usage: /tools ${verb} <n|name>${all}`)
      return
    }
    if (verb === 'off' && selector === 'all') {
      // Only `enabled` becomes `disabled`: a tombstone must stay a tombstone, or
      // `restore all` has nothing left to find. Keep the result explicit today
      // instead of relying on `disabled` and `deleted` being equally hidden.
      const names = snapshot.enabled.map((record) => record.name)
      if (names.length === 0) {
        say('tools · every tool is already off')
        return
      }
      if (!saveToolState(names, 'disabled')) return
      say(`tools · ${String(names.length)} tools off`)
      return
    }
    if ((verb === 'on' || verb === 'restore') && selector === 'all') {
      const names =
        verb === 'on'
          ? snapshot.records.filter((record) => record.state !== 'enabled').map((record) => record.name)
          : snapshot.records.filter((record) => record.state === 'deleted').map((record) => record.name)
      if (names.length === 0) {
        say(verb === 'on' ? 'tools · every tool is already on' : 'tools · nothing is deleted')
        return
      }
      if (!saveToolState(names, 'enabled')) return
      say(
        verb === 'on'
          ? `tools · ${String(names.length)} tools on`
          : `tools · ${String(names.length)} tools restored`,
      )
      return
    }

    const resolved = await tools.resolve(selector)
    if (!resolved.ok) {
      say(resolved.message)
      return
    }
    const name = resolved.record.name
    const current = resolved.record.state
    if (verb === 'off') {
      if (current === 'deleted') {
        say(`tools · ${name} is already deleted · /tools restore ${name} brings it back`)
        return
      }
      if (current === 'disabled') {
        say(`tools · ${name} is already off`)
        return
      }
      if (!saveToolState([name], 'disabled')) return
      say(`tools · ${name} off · hidden from the agent`)
      return
    }
    if (verb === 'delete') {
      if (current === 'deleted') {
        say(`tools · ${name} is already deleted`)
        return
      }
      if (!saveToolState([name], 'deleted')) return
      say(`tools · ${name} deleted · hidden from the agent · /tools restore ${name}`)
      return
    }
    if (verb === 'restore') {
      if (current === 'enabled') {
        say(`tools · ${name} is already on`)
        return
      }
      if (!saveToolState([name], 'enabled')) return
      say(`tools · ${name} ${current === 'deleted' ? 'restored' : 'enabled'} · on`)
      return
    }
    // on: restores a tombstone too, so a deleted tool needs one command.
    if (current === 'enabled') {
      say(`tools · ${name} is already on`)
      return
    }
    if (!saveToolState([name], 'enabled')) return
    say(`tools · ${name} on`)
  }

  /**
   * One line for every `/web` answer: what the backend is, where, and why.
   * `pid` is only for a process z1 started — an external `Z1_SEARX_URL` has no
   * pid of ours to show.
   */
  const webLine = (status: WebStatus): string => {
    const pid = status.managed && status.pid !== undefined ? ` · pid ${String(status.pid)}` : ''
    return `web · ${status.url} · ${status.state}${pid} · ${status.detail}`
  }

  /**
   * `/web` — the backend behind the web tools. `status` never changes anything;
   * `start` is the same provisioning z1 fires on launch (an install on first
   * use), so it also works after `down`; `down` stops only a verified process
   * of ours and leaves the install in place.
   */
  const handleWeb = async (line: string): Promise<void> => {
    const rest = line.slice('/web'.length).trim().toLowerCase()
    const verb = rest === '' ? 'status' : rest
    if (verb === 'status') {
      say(webLine(await webSearchStatus()))
      return
    }
    if (verb === 'start') {
      // Progress goes through `say` so a first install reports as it downloads,
      // exactly like the launch-time provisioning does.
      const status = await ensureWebSearch({ onLine: message => say(dim(message)) })
      say(webLine(status))
      if (status.state === 'disabled') {
        say(dim('  Z1_WEB_AUTOSTART=off is set for this session; unset it to provision'))
      }
      return
    }
    if (verb === 'down') {
      const status = await stopWebSearch()
      say(webLine(status))
      // A stopped backend is restarted by the next launch, so the session does
      // not have to stay up or be restarted by hand.
      if (status.managed && status.state === 'stopped') {
        say(dim('  the next z1 launch starts it again · /web start now brings it back'))
      }
      return
    }
    say(`usage: ${usageText('/web')}`)
  }

  /**
   * `r`/`d` in the session picker. The picker closes first, so the question uses
   * the normal composer; the refreshed text list is printed afterwards.
   */
  const handleSessionPickerAction = async (
    action: 'rename' | 'delete',
    id: string,
  ): Promise<void> => {
    if (sessions === undefined) return
    let summary: SessionSummary | undefined
    try {
      summary = sessions.list({ includeArchived: true }).find((row) => row.id === id)
    } catch (error) {
      sessionFailure('could not read the session', error)
      return
    }
    if (summary === undefined) {
      say(red(`sessions · ${id} disappeared`))
      return
    }
    if (action === 'rename') {
      const name = (await askLine(`rename session "${summary.name}" to:`)).trim()
      if (name === '') {
        say(dim('sessions · not renamed'))
        return
      }
      try {
        sessions.rename(id, name)
        pendingTitles.delete(id)
        if (currentSession?.meta.id === id) {
          currentSession = { ...currentSession, meta: { ...currentSession.meta, name } }
        }
        say(`sessions · renamed to "${literalText(name)}"`)
        printSessions(false)
      } catch (error) {
        sessionFailure('could not rename', error)
      }
      return
    }
    const answer = await askLine(`delete session "${summary.name}" (${id})? [y/N]`)
    if (!answer.trim().toLowerCase().startsWith('y')) {
      say(dim('sessions · not deleted'))
      return
    }
    try {
      sessions.remove(id)
    } catch (error) {
      sessionFailure(`could not delete ${id}`, error)
      return
    }
    pendingTitles.delete(id)
    if (currentSession?.meta.id === id) {
      currentSession = undefined
      history = []
      lastContext = undefined
      lastTokens = 0
      forceCompact = false
      refreshStatus()
    }
    say(`sessions · deleted "${summary.name}" · moved to .trash`)
    printSessions(false)
  }

  /**
   * Interactive `/sessions`: the same arrow picker as `/tools`. Selecting a row
   * closes the menu and switches; the text list stays for pipes and `--all`.
   */
  const openSessionsPicker = (): boolean => {
    if (composer === undefined) return false
    if (sessions === undefined) {
      printSessions(false)
      return true
    }
    let rows: readonly SessionSummary[]
    try {
      rows = sessions.list({ includeArchived: false })
    } catch (error) {
      sessionFailure('could not list', error)
      return true
    }
    if (rows.length === 0) {
      printSessions(false)
      return true
    }
    listedSessions = rows
    const currentIndex = rows.findIndex((row) => row.id === currentSession?.meta.id)
    const noun = rows.length === 1 ? 'session' : 'sessions'
    try {
      composer.openSessionMenu(
        `${String(rows.length)} ${noun} in ${shortPath(sessions.root)} (${sessions.mode})`,
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          detail: `${String(row.messageCount)} msgs · ${shortModel(row.model.model)} · ${relativeTime(row.updatedAt)}${resolve(row.cwd) !== resolve(config.cwd) ? ' · other cwd' : ''}`,
          current: row.id === currentSession?.meta.id,
          archived: row.archived,
          color: sessionColorOf(row),
        })),
        (id) => {
          const summary = rows.find((row) => row.id === id)
          if (summary !== undefined) switchSession(summary)
        },
        currentIndex >= 0 ? currentIndex : 0,
        (action, id) => {
          void handleSessionPickerAction(action, id)
        },
      )
    } catch (error) {
      // A pending approval owns the keyboard; the text list is still useful.
      sessionFailure('could not open the session picker', error)
      printSessions(false)
    }
    return true
  }

  /**
   * One child's own journal rows, for `/agents`. A journal that cannot read the
   * id is not a crash: an empty transcript with the header still says what the
   * registry knows.
   */
  const childEvents = (runId: string): readonly AgentEventRow[] => {
    try {
      return runtime.journal.read(runId) as unknown as readonly AgentEventRow[]
    } catch {
      return []
    }
  }

  /** One child's transcript, printed to the scrollback (the non-TTY view). */
  const printAgentTranscript = (entry: AgentEntry): void => {
    const events = childEvents(entry.runId)
    for (const text of agentTranscriptLines({
      entry,
      events,
      now: Date.now(),
      width: terminalColumns(),
      theme: viewTheme,
    })) {
      say(text)
    }
  }

  /** The printed list: the fallback for a pipe, `Z1_TRAY=off`, and `--once`. */
  const printAgentList = (): void => {
    for (const text of agentListLines({
      entries: agents.list(),
      now: Date.now(),
      columns: terminalColumns(),
      theme: viewTheme,
    })) {
      say(text)
    }
  }

  /**
   * Open the `/agents` overlay (2b).
   *
   * `refresh` re-reads the registry, so the rows are live: a child that settles
   * or is stopped repaints in place. `onStop` runs the same pure `stopAgent`
   * the printed command uses, so `x` and `/agents stop <ref>` refuse alike - and
   * its `line` reaches the picker either way, which is how the user learns why a
   * `wait` child must be stopped with Ctrl-C in its own turn. Nothing is printed
   * to the transcript here: the picker stays open and shows the line itself.
   */
  const openAgentsMenu = (): void => {
    if (composer === undefined || !useComposer) {
      // No keyboard to own: the printed list is the honest fallback.
      printAgentList()
      return
    }
    composer.openAgentsMenu({
      entries: agents.list(),
      refresh: () => agents.list(),
      onOpen: (entry) => {
        printAgentTranscript(agents.get(entry.runId) ?? entry)
      },
      onStop: (entry) => {
        // `stopViaPicker` states the rule as a value: the line is the picker's
        // notice, never a transcript print. `print` is honoured rather than
        // assumed, so a future edit that wants to print has to say so.
        const result = stopViaPicker(stopAgent(agents, entry.runId))
        if (result.print) say(result.notice.text)
        if (result.stopped) childrenChanged(agents)
        return { stopped: result.stopped, line: result.notice.text }
      },
    })
  }

  /**
   * `/agents` - this session's delegated children.
   *
   * Bare opens the overlay (or prints, without a composer); `<n>` or `<runId>`
   * prints one child's transcript from its own journal. `stop <ref>` (or
   * `x <ref>`) cancels a *running* child through its own controller; a finished
   * one is refused with a line that says so. An unknown or garbage reference is
   * a plain message, never a crash.
   */
  const handleAgents = (line: string): void => {
    const rest = line.slice('/agents'.length).trim()
    if (rest === '') {
      openAgentsMenu()
      return
    }

    const words = rest.split(/\s+/)
    const verb = (words[0] ?? '').toLowerCase()
    if (verb === 'stop' || verb === 'x') {
      // The whole decision (including every refusal) is a pure function in
      // `agents-command.ts`; the handler only prints it and repaints.
      const decision = stopAgent(agents, rest.slice((words[0] ?? '').length))
      say(decision.kind === 'stop' ? dim(decision.line) : red(decision.line))
      if (decision.kind === 'stop') childrenChanged(agents)
      return
    }

    const resolved = agents.resolveRef(rest)
    if (!resolved.ok) {
      say(red(agentRefusal(rest, resolved)))
      return
    }
    printAgentTranscript(resolved.entry)
  }

  /**
   * The exit policy for background children (2b): a child that outlives the
   * session is a leak. The cancel-and-wait bound lives in `exit-policy.ts`
   * so it is testable; this only prints its lines and repaints the row.
   *
   * It cancels every child in `running()`, with no mode filter. A `wait: true`
   * child is in that set while it blocks, but `/exit` cannot be reached then:
   * the REPL is inside `runTurn`, awaiting that very call, and only `Ctrl-C`
   * (the turn's own cancel) gets control back. So the filter would be dead
   * code, and the honest statement is `exit-policy.ts`'s: everything still
   * running is cancelled.
   */
  const cancelChildrenForExit = async (): Promise<void> => {
    const result = await stopChildrenOnExit(agents)
    for (const line of result.lines) say(dim(line))
    if (result.cancelled > 0) childrenChanged(agents)
  }

  /**
   * `/sessions` - the whole sub-grammar, declared once in `COMMANDS`. Bare and
   * `--all` list; bare opens the arrow picker in a terminal.
   */
  const handleSessions = async (line: string): Promise<void> => {
    const rest = line.slice('/sessions'.length).trim()
    if (rest === '') {
      if (!openSessionsPicker()) printSessions(false)
      return
    }
    if (rest === '--all' || rest === 'all') {
      printSessions(true)
      return
    }

    const words = rest.split(/\s+/)
    const verb = (words[0] ?? '').toLowerCase()
    const tail = rest.slice((words[0] ?? '').length).trim()

    if (verb === 'new') {
      if (sessions === undefined) {
        say(red('sessions · the store is unavailable (see above)'))
        return
      }
      try {
        const created = sessions.create({
          name: tail === '' ? undefined : tail,
          cwd: config.cwd,
          gitBranch: branch,
          model: { provider: model.provider, model: model.model },
          contextWindow,
          maxSteps,
          toolPolicyRevision: tools.current.revision,
          color: pickSessionColor(),
        })
        sessions.setCurrent(created.meta.id)
        currentSession = created
        if (tail === '') pendingTitles.add(created.meta.id)
        history = []
        lastContext = undefined
        lastTokens = 0
        forceCompact = false
        say(`session · started "${created.meta.name}" · ${created.meta.id}`)
        refreshStatus()
        printSessions(false)
      } catch (error) {
        sessionFailure('could not create a session', error)
      }
      return
    }

    if (verb === 'rename') {
      const space = tail.search(/\s/)
      if (space < 0) {
        say(`usage: /sessions rename <n|id> <name>`)
        return
      }
      const ref = tail.slice(0, space)
      const name = tail.slice(space).trim()
      const resolved = resolveSessionRef(ref)
      if (!resolved.ok) {
        say(resolved.message)
        return
      }
      if (sessions === undefined) return
      try {
        sessions.rename(resolved.summary.id, name)
        // A manual name is final: a session created unnamed earlier in this
        // process must not be re-titled by `titleSession` after the next
        // completed turn (the picker's rename does the same).
        pendingTitles.delete(resolved.summary.id)
        if (currentSession?.meta.id === resolved.summary.id) {
          currentSession = { ...currentSession, meta: { ...currentSession.meta, name } }
        }
        say(`sessions · renamed to "${literalText(name)}"`)
        printSessions(false)
      } catch (error) {
        sessionFailure('could not rename', error)
      }
      return
    }

    if (verb === 'delete') {
      if (tail === '') {
        say(`usage: /sessions delete <n|id>`)
        return
      }
      const resolved = resolveSessionRef(tail)
      if (!resolved.ok) {
        say(resolved.message)
        return
      }
      const target = resolved.summary
      // Destructive and irreversible from inside the chat (the directory moves
      // to `.trash`, but nothing here restores it), so it always asks first.
      const answer = await askLine(`delete session "${target.name}" (${target.id})? [y/N]`)
      if (!answer.trim().toLowerCase().startsWith('y')) {
        say(dim('sessions · not deleted'))
        return
      }
      if (sessions === undefined) return
      try {
        sessions.remove(target.id)
      } catch (error) {
        sessionFailure(`could not delete ${target.id}`, error)
        return
      }
      if (currentSession?.meta.id === target.id) {
        // The live transcript is gone: the next prompt starts a new session.
        currentSession = undefined
        history = []
        lastContext = undefined
        lastTokens = 0
        forceCompact = false
        refreshStatus()
      }
      say(`sessions · deleted "${target.name}" · moved to .trash`)
      printSessions(false)
      return
    }

    if (verb === 'archive' || verb === 'unarchive') {
      if (tail === '') {
        say(`usage: /sessions ${verb} <n|id>`)
        return
      }
      const resolved = resolveSessionRef(tail)
      if (!resolved.ok) {
        say(resolved.message)
        return
      }
      if (sessions === undefined) return
      const archived = verb === 'archive'
      if (archived === resolved.summary.archived) {
        say(
          `sessions · "${resolved.summary.name}" is already ${archived ? 'archived' : 'active'}`,
        )
        return
      }
      try {
        sessions.archive(resolved.summary.id, archived)
      } catch (error) {
        sessionFailure(`could not ${verb} ${resolved.summary.id}`, error)
        return
      }
      if (archived && currentSession?.meta.id === resolved.summary.id) {
        // Archiving the live transcript takes it out of the list, so this
        // process stops writing to it; the next prompt starts a new session.
        currentSession = undefined
        history = []
        lastContext = undefined
        lastTokens = 0
        forceCompact = false
        refreshStatus()
        say(`sessions · archived "${resolved.summary.name}" · a new session starts with your next prompt`)
      } else {
        say(`sessions · ${archived ? 'archived' : 'restored'} "${resolved.summary.name}"`)
      }
      printSessions(archived ? false : true)
      return
    }

    // No verb: the whole of `rest` is a selector, so ids and numbers work
    // exactly as they were printed.
    const resolved = resolveSessionRef(rest)
    if (!resolved.ok) {
      say(resolved.message)
      return
    }
    switchSession(resolved.summary)
  }

  /**
   * Apply one `/view` mode: the live display changes for future events only,
   * then the preference is written. A failed write still applies the mode
   * because display state is not safety state.
   */
  const applyViewMode = (mode: ViewMode): void => {
    viewMode = mode
    const saved = saveViewPreference(mode)
    say(
      saved.ok
        ? `view · ${cyan(mode)}`
        : `view · ${cyan(mode)} · not saved: ${saved.error ?? 'unknown error'}`,
    )
  }

  /** Interactive bare `/view`: open the three-row picker above the composer. */
  const composeViewMenu = (): void => {
    const picker = composer
    if (picker === undefined) return
    picker.openViewMenu(viewMode, applyViewMode)
  }

  type CommandResult = 'continue' | 'exit'
  type CommandHandler = (raw: string, rest: string) => CommandResult | Promise<CommandResult>

  /**
   * One handler per name; `COMMANDS` above is the only list. The dispatcher
   * checks the shape from the same spec, so a bare call and a malformed one
   * both report the table's text instead of a second copy of it.
   */
  const handlers: Record<string, CommandHandler> = {
    '/help': () => {
      printHelp(say)
      return 'continue'
    },
    // A background child is session work, not conversation state: `/new`
    // starts another conversation in the same session, so a live child keeps
    // running (and is delivered into the new turn); only finished rows go. Its
    // row would otherwise be orphaned by `tail.clear()` with no `/agents`
    // entry, so running rows are kept and the status row is reprinted.
    '/exit': async (): Promise<CommandResult> => {
      await cancelChildrenForExit()
      return 'exit'
    },
    '/quit': async (): Promise<CommandResult> => {
      await cancelChildrenForExit()
      return 'exit'
    },
    '/new': () => {
      // A fresh conversation is a fresh session: this one stays on disk and
      // stays listed, and the next prompt creates its replacement. That new
      // session is unnamed, so the first prompt is not stored as its name.
      history = []
      currentSession = undefined
      lastContext = undefined
      lastTokens = 0
      forceCompact = false
      // `/agents` is scoped to this session, so the old conversation's finished
      // children go with it. A running background child is still doing work
      // that was asked for, so it stays (2b): it is listed here and delivered
      // at the next turn of the new conversation.
      const kept = agents.running().length
      agents.clearFinished()
      childrenChanged(agents)
      // The state is gone; the screen has to say so before the confirmation.
      tail.clear()
      say(
        `new conversation · nothing is saved until your first message · the previous session stays in /sessions${
          kept === 0 ? '' : ` · ${String(kept)} ${kept === 1 ? 'subagent' : 'subagents'} still running`
        }`,
      )
      refreshStatus()
      return 'continue'
    },
    '/clear': () => {
      const resetLive = (): void => {
        history = []
        lastContext = undefined
        lastTokens = 0
        forceCompact = false
      }
      // The screen follows the transcript, so it is wiped in the same branch
      // that empties it and never before: a store that refused to clear must
      // leave the old chat visible, or the user reads "cleared" on an empty
      // screen while the next prompt continues the conversation that is still
      // on disk. Pinned mode and native scrollback both wipe here.
      if (sessions === undefined) {
        // No store: the transcript exists only in this process, so clearing it
        // is real but nothing about it can be saved.
        resetLive()
        tail.clear()
        say('clear · cleared in this process only (sessions are not being saved)')
        refreshStatus()
        return 'continue'
      }
      if (currentSession === undefined) {
        resetLive()
        tail.clear()
        say('clear · this conversation is already empty')
        refreshStatus()
        return 'continue'
      }
      const { id, name } = currentSession.meta
      let removed = 0
      try {
        // Report what the transcript actually held: `load` repairs a stale
        // `messageCount` from `events.jsonl` before anything is removed.
        removed = sessions.load(id)?.messages.length ?? currentSession.meta.messageCount
        sessions.clear(id)
        // `clear` keeps id, name, colour, model and folder; the next prompt
        // must append here, so the handle has to stay pointed at this id. The
        // reload is also the only proof the directory survived `clear`: if it
        // did not, keeping the pre-clear handle would keep its old `messages`
        // and `messageCount`, `ensureSession()` would hand that lying object to
        // the next turn, and `appendTurn` on a vanished id fails every time —
        // one reported error, then a chat that silently saves nothing.
        currentSession = sessions.load(id)
        // Old text must not title a conversation that is now empty.
        pendingTitles.delete(id)
        resetLive()
        // Only now: `sessions.clear(id)` returned, so the messages are gone and
        // "this conversation is empty" is true on screen as well as on disk.
        tail.clear()
      } catch (error) {
        // The transcript still holds its messages, so the screen keeps showing
        // them: the error is about a chat that is still there.
        sessionFailure(`could not clear ${id}`, error)
        refreshStatus()
        return 'continue'
      }
      const count = `${String(removed)} ${removed === 1 ? 'message' : 'messages'} removed`
      // After a clear the handle is only valid if the directory is still there;
      // `undefined` here means `load` found nothing, so the next prompt creates
      // a fresh session instead of appending to this one.
      say(
        currentSession === undefined
          ? `cleared "${name}" · ${count} · the session directory is gone; the next prompt starts a new one`
          : removed === 0
            ? `clear · "${name}" is already empty · same session`
            : `cleared "${name}" · ${count} · same session · next prompt starts fresh`,
      )
      refreshStatus()
      return 'continue'
    },
    '/model': (_raw, rest) => {
      if (rest === '') {
        say(`usage: ${usageText('/model')}`)
        return 'continue'
      }
      const parsed = parseModelRef(rest)
      if (!parsed.ok) {
        // Same helper as `--model`/`Z1_MODEL`, but a bad `/model` keeps the
        // session running: it is a command error, not a startup error.
        say(`model · ${parsed.error}`)
        return 'continue'
      }
      model = parsed.model
      // An explicit choice outlives a `/sessions` switch.
      modelPinned = true
      say(`model · ${literalText(modelLabel(model))}`)
      return 'continue'
    },
    '/sessions': async (raw) => {
      await handleSessions(raw)
      return 'continue'
    },
    '/agents': (raw) => {
      handleAgents(raw)
      return 'continue'
    },
    '/tools': async (raw) => {
      await handleTools(raw)
      return 'continue'
    },
    '/web': async (raw) => {
      await handleWeb(raw)
      return 'continue'
    },
    '/context': () => {
      if (lastContext === undefined) {
        say('context · no completed turn yet')
      } else {
        say(
          `context · ${formatTokens(lastContext.tokens)}/${formatTokens(lastContext.window)} (${String(Math.round(lastContext.ratio * 100))}%)${lastContext.compactedTurns > 0 ? ` · compacted ${String(lastContext.compactedTurns)} turns` : ''}`,
        )
      }
      // The project's `AGENTS.md` chain, read again instead of remembered: the
      // files are re-read on every turn, so this line has to describe the next
      // request — including what the budgets dropped.
      say(dim(projectContextSummary(discoverProjectContextFiles(config.cwd), projectContextRoot(config.cwd))))
      return 'continue'
    },
    '/compact': () => {
      forceCompact = true
      lastTokens = lastContext?.tokens ?? lastTokens
      say('context · compaction forced for the next turn')
      return 'continue'
    },
    '/window': (_raw, rest) => {
      const value = Number(rest)
      if (!Number.isFinite(value) || value <= 0) {
        say(`usage: ${usageText('/window')}`)
        return 'continue'
      }
      contextWindow = Math.floor(value)
      say(`window · ${formatTokens(contextWindow)}`)
      return 'continue'
    },
    '/steps': (_raw, rest) => {
      const value = Number(rest)
      if (rest !== 'off' && (!Number.isInteger(value) || value < 1)) {
        say(`usage: ${usageText('/steps')}`)
        return 'continue'
      }
      maxSteps = rest === 'off' ? STEP_CEILING : Math.min(STEP_CEILING, value)
      say(`steps · ${stepLabel(maxSteps)}`)
      return 'continue'
    },
    '/view': (_raw, rest) => {
      if (rest === '') {
        if (composer !== undefined) {
          composeViewMenu()
          return 'continue'
        }
        for (const line of viewListLines(viewMode, viewTheme)) say(line)
        return 'continue'
      }
      const next = parseViewChoice(rest)
      if (next === undefined) {
        say(`usage: ${usageText('/view')}`)
        return 'continue'
      }
      applyViewMode(next)
      return 'continue'
    },
  }

  /**
   * Run one slash-command line.
   *
   * `undefined` means the text was not a command at all (it does not start with
   * `/`), so the caller may send it as a prompt; `'continue'` means it was one
   * and was handled — or reported as a usage/unknown-command error — so it must
   * never be sent to the model.
   */
  const runCommand = async (text: string): Promise<CommandResult | undefined> => {
    if (!text.startsWith('/')) return undefined
    // One lookup for every slash command (see `COMMANDS` and `handlers` above).
    // A handler runs when the spec's shape allows the arguments: `/exit now` is
    // a shape error, and bare `/window` reaches its own handler so the usage
    // text exists once, in the table.
    const name = text.split(/\s+/, 1)[0] ?? text
    const rest = text.slice(name.length).trim()
    const spec = commandSpec(name)
    const handler = handlers[name]
    if (handler !== undefined && shapeAllows(spec, rest)) return await handler(text, rest)
    if (spec !== undefined) {
      say(spec.args === undefined ? `${name} takes no arguments` : `usage: ${usageText(name)}`)
    } else {
      say(`unknown command ${name} · type / for the menu`)
    }
    return 'continue'
  }

  // A terminal drag emits many SIGWINCH events; clear and repaint once.
  let resizeTimer: NodeJS.Timeout | undefined
  process.on('SIGWINCH', () => {
    tail.observeResize()
    debugLog(`sigwinch rows=${String(terminalRows())} cols=${String(terminalColumns())}`)
    if (resizeTimer !== undefined) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      refreshStatus()
      tail.reflow()
    }, 250)
    resizeTimer.unref?.()
  })

  try {
    for (;;) {
      if (closed && pendingLines.length === 0) break
      composer?.setBusy(false)
      // Another session may have changed the policy while this one waited.
      tools.reloadPrefs()
      refreshStatus()
      // 2b: a child that settled during the previous turn was not in that
      // turn's seed. Wake an automated delivery now, before the prompt waits
      // for input the user may never type.
      wakeDeferredSettle()
      // `tail.idle()` closes a pending streamed row and clears the activity
      // line (the last turn's plate). A background child still running is the
      // exception (2b): its row is reprinted here, so it is visible between
      // turns and not only while a turn paints, and it stays while the prompt
      // waits below.
      if (pendingLines.length === 0) {
        tail.idle()
        const row = childIdleRow()
        if (row !== undefined) tail.activity(row)
      }

      // A trailing backslash continues on the next line in the readline path
      // (a pipe, or `Z1_TRAY=off`); the composer has a real newline key.
      let line = ''
      if (composer !== undefined) {
        line = await nextLine('')
      } else {
        for (;;) {
          const promptText = rl?.terminal === true ? (line.length === 0 ? dim('> ') : dim('… ')) : ''
          const chunk = await nextLine(promptText)
          if (chunk.endsWith('\\')) {
            line += `${chunk.slice(0, -1)}\n`
            continue
          }
          line += chunk
          break
        }
      }
      line = line.trim()
      if (line.length === 0) continue

      // 2b: the session woke itself because a background child settled. The
      // report is the turn's seed (printed by `runTurn` as a marked block), so
      // there is no user row and no command dispatch: this is not user input.
      const autoDelivery = line === AUTO_DELIVERY_LINE
      if (autoDelivery) {
        autoDeliveryQueued = false
        // The wake can be overtaken by a turn the user had already queued: that
        // turn drains the report (its seed is built later), so by the time this
        // sentinel is read there is nothing left to deliver. A turn that says
        // "the report is delivered above" with no report above would be worse
        // than no turn at all. The same check covers `/new`'s `clearFinished`.
        if (agents === undefined || agents.settledUndelivered().length === 0) continue
        // A wake queued before the user asked to quit must not start a model
        // turn during shutdown: the `closed` guard in `settleSignal` only stops
        // new wakes, and this one is already in the queue.
        if (closed) break
        // The session is speaking, not the user: one green row says so, where a
        // typed prompt gets the grey bar. The report itself follows from the
        // turn's seed, marked as subagent output.
        say(green(AUTO_DELIVERY_ROW))
      } else {
        // The submitted prompt becomes ordinary scrollback; the composer below
        // stays exactly once.
        const parts = line.split('\n')
        if (composer !== undefined || rl?.terminal !== true) {
          parts.forEach((part, index) => {
            // The user's own words get a full-width tinted band: it is the one
            // row that is *not* the agent talking, and the band is what makes a
            // long transcript scannable when every other row is prose. `❯`
            // stays in front of it, so the marker survives a pipe and a theme
            // that renders the background faintly.
            const line = `${index === 0 ? '❯ ' : '  '}${part}`
            const bar = colorEnabled ? padTo(line, Math.max(1, terminalColumns() - 1)) : line
            say(paint('48;5;237', bar))
          })
        }
      }

      // A command on the first line of a multi-line submission runs first, and
      // the rest of the box is the prompt it was typed with: `/tools` on its own
      // line followed by a question used to reach the `/tools` handler as a
      // weird argument (or the model as one prompt), so the tools list was never
      // shown and the question was never answered. Only a line the table knows
      // and whose shape allows its own arguments splits; anything else is one
      // prompt, exactly as before. A `rest: true` command owns the lines below
      // it as arguments, so `/tools` + `off 3` is one command and never a prompt.
      // An auto-delivery line is neither: it is the session's own prompt and
      // must never reach the command table.
      const split = autoDelivery
        ? undefined
        : splitCommandAndPrompt(
            line,
            (name, rest) => handlers[name] !== undefined && shapeAllows(commandSpec(name), rest),
            (name, args) => commandSpec(name)?.rest === true && restArguments(name, args),
          )
      if (autoDelivery) line = AUTO_DELIVERY_PROMPT
      else if (split !== undefined) {
        if ((await runCommand(split.command)) === 'exit') break
        // Nothing under the command: it was the whole submission.
        if (split.prompt.length === 0) continue
        line = split.prompt
      } else {
        // Not a runnable command — but `/foo` on the first line with a question
        // under it is not nothing either. The dispatcher knows no `/foo`, so it
        // used to print "unknown command" and take the question down with it:
        // the user typed both halves and the console reports what it did with
        // the second. A *known* command with the wrong shape stays the usage
        // error it always was (the predicate here asks only about the table, so
        // `/exit now` under a question is refused, not forwarded).
        const unknown = splitUnknownCommand(line, (name) => commandSpec(name) !== undefined)
        if (unknown !== undefined) {
          await runCommand(unknown.command)
          say(dim('the text under it was sent as a prompt'))
          line = unknown.prompt
        } else {
          const outcome = await runCommand(line)
          if (outcome === 'exit') break
          // A consumed command (or a usage/unknown-command report) is not a prompt.
          if (outcome === 'continue') continue
        }
      }

      composer?.setBusy(true)
      // A queued prompt may start while a command picker is open; a running turn
      // owns the transcript, so those pickers must not float over it. The
      // `/agents` overlay is the exception and stays open on purpose: it is the
      // one view that is *about* the work a running turn started, and it was
      // opened during the turn it describes (2b).
      composer?.closeToolMenu()
      composer?.closeSessionMenu()
      composer?.closeViewMenu()
      const progress = createProgress(tail, viewMode)
      try {
        // `model` is the turn's own handle: the run passes it to the host hooks
        // that make a model call of their own (today `tool.create`), so a tool
        // proposal is billed and journaled like the turn that asked for it.
        const handle = await runtime.beginRun({ approval, model })
        // The first prompt of a conversation creates its session; later prompts
        // keep using it. A store failure returns undefined and the turn still runs.
        const activeSession = ensureSession()
        // From here until the turn settles, a child that ends cannot be in this
        // turn's seed (`drainSettled` already ran); it is remembered for the
        // automated delivery right after this turn. Inside the `try` because
        // it must be released on every path, including a `beginRun` throw.
        turnActive = true
        try {
        const outcome = await runTurn(runtime, handle, model, history, line, progress, {
          forceCompact,
          lastTokens,
          maxSteps,
          contextWindow,
          toolState: tools,
          cwd: config.cwd,
          // The store may have failed to open: the section then names `.z1/`
          // only, instead of a transcript directory this process never saw.
          sessionRoot: sessions?.root,
          // `history` is the transcript this turn replays, so it is the count the
          // user sees in `/sessions` and in the reopen banner — but `system`
          // entries are not messages there: the store drops them before counting,
          // and `outcome.history` hands them back, so an unfiltered length would
          // run one (or more) ahead of every other count.
          session:
            activeSession === undefined
              ? undefined
              : {
                  name: activeSession.meta.name,
                  messageCount: history.filter((message) => message.role !== 'system').length,
                },
          agents,
          viewMode,
        })
        forceCompact = false
        history = outcome.history
        // A failed or cancelled turn is saved too: the store writes whichever
        // transcript this turn produced and no-ops when nothing changed. A
        // `false` means the transcript was cleared elsewhere mid-turn, so
        // `history` and the context below were reset and none of this turn's
        // state may be carried into the next prompt.
        const kept =
          activeSession === undefined
            ? true
            : saveTurn(activeSession, outcome.history, outcome.runId)
        if (activeSession !== undefined) {
          // Only a new, unnamed session gets an AI title; a loaded transcript
          // keeps the name it already has.
          if (kept && outcome.status === 'completed' && currentSession !== undefined) {
            await titleSession(handle, currentSession)
          }
        }
        if (outcome.context !== undefined && kept) {
          lastContext = outcome.context
          lastTokens = outcome.context.tokens
          // The footer shows the percentage on every prompt; only a compaction
          // is worth its own line.
          if (outcome.context.compactedTurns > 0) {
            progress.print(dim(`⬡ compacted ${outcome.context.compactedTurns} turns`))
          } else if (!colorEnabled) {
            progress.print(
              dim(
                `⬡ ctx ${formatTokens(outcome.context.tokens)}/${formatTokens(outcome.context.window)} · ${String(Math.round(outcome.context.ratio * 100))}%`,
              ),
            )
          }
        }
        progress.closeLine()
      } finally {
          await handle.dispose()
          // The turn no longer owns delivery: a settle that arrived during it is
          // woken at the top of the loop, an idle one was already woken by
          // `onFinish`.
          turnActive = false
        }
      } finally {
        composer?.setBusy(false)
      }
    }
  } finally {
    composer?.close()
    activeComposer = undefined
    tail.erase()
    rl?.close()
    restoreTerminal()
    await runtime.close()
  }
}

const options = parseArgs()

if (options.once !== undefined) {
  oneShot(options.once, options.model, options.view)
    .then(code => { process.exitCode = code })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
} else {
  interactive(options.model, options.view).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
