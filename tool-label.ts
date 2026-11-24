/**
 * How a tool call reads to a person.
 *
 * The transcript used to print the raw argument payload:
 *
 *     ⬢ read({"path":"package.json"})
 *
 * which is a JSON dump in the middle of prose. A reader wants `Read
 * package.json` - the tool as a verb, the one argument that identifies the
 * call, and nothing else. This module is the whole translation table, so the
 * wording is testable and every mode shares it.
 *
 * Rules, from how the reference CLIs read:
 *
 * - **A verb, capitalised**, not the tool id: `read` → `Read`, `web.search` →
 *   `Search`, `git.status` → `Git status`.
 * - **The identifying argument, not the payload**: a path, a pattern, a query,
 *   a command. Two arguments are `x → y`; more than two are `a, b, +N`.
 * - **Paths keep their tail** (`…/src/main.ts`) - the file name is what
 *   identifies a file, its directory is context - and the tail is what
 *   survives truncation.
 * - **Commands keep their head**, because `git status --short` is a different
 *   operation from `git push`.
 * - An unknown tool falls back to its own name and its first argument, never
 *   to `JSON.stringify`.
 */

/** Longest one-line argument the transcript prints before it is cut. */
export const MAX_LABEL = 64

/**
 * Verbs for the tools this project ships. A tool that is not here still gets a
 * readable label: the id with its dots and underscores turned into spaces and
 * the first letter capitalised, so `todo.read` reads `Todo read` rather than
 * disappearing behind a JSON blob.
 */
const VERBS: Readonly<Record<string, string>> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  apply_patch: 'Patch',
  move: 'Move',
  mkdir: 'Mkdir',
  stat: 'Stat',
  list: 'List',
  glob: 'Glob',
  grep: 'Grep',
  tree: 'Tree',
  shell: 'Shell',
  git: 'Git',
  'git.status': 'Git status',
  'git.diff': 'Git diff',
  'git.log': 'Git log',
  'web.search': 'Search',
  'web.fetch': 'Fetch',
  'web.status': 'Web status',
  'stack.search': 'Stack search',
  'github.issues': 'GitHub issues',
  'todo.read': 'Todo',
  subagent: 'Subagent',
  'process.start': 'Start',
  'process.run': 'Run',
  'process.kill': 'Kill',
  'process.list': 'Processes',
  'system.info': 'System info',
}

/** The verb a row starts with. Unknown ids are humanised rather than dropped. */
export const toolVerb = (name: string): string => {
  const known = VERBS[name]
  if (known !== undefined) return known
  const words = name.replace(/[._-]+/g, ' ').trim()
  if (words.length === 0) return name
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/**
 * Keep the end of a path: `…/src/main.ts`.
 *
 * The file name identifies the file; the directory is context the reader
 * usually does not need. Cutting the front also means truncation takes the
 * least useful part first.
 *
 * An *absolute* path is shortened even when it would fit: a transcript row
 * reading `Read C:/Users/alex/Documents/projects/app/src/main.ts` spends most
 * of its width saying where the home directory is, and the next row says it
 * again. Two trailing segments (`app/src/main.ts`'s last two) are the useful
 * part: the file, and the directory that places it.
 */
export const tailPath = (value: string, max = MAX_LABEL): string => {
  const text = value.replace(/\\/g, '/').replace(/\s+/g, ' ').trim()
  const absolute = /^(?:[A-Za-z]:)?\//.test(text)
  // A Windows drive (`C:`) is not a path segment: dropping the root must drop
  // it too, or every row reads `…/C:/Users/…`.
  const body = text.replace(/^[A-Za-z]:/, '')
  const segments = body.split('/').filter((part) => part.length > 0)
  if (segments.length === 0) return text

  // A relative path is shown whole unless it is too long; then its tail wins.
  if (!absolute) {
    if (text.length <= max) return text
    return `…/${joinTail(segments, max - 2)}`
  }

  // An absolute path always drops its root: `…/` plus as many trailing
  // segments as fit, never fewer than the file name itself.
  return `…/${joinTail(segments, max - 1)}`
}

/** As many trailing segments as fit in `max`, joined by `/`. */
function joinTail(segments: readonly string[], max: number): string {
  // Depth is a budget of its own. A path like `a/a/a/…/file.ts` fits in 64
  // characters and is still unreadable: the eye cannot find the file name in
  // it. Three trailing segments is what a reader uses - the file, its parent,
  // and the parent's parent.
  const deepest = segments.slice(-3)
  const kept: string[] = []
  let used = 0
  for (let index = deepest.length - 1; index >= 0; index -= 1) {
    const segment = deepest[index] as string
    const cost = segment.length + (kept.length === 0 ? 0 : 1)
    // Always keep at least one segment, even when the name alone overflows.
    if (kept.length > 0 && used + cost > max) break
    kept.unshift(segment)
    used += cost
  }
  const text = kept.join('/')
  if (text.length <= max) return text
  // A single segment longer than the budget: its own tail, with an ellipsis.
  return `…${text.slice(-(Math.max(1, max - 1)))}`
}

/** Cut a one-line value from the right, keeping its head. */
const headText = (value: string, max = MAX_LABEL): string => {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

/** Join a few identifying values, naming how many were left out. */
const joinArgs = (parts: readonly string[]): string | undefined => {
  const kept = parts.filter((part) => part.length > 0)
  if (kept.length === 0) return undefined
  if (kept.length <= 2) return kept.join(', ')
  return `${kept.slice(0, 2).join(', ')}, +${String(kept.length - 2)}`
}

const asText = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.replace(/\s+/g, ' ').trim()
    return trimmed.length === 0 ? undefined : trimmed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** Keys whose value is a path, in the order a label should prefer them. */
const PATH_KEYS = ['path', 'file', 'target'] as const
/** Keys whose value is a pattern or query, kept as typed. */
const QUERY_KEYS = ['pattern', 'query', 'url', 'glob'] as const
/** Keys whose value is a command, kept by its head. */
const COMMAND_KEYS = ['command', 'cmd'] as const

/**
 * The label for one call: the verb plus whatever identifies it.
 *
 * `undefined` when the call carries no argument worth a row - a tool with an
 * empty payload reads as its verb alone.
 */
export const toolLabel = (name: string, args: unknown): string | undefined => {
  const verb = toolVerb(name)
  if (args === undefined || args === null) return verb
  let record: Record<string, unknown>
  if (typeof args === 'string') {
    const raw = args.trim()
    if (raw === '' || raw === '{}' || raw === 'null') return verb
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return `${verb} ${headText(raw)}`
      }
      record = parsed as Record<string, unknown>
    } catch {
      return `${verb} ${headText(raw)}`
    }
  } else if (typeof args === 'object' && !Array.isArray(args)) {
    record = args as Record<string, unknown>
  } else {
    const text = asText(args)
    return text === undefined ? verb : `${verb} ${headText(text)}`
  }

  // `move`/`edit`-style pairs read as a transition and are worth both ends.
  const from = asText(record['from'])
  const to = asText(record['to'])
  if (from !== undefined && to !== undefined) {
    return `${verb} ${tailPath(from, 24)} → ${tailPath(to, 24)}`
  }

  for (const key of PATH_KEYS) {
    const value = asText(record[key])
    if (value !== undefined) return `${verb} ${tailPath(value)}`
  }
  for (const key of QUERY_KEYS) {
    const value = asText(record[key])
    if (value !== undefined) return `${verb} ${headText(value)}`
  }
  for (const key of COMMAND_KEYS) {
    const value = asText(record[key])
    if (value !== undefined) {
      // `cmd /c dir` and `bash -lc foo` say the shell first; that is the head a
      // reader needs, and the rest is what gets cut.
      const argv = record['args']
      const rest = Array.isArray(argv) ? argv.filter((item) => typeof item === 'string').join(' ') : ''
      return `${verb} ${headText(rest.length > 0 ? `${value} ${rest}` : value)}`
    }
  }
  // A tool with no recognised key still names its first argument.
  const first = Object.values(record).find((value) => typeof value === 'string' || typeof value === 'number')
  const text = asText(first)
  return text === undefined ? verb : `${verb} ${headText(text)}`
}

