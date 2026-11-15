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
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { argv, stdin, stdout } from 'node:process'

import { createRuntime, loadRuntimeConfig } from '/home/oleksii/Projects/z1-sdk/z1/packages/bootstrap/src/index.ts'
import type { Runtime, RunHandle } from '/home/oleksii/Projects/z1-sdk/z1/packages/bootstrap/src/index.ts'
import { buildAgentGraph } from '/home/oleksii/Projects/z1-sdk/z1/packages/agent/src/index.ts'
import { runGraph } from '/home/oleksii/Projects/z1-sdk/z1/packages/runtime/src/index.ts'
import type { ApprovalService, RunEvent, RunResult } from '/home/oleksii/Projects/z1-sdk/z1/packages/runtime/src/index.ts'
import { graphDigest } from '/home/oleksii/Projects/z1-sdk/z1/packages/graph/src/index.ts'

import {
  createGuardedTools,
  loadToolPreferences,
  saveToolPreferences,
  toolState,
  withToolStates,
  type ToolPreferences,
  type ToolState,
} from './tool-policy.ts'

// Keep the console clean: service-selection info goes to stderr from the SDK.
const stderrWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
  if (text.startsWith('z1: [info] service ')) return true
  return (stderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
}) as typeof process.stderr.write

type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolCalls?: unknown[] }
type ModelHandle = { provider: string; model: string; credentialRef?: string; params?: Record<string, unknown> }
type ToolSchema = Awaited<ReturnType<RunHandle['services']['tools']['list']>>[number]
type MutableGraph = {
  id: string
  nodes: Array<Record<string, unknown>>
  edges: Array<{ id: string; kind: string; from: { node: string; port: string }; to: { node: string; port: string } }>
  [key: string]: unknown
}

const MAX_ARGS = 120

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

/** Compact, single-line JSON of a tool argument payload, truncated to fit a row. */
const compactArgs = (value: unknown): string => {
  let raw: string
  if (value === undefined || value === null) raw = '{}'
  else if (typeof value === 'string') raw = value
  else {
    try {
      raw = JSON.stringify(value) ?? '{}'
    } catch {
      raw = String(value)
    }
  }
  raw = raw.replace(/\s+/g, ' ').trim()
  if (raw.length === 0) raw = '{}'
  return raw.length <= MAX_ARGS ? raw : `${raw.slice(0, MAX_ARGS - 1)}…`
}

/** One line of a tool failure: strings as-is, objects by their `error` field. */
const errorText = (value: unknown): string => {
  let raw: string
  if (typeof value === 'string') raw = value
  else if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['error'] === 'string') {
    raw = String((value as Record<string, unknown>)['error'])
  } else {
    try {
      raw = JSON.stringify(value) ?? String(value)
    } catch {
      raw = String(value)
    }
  }
  raw = raw.replace(/\s+/g, ' ').trim()
  return raw.length === 0 ? 'error' : raw
}

/** Payload size the way a user reads it: characters, then kilobytes. */
const byteSize = (value: unknown): string => {
  let count = 0
  if (typeof value === 'string') count = value.length
  else {
    try {
      count = (JSON.stringify(value) ?? '').length
    } catch {
      count = String(value).length
    }
  }
  return count < 1024 ? `${String(count)} B` : `${(count / 1024).toFixed(1)} KB`
}

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

/** Printable width, ignoring the SGR sequences the accents add. */
const visibleLength = (text: string): number => text.replace(/\x1b\[[0-9;]*m/g, '').length

/** Terminal cells one code point occupies: 2 for CJK/emoji, 0 for combining. */
const charCells = (char: string): number => {
  const code = char.codePointAt(0) ?? 0
  if (code === 0x200d) return 0
  if (code >= 0x0300 && code <= 0x036f) return 0
  if (code >= 0xfe00 && code <= 0xfe0f) return 0
  if (code >= 0x1f3fb && code <= 0x1f3ff) return 0
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f680 && code <= 0x1f6ff) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x1fa70 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  ) {
    return 2
  }
  return 1
}

/** Display width of a string, ignoring SGR accents. */
const displayCells = (text: string): number => {
  let total = 0
  for (const char of stripAnsi(text)) total += charCells(char)
  return total
}

/** Truncate for a fixed-width box; the tail is usually the interesting part. */
const fit = (text: string, width: number): string =>
  visibleLength(text) <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`

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

const elapsedLabel = (ms: number): string => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 1000).toFixed(0)}s`)

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
 * Undo everything the UI did to the terminal. A crash that leaves the cursor
 * hidden, raw mode on or SGR dim is as broken as a leftover scroll region.
 */
const restoreTerminal = (): void => {
  if (terminalRestored) return
  terminalRestored = true
  if (!stdout.isTTY) return
  try {
    activeTail?.erase()
    if (stdin.isTTY) stdin.setRawMode(false)
    stdout.write('\x1b[0m\x1b[?25h\x1b[?2004l\x1b[r\r')
  } catch {
    // The terminal is already gone; there is nothing left to restore.
  }
}

/** Printable cells, ignoring the SGR sequences the accents add. */
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')

