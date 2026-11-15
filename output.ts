/**
 * Assistant-output sanitizer: the safety net for a model that answers with
 * tool-call markup instead of prose.
 *
 * The prompt already says "you have no tools this turn", but a model can still
 * emit its provider's wire syntax — `<|DSML| calls>`, `<tool_call>`, `<invoke>`
 * — and the terminal renders it verbatim. This module removes that markup from
 * streamed deltas and from the final text, so neither the screen nor the saved
 * transcript ever sees it.
 *
 * Two rules constrain it:
 *  - ordinary HTML/XML (`<div>`, `<p>`, `&lt;`) is untouched, and
 *  - fenced ``` code blocks are emitted verbatim, because a user asking about
 *    `<tool_call>` needs to see the example they asked for.
 *
 * Streaming: only markup candidates buffer (`<|` across a chunk boundary, a
 * whole block until its closer). Ordinary prose is returned from `push` as soon
 * as it arrives. A partial token is held for at most `HOLD_LIMIT` bytes and then
 * emitted literally, so a stray `<` can never stall the stream.
 */

/** Matches the "no tools" notice `chat.ts` prints for an empty sanitized turn. */
export const NO_TOOLS_NOTICE = 'no tools are enabled this turn · /tools to enable one'

/** Matches the "markup only" notice for a tools-enabled turn. */
export const MARKUP_ONLY_NOTICE = '(the model emitted tool-call markup with no tool result; nothing ran)'

/** A partial token is held for at most this many bytes. */
const HOLD_LIMIT = 2048

/** How much of a dropped block's tail to keep while looking for its closer. */
const BLOCK_TAIL = 64

export interface OutputSanitizer {
  /** Feed one streamed delta; returns the text that is safe to show. */
  push(delta: string): string
  /** End the stream; returns any literal tail that must still be shown. */
  flush(): string
}

export interface SanitizeResult {
  text: string
  removed: boolean
}

type Verdict =
  | { kind: 'hold' }
  | { kind: 'literal' }
  | { kind: 'remove'; length: number }
  | { kind: 'block'; length: number; pattern: RegExp; keep: number }

/** A complete `<|...|>` / `</|...|>` token, including the `>` when present. */
const TOKEN = /^<\/?\|[^<>|\n]+\|>?/

/** DSML's marker is `<|DSML|` (no `>`): a word tag follows it, then `>`. */
const DSML_OPEN = /^<\|DSML\|\s*([A-Za-z_][A-Za-z0-9_.-]*)[^>]*>/
const DSML_CLOSE = /^<\/\|DSML\|\s*([A-Za-z_][A-Za-z0-9_.-]*)[^>]*>/
const DSML_MARKER = /^<\/?\|DSML\|>?/

/** XML/DSML tool-call tags. Longest first so `tool_calls` wins over `tool_call`. */
const XML_TAGS: readonly string[] = [
  'tool_calls',
  'tool_call',
  'function_calls',
  'function_call',
  'invoke',
  'parameter',
]

/** A closing tag turns the tail of a block we failed to pair into a no-op. */
const XML_CLOSERS: readonly { text: string; pattern: RegExp }[] = [
  { text: '</tool_calls>', pattern: /<\/tool_calls>/ },
  { text: '</tool_call>', pattern: /<\/tool_calls?>/ },
  { text: '</function_calls>', pattern: /<\/function_calls>/ },
  { text: '</function_call>', pattern: /<\/function_calls?>/ },
  { text: '</invoke>', pattern: /<\/invoke>/ },
  { text: '</parameter>', pattern: /<\/parameter>/ },
]

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The closer for an opening block. `tool_call`/`function_call` accept a plural
 * closer too: models are inconsistent about the paired name.
 */
const closerFor = (name: string): RegExp => {
  if (name === 'tool_call') return /<\/tool_calls?>/
  if (name === 'function_call') return /<\/function_calls?>/
  return new RegExp(`</${escapeRegExp(name)}>`)
}

/**
 * Classify the text starting at a `<`. A verdict is only returned once the
 * answer is unambiguous; a prefix of a marker is `hold`, never `literal`.
 */
