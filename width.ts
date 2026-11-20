/**
 * Terminal width: columns are counted in *cells*, never in UTF-16 code units.
 *
 * `String#length` says `"日本語"` is three and `"😀"` is two, while a terminal
 * paints the first as six cells and the second as one glyph. Sizing a column
 * with code units overflows the box around CJK and slices an emoji in half,
 * leaving a lone surrogate on screen. These helpers are the single place that
 * answers "how wide" and "cut it to N cells".
 *
 * The approximations are deliberate and small: a ZWJ sequence counts the cells
 * of its parts (usually more than the joined glyph) and a flag is two cells
 * rather than one. Over-counting a glyph can waste a column; under-counting
 * would break the layout, which is the bug this module exists to avoid.
 */

/** Terminal cells one code point occupies: 2 for CJK/emoji, 0 for combining. */
export const charCells = (char: string): number => {
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

/** Printable cells, ignoring the SGR sequences the accents add. */
export const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')

/** Display width of a string, ignoring SGR accents. */
export const displayCells = (text: string): number => {
  let total = 0
  for (const char of stripAnsi(text)) total += charCells(char)
  return total
}

/**
 * One unbreakable piece of output: a base code point, any zero-cell marks that
 * follow it, and — when the base ends in a ZWJ — the next base and its marks.
 * Cutting between those pieces is what produced the lone surrogate and the
 * orphaned combining accent.
 */
interface Glyph {
  text: string
  cells: number
}

/** Split `text` into glyphs, treating each SGR sequence as a zero-cell glyph. */
const glyphs = (text: string): Glyph[] => {
  const out: Glyph[] = []
  let at = 0
  while (at < text.length) {
    const sgr = /^\x1b\[[0-9;]*m/.exec(text.slice(at))
    if (sgr !== null) {
      out.push({ text: sgr[0], cells: 0 })
      at += sgr[0].length
      continue
    }
    const first = text.codePointAt(at) ?? 0
    const base = String.fromCodePoint(first)
    at += base.length
    let unit = base
    let cells = charCells(base)
    // Zero-cell marks belong to the glyph they follow; a ZWJ also claims the
    // next base, so the slice can never end on a joined emoji half.
    while (at < text.length) {
      if (/^\x1b\[[0-9;]*m/.test(text.slice(at))) break
      const code = text.codePointAt(at) ?? 0
      const next = String.fromCodePoint(code)
      if (charCells(next) !== 0) break
      unit += next
      at += next.length
      if (code !== 0x200d || at >= text.length) continue
      const joined = text.codePointAt(at) ?? 0
      const joinedText = String.fromCodePoint(joined)
      unit += joinedText
      at += joinedText.length
      cells += charCells(joinedText)
    }
    out.push({ text: unit, cells })
  }
  return out
}

/** The cells available to content when `width` cells also hold an ellipsis. */
const budgetFor = (width: number): number => Math.max(0, width - 1)

/**
 * Truncate for a fixed-width box. The ellipsis costs one cell, so the kept
 * prefix may use `width - 1` cells and never splits a glyph.
 */
export const fit = (text: string, width: number): string => {
  if (width <= 0) return ''
  if (displayCells(text) <= width) return text
  const budget = budgetFor(width)
  let out = ''
  let used = 0
  for (const glyph of glyphs(text)) {
    if (glyph.cells === 0) {
      out += glyph.text
      continue
    }
    if (used + glyph.cells > budget) break
    out += glyph.text
    used += glyph.cells
  }
  // A cut through coloured text needs the reset, but a pipe must stay free of
  // escapes: only add one when the kept prefix actually opened an SGR.
  return `${out}${/\x1b\[[0-9;]*m/.test(out) ? '\x1b[0m' : ''}…`
}

/** Truncate without cutting an SGR sequence or a glyph in half. */
export const clip = (text: string, width: number): string => {
  if (width <= 0) return ''
  if (displayCells(text) <= width) return text
  const budget = budgetFor(width)
  let out = ''
  let used = 0
  for (const glyph of glyphs(text)) {
    if (glyph.cells === 0) {
      out += glyph.text
      continue
    }
    if (used + glyph.cells > budget) break
    out += glyph.text
    used += glyph.cells
  }
  return `${out}\x1b[0m…`
}