/** Truncate without cutting an SGR sequence in half. */
const clip = (text: string, width: number): string => {
  if (width <= 0) return ''
  let out = ''
  let used = 0
  for (let index = 0; index < text.length && used < width; index += 1) {
    const rest = text.slice(index)
    const sgr = /^\x1b\[[0-9;]*m/.exec(rest)
    if (sgr) {
      out += sgr[0]
      index += sgr[0].length - 1
      continue
    }
    out += text[index]
    used += 1
  }
  return used < stripAnsi(text).length ? `${out}\x1b[0m…` : out
}

const terminalRows = (): number => {
  const rows = stdout.rows
  return rows === undefined || rows <= 0 ? 24 : rows
}

type DisplayRow = { text: string; start: number; end: number }

/** One slash command: the menu, `/help`, and Tab all read the same list. */
interface CommandSpec {
  name: string
  description: string
  /** Present when the command takes arguments; Enter completes instead of running. */
  args?: string
}

/**
 * Wrap the draft the way the terminal will: hard breaks at `width` cells, and
 * one row per logical newline. Offsets stay in UTF-16 units, which is what the
 * cursor and String#slice use.
 */
const layoutRows = (value: string, width: number): DisplayRow[] => {
  const rows: DisplayRow[] = []
  const limit = Math.max(1, width)
  let offset = 0
  const lines = value.split('\n')
  lines.forEach((line, lineIndex) => {
    let rowStart = offset
    let rowText = ''
    let cells = 0
    let charOffset = offset
    for (const char of line) {
      const cellsForChar = charCells(char)
      if (cells > 0 && cells + cellsForChar > limit) {
        rows.push({ text: rowText, start: rowStart, end: charOffset })
        rowStart = charOffset
        rowText = ''
        cells = 0
      }
      rowText += char
      cells += cellsForChar
      charOffset += char.length
    }
    rows.push({ text: rowText, start: rowStart, end: charOffset })
    offset = charOffset + (lineIndex < lines.length - 1 ? 1 : 0)
  })
  return rows
}

/** Where the caret sits: row index plus a cell column within that row. */
const cursorPosition = (rows: readonly DisplayRow[], cursor: number): { row: number; col: number } => {
  let result = { row: 0, col: 0 }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    if (cursor < row.start) break
    if (cursor <= row.end) {
      result = {
        row: index,
        col: displayCells(row.text.slice(0, Math.max(0, cursor - row.start))),
      }
      if (cursor === row.end && index + 1 < rows.length && rows[index + 1]!.start === cursor) {
        result = { row: index + 1, col: 0 }
      }
      break
    }
  }
  return result
}

/** One row of the interactive `/tools` menu. */
interface ToolMenuItem {
  name: string
  description: string
  state: ToolState
}

type ToolMenuAction = 'toggle' | 'delete'

