import assert from 'node:assert/strict'

import { splitCommandAndPrompt } from '../input.ts'

/** The console's own predicate, reduced to existence and shape. */
const probeFor = (table: Record<string, 'none' | 'args' | 'rest'>) => (name: string, rest: string): boolean => {
  const kind = table[name]
  if (kind === undefined) return false
  if (kind === 'args') return rest !== ''
  return kind === 'rest' || rest === ''
}

const tools = probeFor({ '/tools': 'rest' })
const toolsAndModel = probeFor({ '/tools': 'rest', '/model': 'args' })

// ------------------------------------------------------------ command + prompt
// The reported case: the composer submits `/tools` and the question after it as
// one string. Both halves are kept: the command line, and the question under it.
assert.deepEqual(splitCommandAndPrompt('/tools\nhi', tools), { command: '/tools', prompt: 'hi' })

// Blank lines between them are spacing, and the prompt keeps its own newlines.
assert.deepEqual(splitCommandAndPrompt('/tools\n\nhi\nthere', tools), {
  command: '/tools',
  prompt: 'hi\nthere',
})
assert.deepEqual(splitCommandAndPrompt('/tools\n   \nhi', tools), { command: '/tools', prompt: 'hi' })
// Indentation inside the prompt is content (a pasted snippet), so only whole
// blank lines are dropped; the caller trims the submission's own edges.
assert.deepEqual(splitCommandAndPrompt('/tools\n\n  indented()', tools), {
  command: '/tools',
  prompt: '  indented()',
})

// Arguments stay with the command, never with the prompt.
assert.deepEqual(splitCommandAndPrompt('/model river/x\nhi', toolsAndModel), {
  command: '/model river/x',
  prompt: 'hi',
})
assert.deepEqual(splitCommandAndPrompt('  /tools  \nhi', tools), { command: '/tools', prompt: 'hi' })

// A command with nothing under it is the command alone: the caller runs it and
// stops, it is not a prompt.
assert.equal(splitCommandAndPrompt('/tools', tools), undefined)
assert.deepEqual(splitCommandAndPrompt('/tools\n\n', tools), { command: '/tools', prompt: '' })

// ------------------------------------------------------------------ no split
// An unknown `/foo` is text the user may want the model to read (a pasted path,
// a diff): swallowing it would lose the prompt, so it stays one prompt.
assert.equal(splitCommandAndPrompt('/unknown\nhi', tools), undefined)
// A command that is not on the first line is part of the prompt.
assert.equal(splitCommandAndPrompt('hello\n/tools', tools), undefined)
// No newline, no second half to split off.
assert.equal(splitCommandAndPrompt('/tools hi', tools), undefined)
// The shape of the command's own line is part of the predicate: `/model` with no
// argument is a usage error, so the text under it must not be run under it.
assert.equal(splitCommandAndPrompt('/model\nhi', probeFor({ '/model': 'args' })), undefined)
assert.equal(splitCommandAndPrompt('/exit now\nhi', probeFor({ '/exit': 'none' })), undefined)

// The predicate is never asked about a line that is not a command line.
const asked: string[] = []
const probe = (name: string): boolean => {
  asked.push(name)
  return false
}
assert.equal(splitCommandAndPrompt('hello\nthere', probe), undefined)
assert.equal(splitCommandAndPrompt('hello\n/tools', probe), undefined)
assert.equal(asked.length, 0, 'a non-slash first line does not consult the table')

console.log('input tests passed (6 split cases, 2 no-split cases)')
