/**
 * A hand-off closes the turn, and the *footer* is what says so.
 *
 * The bug this pins, reported by the user: after a launch the transcript
 * printed its own row (`◷ subagent launched · the report arrives when it
 * finishes · /agents`) while the footer already showed
 * `◷ 1 subagent running · /agents`. Two rows, same fact, one screen.
 *
 * The rule now: the turn prints **nothing** for a textless hand-off. The footer
 * row is live for as long as the child runs and the report arrives on its own,
 * so the state is already on screen without the transcript repeating it. What
 * must not happen instead is the old empty-turn fallback
 * (`(the model emitted tool-call markup with no tool result; nothing ran)`),
 * which was false twice over: a child did start, and the turn did not fail.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MARKUP_ONLY_NOTICE, NO_TOOLS_NOTICE } from '../output.ts'
import { runningLabel } from '../agents.ts'

const source = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf8')

// --------------------------- the footer is the one that speaks

// The row that carries the state is the live one, and it names `/agents`.
{
  const row = runningLabel(1)
  assert.equal(row, '◷ 1 subagent running · /agents', 'one live child: the footer row')
  assert.equal(runningLabel(2), '◷ 2 subagents running · /agents', 'two: the count is named')
  assert.equal(runningLabel(0), undefined, 'no child, no row - the footer goes back to idle')
}

// There is no second, transcript-side launch row any more. A grep for the
// sentence is the honest check: the constant is gone, so no path can print it.
assert.ok(!source.includes('subagent launched ·'), 'chat.ts prints no launch row of its own')
assert.ok(!source.includes('report arrives when it finishes'), 'nor the sentence explaining delivery')

// --------------------------- an empty hand-off prints nothing

// The decisive property: with a hand-off and no model text, the reply is empty
// and its notice is undefined, so `progress.print` is never reached. The old
// fallback would have produced MARKUP_ONLY_NOTICE here.
{
  const at = source.indexOf('const handOff =')
  assert.ok(at >= 0, 'the turn decides whether it was a hand-off')
  const decision = source.slice(at, at + 400)
  assert.match(
    decision,
    /\? \{ text: '', notice: undefined as string \| undefined \}/,
    'a hand-off returns no text and no notice: nothing is printed',
  )
  assert.match(
    source,
    /const handOff = result\.status === 'completed' && visible\.trim\(\)\.length === 0 && launchedThisTurn\.length > 0/,
    'only a completed, textless turn that launched something is a hand-off',
  )
  // The fallback still exists for the cases it is actually about.
  const fallback = source.indexOf('finalizeAssistantReply(visible, toolsEnabled)')
  assert.ok(fallback > at, 'the empty-turn fallback is still there, below the hand-off case')
}

// A hand-off does not need a running child to be recognised: a fast child may
// settle before the turn closes, and the turn must still not claim "nothing
// ran". `launchedThisTurn` is what it reads, not the live count.
{
  assert.match(source, /launchedThisTurn\.push\(launch\.result\.runId\)/, 'the turn records what it started')
  const handOffLine = source.slice(source.indexOf('const handOff ='), source.indexOf('const reply ='))
  assert.ok(!handOffLine.includes('running()'), 'the decision does not read the live count')
}

// --------------------------- the notices that remain are still honest

// The two empty-turn notices are untouched, because they answer different
// questions: no tools at all, or markup with no result. Neither applies to a
// hand-off, which is exactly why the hand-off case comes first.
assert.ok(MARKUP_ONLY_NOTICE.includes('nothing ran'), 'the markup notice still exists')
assert.ok(NO_TOOLS_NOTICE.includes('/tools'), 'the no-tools notice still exists')
assert.ok(!MARKUP_ONLY_NOTICE.includes('subagent'), 'and neither mentions a delegation')
assert.ok(!NO_TOOLS_NOTICE.includes('subagent'), 'nor the other')

// --------------------------- the user still learns the outcome

// Removing the duplicate row must not remove the *report*: the delivery turn
// prints the child's answer (in the `/view` form) and the footer disappears when
// the count reaches zero. The report path is asserted in `agents-output.test`.
{
  assert.match(source, /deliveredLines\(\{/, 'the delivered report is still printed by the turn')
  assert.match(source, /if \(autoDelivery\) \{[\s\S]*?say\(green\(AUTO_DELIVERY_ROW\)\)/, 'the reporting turn is still announced once')
}

console.log('PASS: launch-row (no duplicate row; a textless hand-off prints nothing; footer carries the state)')
