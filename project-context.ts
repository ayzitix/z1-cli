/**
 * The one system-prompt section that carries the project's own instructions.
 *
 * A repository writes its rules down in `AGENTS.md` — comment language, the
 * style a file keeps, which command is the real check — and a session that
 * starts in it is expected to have read them. Without this section every
 * session begins blind to all of it and has to be told again in each first
 * prompt, which is exactly what the file exists to avoid.
 *
 * The whole chain, root first: a nested `AGENTS.md` is more specific than its
 * parent, so both arrive, and the nearest file comes last — where a model that
 * reads a prompt top-down reads it last. That chain is also why there are
 * budgets: 32 KiB per file and 64 KiB for the set keep one huge root file from
 * crowding out the subdirectory that says what this task is about. What a cut
 * leaves behind is a visible marker, so a model holding a prefix knows it holds
 * a prefix instead of inventing the rest.
 *
 * Read on every turn, never cached: the system prompt is rebuilt from the
 * turn's snapshot, and `AGENTS.md` usually changes while the agent is working
 * on the very thing it describes. A cache would hide the edit until a restart.
 *
 * Silent on failure: the file may be a directory, locked by an editor, or
 * unreadable for a reason this process cannot fix. A prompt section is no place
 * to fail a turn over that, so a candidate that is not a readable regular file
 * is skipped; the model then simply has no rules, which is the state every
 * session was in before this section existed.
 *
 * A file with nothing in it is not context either: an empty `AGENTS.md` (or one
 * holding a BOM and blank lines) would otherwise become a heading with an empty
 * body — one more thing to read for no rule at all.
 *
 * Only the head of an over-budget file is read. A 40 MiB `AGENTS.md` would
 * otherwise cost 40 MiB of I/O on every turn, and one past Node's 2 GiB string
 * limit would throw instead of arriving truncated; the cut is what the model
 * gets either way, so reading past it buys nothing.
 *
 * Deliberately not here (the next slice): the global `~/.config/z1/AGENTS.md`,
 * a `CLAUDE.md` fallback, and `@imports`.
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { findRepoRoot } from './sdk.ts'

/** The file name a project writes its rules in, at every level of the tree. */
export const PROJECT_CONTEXT_FILE = 'AGENTS.md'

/** Per-file ceiling: a bigger single file is context nobody asked for. */
export const PER_FILE_BYTES = 32_768

/** Chain ceiling: the whole root-to-workspace set shares one budget. */
export const CHAIN_BYTES = 65_536

/** The section heading, for callers that compose the slot themselves. */
export const PROJECT_CONTEXT_HEADING = '## Project context (AGENTS.md)'

/**
 * The prompt stack's default ceiling, mirrored from
 * `z1-sdk/z1/packages/prompt/src/stack.ts` (`DEFAULT_BUDGET_TOKENS`): what
 * `buildAgentGraph` uses when the caller passes no `budgetTokens`.
 *
 * Mirroring a default is normally a smell, and here it is a deliberate one: the
 * stack drops the whole `custom` section — every z1-cli section — once the total
 * passes the ceiling, so the CLI has to know the number it is raising.
 */
export const STACK_BUDGET_TOKENS = 6000

/**
 * The stack ceiling that keeps this section: the default, plus the section's own
 * chars/4 estimate, plus 256 tokens of slack for the headings and for the gap
 * between an estimate and a real tokenizer.
 *
 * The base 6000 already covers the built-in stack, `toolInventoryText` and
 * `ownStateText` — measured, the built-in prompt is ~7.9k chars (≈2k tokens) and
 * those two sections ~2k chars (≈0.5k tokens) on the wire, both under the default — so
 * without an `AGENTS.md` no budget is passed and a turn costs exactly what it
 * did before.
 */
export function projectContextBudget(text: string): number {
  return text === '' ? STACK_BUDGET_TOKENS : STACK_BUDGET_TOKENS + Math.ceil(text.length / 4) + 256
}