/**
 * What a result is, in words: `Read 120 lines`, `Listed 6 entries`, `(no
 * output)`.
 *
 * The transcript used to print `✓ 408ms · 163 B` for every call, which is
 * telemetry, not an answer: nobody reads a millisecond count. The useful fact
 * is the *size of what came back*, and only when it is worth naming.
 *
 * `verb: false` drops the leading verb, for a row that already names it
 * (`Read package.json · 7 lines` rather than `… · Read 7 lines`).
 */
export const resultSummary = (
  name: string,
  value: unknown,
  options: { readonly verb?: boolean } = {},
): string | undefined => {
  const verb = options.verb === false ? '' : toolVerb(name)
  const withVerb = (text: string): string => (verb.length === 0 ? text : `${verb} ${text}`)
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0) return '(no output)'
    const lines = text.split('\n').length
    const first = text.split('\n')[0]?.trim() ?? ''
    // A one-line result is its own summary; quoting it is more useful than
    // counting it.
    if (lines === 1) return headText(first, 100)
    return withVerb(`${String(lines)} lines`)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    // A delegation reports its own status; a payload shape is not a summary.
    if (typeof record['status'] === 'string' && record['runId'] !== undefined) return undefined
    const entries = record['entries']
    if (Array.isArray(entries)) {
      return entries.length === 0 ? '(no entries)' : withVerb(`${String(entries.length)} entries`)
    }
    const files = record['files']
    if (Array.isArray(files)) {
      return files.length === 0 ? '(no files)' : withVerb(`${String(files.length)} files`)
    }
    // An `output` field is the common shell/git shape: count its lines.
    const output = record['output']
    if (typeof output === 'string') return resultSummary(name, output, options)
    const error = asText(record['error'])
    if (error !== undefined) return headText(error, 100)
    const keys = Object.keys(record).length
    return keys === 0 ? '(no output)' : undefined
  }
  return headText(String(value), 100)
}

/** The one-line label a finished row prints: the verb, its target, its result. */
export const callLine = (name: string, args: unknown): string => toolLabel(name, args) ?? toolVerb(name)

/**
 * Just the identifying part of a call (`package.json`), for a row that draws
 * the verb itself.
 *
 * `undefined` when the call has nothing worth naming, which is what tells the
 * caller to print the verb alone rather than an empty separator.
 */
export const toolTarget = (name: string, args: unknown): string | undefined => {
  const label = toolLabel(name, args)
  if (label === undefined) return undefined
  const verb = toolVerb(name)
  if (label === verb) return undefined
  return label.startsWith(`${verb} `) ? label.slice(verb.length + 1) : label
}
