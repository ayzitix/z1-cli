/**
 * Terminal width: `fit` and `clip` budget in cells.
 *
 * The layout sizes columns with `displayCells`, so a truncation that counted
 * UTF-16 units either overflowed the box (CJK) or cut a surrogate pair in half
 * (emoji). The property here is the guard: for every string and width, the
 * result fits the budget and is valid text. The exact-output checks pin the
 * ellipsis cost and the same-glyph rules.
 */
import assert from 'node:assert/strict'

import { charCells, clip, displayCells, fit } from '../width.ts'

/** Reject a high surrogate at the end or a low surrogate with no high before it. */
const loneSurrogate = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

const SAMPLES = [
  'plain ascii',
  '日本語',
  '😀',
  '👍🏽',
  '❤️',
  'e\u0301xtra',
  '👩\u200d👩\u200d👧',
  'ascii 日本語 😀 done',
  '\x1b[31m日本語\x1b[0m',
  '\x1b[1mnote\x1b[0m: 日本語 😀',
  '',
]

for (const sample of SAMPLES) {
  for (let width = 0; width <= 14; width += 1) {
    for (const cut of [fit(sample, width), clip(sample, width)]) {
      assert.ok(
        displayCells(cut) <= width,
        `width ${String(width)}: ${JSON.stringify(cut)} is ${String(displayCells(cut))} cells`,
      )
      assert.equal(loneSurrogate(cut), false, `width ${String(width)}: ${JSON.stringify(cut)} splits a surrogate pair`)
      assert.equal(cut.endsWith('\u200d'), false, `width ${String(width)}: ${JSON.stringify(cut)} ends on a ZWJ`)
    }
  }
}

// A string that fits is returned unchanged, SGR included.
assert.equal(fit('日本語', 6), '日本語', 'exactly-fitting CJK is untouched')
assert.equal(clip('\x1b[31mabc\x1b[0m', 3), '\x1b[31mabc\x1b[0m', 'exactly-fitting coloured text is untouched')
assert.equal(fit('', 3), '', 'an empty string stays empty')
assert.equal(fit('abc', 0), '', 'a zero width fits nothing')
assert.equal(clip('abc', -1), '', 'a negative width fits nothing')

// The ellipsis is a cell: `fit` keeps at most width - 1 cells of content.
assert.equal(fit('日本語', 1), '…', 'a 1-cell budget is the ellipsis alone')
assert.equal(fit('😀', 1), '…', 'an emoji wider than the budget is never cut')
assert.equal(fit('日本語', 5), '日本…', 'two CJK glyphs plus the ellipsis fill five cells')
assert.equal(displayCells(fit('日本語', 3)), 3, 'an odd budget rounds down to whole glyphs')

// A combining mark stays with its base; every output is still valid text.
{
  const out = fit('e\u0301xtra', 2)
  assert.equal(out, 'e\u0301…', 'the accent is not separated from its base')
  assert.equal(displayCells(out), 2, 'and the pair counts as one cell')
}

// A ZWJ family is one glyph: either all of it or the ellipsis.
{
  const family = '👩\u200d👩\u200d👧'
  assert.equal(fit(family, 5), '…', 'a joined emoji sequence is not sliced')
  assert.equal(fit(family, 6), family, 'and it fits whole when the budget allows')
  assert.equal(fit('ab日本語', 5), 'ab日…', 'the glyph after ASCII still counts in cells')
}

// Coloured truncation resets the SGR before the ellipsis; colour-free output
// stays escape-free so a pipe keeps its no-ESC guarantee. `clip` once appended
// `\x1b[0m` unconditionally, which put the only ESC on the line under NO_COLOR.
{
  const coloured = fit('\x1b[31m日本語\x1b[0m', 5)
  assert.ok(coloured.startsWith('\x1b[31m'), 'the opening SGR is kept')
  assert.ok(coloured.includes('\x1b[0m…'), 'and the reset precedes the ellipsis')
  assert.equal(fit('日本語', 5).includes('\x1b['), false, 'plain text gains no escape byte')
}
{
  const plain = clip('abcdefghij', 4)
  assert.equal(plain, 'abc…', 'clip on plain text is a plain truncation')
  assert.equal(plain.includes('\x1b'), false, 'and carries no escape byte at all')
  assert.equal(clip('日本語です', 5), '日本…', 'CJK truncation is escape-free too')
  const coloured = clip('\x1b[31m日本語\x1b[0m', 5)
  assert.ok(coloured.includes('\x1b[0m…'), 'clip still resets coloured text before the ellipsis')
  // Byte-identical to a truncation that never knew about SGR: the only
  // difference from plain text is the kept prefix and the ellipsis.
  assert.equal(clip('abcdefghij', 4), 'abcdefghij'.slice(0, 3) + '…', 'plain clip is byte-identical to a plain cut')
}

// charCells is the unit both helpers trust.
assert.equal(charCells('日'), 2, 'CJK is two cells')
assert.equal(charCells('e\u0301'), 1, 'a base plus a combining mark is one cell')
assert.equal(charCells('\u200d'), 0, 'a ZWJ is zero cells')

console.log('width tests passed (CJK, emoji, combining marks, ZWJ, ANSI all fit their budget)')