const classify = (text: string): Verdict => {
  // --- DSML blocks ---------------------------------------------------------
  // `<|DSML| calls>` opens a block; `</|DSML| calls>` closes it. The tag is not
  // a `|>`-terminated token, so it is matched before the generic token rule.
  if (text.startsWith('<|DSML|') || text.startsWith('</|DSML|')) {
    const close = DSML_CLOSE.exec(text)
    if (close !== null) return { kind: 'remove', length: close[0].length }

    const open = DSML_OPEN.exec(text)
    if (open !== null) {
      const name = open[1] ?? ''
      const pattern = new RegExp(`</\\|DSML\\|\\s*${escapeRegExp(name)}\\s*>`)
      const rest = text.slice(open[0].length)
      const matched = pattern.exec(rest)
      if (matched !== null) {
        return { kind: 'remove', length: open[0].length + matched.index + matched[0].length }
      }
      // An unpaired opener is a block whose closer may still arrive; drop its
      // body rather than leak the first line and the parameters under it.
      return { kind: 'block', length: open[0].length, pattern, keep: BLOCK_TAIL }
    }

    const marker = DSML_MARKER.exec(text)
    if (marker !== null) {
      const rest = text.slice(marker[0].length)
      // A lone marker line is markup, not prose: drop it with its newline.
      if (/^[ \t]*\n/.test(rest)) {
        const nl = rest.indexOf('\n')
        return { kind: 'remove', length: marker[0].length + nl + 1 }
      }
      // `<|DSML|>`, or a marker followed by nothing yet: a tag may still come.
      if (rest.length === 0) return { kind: 'hold' }
      if (text.length > HOLD_LIMIT) return { kind: 'literal' }
      return { kind: 'hold' }
    }
  }

  // --- generic `<|...|>` / `</|...|>` tokens -------------------------------
  const token = TOKEN.exec(text)
  if (token !== null) return { kind: 'remove', length: token[0].length }
  if (text.startsWith('<|') || text.startsWith('</|')) {
    if (text.length > HOLD_LIMIT) return { kind: 'literal' }
    return { kind: 'hold' }
  }

  // --- XML tool-call blocks ------------------------------------------------
  for (const closer of XML_CLOSERS) {
    if (text.startsWith(closer.text)) return { kind: 'remove', length: closer.text.length }
  }
  for (const closer of XML_CLOSERS) {
    if (closer.text.startsWith(text)) return { kind: 'hold' }
  }

  for (const name of XML_TAGS) {
    const core = `<${name}`
    if (text.startsWith(core)) {
      const gt = text.indexOf('>')
      if (gt < 0) {
        if (text.length > HOLD_LIMIT) return { kind: 'literal' }
        return { kind: 'hold' }
      }
      const opener = text.slice(0, gt + 1)
      // `<invokeX>` is a different word, not our tag.
      const after = text.charAt(core.length)
      if (after !== '>' && after !== ' ' && after !== '\t' && after !== '\n') {
        return { kind: 'literal' }
      }
      const pattern = closerFor(name)
      const rest = text.slice(gt + 1)
      const matched = pattern.exec(rest)
      if (matched !== null) {
        return { kind: 'remove', length: opener.length + matched.index + matched[0].length }
      }
      return { kind: 'block', length: opener.length, pattern, keep: BLOCK_TAIL }
    }
    if (core.startsWith(text)) return { kind: 'hold' }
  }

  return { kind: 'literal' }
}

/** True when everything on the current line so far is whitespace. */
const lineIsBlank = (lineStart: boolean, text: string): boolean => {
  const nl = text.lastIndexOf('\n')
  const tail = nl >= 0 ? text.slice(nl + 1) : text
  return (nl >= 0 || lineStart) && tail.trim() === ''
}

/**
 * A stateful sanitizer. Feed every delta through `push` and call `flush` once at
 * the end of the turn; both return only text that is safe to display.
 */