/** One readable `AGENTS.md` of the chain. */
export interface ProjectContextFile {
  /** Absolute path of the file that was read. */
  path: string
  /** The text the prompt carries: BOM and CRLF gone, cut text marked when cut. */
  text: string
  /**
   * What this record spends of the chain budget: the UTF-8 bytes of `text`,
   * which for a cut file is the kept prefix plus its marker. Counting the file
   * on disk instead would let a truncated file spend budget on bytes the model
   * never sees.
   */
  bytes: number
  /** Whether the per-file ceiling cut `text`. */
  truncated: boolean
}

/** What the chain budget dropped, so the section can say so instead of hiding it. */
export interface ProjectContextOmission {
  /** Absolute paths of the dropped files, farthest from the workspace first. */
  paths: readonly string[]
  /** The budget that dropped them, in bytes. */
  bytes: number
}

/**
 * The chain `discoverProjectContextFiles` answers with: a plain list of files,
 * plus the omission the budget produced. The omission rides on the array
 * because it is the one value `projectContextText` receives — moving it into a
 * separate return type would only make the caller juggle two things that
 * describe the same turn.
 */
export type ProjectContextChain = ProjectContextFile[] & { readonly omission?: ProjectContextOmission }

/** `a/b` on every platform: a Windows heading must not read `a\b`. */
const posix = (path: string): string => path.split(sep).join('/')

/** CRLF and a leading BOM are what an editor adds and the model must not count. */
const normalize = (text: string): string =>
  (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n')

/**
 * The directory the headings are relative to: the repository root, or `cwd`
 * when it is not in one.
 *
 * Exported so the caller that composes the section labels the same files with
 * the same names as `/context` does — one rule, one place.
 */
export function projectContextRoot(cwd: string): string {
  const start = resolve(cwd)
  return findRepoRoot(start) ?? start
}

/**
 * `a/b/AGENTS.md` when the file is inside `root`, the absolute posix path
 * otherwise. A `..` never reaches the prompt: a path the model cannot mistake
 * for a project file is worth the extra characters.
 */
export function projectContextLabel(path: string, root?: string): string {
  if (root === undefined) return posix(path)
  const rel = relative(resolve(root), path)
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  return inside ? posix(rel) : posix(path)
}

/**
 * Root→workspace, both included. A workspace outside `root` gets itself alone:
 * walking up to a directory that is not an ancestor would read files that are
 * not part of this project.
 */
const chainDirs = (cwd: string, root: string): string[] => {
  const dirs: string[] = []
  let dir = cwd
  for (;;) {
    dirs.push(dir)
    if (dir === root) return dirs.reverse()
    const parent = dirname(dir)
    if (parent === dir) return [cwd]
    dir = parent
  }
}

/**
 * `buffer` cut at `limit` without splitting a character. A byte that is still a
 * UTF-8 continuation byte (`10xxxxxx`) at the cut belongs to a character that
 * started earlier, so the cut steps back to that character's first byte —
 * decoding half a character would put U+FFFD in the prompt instead of the text.
 */
const cutAtCharacter = (buffer: Buffer, limit: number): Buffer => {
  let end = Math.max(0, Math.min(limit, buffer.length))
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end)
}

/**
 * What a cut leaves. The same `… [z1: …] …` shape the SDK puts on a clipped
 * tool result, on a line of its own: the model has met the form before, so the
 * marker needs no explanation it would have to invent.
 */
const truncationMarker = (bytes: number): string =>
  `\n\n… [z1: ${PROJECT_CONTEXT_FILE} truncated at ${String(bytes)} bytes] …`

/** The budget, worded the way a person reads it: 200 bytes, never `0 KiB`. */
const budgetLabel = (bytes: number): string =>
  bytes < 1024 ? `${String(bytes)} bytes` : `${String(Math.round(bytes / 1024))} KiB`

/** The budget marker: which files did not fit, named the way the blocks are. */
const omissionMarker = (omission: ProjectContextOmission, root: string | undefined): string =>
  `[z1: ${String(omission.paths.length)} earlier project context ${omission.paths.length === 1 ? 'file' : 'files'} omitted: ${budgetLabel(omission.bytes)} budget: ${omission.paths.map((path) => projectContextLabel(path, root)).join(', ')}]`

