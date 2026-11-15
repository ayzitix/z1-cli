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
const BLOCK_TAIL = 128

/** A dropped block stops eating the answer after this many bytes. */
const BLOCK_LIMIT = 4096

/**
 * The most token text a control marker may carry. Providers space their markers
 * out (`<| DSML | calls>`), so the text may contain spaces; the longest real
 * token here is `end▁of▁sentence` (16).
 */
const TOKEN_TEXT_MAX = 24

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
  | { kind: 'block'; length: number; pattern: RegExp; keep: number; limit: number }

/**
 * A control marker: `<|`, up to `TOKEN_TEXT_MAX` characters of token text
 * (spaces allowed, so `<| DSML |` matches), then the closing pipe. The closing
 * `</| … |` form matches too; the optional `>` and any tag that follows it are
 * handled by `MARKER_TAIL`.
 */
const MARKER = new RegExp(`^</?\\|[ \\t]*[^<>|\\n]{0,${TOKEN_TEXT_MAX}}\\|`)

/**
 * What follows a marker on the same line: the tag name (`calls`, `invoke`) and
 * its `name="value"` attributes, through the `>`. Ordinary prose after a marker
 * fails this, so the marker alone is dropped and the words survive.
 */
const MARKER_TAIL =
  /^[ \t]*([A-Za-z_][A-Za-z0-9_.:-]*)?(?:[ \t]+[A-Za-z_][A-Za-z0-9_.:-]*="[^"<>\n]*")*[ \t]*>/

/** A tail that is still arriving (`calls`, `parameter name="i`): held, not prose. */
const TAIL_PREFIX =
  /^[ \t]*(?:[A-Za-z_][A-Za-z0-9_.:-]*)?(?:[ \t]+[A-Za-z_][A-Za-z0-9_.:-]*="[^"<>\n]*")*[ \t]*$/

/** Tags whose marker opens a block that ends at the matching closing line. */
const BLOCK_TAGS: readonly string[] = [
  'tool_calls',
  'tool_call',
  'function_calls',
  'function_call',
  'calls',
  'invoke',
  'parameter',
]

/**
 * A line that is only a drained fragment of a tool-call block: what is left of
 * `<|DSML| calls>` once the marker is gone. A line that merely mentions `calls`
 * is prose and is not matched. Group 1 is the tag, `/` marks a closer.
 */
const REMNANT_LINE = /^\/?(tool_calls?|function_calls?|calls|invoke|parameter)(?:[ \t]+[^<>]*)?>$/

/** The same fragment before its `>`, so a split inside it is not shown as prose. */
const REMNANT_PARTIAL =
  /^[ \t]*\/?(?:tool_calls?|function_calls?|calls|invoke|parameter)(?:[ \t]+[A-Za-z_][A-Za-z0-9_.:-]*="[^"<>\n]*")*[ \t]*>?[ \t]*$/

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
 * The closer for a marker block: either the marker form (`</| DSML | calls>`)
 * anywhere, or a bare `calls>` / `/calls>` line left once the marker is gone.
 */
const blockCloser = (name: string): RegExp => {
  const tag = `${escapeRegExp(name)}${name.endsWith('call') ? 's?' : ''}`
  return new RegExp(
    `</?\\|[ \\t]*[^<>|\\n]{0,${TOKEN_TEXT_MAX}}\\|[ \\t]*${tag}[ \\t]*>|^[ \\t]*\\/?${tag}>`,
    'm',
  )
}

