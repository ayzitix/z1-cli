/**
 * The live-subagent row is a *state*, so it carries the theme's state hue.
 *
 * The rule from `z1-docs/docs/theme.md`: white surfaces, black accents, and the
 * only colours allowed to have a hue are the ones that mean something. A child
 * that is running is live work, so the row is green (`ViewTheme.green`, SGR
 * 32) while the rest of the tray stays dim.
 *
 * Three writers paint that row and they must all agree:
 *
 * 1. the composer footer (`hint()` → `layout()`), where the row replaces
 *    `? for shortcuts`;
 * 2. the turn's plate (compact/medium activity row);
 * 3. the between-turns repaint (`childIdleRow`).
 *
 * The row *text* still comes from one place (`runningLabel`), so these tests
 * assert the colour decision on top of the already-tested text.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runningLabel } from '../agents.ts'
import { displayCells, stripAnsi } from '../width.ts'

const source = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf8')

// The palette: green is SGR 32 and is the name the theme exposes. A row that
// used `cyan` or `bold` would be a different meaning, not this one.
assert.match(source, /const green = \(text: string\): string => paint\('32', text\)/, 'green is SGR 32')
assert.match(
  source,
  /const viewTheme: ViewTheme = \{ dim, bold, cyan, green, red, yellow \}/,
  'the theme handed to the formatter carries the same green',
)

// --------------------------- writer 3: between turns

// The idle row is the plainest case: no plate, no footer - just the row above
// the prompt while a child runs.
assert.match(
  source,
  /const childIdleRow = \(\): string \| undefined => \{\s*const row = childStatusRow\(\{ running: runningChildren \}\)\s*return row === undefined \? undefined : green\(row\)/,
  'the between-turns row is green',
)

// --------------------------- writer 2: the plate

assert.match(
  source,
  /const childRow = children === undefined \? undefined : green\(children\)/,
  'the plate appends a green child row',
)

// --------------------------- writer 1: the footer

// The footer is dim as a whole; the live row is the one segment that keeps its
// state hue. The decision compares against the *same* string `hint()` returned,
// so the footer cannot grow a second copy of the precedence rule.
assert.match(
  source,
  /const runningHint = runningLabel\(runningChildren\)\s*\n\s*const liveChildRow = runningHint !== undefined && hint === runningHint/,
  'the footer colours exactly the row the hint returned',
)
assert.match(
  source,
  /liveChildRow && left\.length > 0 \? `  \$\{green\(left\)\}\$\{dim\(after\)\}` : dim\(`  \$\{left\}\$\{after\}`\)/,
  'only that segment is green; everything else stays dim',
)
assert.match(source, /      footer,\r?\n {4}\]/, 'the footer is painted once, not re-dimmed over the green')

// The footer's width maths must stay ANSI-agnostic *or* ANSI-aware; it currently
// measures the plain hint, and the coloured row is the same cells. This asserts
// the coloured and plain forms have identical display width, which is the
// property that keeps the padding correct.
{
  const plain = runningLabel(2)
  assert.ok(plain !== undefined)
  const green = (text: string): string => `\x1b[32m${text}\x1b[0m`
  assert.equal(displayCells(green(plain)), displayCells(plain), 'colouring adds no cells')
  assert.equal(stripAnsi(green(plain)), plain, 'stripping the colour gives the plain row back')
}

// A green row must vanish when the last child settles: colour is not state, the
// count is. `runningLabel(0)` is the single source of that.
assert.equal(runningLabel(0), undefined, 'no running children, no coloured row')

// --------------------------- NO_COLOR

// `paint` is the only colour path, and it is a no-op without a TTY or with
// `NO_COLOR`. A green row therefore degrades to the plain text, never to a
// broken escape sequence.
assert.match(
  source,
  /const paint = \(code: string, text: string\): string =>\s*colorEnabled \? `\\x1b\[\$\{code\}m\$\{text\}\\x1b\[0m` : text/,
  'paint is identity without colour',
)
assert.match(
  source,
  /const colorEnabled = Boolean\(process\.stdout\.isTTY\) && process\.env\['NO_COLOR'\] === undefined/,
  'colour is off in a pipe or with NO_COLOR',
)

console.log('PASS: subagent-row-colour (green state hue in all three writers, NO_COLOR safe)')