/**
 * How many disk bytes are read before the cut is known: `HEAD_BYTES(limit)`.
 *
 * The limit counts normalized text, and normalizing can only shrink: a CRLF
 * pair becomes one byte, so the worst case is two disk bytes per kept byte. The
 * `+ 4` covers a 3-byte BOM plus one byte of slack on the boundary.
 */
const headBytes = (limit: number): number => 2 * limit + 4

/**
 * The first `bytes` of a file. `readSync` may answer with fewer bytes than
 * asked for, so the loop keeps a short read from looking like a short file.
 */
const readHead = (path: string, bytes: number): Buffer => {
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(bytes)
    let filled = 0
    while (filled < bytes) {
      const read = readSync(descriptor, buffer, filled, bytes - filled, filled)
      if (read <= 0) break
      filled += read
    }
    return buffer.subarray(0, filled)
  } finally {
    closeSync(descriptor)
  }
}

/** The cut text: the kept prefix without its trailing line breaks, then the marker. */
const clippedText = (text: string, limit: number): string =>
  `${cutAtCharacter(Buffer.from(text, 'utf8'), limit).toString('utf8').replace(/[\r\n]+$/, '')}${truncationMarker(limit)}`

/** One candidate: `undefined` for anything that carries no rules. */
const readContextFile = (dir: string, perFileBytes: number): ProjectContextFile | undefined => {
  const path = join(dir, PROJECT_CONTEXT_FILE)
  // A negative ceiling is a caller error, not a licence to slice from the end.
  const limit = Math.max(0, perFileBytes)
  const window = headBytes(limit)
  try {
    const stat = statSync(path)
    // A directory (or a device) with that name is not project context.
    if (!stat.isFile()) return undefined
    // The head is read only when the file cannot fit even after normalizing:
    // shrinking is at most one byte per two (CRLF→LF) plus a 3-byte BOM, so a
    // disk size above `2 * limit + 4` leaves at least `limit + 1` normalized
    // bytes. Deciding on disk size alone used to cut CRLF files that fit.
    const head = stat.size > window ? readHead(path, window) : undefined
    const text = normalize((head ?? readFileSync(path)).toString('utf8'))
    const bytes = Buffer.byteLength(text, 'utf8')
    if (head === undefined && bytes <= limit) {
      // Nothing but a BOM, blank lines or spaces says nothing — but only when
      // the file was read whole: an all-blank head is a cut file, not silence.
      if (text.trim() === '') return undefined
      return { path, text, bytes, truncated: false }
    }
    const clipped = clippedText(text, limit)
    return { path, text: clipped, bytes: Buffer.byteLength(clipped, 'utf8'), truncated: true }
  } catch {
    // Locked, gone, refused: no rules beat a failed turn.
    return undefined
  }
}

/**
 * Every `AGENTS.md` from the repository root down to `cwd`, in that order.
 *
 * `limits` exists for the tests and for a caller that wants a smaller section;
 * the defaults are the documented budgets.
 */