/** The verdict for a marker plus whatever tail the same line already carries. */
const classifyMarker = (text: string): Verdict => {
  const marker = MARKER.exec(text)
  // `<|`, `<|DSM`: no pipe yet, so this is still a possible marker.
  if (marker === null) {
    if (text.length > HOLD_LIMIT) return { kind: 'literal' }
    return { kind: 'hold' }
  }
  const closing = text.startsWith('</|')
  const rest = text.slice(marker[0].length)
  const tail = MARKER_TAIL.exec(rest)

  if (tail === null) {
    // A lone marker line is markup, not prose: drop it with its newline.
    if (/^[ \t]*\n/.test(rest)) {
      const nl = rest.indexOf('\n')
      return { kind: 'remove', length: marker[0].length + nl + 1 }
    }
    // `<|DSML|` and nothing yet: the tag (or a newline) may still arrive.
    if (rest.length === 0) return { kind: 'hold' }
    // A half-arrived tag (`calls`, `parameter name="i`) is held so a split
    // inside it cannot leak the fragment; anything else is prose, and only the
    // marker itself is dropped.
    if (rest.length <= 96 && TAIL_PREFIX.test(rest)) return { kind: 'hold' }
    return { kind: 'remove', length: marker[0].length }
  }

  const length = marker[0].length + tail[0].length
  const name = tail[1]
  if (closing || name === undefined || !BLOCK_TAGS.includes(name)) {
    return { kind: 'remove', length }
  }
  // `<|DSML| calls>` opens a block; drop it through its matching closer line.
  const pattern = blockCloser(name)
  const after = rest.slice(tail[0].length)
  const matched = pattern.exec(after)
  if (matched !== null) {
    return { kind: 'remove', length: length + matched.index + matched[0].length }
  }
  // An unpaired opener is a block whose closer may still arrive: drop its body
  // rather than leak the first line and the parameters under it.
  return { kind: 'block', length, pattern, keep: BLOCK_TAIL, limit: BLOCK_LIMIT }
}

/**
 * Classify the text starting at a `<`. A verdict is only returned once the
 * answer is unambiguous; a prefix of a marker is `hold`, never `literal`.
 */