interface ToolMenu {
  items: readonly ToolMenuItem[]
  index: number
  /** Set while the Delete key waits for a yes/no confirmation. */
  confirmDelete?: string
  onAction: (action: ToolMenuAction, name: string) => readonly ToolMenuItem[]
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
  private override: { text: string; until: number } | undefined
  private history: string[] = []
  private historyIndex = -1
  private stash = ''
  /** Selected row in the slash menu, and the draft that dismissed it. */
  private menuIndex = 0
  private menuDismissed: string | undefined
  /** Interactive `/tools` picker, independent of the slash menu. */
  private toolsMenu: ToolMenu | undefined
  private buffer = ''
  private escTimer: NodeJS.Timeout | undefined
  private closed = false
  private readonly onChange: () => void
  private readonly onLine: (line: string) => void
  private readonly onAbort: () => void
  private readonly onExit: () => void
  private readonly complete: (value: string, cursor: number) => { value: string; cursor: number; message?: string } | undefined
  private readonly commands: () => readonly CommandSpec[]
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
  }) {
    this.onChange = options.onChange
    this.onLine = options.onLine
    this.onAbort = options.onAbort
    this.onExit = options.onExit
    this.complete = options.complete
    this.commands = options.commands
    this.scroll = options.scroll
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', this.onData)
    // Bracketed paste: a pasted block arrives as one key, not as keystrokes.
    stdout.write('\x1b[?2004h')
  }

  /** Show `label` in the footer and resolve with the next submitted line. */
  ask(label: string): Promise<string> {
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
    this.toolsMenu = { items, index: 0, onAction }
    this.changed()
  }

  /** Hide the picker without touching the draft. */
  closeToolMenu(): void {
    if (this.toolsMenu === undefined) return
    this.toolsMenu = undefined
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
    this.override = { text, until: Date.now() + ms }
    this.changed()
    const timer = setTimeout(() => {
      if (this.override !== undefined && Date.now() >= this.override.until) {
        this.override = undefined
        this.changed()
      }
    }, ms + 20)
    timer.unref?.()
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
      return
    }
    if (this.value.length === 0) return
    const now = Date.now()
    if (this.override?.text === 'esc again to clear' && now < this.override.until) {
      this.override = undefined
      this.clearDraft()
      this.changed()
      return
    }
    this.note('esc again to clear')
  }

  private ctrlC(): void {
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
    const now = Date.now()
    if (this.override?.text === 'press ctrl+c again to exit' && now < this.override.until) {
      this.onExit()
      return
    }
    this.note('press ctrl+c again to exit')
  }

  private ctrlD(): void {
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
    this.override = undefined
    this.menuIndex = 0
    this.menuDismissed = undefined
  }

  private submit(): void {
    if (this.asking !== undefined) {
      this.endAsk(this.value)
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

  /** Send the draft as one turn, leaving the composer ready for the next one. */
  private submitText(): void {
    const text = this.value
    if (text.trim().length === 0) return
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
      const description = (item.description.split('\n')[0] ?? '').trim()
      const room = Math.max(0, columns - 2 - 4 - 3 - nameWidth - 2)
      const suffix = description.length > 0 ? `  ${dim(clip(description, room))}` : ''
      lines.push(clip(`${pointer}${state}  ${label}${suffix}`, Math.max(1, columns - 1)))
    }
    return lines
  }

  private insert(text: string): void {
    if (this.toolsMenu !== undefined) return
    const clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    if (clean.length === 0) return
    this.value = `${this.value.slice(0, this.cursor)}${clean}${this.value.slice(this.cursor)}`
    this.cursor += clean.length
    this.historyIndex = -1
    this.changed()
  }

  private backspace(): void {
    if (this.toolsMenu !== undefined) return
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
    const rows = layoutRows(this.value, Math.max(1, terminalColumns() - 2))
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

  private hint(menuOpen: boolean): string {
    if (this.asking !== undefined) return this.asking.label
    if (this.toolsMenu !== undefined) {
      return this.toolsMenu.confirmDelete !== undefined
        ? '⏎ yes · esc cancel'
        : '↑↓ · ⏎ toggle · del delete · esc'
    }
    if (menuOpen) return '↑↓ select · ⏎ run · esc close'
    if (this.override !== undefined && Date.now() < this.override.until) return this.override.text
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
    const toolLines = this.renderToolMenu(width)
    // The composer is a full sharp box: top/bottom rules and vertical sides.
    // It is accented only while the field is active (idle, asking, or a draft
    // is being edited); during a run with an empty draft it stays dim.
    // The composer is a plain, uniformly dim box; no prompt chevron and no
    // brighter edge that would read as a bold outline.
    const leftEdge = dim('│')
    const rightEdge = dim('│')
    const textWidth = Math.max(1, width - 4)
    const rows = layoutRows(this.value, textWidth)
    const position = cursorPosition(rows, this.cursor)
    const maxVisible = Math.max(3, Math.min(12, terminalRows() - 8))
    let start = 0
    if (rows.length > maxVisible) {
      const half = Math.floor(maxVisible / 2)
      start = Math.max(0, Math.min(rows.length - maxVisible, position.row - half))
    }
    const visible = rows.slice(start, start + maxVisible)
    const input: string[] = visible.map((row) => `${leftEdge} ${padTo(row.text, textWidth)} ${rightEdge}`)
    if (this.value.length === 0) {
      input[0] = `${leftEdge} ${padTo(dim('Ask z1…'), textWidth)} ${rightEdge}`
    }
    const rule = (left: string, right: string): string =>
      dim(`${left}${'─'.repeat(Math.max(0, width - 2))}${right}`)
    const header = rule('┌', '┐')
    const footerRule = rule('└', '┘')
    const hint = this.hint(menu.open)
    const right = status
    const available = Math.max(1, width - 2)
    let footer = '  '
    if (this.asking !== undefined) {
      // A question owns the row: an approval must be readable before the status.
      footer += clip(hint, available)
    } else if (hint.length > 0 && right.length > 0 && hint.length + right.length <= available) {
      // The happy path: hint on the left, session status on the right.
      footer += `${hint}${' '.repeat(available - hint.length - right.length)}${right}`
    } else {
      // The hint always keeps its room; the status is truncated from the right,
      // so model and context survive. This is Claude Code's footer rule.
      const leftBudget = right.length === 0 ? available : Math.max(0, available - Math.min(right.length, 24) - 1)
      const left = clip(hint, leftBudget)
      const rightBudget = Math.max(0, available - stripAnsi(left).length - (left.length > 0 ? 2 : 0))
      const rightText = clip(right, rightBudget)
      footer += left
      if (rightText.length > 0) {
        footer += `${' '.repeat(Math.max(0, available - stripAnsi(left).length - stripAnsi(rightText).length))}${rightText}`
      }
    }
    const lines = [...toolLines, ...menuLines, header, ...input, footerRule, dim(footer)]
    const key = [
      this.value,
      String(this.cursor),
      status,
      this.busy ? '1' : '0',
      this.asking?.label ?? '',
      this.hint(menu.open),
      menu.open ? `${String(menu.index)}:${menuLines.join('\n')}` : '',
      toolLines.join('\n'),
      this.toolsMenu === undefined ? '' : String(this.toolsMenu.confirmDelete ?? ''),
      String(width),
    ].join('\u0000')
    return {
      lines,
      cursorRow: toolLines.length + menuLines.length + 1 + (position.row - start),
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
  let pinnedActive = false
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
    if (!pinnedActive) {
      stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?1000h\x1b[?1006h')
      pinnedActive = true
    }
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
      if (pinnedActive) stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1049l')
      pinnedActive = false
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
    if (!pinned || !live || !pinnedActive) return false
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
  /** Start the animated "thinking" row; the next print replaces it. */
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
}


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

const createProgress = (tail: Tail): Progress => {
  const startedAt = Date.now()
  const calls = new Map<string, { name: string; args: string }>()
  const shown = new Set<string>()
  let runError: string | undefined
  let assistantStarted = false
  let spinner: NodeJS.Timeout | undefined
  const frames = [paint('0', '⬡'), dim('⬡')]
  let frame = 0

  const stopSpinner = (): void => {
    if (spinner === undefined) return
    clearInterval(spinner)
    spinner = undefined
    tail.activity(undefined)
  }

  const working = (label: string): void => {
    stopSpinner()
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
  }

  let markdown: MarkdownPrinter | undefined

  const emit = (line: string): void => {
    if (!assistantStarted && stripAnsi(line).trim() === '') return
    if (spinner !== undefined) stopSpinner()
    if (!assistantStarted) {
      assistantStarted = true
      tail.print(`${bold('⬢')} ${line}`)
    } else {
      tail.print(line)
    }
  }
  markdown = createMarkdownPrinter(emit)

  const print = (line: string): void => {
    markdown?.flush()
    stopSpinner()
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
          const value = incoming.outputs['value'] as { item?: { name?: unknown; arguments?: unknown } } | undefined
          const item = value?.item ?? {}
          const name = typeof item.name === 'string' && item.name.length > 0 ? item.name : 'tool'
          const args = compactArgs(item.arguments)
          calls.set(input[1] as string, { name, args })
          print(`${bold('⬢')} ${cyan(name)}${args.length === 0 ? '' : dim(`(${args})`)}`)
          return
        }
        // `mapCall` publishes the tool result; `isError` picks the symbol.
        const call = /^(loop\/\d+\/toolMap\/\d+)\/mapCall$/.exec(incoming.path)
        if (call !== null) {
          const name = calls.get(call[1] as string)?.name ?? 'tool'
          const ms = `${String(incoming.durationMs)}ms`
          if (incoming.outputs['isError'] === true) {
            const text = errorText(incoming.outputs['result'])
            shown.add(text)
            print(`  ${dim('⎿')}  ${red(`✗ ${text}`)} ${dim(`· ${ms}`)}`)
          } else {
            print(`  ${dim('⎿')}  ${green('✓')} ${dim(`${ms} · ${byteSize(incoming.outputs['result'])}`)}`)
          }
          return
        }
        return
      }
      case 'node.failed': {
        shown.add(incoming.error)
        print(`  ${dim('⎿')}  ${red(`✗ ${incoming.path}`)} ${dim(`· ${incoming.error}`)}`)
        return
      }
      case 'run.failed': {
        runError = incoming.error
        shown.add(incoming.error)
        return
      }
      default:
        return
    }
  }

  const settle = (status: string, error: string | undefined): void => {
    const elapsed = elapsedLabel(Date.now() - startedAt)
    if (status === 'completed') {
      print(green(`⬢ done · ${elapsed}`))
      return
    }
    if (status === 'cancelled') {
      print(dim(`⬡ cancelled · ${elapsed}`))
      return
    }
    print(red(`⬢ failed · ${elapsed}`))
    const message = error ?? runError
    if (message !== undefined && message.length > 0) {
      if (!shown.has(message)) print(`  ${dim('⎿')}  ${red(message)}`)
      if (message.includes('step limit')) {
        print(`  ${dim('⎿')}  ${yellow('step limit reached — say "continue" to resume, or /new')}`)
      } else if (message.includes('TIMEOUT')) {
        print(`  ${dim('⎿')}  ${yellow('turn timed out — say "continue" to resume, or /new')}`)
      }
    }
  }

  return { working, print, stream, event, settle, closeLine }
}

/** Abort channel of the turn that is currently running, if any. */
let activeAbort: AbortController | undefined

let closed = false
/** Lines typed while a turn is running: Claude Code queues them, so does z1. */
const pendingLines: string[] = []
let lineWaiter: ((line: string) => void) | undefined
let activeComposer: Composer | undefined

const deliverLine = (line: string): void => {
  const waiter = lineWaiter
  if (waiter !== undefined) {
    lineWaiter = undefined
    waiter(line)
    return
  }
  pendingLines.push(line)
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

const defaultModel = (): ModelHandle => {
  const explicit = process.env['Z1_MODEL']?.trim()
  const raw = explicit && explicit.length > 0
    ? explicit
    : process.env['RIVER_API_KEY']
      ? 'river/deepseek-ai/DeepSeek-V4.1-Flash'
      : process.env['OPENAI_API_KEY']
        ? 'openai/gpt-4.1-mini'
        : 'mock/mock-1'
  const slash = raw.indexOf('/')
  if (slash < 0) return { provider: 'mock', model: raw }
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

const modelLabel = (model: ModelHandle): string => `${model.provider}/${model.model}`

/**
 * `z1.flow.loop.maxIterations` is an integer capped at 10 000 by its schema, so
 * the graph cannot express "no limit". That ceiling is the practical one: a
 * single user turn that reaches it is a runaway, not a long task.
 */
const STEP_CEILING = 10_000

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
  { name: '/model', description: 'switch the model', args: '<provider/model>' },
  // No `args` here: Enter on a bare `/tools` must list, not complete. The
  // toggle grammar is shown in the description and in `/help`.
  { name: '/tools', description: 'tool picker; on/off/delete/restore <n|name>' },
  { name: '/context', description: 'show context usage' },
  { name: '/compact', description: 'compact the next turn' },
  { name: '/window', description: 'set the context window', args: '<tokens>' },
  { name: '/steps', description: 'set the step limit', args: '<n|off>' },
  { name: '/exit', description: 'quit z1' },
  { name: '/quit', description: 'quit z1 (same as /exit)' },
]

const usage = (print: (line?: string) => void): void => {
  print('')
  for (const command of COMMANDS) {
    const label = command.args === undefined ? command.name : `${command.name} ${command.args}`
    print(`  ${label.padEnd(24)} ${dim(command.description)}`)
  }
  print(`\n  ${dim('Type / for the menu; Ctrl-D also exits.')}\n`)
}

/**
 * Seed the previous transcript while keeping the **current** system prompt.
 *
 * The loop seed is `[promptHead, [history, newUser]]`: `promptHead` is rebuilt
 * from the prompt stack for this turn (memory, compaction, tool inventory). The
 * old version replaced the `promptHead` input with the whole history, so every
 * follow-up turn silently reused the previous system message — enabling a tool
 * mid-chat changed the request but the model still read "no tools".
 *
 * The history's own system message is dropped; the fresh `promptHead` supplies
 * it. Tool calls and tool results stay in order.
 */
const seedHistory = (graph: unknown, history: readonly ChatMessage[]): unknown => {
  if (history.length === 0) return graph
  const previous = history.filter((message) => message.role !== 'system')
  if (previous.length === 0) return graph
  const g = structuredClone(graph) as MutableGraph
  const loop = g.nodes.find(node => node['type'] === 'z1.flow.loop')
  if (!loop) return graph
  const loopId = String(loop['id'])
  const seed = g.edges.find(edge => edge.to.node === loopId && edge.to.port === 'seed')
  if (!seed) return graph
  const concat = g.nodes.find(node => node['id'] === seed.from.node)
  if (!concat || concat['type'] !== 'z1.core.concat') return graph
  const concatId = String(concat['id'])

  // `seed = concat(promptHead, seedUser)`, and `seedUser = concat(empty, user)`.
  // Fill the empty constant; leave `promptHead` alone.
  const userEdge = g.edges.find(edge => edge.to.node === concatId && edge.to.port === 'b')
  if (!userEdge) return graph
  const userConcat = g.nodes.find(node => node['id'] === userEdge.from.node)
  if (!userConcat || userConcat['type'] !== 'z1.core.concat') return graph
  const userConcatId = String(userConcat['id'])
  const emptyEdge = g.edges.find(edge => edge.to.node === userConcatId && edge.to.port === 'a')
  if (!emptyEdge) return graph
  const empty = g.nodes.find(node => node['id'] === emptyEdge.from.node)
  if (!empty || empty['type'] !== 'z1.core.const') return graph

  const current = empty['config']
  empty['config'] = {
    ...(typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {}),
    value: previous,
  }
  return g
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
 * A compact, authoritative list for the system prompt. The provider omits the
 * wire `tools` array when no tool is enabled, so without this block the model
 * has no way to know that it has none and tends to invent "basic" tools.
 *
 * Names only: the enabled tools' full JSON schemas already travel in the same
 * request, and short names keep the custom section negligible beside the
 * 6000-token prompt budget (the custom slot is dropped first when it overflows).
 */
const toolInventoryText = (
  enabled: readonly ToolSchema[],
  total: number,
  known: boolean,
): string => {
  const heading = '## Tools available this turn'
  if (!known) {
    return [
      heading,
      '',
      'The tool inventory could not be read in this run. Do not claim or call any tool. If the task needs one, say the tool service is unavailable.',
    ].join('\n')
  }
  if (enabled.length === 0) {
    return [
      heading,
      '',
      'None. You have no tools this turn: you cannot read files, edit files, run commands, search, browse, or use any other tool. Do not claim to have done so. If the task needs a tool, say in one sentence which one, and ask the user to enable it with /tools.',
    ].join('\n')
  }
  const names = enabled.map((tool) => `\`${tool.name}\``).join(', ')
  const off = Math.max(0, total - enabled.length)
  const count =
    off > 0
      ? `${String(enabled.length)} of ${String(total)} installed; ${String(off)} turned off`
      : `all ${String(total)} installed`
  return [
    heading,
    '',
    `You have: ${names} (${count}).`,
    'That list is the complete set. Never claim or call a tool not named here. Their schemas are attached to this request. If a task needs a missing tool, say which one and ask the user to enable it with /tools.',
  ].join('\n')
}

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
  } = {},
): Promise<TurnResult> => {
  const maxSteps = options.maxSteps ?? stepLimit(process.env['Z1_MAX_STEPS'])
  const contextWindow =
    options.contextWindow ?? (Number(process.env['Z1_CONTEXT_WINDOW'] ?? '128000') || 128_000)

  // The prompt must agree with the tool service. Read the same inventory the
  // guard will advertise, so "all tools off" becomes an explicit "None" in the
  // system message instead of a request that merely lacks a tools array.
  const guardedTools = createGuardedTools(handle.services.tools)
  let enabledTools: readonly ToolSchema[] = []
  let totalTools = 0
  let inventoryKnown = true
  try {
    const installed = await handle.services.tools.list()
    totalTools = installed.length
    const { prefs } = loadToolPreferences()
    enabledTools = installed.filter((tool) => toolState(prefs, tool.name) === 'enabled')
  } catch {
    inventoryKnown = false
  }

  let built: unknown = buildAgentGraph({
    model,
    maxSteps,
    system: toolInventoryText(enabledTools, totalTools, inventoryKnown),
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
  })
  if (options.forceCompact === true) built = forceCompaction(built, options.lastTokens ?? 2_000)
  const graph = seedHistory(built, history)
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

  let streamed = false
  const controller = new AbortController()
  activeAbort = controller
  const result: RunResult = await runGraph({
    signal: controller.signal,
    graph: graph as never,
    input: prompt,
    registry: handle.registry,
    services: {
      ...handle.services,
      // One policy for both the advertised list and execution. The model sees
      // only enabled tools, and a hallucinated name is rejected as a tool error
      // (z1.tool.call turns a throw into data), so it cannot run hidden tools.
      tools: guardedTools,
      onEvent: (event) => {
        if (event.type === 'node.stream' && event.port === 'text' && event.path.endsWith('/chat')) {
          streamed = true
        }
        progress.event(event)
      },
    },
    runId,
    journal: runtime.journal,
  })

  // A completed run's answer was streamed; print it only when nothing arrived
  // (a provider without streaming, or a mock that answers in one shot).
  activeAbort = undefined
  const output = String(result.outputs['output'] ?? '')
  if (result.status === 'completed' && !streamed && output.length > 0) {
    progress.print(output)
  }

  progress.settle(result.status, result.error)

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
  if (next.length === 0) {
    next = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: output },
    ]
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

  return { status: result.status, output, error: result.error, history: next, ...(context === undefined ? {} : { context }) }
}