export function discoverProjectContextFiles(
  cwd: string,
  limits: { perFileBytes?: number; chainBytes?: number } = {},
): ProjectContextChain {
  const start = resolve(cwd)
  const root = projectContextRoot(start)
  const perFileBytes = limits.perFileBytes ?? PER_FILE_BYTES
  const chainBytes = limits.chainBytes ?? CHAIN_BYTES

  const found: ProjectContextFile[] = []
  for (const dir of chainDirs(start, root)) {
    const file = readContextFile(dir, perFileBytes)
    if (file !== undefined) found.push(file)
  }

  // Nearest first: a nested file says what this task is about, the root file
  // says what the repository is about — so the budget keeps the specific one.
  // The chain ends at the first file that no longer fits, which leaves a
  // root→workspace prefix rather than a hole in the middle of it.
  const kept: ProjectContextFile[] = []
  const omitted: string[] = []
  let total = 0
  for (let index = found.length - 1; index >= 0; index -= 1) {
    const file = found[index]
    if (file === undefined) continue
    if (total + file.bytes > chainBytes) {
      for (let dropped = 0; dropped <= index; dropped += 1) {
        const path = found[dropped]?.path
        if (path !== undefined) omitted.push(path)
      }
      break
    }
    total += file.bytes
    kept.unshift(file)
  }

  const chain = kept as ProjectContextChain
  if (omitted.length > 0) {
    Object.defineProperty(chain, 'omission', {
      value: Object.freeze({ paths: Object.freeze(omitted), bytes: chainBytes }),
      // Not enumerable: a caller that maps or spreads this array gets its files
      // and nothing else.
      enumerable: false,
    })
  }
  Object.freeze(chain)
  return chain
}

/**
 * The section body for the custom prompt slot — `''` when the project has no
 * `AGENTS.md` at all, so the caller can drop the slot with the same
 * `.filter(Boolean)` it uses for the others.
 *
 * Farthest first, one heading per file, so the nearest instructions are the
 * last thing read before the turn. `root` is the directory the headings are
 * relative to (`projectContextRoot`); without it they are absolute.
 *
 * A chain that kept no file but still has an omission answers with the marker
 * alone: the budget dropped rules this project does have, and going silent
 * would report the one thing that is not true.
 */
export function projectContextText(files: readonly ProjectContextFile[], root?: string): string {
  const omission = (files as ProjectContextChain).omission
  if (files.length === 0) return omission === undefined ? '' : omissionMarker(omission, root).trim()
  const blocks = files.map(
    (file) => `### ${projectContextLabel(file.path, root)}\n\n${file.text.trim()}`,
  )
  return [
    ...(omission === undefined ? [] : [omissionMarker(omission, root), '']),
    PROJECT_CONTEXT_HEADING,
    '',
    blocks.join('\n\n'),
  ]
    .join('\n')
    .trim()
}

/** `12` / `8.2k` — the console's `formatTokens` rounding, kept local because importing `chat.ts` starts a session. */
const tokenLabel = (chars: number): string => {
  const tokens = Math.max(0, Math.round(chars / 4))
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`
}

/** `HH:MM` in the caller's own timezone: what the user's clock says. */
const clockLabel = (now: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * One compact line for `/context`: how much of the next request is project
 * rules, where they come from, and which files the budget could not carry.
 *
 * Pure over a discovered chain, so a test pins the wording without starting a
 * console: `files` is what `discoverProjectContextFiles` returned, `root` the
 * directory the labels are relative to, `now` the clock the line reports.
 */
export function projectContextSummary(
  files: readonly ProjectContextFile[],
  root?: string,
  now: Date = new Date(),
): string {
  const omission = (files as ProjectContextChain).omission
  // Nothing to report is a report: the project simply has no rules yet.
  if (files.length === 0 && omission === undefined) {
    return `project · no ${PROJECT_CONTEXT_FILE} in this project`
  }
  const labels = files.map((file) => projectContextLabel(file.path, root))
  const parts = ['project']
  if (files.length > 0) {
    parts.push(`${String(files.length)} ${PROJECT_CONTEXT_FILE} ${files.length === 1 ? 'file' : 'files'}`)
  }
  if (omission !== undefined) {
    parts.push(`${String(omission.paths.length)} earlier omitted`)
    // Nothing was kept, so the kept files name no source at all: the line names
    // the dropped ones instead, the same labels the section's marker prints.
    if (labels.length === 0) labels.push(...omission.paths.map((path) => projectContextLabel(path, root)))
  }
  // The estimate covers exactly the section the next request will carry, marker
  // included: a marker-only chain really does cost the model these characters.
  parts.push(`~${tokenLabel(projectContextText(files, root).length)} tokens`, `as of ${clockLabel(now)}`)
  if (labels.length > 0) parts.push(labels.join(' · '))
  return parts.join(' · ')
}