export function createOutputSanitizer(): OutputSanitizer {
  let buffer = ''
  let output = ''
  let inFence = false
  let lineStart = true
  let block: { pattern: RegExp; keep: number } | undefined

  const emit = (text: string): void => {
    if (text.length === 0) return
    output += text
    lineStart = lineIsBlank(lineStart, text)
  }

  /** Consume a trailing newline when a dropped block owned its whole line. */
  const consumeLineEnd = (): void => {
    if (!lineStart) return
    const match = /^[ \t]*\n/.exec(buffer)
    if (match !== null) buffer = buffer.slice(match[0].length)
  }

  const push = (delta: string): string => {
    buffer += delta
    while (buffer.length > 0) {
      if (block !== undefined) {
        const matched = block.pattern.exec(buffer)
        if (matched === null) {
          // Keep only enough tail to catch a closer split across deltas.
          buffer = buffer.slice(Math.max(0, buffer.length - block.keep))
          break
        }
        buffer = buffer.slice(matched.index + matched[0].length)
        block = undefined
        consumeLineEnd()
        continue
      }

      if (inFence) {
        const nl = buffer.indexOf('\n')
        if (nl < 0) break
        const line = buffer.slice(0, nl + 1)
        buffer = buffer.slice(nl + 1)
        emit(line)
        if (/^ {0,3}```/.test(line)) inFence = false
        continue
      }

      if (lineStart) {
        const nl = buffer.indexOf('\n')
        if (nl < 0) {
          // A fence opener is the only line-start decision; hold its prefix
          // and its language tag until the newline can switch the mode.
          if (/^ {0,3}`{0,2}$/.test(buffer)) break
          if (/^ {0,3}```/.test(buffer)) break
        } else {
          const line = buffer.slice(0, nl + 1)
          if (/^ {0,3}```/.test(line)) {
            buffer = buffer.slice(nl + 1)
            emit(line)
            inFence = true
            continue
          }
        }
      }

      const lt = buffer.indexOf('<')
      if (lt < 0) {
        emit(buffer)
        buffer = ''
        continue
      }
      if (lt > 0) {
        emit(buffer.slice(0, lt))
        buffer = buffer.slice(lt)
        continue
      }

      const verdict = classify(buffer)
      if (verdict.kind === 'hold') {
        if (buffer.length > HOLD_LIMIT) {
          // No `|>` (or tag close) arrived: emit the held text literally.
          emit(buffer)
          buffer = ''
        }
        break
      }
      if (verdict.kind === 'literal') {
        emit('<')
        buffer = buffer.slice(1)
        continue
      }
      if (verdict.kind === 'remove') {
        buffer = buffer.slice(verdict.length)
        consumeLineEnd()
        continue
      }
      buffer = buffer.slice(verdict.length)
      block = { pattern: verdict.pattern, keep: verdict.keep }
      consumeLineEnd()
    }
    const out = output
    output = ''
    return out
  }

  const flush = (): string => {
    if (block !== undefined) {
      // An unclosed block is still markup: drop what is left of it.
      buffer = ''
      block = undefined
    } else if (buffer.length > 0) {
      const marker = DSML_MARKER.exec(buffer)
      if (marker !== null && marker[0].length === buffer.length) {
        // A complete `<|DSML|` marker on its own is a token, not partial text.
        buffer = buffer.slice(marker[0].length)
      }
      emit(buffer)
      buffer = ''
    }
    const out = output
    output = ''
    return out
  }

  return { push, flush }
}

/**
 * Sanitize a complete string. Whitespace that only survives because markup was
 * removed counts as empty, so callers can treat it as "no prose".
 */
export function sanitizeOutput(text: string): SanitizeResult {
  const sanitizer = createOutputSanitizer()
  let clean = sanitizer.push(text)
  clean += sanitizer.flush()
  if (clean.trim().length === 0) clean = ''
  return { text: clean, removed: clean !== text }
}

export interface FinalReply {
  /** The assistant text to show and to save. */
  text: string
  /** Set when the text is a notice rather than the model's own prose. */
  notice: string | undefined
}

/**
 * Turn-level policy for an empty sanitized answer. Pure so the test can prove
 * the 0-tool case without a model: an empty turns into the `/tools` notice, and
 * a tools-enabled turn that emitted only markup says nothing ran.
 */
export function finalizeAssistantReply(text: string, toolsEnabled: boolean): FinalReply {
  if (text.trim().length > 0) return { text, notice: undefined }
  const notice = toolsEnabled ? MARKUP_ONLY_NOTICE : NO_TOOLS_NOTICE
  return { text: notice, notice }
}