interface Options {
  once?: string
  model?: string
}

const parseArgs = (): Options => {
  const options: Options = {}
  // argv[0] is the interpreter and argv[1] the script, under `tsx script.ts`.
  const rest = argv.slice(2)
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? ''
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
    console.error(`chat: unknown argument ${arg}`)
    process.exit(2)
  }
  return options
}

const modelFrom = (raw: string): ModelHandle => {
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) {
    console.error(`chat: model must be provider/model, got "${raw}"`)
    process.exit(2)
  }
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

/**
 * One shot: no banner, no prompt loop. Same progress, final answer, exit 0 on a
 * completed run and 1 otherwise.
 */
const oneShot = async (prompt: string, explicitModel: string | undefined): Promise<number> => {
  // Slash commands belong to the interactive loop; sending one to the model
  // would look like a prompt and silently do nothing.
  const trimmed = prompt.trimStart()
  if (trimmed.startsWith('/')) {
    const command = trimmed.split(/\s+/, 1)[0] ?? trimmed
    console.error(`chat --once: ${command} is an interactive command; run z1 without --once`)
    return 2
  }
  const config = loadRuntimeConfig({ cwd: process.cwd(), env: process.env, overrides: { live: true } })
  const runtime = await createRuntime(config)
  const tail = createTail()
  const progress = createProgress(tail)
  const model = explicitModel === undefined ? defaultModel() : modelFrom(explicitModel)
  progress.print(`› ${prompt}`)
  // Without a terminal an approval would block forever, so it is declined and
  // reported instead of silently hanging the run.
  const handle = await runtime.beginRun({ approval: quietApproval(progress) })
  try {
    const outcome = await runTurn(runtime, handle, model, [], prompt, progress)
    if (outcome.context !== undefined) {
      progress.print(
        dim(
          `⬡ ctx ${formatTokens(outcome.context.tokens)}/${formatTokens(outcome.context.window)} · ${String(Math.round(outcome.context.ratio * 100))}%`,
        ),
      )
    }
    progress.closeLine()
    return outcome.status === 'completed' ? 0 : 1
  } finally {
    await handle.dispose()
    await runtime.close()
    rl?.close()
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
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
    return name.length === 0 ? undefined : name
  } catch {
    return undefined
  }
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

const interactive = async (explicitModel: string | undefined): Promise<void> => {
  const config = loadRuntimeConfig({ cwd: process.cwd(), env: process.env, overrides: { live: true } })
  const runtime = await createRuntime(config)
  let model = explicitModel === undefined ? defaultModel() : modelFrom(explicitModel)
  let history: ChatMessage[] = []
  let lastTokens = 0
  let lastContext: TurnContext | undefined
  let forceCompact = false
  let maxSteps = stepLimit(process.env['Z1_MAX_STEPS'])
  let contextWindow = Number(process.env['Z1_CONTEXT_WINDOW'] ?? '128000') || 128_000

  const branch = gitBranch(config.cwd)

  // Tool inventory for the banner and `/tools`: one short-lived run so the
  // module worker behind `services.tools` exists, then dispose it. Nothing in
  // that probe asks for approval, so a rejecting stub is enough.
  const probeApproval: ApprovalService = { request: async () => 'rejected' }
  let tools: readonly ToolSchema[] = []
  const refreshTools = async (): Promise<void> => {
    const probe = await runtime.beginRun({ approval: probeApproval })
    try {
      tools = await probe.services.tools.list()
    } finally {
      await probe.dispose()
    }
  }
  try {
    await refreshTools()
  } catch (error) {
    console.log(`tools · unavailable (${error instanceof Error ? error.message : String(error)})`)
  }

  // Enablement is an overlay on the live list, shared by every z1 session. The
  // startup read is only for the first drawing; every turn re-reads it inside
  // the guarded tool service, so another session's change applies immediately.
  const loadedPrefs = loadToolPreferences()
  let toolPrefs: ToolPreferences = loadedPrefs.prefs
  let toolPrefsError = loadedPrefs.error
  const prefsPath = loadedPrefs.path
  /** Names in the order of the last printed `/tools` list, for `off 3`. */
  let toolListing: string[] | undefined

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
  // The shell line that launched z1 is exactly one row above the cursor.
  // Erase that line only; in pinned mode the banner lives on the alternate
  // screen, so the normal buffer stays clean for the shell after exit.
  if (stdout.isTTY) stdout.write('\x1b[1A\x1b[2K\r')
  if (!pinnedMode) printBox(buildBanner())

  const tail = createTail({ live: process.env['Z1_TRAY'] !== 'off', pinned: pinnedMode })
  tail.setHeader(buildBanner)
  /** Everything the user sees from here on goes through the tail. */
  const say = (line = ''): void => tail.print(line)

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

  const reloadToolPrefs = (): void => {
    const loaded = loadToolPreferences()
    toolPrefs = loaded.prefs
    toolPrefsError = loaded.error
  }
  const enabledToolCount = (): number =>
    tools.filter((tool) => toolState(toolPrefs, tool.name) === 'enabled').length
  /** `20/22` in the footer: what the agent can use, not just what is installed. */
  const toolCountLabel = (): string =>
    tools.length === 0 ? '0' : `${String(enabledToolCount())}/${String(tools.length)}`

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
   * `/tools` keeps a numbered list so `off 3` is easy. Numbers resolve against
   * the last printed list, so a stale index cannot silently hit another tool
   * after the module set changes; names always resolve against the live list.
   */
  const printTools = (includeOrphans: boolean): void => {
    reloadToolPrefs()
    const installed = new Set(tools.map((tool) => tool.name))
    const rows = tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      state: toolState(toolPrefs, tool.name),
      installed: true,
    }))
    if (includeOrphans) {
      for (const [name, entry] of Object.entries(toolPrefs.tools)) {
        if (installed.has(name)) continue
        rows.push({ name, description: '', state: entry.state, installed: false })
      }
    }
    toolListing = rows.map((row) => row.name)

    const live = rows.filter((row) => row.installed)
    const off = live.filter((row) => row.state === 'disabled').length
    const deleted = live.filter((row) => row.state === 'deleted').length
    const stale = rows.length - live.length
    const parts = [`${green(String(live.length - off - deleted))} enabled`]
    if (off > 0) parts.push(`${yellow(String(off))} off`)
    if (deleted > 0) parts.push(`${red(String(deleted))} deleted`)
    if (stale > 0) parts.push(`${String(stale)} stale`)
    say(`${bold('tools')} · ${String(tools.length)} installed · ${parts.join(' · ')}`)
    if (toolPrefsError !== undefined) {
      say(red(`tools · preferences unreadable (${prefsPath}): ${toolPrefsError}`))
      say(dim('  every tool is treated as enabled until the file is fixed or replaced'))
    }
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
      say(`${prefix}${padTo(fit(row.name, nameWidth), nameWidth)}${suffix}${missing}`)
    }
    if (deleted > 0) {
      say(dim('  deleted tools stay installed in the module but are hidden from the agent.'))
      say(dim('  /tools restore <n|name> brings one back; /tools --all shows stale entries.'))
    }
  }

  const findToolName = (selector: string): string | undefined => {
    if (/^\d+$/.test(selector)) {
      const listing = toolListing ?? tools.map((tool) => tool.name)
      return listing[Number(selector) - 1]
    }
    if (tools.some((tool) => tool.name === selector)) return selector
    // A deleted tool that is no longer installed still has a preference entry,
    // and must remain selectable for `restore`.
    if (Object.hasOwn(toolPrefs.tools, selector)) return selector
    return undefined
  }

  const applyToolState = (names: readonly string[], state: ToolState): boolean => {
    const previous = toolPrefs
    // Re-read just before writing: another z1 session may have toggled a
    // different tool since this command started. Whole-file rename is still
    // last-writer-wins for two truly simultaneous writes.
    const fresh = loadToolPreferences()
    const next = withToolStates(fresh.prefs, names, state)
    const saved = saveToolPreferences(next)
    if (!saved.ok) {
      // The guarded tool service re-reads the file, so an unsaved change would
      // make the list disagree with what the agent can actually call.
      toolPrefs = previous
      say(red(`tools · could not save preferences (${saved.path}): ${saved.error}`))
      refreshStatus()
      return false
    }
    toolPrefs = next
    toolPrefsError = undefined
    refreshStatus()
    return true
  }

  const toolMenuItems = (): readonly ToolMenuItem[] =>
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      state: toolState(toolPrefs, tool.name),
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
    reloadToolPrefs()
    composer.openToolMenu(toolMenuItems(), (action, name) => {
      reloadToolPrefs()
      const current = toolState(toolPrefs, name)
      const next: ToolState =
        action === 'delete' ? 'deleted' : current === 'enabled' ? 'disabled' : 'enabled'
      if (current !== next) applyToolState([name], next)
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
      try {
        await refreshTools()
        toolListing = undefined
        reloadToolPrefs()
        say(`tools · refreshed · ${String(tools.length)} installed`)
      } catch (error) {
        say(red(`tools · unavailable (${error instanceof Error ? error.message : String(error)})`))
      }
      return
    }

    const words = rest.split(/\s+/)
    const verb = (words[0] ?? '').toLowerCase()
    const selector = words.slice(1).join(' ').trim()
    if (!['on', 'off', 'delete', 'restore', 'reset'].includes(verb)) {
      say('usage: /tools [on|off|delete|restore|reset] <n|name> | /tools refresh | /tools --all')
      return
    }

    reloadToolPrefs()
    if (verb === 'reset') {
      const names = Object.keys(toolPrefs.tools)
      const wasBroken = toolPrefsError !== undefined
      if (names.length === 0 && !wasBroken) {
        say('tools · preferences already empty')
        return
      }
      if (!applyToolState(names, 'enabled')) return
      say(
        wasBroken
          ? 'tools · preferences reset · the unreadable file was replaced'
          : `tools · preferences cleared · ${String(names.length)} restored to defaults`,
      )
      return
    }
    if (selector === '') {
      const all = verb === 'on' || verb === 'off' || verb === 'restore' ? '|all' : ''
      say(`usage: /tools ${verb} <n|name>${all}`)
      return
    }
    if (verb === 'off' && selector === 'all') {
      const names = tools
        .map((tool) => tool.name)
        .filter((name) => toolState(toolPrefs, name) !== 'disabled')
      if (names.length === 0) {
        say('tools · every tool is already off')
        return
      }
      if (!applyToolState(names, 'disabled')) return
      say(`tools · ${String(names.length)} tools off`)
      return
    }
    if ((verb === 'on' || verb === 'restore') && selector === 'all') {
      const names =
        verb === 'on'
          ? Array.from(new Set([...tools.map((tool) => tool.name), ...Object.keys(toolPrefs.tools)])).filter(
              (name) => toolState(toolPrefs, name) !== 'enabled',
            )
          : Object.entries(toolPrefs.tools)
              .filter(([, entry]) => entry.state === 'deleted')
              .map(([name]) => name)
      if (names.length === 0) {
        say(verb === 'on' ? 'tools · every tool is already on' : 'tools · nothing is deleted')
        return
      }
      if (!applyToolState(names, 'enabled')) return
      say(
        verb === 'on'
          ? `tools · ${String(names.length)} tools on`
          : `tools · ${String(names.length)} tools restored`,
      )
      return
    }

    const name = findToolName(selector)
    if (name === undefined) {
      say(`tools · no tool "${selector}" · /tools for the list`)
      return
    }
    const current = toolState(toolPrefs, name)
    if (verb === 'off') {
      if (current === 'disabled') {
        say(`tools · ${name} is already off`)
        return
      }
      if (!applyToolState([name], 'disabled')) return
      say(
        current === 'deleted'
          ? `tools · ${name} deleted → off · still hidden from the agent`
          : `tools · ${name} off · hidden from the agent`,
      )
      return
    }
    if (verb === 'delete') {
      if (current === 'deleted') {
        say(`tools · ${name} is already deleted`)
        return
      }
      if (!applyToolState([name], 'deleted')) return
      say(`tools · ${name} deleted · hidden from the agent · /tools restore ${name}`)
      return
    }
    if (verb === 'restore') {
      if (current === 'enabled') {
        say(`tools · ${name} is already on`)
        return
      }
      if (!applyToolState([name], 'enabled')) return
      say(`tools · ${name} ${current === 'deleted' ? 'restored' : 'enabled'} · on`)
      return
    }
    // on: restores a tombstone too, so a deleted tool needs one command.
    if (current === 'enabled') {
      say(`tools · ${name} is already on`)
      return
    }
    if (!applyToolState([name], 'enabled')) return
    say(`tools · ${name} on`)
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
      reloadToolPrefs()
      refreshStatus()
      if (pendingLines.length === 0) tail.idle()

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

      // The submitted prompt becomes ordinary scrollback; the composer below
      // stays exactly once.
      const parts = line.split('\n')
      if (composer !== undefined || rl?.terminal !== true) {
        parts.forEach((part, index) => {
          const line = `${index === 0 ? '│ ' : '  '}${part}`
          // A full-width, one-cell-short bar stays a single row and makes the
          // user's turn easy to spot between assistant blocks.
          const bar = colorEnabled ? padTo(line, Math.max(1, terminalColumns() - 1)) : line
          say(paint('48;5;237', bar))
        })
      }

      if (line === '/exit' || line === '/quit') break
      if (line === '/help') { usage(say); continue }
      if (line === '/new') {
        history = []
        say('conversation cleared')
        continue
      }
      if (line === '/context') {
        if (lastContext === undefined) {
          say('context · no completed turn yet')
        } else {
          say(
            `context · ${formatTokens(lastContext.tokens)}/${formatTokens(lastContext.window)} (${Math.round(lastContext.ratio * 100)}%)${lastContext.compactedTurns > 0 ? ` · compacted ${lastContext.compactedTurns} turns` : ''}`,
          )
        }
        continue
      }
      if (line.startsWith('/window ')) {
        const value = Number(line.slice('/window '.length).trim())
        if (!Number.isFinite(value) || value <= 0) {
          say('usage: /window <tokens>, e.g. /window 200000')
          continue
        }
        contextWindow = Math.floor(value)
        say(`window · ${formatTokens(contextWindow)}`)
        continue
      }
      if (line.startsWith('/steps ')) {
        const raw = line.slice('/steps '.length).trim()
        const value = Number(raw)
        if (raw !== 'off' && (!Number.isInteger(value) || value < 1)) {
          say('usage: /steps <n> | /steps off')
          continue
        }
        maxSteps = raw === 'off' ? STEP_CEILING : Math.min(STEP_CEILING, value)
        say(`steps · ${stepLabel(maxSteps)}`)
        continue
      }
      if (line === '/compact') {
        forceCompact = true
        lastTokens = lastContext?.tokens ?? lastTokens
        say('context · compaction forced for the next turn')
        continue
      }
      if (line === '/tools' || line.startsWith('/tools ')) {
        await handleTools(line)
        continue
      }
      if (line === '/window') {
        say('usage: /window <tokens>, e.g. /window 200000')
        continue
      }
      if (line === '/steps') {
        say('usage: /steps <n> | /steps off')
        continue
      }
      if (line.startsWith('/model ')) {
        const raw = line.slice('/model '.length).trim()
        const slash = raw.indexOf('/')
        if (slash <= 0 || slash === raw.length - 1) {
          say('usage: /model provider/model')
          continue
        }
        model = { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
        say(`model · ${modelLabel(model)}`)
        continue
      }
      if (line === '/model') {
        say('usage: /model provider/model')
        continue
      }
      if (line.startsWith('/')) {
        // A slash command is never sent to the model. A known name with the
        // wrong shape gets its usage; anything else is a menu miss.
        const name = line.split(/\s+/, 1)[0] ?? line
        const spec = COMMANDS.find((command) => command.name === name)
        if (spec !== undefined) {
          say(spec.args === undefined ? `${name} takes no arguments` : `usage: ${name} ${spec.args}`)
        } else {
          say(`unknown command ${name} · type / for the menu`)
        }
        continue
      }

      composer?.setBusy(true)
      // A queued prompt may start while the picker is open; a running turn
      // owns the transcript, so the picker must not float over it.
      composer?.closeToolMenu()
      const progress = createProgress(tail)
      const handle = await runtime.beginRun({ approval })
      try {
        const outcome = await runTurn(runtime, handle, model, history, line, progress, {
          forceCompact,
          lastTokens,
          maxSteps,
          contextWindow,
        })
        forceCompact = false
        history = outcome.history
        if (outcome.context !== undefined) {
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
      }
      composer?.setBusy(false)
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
  oneShot(options.once, options.model)
    .then(code => { process.exitCode = code })
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
} else {
  interactive(options.model).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