const classify = (text: string): Verdict => {
  // --- control markers, tight (`<|DSML|`) or spaced (`<| DSML |`) ----------
  if (text.startsWith('<|') || text.startsWith('</|')) {
    return classifyMarker(text)
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
      return { kind: 'block', length: opener.length, pattern, keep: BLOCK_TAIL, limit: BLOCK_LIMIT }
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
  let block: { pattern: RegExp; keep: number; limit: number } | undefined
  /** Bytes already dropped for the current block; bounds how much it may eat. */
  let dropped = 0
  /** True when the line just dropped was a block remnant (so a lone `>` is too). */
  let remnantLine = false
  /** A `calls>` line whose block body must be seen before anything else is dropped. */
  let pending: string | undefined
  /** A dropped block owned the line, and its newline has not arrived yet. */
  let swallowLineEnd = false

  const emit = (text: string): void => {
    if (text.length === 0) return
    output += text
    lineStart = lineIsBlank(lineStart, text)
  }

  /** Consume a trailing newline when a dropped block owned its whole line. */
  const consumeLineEnd = (): void => {
    if (!lineStart) return
    const match = /^[ \t]*\n/.exec(buffer)
    if (match !== null) {
      buffer = buffer.slice(match[0].length)
      return
    }
    // The newline may still be in a later delta: keep swallowing it.
    swallowLineEnd = buffer.length === 0 || /^[ \t]*$/.test(buffer)
  }

  const startBlock = (name: string): void => {
    block = { pattern: blockCloser(name), keep: BLOCK_TAIL, limit: BLOCK_LIMIT }
    dropped = 0
  }

  const push = (delta: string): string => {
    buffer += delta
    while (buffer.length > 0) {
      if (swallowLineEnd) {
        if (!lineStart) {
          swallowLineEnd = false
        } else if (/^[ \t]*\n/.test(buffer)) {
          buffer = buffer.replace(/^[ \t]*\n/, '')
          swallowLineEnd = false
          continue
        } else if (!/^[ \t]*$/.test(buffer) || buffer.length > HOLD_LIMIT) {
          swallowLineEnd = false
        } else {
          // Only indentation so far: the newline may still be in a later delta.
          break
        }
      }

      if (block !== undefined) {
        const matched = block.pattern.exec(buffer)
        if (matched === null) {
          // Keep only enough tail to catch a closer split across deltas, and
          // never drop more than the block's budget.
          const room = block.limit - dropped
          const cut = Math.min(Math.max(0, buffer.length - block.keep), room)
          dropped += cut
          buffer = buffer.slice(cut)
          if (dropped >= block.limit) {
            // Bounded: an unpaired opener must not swallow the whole answer.
            block = undefined
            dropped = 0
            continue
          }
          break
        }
        buffer = buffer.slice(matched.index + matched[0].length)
        block = undefined
        dropped = 0
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
          // A remnant of a dropped block may still be arriving: hold the
          // candidate line until its newline (or another byte) decides it.
          if (buffer.length <= HOLD_LIMIT && REMNANT_PARTIAL.test(buffer)) break
          if (pending !== undefined) {
            if (buffer.length <= 256) break
            pending = undefined
          }
          if (remnantLine && /^[ \t]*>$/.test(buffer)) break
        } else {
          const line = buffer.slice(0, nl + 1)
          if (/^ {0,3}```/.test(line)) {
            buffer = buffer.slice(nl + 1)
            emit(line)
            inFence = true
            continue
          }
          const body = line.slice(0, -1).trim()
          // A block opener whose body has not been seen yet: `calls>` alone is
          // dropped, but only a closer or an `invoke`/`parameter` row makes it
          // a block, so a stray `calls>` line cannot eat the prose under it.
          if (pending !== undefined) {
            const name = pending
            if (new RegExp(`^\\/?${escapeRegExp(name)}>$`).test(body)) {
              pending = undefined
              buffer = buffer.slice(nl + 1)
              remnantLine = true
              continue
            }
            if (REMNANT_LINE.test(body)) {
              startBlock(name)
              pending = undefined
              buffer = buffer.slice(nl + 1)
              remnantLine = true
              continue
            }
            pending = undefined
          }
          if (remnantLine && body === '>') {
            buffer = buffer.slice(nl + 1)
            continue
          }
          const remnant = REMNANT_LINE.exec(body)
          if (remnant !== null) {
            const name = remnant[1] ?? ''
            const closing = remnant[0].startsWith('/')
            buffer = buffer.slice(nl + 1)
            remnantLine = true
            if (!closing && name !== 'parameter') {
              // `invoke …>` is conclusive; a bare `calls>` waits for its body.
              if (name === 'invoke') startBlock(name)
              else pending = name
            }
            continue
          }
          remnantLine = false
        }
      }

      // Emit at most one line at a time, so the line-start rules above see
      // every line of a multi-line delta (a remnant can follow prose).
      const lt = buffer.indexOf('<')
      const nl = buffer.indexOf('\n')
      if (lt < 0) {
        const end = nl < 0 ? buffer.length : nl + 1
        emit(buffer.slice(0, end))
        buffer = buffer.slice(end)
        continue
      }
      if (lt > 0) {
        const end = nl >= 0 && nl < lt ? nl + 1 : lt
        emit(buffer.slice(0, end))
        buffer = buffer.slice(end)
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
      block = { pattern: verdict.pattern, keep: verdict.keep, limit: verdict.limit }
      dropped = 0
      remnantLine = true
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
      pending = undefined
    } else if (buffer.length > 0) {
      const trimmed = buffer.trim()
      const marker = buffer.startsWith('<|') || buffer.startsWith('</|') ? MARKER.exec(buffer) : null
      if (marker !== null && marker[0].length === buffer.length) {
        // A complete `<|DSML|` marker on its own is a token, not partial text.
        buffer = ''
      } else if (REMNANT_LINE.test(trimmed) || (remnantLine && trimmed === '>')) {
        // A drained fragment with no newline to end it is still markup.
        buffer = ''
      }
      emit(buffer)
      buffer = ''
    }
    pending = undefined
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
  // Whitespace, and the punctuation a dropped block leaves behind, are not prose.
  if (/^[\s<>/|]*$/.test(clean)) clean = ''
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
