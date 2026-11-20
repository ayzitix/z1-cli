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
 * whole block until its closer, a line that could still become a drained
 * remnant). Ordinary prose is returned from `push` as soon as it arrives. A
 * partial token is held for at most `HOLD_LIMIT` bytes and then emitted
 * literally, so a stray `<` can never stall the stream. An XML opener is held
 * only while its body could still prove to be a call (a `parameter` row, a JSON
 * payload, or a closer within `CONFIRM_WINDOW`); a sentence that merely mentions
 * the tag is released, not swallowed.
 *
 * Streamed and whole-string output are the same function: `sanitizeOutput` is
 * `push` + `flush` over the whole text, and every chunking of that text returns
 * the same characters. The one documented exception is whitespace-only output,
 * which `sanitizeOutput` reports as empty text.
 */

/** Matches the "no tools" notice `chat.ts` prints for an empty sanitized turn. */
export const NO_TOOLS_NOTICE = 'no tools are enabled this turn · /tools to enable one'

/** Matches the "markup only" notice for a tools-enabled turn. */
export const MARKUP_ONLY_NOTICE = '(the model emitted tool-call markup with no tool result; nothing ran)'

/** A partial token is held for at most this many bytes. */
const HOLD_LIMIT = 2048

/** How much of a dropped block's tail to keep while looking for its closer. */
const BLOCK_TAIL = 128

/**
 * A dropped block keeps swallowing until its closer, however long its body is:
 * a 14 KB DSML dump is still one block, and emitting the body after a few KB was
 * exactly the leak. This is the point where a closer is given up on instead of
 * swallowed forever — a block that big is not one turn's markup.
 */
const BLOCK_HARD_LIMIT = 64 * 1024

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
  | { kind: 'hold'; window?: number; opener?: boolean }
  | { kind: 'literal' }
  | { kind: 'remove'; length: number }
  | { kind: 'block'; length: number; pattern: RegExp; keep: number }

/**
 * The visible marker `flush` adds when a block was confirmed but never closed.
 * Dropping the body silently made a truncated leak look like an empty answer;
 * the marker says markup was removed instead of pretending nothing happened.
 */
export const UNCLOSED_BLOCK_NOTICE = '[tool-call markup removed: the block had no closing tag]'

/**
 * How long an XML opener may stay undecided before it is treated as prose.
 *
 * An opener is only a block when the body looks like a call (see
 * `classifyOpener`), so the hold exists solely to wait for that evidence. Four
 * kilobytes covers a short JSON payload or the first `parameter` row while
 * bounding the delay for a sentence that merely mentions the tag.
 */
const CONFIRM_WINDOW = 4096

/**
 * A mid-line opener gets a shorter window. A real leaked call starts its own
 * line; holding the rest of a paragraph for 4 KB because it says `<invoke>` in
 * passing is exactly the prose-eating bug this rule exists to stop.
 */
const MIDLINE_CONFIRM_WINDOW = 512

/** A `parameter`/`function_call`/`tool_call` row, optionally marker-prefixed. */
const CALL_ROW =
  /^[ \t]*(?:<\|[ \t]*[^<>|\n]{0,24}[ \t]*\|[ \t]*)?<\/?(?:parameter|function_call|tool_call|calls)\b/m

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

/**
 * The same fragment before its `>`, so a split inside it is not shown as prose.
 * Every proper prefix of a tag counts too (`c`, `cal`, `calls`): a streamed line
 * arrives one character at a time, and `calls>` only becomes recognizable at
 * its `>` — by which time the `calls` characters must not already be on screen.
 */
const REMNANT_TAGS = ['tool_calls', 'tool_call', 'function_calls', 'function_call', 'calls', 'invoke', 'parameter']

/** Every proper prefix of `tag`, longest first, as a regex alternation. */
const prefixesOf = (tag: string): string[] => {
  const out: string[] = []
  for (let at = tag.length; at > 0; at -= 1) out.push(tag.slice(0, at))
  return out
}

const REMNANT_PARTIAL = new RegExp(
  `^[ \\t]*\\/?(?:${[...REMNANT_TAGS].reverse().flatMap(prefixesOf).join('|')})?(?:[ \\t]+[^<>\\n]*)?[ \\t]*>?[ \\t]*$`,
)

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
  return { kind: 'block', length, pattern, keep: BLOCK_TAIL }
}

/**
 * True when `body` contains a line that starts with a `parameter` /
 * `function_call` / `tool_call` row. That is the cheapest proof the opener has
 * a call-shaped body: a real block puts its arguments on their own lines.
 */
