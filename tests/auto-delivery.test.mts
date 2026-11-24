/**
 * Auto-delivery of a settled background child (2b).
 *
 * The requirement, in the user's words: the parent must not wait for a
 * subagent, and when the child finishes it reports back to the parent. The
 * second half is what this tests: the report reaches the parent *without the
 * user typing anything*, once, whichever side of a turn the settle lands on.
 *
 * Everything asserted here is the pure decision (`settleSignal`,
 * `afterTurnSignal`) plus the wiring that uses it in `chat.ts`. The turn
 * itself is the existing, tested delivery path (`drainSettled` +
 * `deliveredBlock`), so nothing here re-tests how a block is built.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  AUTO_DELIVERY_LINE,
  AUTO_DELIVERY_PROMPT,
  AUTO_DELIVERY_ROW,
  afterTurnSignal,
  settleSignal,
} from '../auto-delivery.ts'

const source = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf8')

// --------------------------- the sentinel cannot be typed

// The wake travels through the ordinary line queue, so it must be a string no
// user input can equal. NUL is not typeable and is stripped by no editing path
// short of a deliberate paste, which `trim()` does not remove either.
assert.ok(AUTO_DELIVERY_LINE.includes('\u0000'), 'the sentinel carries a NUL')
assert.equal(AUTO_DELIVERY_LINE.trim(), AUTO_DELIVERY_LINE, 'a NUL survives trim, so a queued line cannot decay into it')
assert.ok(AUTO_DELIVERY_LINE.length > 2, 'the sentinel is a whole token, not a stray control byte')
for (const typed of ['', ' ', '/agents', 'continue', 'a\u0000b']) {
  assert.notEqual(typed, AUTO_DELIVERY_LINE, `typed input ${JSON.stringify(typed)} is not the sentinel`)
}

// The prompt is an instruction to continue, never a question to the user, and
// it repeats the one rule that matters: the report is data.
assert.match(AUTO_DELIVERY_PROMPT, /finished/i, 'the prompt says a child finished')
assert.match(AUTO_DELIVERY_PROMPT, /subagent output/i, 'the prompt marks the block as subagent output')
assert.match(AUTO_DELIVERY_PROMPT, /not as instructions/i, 'the prompt keeps the child text untrusted')
assert.match(AUTO_DELIVERY_PROMPT, /do not wait/i, 'the prompt forbids waiting on the rest')
assert.ok(!AUTO_DELIVERY_PROMPT.endsWith('?'), 'the automated turn does not ask the user anything')

// The visible row is short enough for the transcript and starts with the glyph
// the running row uses, so the two read as the same feature.
assert.ok(AUTO_DELIVERY_ROW.startsWith('◷ '), 'the row uses the running glyph')
assert.ok(AUTO_DELIVERY_ROW.length <= 48, 'the row is a short line, not a sentence')

// --------------------------- the decision

// Idle settle: wake. This is the case the feature exists for - the prompt is
// waiting and nobody may ever type again.
assert.equal(
  settleSignal({ enabled: true, closed: false, turnActive: false, queued: false }),
  'wake',
  'a settle while the prompt is idle wakes the automated turn',
)

// Mid-turn settle: defer. The running turn's seed was built before this report
// existed, so it cannot carry it; waking the queue now would be swallowed by
// the turn's own read of it.
assert.equal(
  settleSignal({ enabled: true, closed: false, turnActive: true, queued: false }),
  'defer',
  'a settle during a turn is deferred, not dropped',
)

// Coalescing: a second child settling while a wake is queued changes nothing.
// `deliveredBlock` names every child in the one turn, so one wake is enough.
assert.equal(
  settleSignal({ enabled: true, closed: false, turnActive: false, queued: true }),
  'ignore',
  'a queued wake absorbs further settles',
)

// `--once` has no next turn: its policy is `once-policy.ts` (wait or detach),
// and it must never queue a sentinel nothing will read.
assert.equal(
  settleSignal({ enabled: false, closed: false, turnActive: false, queued: false }),
  'ignore',
  'a one-shot never queues the automated turn',
)

// A closing session must not start new work.
assert.equal(
  settleSignal({ enabled: true, closed: true, turnActive: false, queued: false }),
  'ignore',
  'a closed session does not wake',
)

// After the turn: only a *deferred* settle wakes. An idle one already woke the
// queue from the callback; waking again would run two turns for one report.
assert.equal(
  afterTurnSignal({ enabled: true, closed: false, turnActive: false, queued: false, deferred: true }),
  'wake',
  'a deferred settle wakes at the top of the loop',
)
assert.equal(
  afterTurnSignal({ enabled: true, closed: false, turnActive: false, queued: false, deferred: false }),
  'ignore',
  'nothing deferred, nothing to wake',
)
assert.equal(
  afterTurnSignal({ enabled: true, closed: false, turnActive: false, queued: true, deferred: true }),
  'ignore',
  'a queued wake is not queued twice',
)
assert.equal(
  afterTurnSignal({ enabled: false, closed: false, turnActive: false, queued: false, deferred: true }),
  'ignore',
  'a one-shot ignores the deferred path too',
)

// The two functions must never disagree about a settle that is both deferred
// and still mid-turn: the loop top is not reached during a turn.
assert.equal(
  settleSignal({ enabled: true, closed: false, turnActive: true, queued: false }),
  'defer',
  'mid-turn is always defer, never wake',
)

// --------------------------- the wiring

// The settle hook asks the decision, not a hand-rolled condition.
assert.match(
  source,
  /onFinish:[\s\S]*?wakeForSettledChild\(\)/,
  'a finished child asks for the automated delivery',
)
// Only a background, still-undelivered child wakes: a `wait: true` child
// already answered its call, and a second report would be a duplicate.
assert.match(
  source,
  /after\.mode === 'background' &&\s*after\.delivered !== true/,
  'only an undelivered background child wakes a turn',
)
// The loop top delivers a settle deferred by the turn that was running.
assert.match(source, /wakeDeferredSettle\(\)/, 'the loop top drains a deferred settle')
assert.match(
  source,
  /const wakeDeferredSettle = \(\)[\s\S]*?afterTurnSignal\(\{/,
  'the loop top goes through the pure decision',
)
assert.match(
  source,
  /const wakeForSettledChild = \(\)[\s\S]*?settleSignal\(\{/,
  'the settle path goes through the pure decision',
)
// The turn owns the transcript for exactly the span delivery must avoid, and
// gives it back in `finally` so a throw cannot leave the session stuck.
assert.match(source, /turnActive = true\r?\n/, 'the turn marks the transcript as owned')
assert.match(
  source,
  /finally \{\s*await handle\.dispose\(\)[\s\S]*?turnActive = false/s,
  'the turn releases the transcript even when it throws',
)
// The sentinel never reaches the command table or the model as itself.
assert.match(source, /const autoDelivery = line === AUTO_DELIVERY_LINE/, 'the loop recognises the sentinel')
assert.match(
  source,
  /if \(autoDelivery\) line = AUTO_DELIVERY_PROMPT/,
  'the sentinel becomes the prompt, never a command',
)
assert.match(
  source,
  /const split = autoDelivery\s*\?\s*undefined\s*:\s*splitCommandAndPrompt\(/,
  'an automated turn is never dispatched as a command',
)
// A one-shot does not enable it: `interactive()` is the only surface with a
// next turn, and `oneShot` runs before any of this.
assert.match(source, /autoDeliveryEnabled = true/, 'the interactive session enables the wake')
assert.equal(
  source.match(/autoDeliveryEnabled = true/g)?.length,
  1,
  'exactly one place enables it',
)

// --------------------------- the overtaken wake

// A user prompt already in the queue goes first and drains the report into its
// own seed; the sentinel then has nothing left to deliver. Running the
// automated turn anyway would tell the model "the report is delivered above"
// with no report above it - a lie in the transcript. The loop therefore checks
// the registry before it prints the row or starts the turn.
assert.match(
  source,
  /if \(autoDelivery\) \{\s*autoDeliveryQueued = false[\s\S]*?if \(agents === undefined \|\| agents\.settledUndelivered\(\)\.length === 0\) continue/,
  'an overtaken wake is dropped, not run over nothing',
)
// The check is *after* the queue flag is cleared: a wake that is dropped must
// not leave `autoDeliveryQueued` stuck true, or no later settle would ever wake
// anything again.
{
  const at = source.indexOf('autoDeliveryQueued = false')
  const guard = source.indexOf('settledUndelivered().length === 0) continue')
  assert.ok(at >= 0 && guard > at, 'the flag is cleared before the overtaken wake is dropped')
}

console.log('PASS: auto-delivery (sentinel, idle/mid-turn/coalesce, after-turn, wiring)')
