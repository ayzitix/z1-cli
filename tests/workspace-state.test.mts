import assert from 'node:assert/strict'
import { join, sep } from 'node:path'

import { OWN_STATE_HEADING, ownStateText } from '../workspace-state.ts'

const cwd = '/home/me/proj'
/** The body is one line per rule; a section that grew is a section that drifts. */
const bodyLines = (text: string) => text.split('\n').filter((line) => line.trim() !== '')

// Root inside the workspace: relative, as the user sees it.
const inside = ownStateText({ cwd, sessionRoot: join(cwd, 'z1') })
assert.ok(inside.startsWith(`${OWN_STATE_HEADING}\n\n`), 'the body carries its own heading')
assert.ok(inside.includes('`z1/` is z1'), 'the root is shown relative to cwd')
assert.ok(!inside.includes(cwd), 'no absolute path when the root is inside the workspace')
assert.ok(inside.includes('`.z1/`'), 'the .z1/ half is always present')

// Root in a nested directory: still relative, no leading `./`, posix separators.
const nested = ownStateText({ cwd, sessionRoot: join(cwd, 'state', 'deep', 'z1') })
assert.ok(nested.includes('`state/deep/z1/`'), 'a nested root keeps its subdirectories')
assert.ok(nested.includes(`${OWN_STATE_HEADING}\n\n`), 'the heading is always first')

// Root outside: absolute, and never a `..` the model could resolve into a sibling.
for (const outside of ['/home/me/other/z1', '/tmp/somewhere/z1']) {
  const text = ownStateText({ cwd, sessionRoot: outside })
  assert.ok(text.includes(`\`${outside}/`.split(sep).join('/')), `absolute root is shown: ${outside}`)
  assert.ok(!text.includes('..'), 'no parent-relative path reaches the prompt')
}

// Root equal to cwd: "inside" would be the empty string, so it is shown absolute.
const same = ownStateText({ cwd, sessionRoot: cwd })
assert.ok(same.includes(`\`${cwd}/`), 'root === cwd falls back to the absolute form')
assert.ok(!same.includes('``'), 'never an empty path')

// No root: the .z1/ half survives, and nothing pretends to know the transcripts.
const none = ownStateText({ cwd })
assert.ok(none.startsWith(OWN_STATE_HEADING), 'no root still gets a section')
assert.ok(none.includes('`.z1/`'), 'the .z1/ half is present without a root')
assert.ok(!/transcript/i.test(none), 'no transcript path or promise without a root')
assert.ok(!none.includes(cwd), 'no path at all without a root')
assert.equal(ownStateText({ cwd, sessionRoot: '  ' }), none, 'a blank root is an unknown root')

// Shape: compact, bullet-only, and no claim that the tools enforce any of it.
for (const text of [inside, nested, none]) {
  assert.ok(bodyLines(text).length <= 9, 'the section stays under ten lines')
  for (const line of bodyLines(text).slice(2)) {
    assert.ok(line.startsWith('- '), 'rules are plain bullets')
  }
  assert.ok(!/enforce|prevent|block/i.test(text), 'no claim that the tools enforce this')
}

console.log('workspace-state tests passed')