const hasCallRow = (body: string): boolean => CALL_ROW.test(body)

/**
 * True when `body` is a complete JSON object/array. A provider that wraps a
 * call in `<tool_call>` puts the arguments there, and parsing them is the
 * strongest signal that the block is not prose. The closing-bracket guard keeps
 * a long paragraph starting with `{` from being parsed on every delta.
 */
const isJsonPayload = (body: string): boolean => {
  const trimmed = body.trim()
  if (trimmed.length < 2) return false
  if (!/^[[{]/.test(trimmed) || !/[\]}]$/.test(trimmed)) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/**
 * Decide what an XML opener is. Ordinary prose *describes* this format —
 * "a call starts with `<invoke name="search">` and …" — so an opener alone is
 * not enough to start dropping; it has to look like a call.
 *
 * An opener is a block when any of these holds:
 *  - a `parameter`/`function_call`/`tool_call` row follows (line-anchored), or
 *  - it starts its line and a matching closer arrives within `CONFIRM_WINDOW`
 *    cells (the shape of a real multi-line block), or
 *  - the text between opener and closer parses as JSON.
 *
 * Otherwise it is prose: only the `<` is emitted literally and the rest of the
 * sentence is processed normally, so the words survive.
 */
const classifyOpener = (text: string, name: string, atLineStart: boolean): Verdict => {
  const core = `<${name}`
  const gt = text.indexOf('>')
  if (gt < 0) {
    if (text.length > HOLD_LIMIT) return { kind: 'literal' }
    return { kind: 'hold' }
  }
  // `<invokeX>` is a different word, not our tag.
  const after = text.charAt(core.length)
  if (after !== '>' && after !== ' ' && after !== '\t' && after !== '\n') {
    return { kind: 'literal' }
  }
  const opener = text.slice(0, gt + 1)
  const pattern = closerFor(name)
  const rest = text.slice(gt + 1)

  const matched = pattern.exec(rest)
  if (matched !== null) {
    // A confirmed block is removed whole, closer included.
    const body = rest.slice(0, matched.index)
    if (hasCallRow(body) || isJsonPayload(body) || (atLineStart && matched.index <= CONFIRM_WINDOW)) {
      return { kind: 'remove', length: opener.length + matched.index + matched[0].length }
    }
    // A sentence that mentions both tags is still a sentence.
    return { kind: 'literal' }
  }

  // The closer has not arrived. The body itself can already prove the call.
  if (hasCallRow(rest) || isJsonPayload(rest)) {
    return { kind: 'block', length: opener.length, pattern, keep: BLOCK_TAIL }
  }

  // A line-start opener is never released as prose when the window elapses. A
  // real call streams its JSON body gradually, so at CONFIRM_WINDOW the body is
  // still incomplete — releasing here printed the whole arguments blob as text
  // and only the later closer was stripped. Instead the opener is committed as
  // a block: its body is dropped until the closer arrives or BLOCK_HARD_LIMIT
  // gives up, and a stream that ends before that is reported by `flush` with
  // the unclosed-block notice, never as raw body text.
  if (atLineStart && rest.length >= CONFIRM_WINDOW) {
    return { kind: 'block', length: opener.length, pattern, keep: BLOCK_TAIL }
  }

  // A mid-line opener keeps the short prose release: ordinary prose like
  // "The element <parameter name="id"> holds the id" is mid-line, and holding
  // the rest of a paragraph for it is exactly the prose-eating bug the
  // line-start rule exists to stop.
  if (!atLineStart && rest.length >= MIDLINE_CONFIRM_WINDOW) return { kind: 'literal' }

  // Nothing conclusive yet: hold the candidate rather than emit a prefix that
  // a later row would have turned into a block. `opener` marks a line-start
  // candidate so `flush` can tell a stream truncated mid-call (markup) from a
  // mid-line mention that is genuinely prose.
  return {
    kind: 'hold',
    window: atLineStart ? CONFIRM_WINDOW : MIDLINE_CONFIRM_WINDOW,
    opener: atLineStart || undefined,
  }
}

/**
 * Classify the text starting at a `<`. A verdict is only returned once the
 * answer is unambiguous; a prefix of a marker is `hold`, never `literal`.
 * `atLineStart` is true when nothing but whitespace precedes the `<` on its
 * line, which is what separates a leaked block from a sentence about one.
 */
const classify = (text: string, atLineStart: boolean): Verdict => {
  // --- control markers, tight (`<|DSML|`) or spaced (`<| DSML |`) ----------
  if (text.startsWith('<|') || text.startsWith('</|')) {
    // Marker holds keep their own release rules: a complete lone token is
    // dropped at flush, and a partial form without the closing pipe stays
    // literal (a truncated token is a stray two bytes, not a leaked block).
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
    if (text.startsWith(`<${name}`)) return classifyOpener(text, name, atLineStart)
    if (`<${name}`.startsWith(text)) return { kind: 'hold' }
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
  /** Bytes already dropped for the current block; compared to `BLOCK_HARD_LIMIT`. */
  let dropped = 0
  /**
   * The current block never produced a closer before `BLOCK_HARD_LIMIT`, so the
   * rest of the stream is treated as the block body: dropping it leaves an empty
   * answer, which the notice path turns into "no tools" instead of leaking it.
   */
  let dropRest = false
  /** True when the line just dropped was a block remnant (so a lone `>` is too). */
  let remnantLine = false
  /** A `calls>` line whose block body must be seen before anything else is dropped. */
  let pending: string | undefined
  /**
   * The held candidate began with a line-start opener (`<tool_call`, `<invoke`,
   * a `<|`/`</|` marker): it is a block candidate, not prose, so a stream that
   * ends while it is still undecided must be reported as removed markup, not
   * printed. A mid-line mention keeps its prose release and never sets this.
   */
  let heldOpener = false
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
    block = { pattern: blockCloser(name), keep: BLOCK_TAIL }
    dropped = 0
  }

  const push = (delta: string): string => {
    buffer += delta
    while (buffer.length > 0) {
      if (dropRest) {
        buffer = ''
        break
      }
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
          // Keep only enough tail to catch a closer split across deltas. There is
          // no per-block budget: a 14 KB DSML dump is one block, and emitting its
          // body after a few KB was exactly the leak.
          const cut = Math.max(0, buffer.length - block.keep)
          dropped += cut
          buffer = buffer.slice(cut)
          if (dropped >= BLOCK_HARD_LIMIT) {
            // 64 KB without a closer is not one turn's markup. Drop the rest of
            // the stream instead of emitting the body, and leave no block state.
            block = undefined
            dropped = 0
            dropRest = true
            buffer = ''
            break
          }
          break
        }
        buffer = buffer.slice(matched.index + matched[0].length)
        block = undefined
        dropped = 0
        dropRest = false
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

      const verdict = classify(buffer, lineStart)
      if (verdict.kind === 'hold') {
        // An opener-tagged hold is a block candidate: it must never be pushed
        // out as prose by the window, because a real call streams its body
        // gradually — `classify` commits it to a block once the window elapses.
        if (verdict.opener !== true) {
          const window = verdict.window ?? HOLD_LIMIT
          if (buffer.length > window) {
            // No `|>`, tag close or call evidence arrived: emit the held text.
            emit(buffer)
            buffer = ''
          }
        }
        heldOpener = verdict.opener === true
        break
      }
      heldOpener = false
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
      dropped = 0
      remnantLine = true
      consumeLineEnd()
    }
    const out = output
    output = ''
    return out
  }

  const flush = (): string => {
    if (block !== undefined || dropRest) {
      // An unclosed block is still markup, but a long body must not vanish
      // without a trace: say it was removed. A bare opener with no body is the
      // only case with nothing to report.
      const bodySeen = dropRest || dropped > 0 || buffer.length > 0
      buffer = ''
      block = undefined
      pending = undefined
      if (bodySeen) emit(UNCLOSED_BLOCK_NOTICE)
    } else if (buffer.length > 0) {
      const trimmed = buffer.trim()
      const marker = buffer.startsWith('<|') || buffer.startsWith('</|') ? MARKER.exec(buffer) : null
      if (marker !== null && marker[0].length === buffer.length) {
        // A complete `<|DSML|` marker on its own is a token, not partial text.
        buffer = ''
      } else if (REMNANT_LINE.test(trimmed) || (remnantLine && trimmed === '>')) {
        // A drained fragment with no newline to end it is still markup.
        buffer = ''
      } else if (heldOpener) {
        // The stream ended while a line-start opener was still undecided — the
        // shape of a turn cut off by max_tokens mid-call. The held text is
        // markup, not prose, so it becomes the removal marker instead of
        // printing a truncated call; only a verdict of `literal` (a mid-line
        // mention) may ever reach the screen as text.
        emit(UNCLOSED_BLOCK_NOTICE)
        buffer = ''
      }
      if (buffer.length > 0) emit(buffer)
      buffer = ''
    }
    pending = undefined
    block = undefined
    dropped = 0
    dropRest = false
    heldOpener = false
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
