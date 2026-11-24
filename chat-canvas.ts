/**
 * The composer's text canvas: wrapping, the caret, and the cursor block.
 *
 * These lived inside `chat.ts`, which parses argv and starts the CLI at module
 * scope and so cannot be imported by a test. They are pure - string in, string
 * or offsets out, no terminal - which is why they can move here unchanged and
 * be tested directly: a caret that is one cell wrong is a rendering bug, and the
 * only way to pin it is to assert the cell.
 *
 * Every width is counted with `width.ts` (`charCells`/`displayCells`), never
 * with `String#length`: a CJK character is one UTF-16 unit per code point but two
 * terminal cells, and an emoji is one grapheme made of several units.
 */

import { charCells, displayCells } from './width.ts'

/** One drawn row of the draft: its text and the UTF-16 range it covers. */
export type DisplayRow = { text: string; start: number; end: number }

/**
 * Wrap the draft the way the terminal will: hard breaks at `width` cells, and
 * one row per logical newline. Offsets stay in UTF-16 units, which is what the
 * cursor and String#slice use.
 */
export const layoutRows = (value: string, width: number): DisplayRow[] => {
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
export const cursorPosition = (
  rows: readonly DisplayRow[],
  cursor: number,
): { row: number; col: number } => {
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

/**
 * The cells of one draft row that the composer can paint.
 *
 * The box is `│ text │`: two edges and one space each side, so the draft gets
 * `width - 4`. `layout()` and the caret's `vertical()` must wrap at exactly this
 * value - they used to disagree (`width - 2` vs `width - 4`), which put the
 * caret one row and one column off after every wrap.
 */
export const composerTextWidth = (width: number): number => Math.max(1, width - 4)

/**
 * A draft row split at the caret, for drawing the cursor block.
 *
 * `before` is left of the caret, `at` is the one grapheme the block inverts
 * (empty at end-of-line) and `after` is the rest. Slicing stays in UTF-16 units
 * - the unit `cursorPosition` and `String#slice` use - and every boundary is
 * moved onto a grapheme edge:
 *
 * - a zero-cell mark (a combining accent, a variation selector, a ZWJ) that sits
 *   at the caret continues the character *before* it, so it goes into `before`
 *   and the block covers the next whole grapheme. Without this, `e\u0301` would
 *   split as `e` + `\u0301` and the block would invert a bare accent.
 * - `at` takes the base code point, its zero-cell marks, and any ZWJ join that
 *   follows, so an emoji family is one block and not four.
 *
 * The caller pads `before` with `displayCells`, never `String#length`.
 */
export const splitAtCaret = (
  row: DisplayRow,
  cursor: number,
): { readonly before: string; readonly at: string; readonly after: string } => {
  let offset = Math.max(0, Math.min(cursor - row.start, row.text.length))
  // Marks that continue the previous grapheme belong on this side of the block.
  while (offset < row.text.length && charCells(row.text[offset]!) === 0) offset += 1
  const before = row.text.slice(0, offset)
  const rest = row.text.slice(offset)
  if (rest.length === 0) return { before, at: '', after: '' }
  // The block inverts one base plus everything that cannot stand in a cell of
  // its own: zero-cell marks, and a ZWJ that joins the next base to this one.
  let end = 0
  for (const char of rest) {
    const cells = charCells(char)
    if (cells === 0) {
      end += char.length
      continue
    }
    if (end === 0 || rest.slice(0, end).endsWith('\u200d')) {
      end += char.length
      continue
    }
    break
  }
  return { before, at: rest.slice(0, end), after: rest.slice(end) }
}

/** Reverse video: the cell under the caret. */
export const CURSOR_STEADY = '\x1b[7m'

/**
 * One composer row with its cursor block, as the terminal draws it.
 *
 * The block is always a solid reverse-video cell - it does not blink. A
 * blinking caret is what the terminal's own cursor does, and it is famously
 * hard to find in a boxed field; a steady block is exactly where the next
 * character goes, and while a turn runs it also reads as "this is live". An
 * idle block additionally carries an underline, so it still stands out on
 * terminals that render reverse video dimly.
 *
 * At end-of-line there is no character to invert, so a space is drawn in
 * reverse - the block still occupies a cell, which is what makes the caret
 * visible on an empty draft.
 */
export const composerRowWithCursor = (input: {
  readonly row: DisplayRow
  readonly cursor: number
  readonly cells: number
  readonly steady: boolean
}): string => {
  const { before, at, after } = splitAtCaret(input.row, input.cursor)
  const visibleAt = at.length === 0 ? ' ' : at
  const painted = `${CURSOR_STEADY}${visibleAt}${input.steady ? '' : '\x1b[4m'}`
  const used = displayCells(before) + displayCells(visibleAt) + displayCells(after)
  return `${before}${painted}\x1b[27m\x1b[24m${after}${' '.repeat(Math.max(0, input.cells - used))}`
}
