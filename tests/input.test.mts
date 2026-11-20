import assert from 'node:assert/strict'

import { restArguments, splitCommandAndPrompt, splitUnknownCommand } from '../input.ts'

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

// A `rest: true` command owns the lines below it: `/tools` + `off 3` is one
// command, not a picker followed by a prompt the model would answer. The probe
// sees the arguments, so text that is not a subcommand is still a prompt.
const takesOff = (name: string, args: string): boolean =>
  name === '/tools' && (args.split(/\s+/, 1)[0] ?? '') === 'off'
assert.deepEqual(splitCommandAndPrompt('/tools\noff 3', tools, takesOff), {
  command: '/tools off 3',
  prompt: '',
})
assert.deepEqual(splitCommandAndPrompt('/tools\n\noff\n  3', tools, takesOff), {
  command: '/tools off 3',
  prompt: '',
})
assert.deepEqual(splitCommandAndPrompt('/tools\nhi', tools, takesOff), {
  command: '/tools',
  prompt: 'hi',
}, 'a line that is not the sub-grammar stays the prompt under the command')
assert.deepEqual(splitCommandAndPrompt('/tools\noff 3', tools), { command: '/tools', prompt: 'off 3' }, 'without the probe the old split is kept')
assert.deepEqual(splitCommandAndPrompt('/model river/x\nhi', toolsAndModel, takesOff), {
  command: '/model river/x',
  prompt: 'hi',
}, 'a non-rest command still splits off a prompt')

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

// ------------------------------------------------------- unknown command + text
// `/foo` runs nothing and the dispatcher says so, but the question under it is
// still what the user asked: the split is reported so the caller can print the
// unknown-command line and then ask the rest.
const noCommands = (): boolean => false
assert.deepEqual(splitUnknownCommand('/foo\nhi', noCommands), { command: '/foo', prompt: 'hi' })
// The command line keeps its own arguments: only the table decides.
assert.deepEqual(splitUnknownCommand('  /foo --bar \nhi', noCommands), { command: '/foo --bar', prompt: 'hi' })
// Blank separator lines under it are spacing, as for a known command.
assert.deepEqual(splitUnknownCommand('/foo\n\nhi\nthere', noCommands), { command: '/foo', prompt: 'hi\nthere' })

// No text under it: the plain unknown-command line already says everything, so
// there is no second half to send (and no empty prompt).
assert.equal(splitUnknownCommand('/foo', noCommands), undefined)
assert.equal(splitUnknownCommand('/foo\n\n   \n', noCommands), undefined)

// A known command is never an unknown one, whatever its shape: `/tools` with a
// question is `splitCommandAndPrompt`'s case, and a known-but-misshapen line is
// a usage error, not a prompt.
const known = (name: string): boolean => name === '/tools' || name === '/exit'
assert.equal(splitUnknownCommand('/tools\nhi', known), undefined)
assert.equal(splitUnknownCommand('/exit now\nhi', known), undefined, 'a misshapen command stays a usage error')

// Nothing to split without a newline, and a non-slash first line is a prompt.
assert.equal(splitUnknownCommand('/foo hi', noCommands), undefined)
assert.equal(splitUnknownCommand('hello\n/foo', noCommands), undefined)

// Only the bare first token is looked up, so `/foo/bar` is not `/foo`.
const names: string[] = []
assert.equal(
  splitUnknownCommand(
    '/foo/bar\nhi',
    (name) => {
      names.push(name)
      return false
    },
  )?.command,
  '/foo/bar',
)
assert.deepEqual(names, ['/foo/bar'])

// ------------------------------------------------------- the real rest grammar
// `restArguments` is what chat.ts dispatches with, so it is under test here
// directly: the whole block under a rest command must match that command's
// sub-grammar, not just its first word. A first-word check swallowed ordinary
// English, because `on`, `all`, `new` and `start` open real prompts too.
const knownRest = (name: string): boolean =>
  name === '/tools' || name === '/sessions' || name === '/web'
const realSplit = (text: string): ReturnType<typeof splitCommandAndPrompt> =>
  splitCommandAndPrompt(text, knownRest, restArguments)

// The four reported losses: a sentence whose first word is a verb of the
// command must stay the prompt, whole and untouched.
const PROMPTS_UNDER = [
  ['/tools', 'on the record, why is this slow?'],
  ['/tools', 'all of the above explains the design'],
  ['/sessions', 'new ideas for the parser'],
  ['/web', 'start over with a simpler approach'],
] as const
for (const [name, question] of PROMPTS_UNDER) {
  assert.equal(restArguments(name, question), false, `the grammar refuses "${question}"`)
  assert.deepEqual(
    realSplit(`${name}\n${question}`),
    { command: name, prompt: question },
    `${name} + "${question}" keeps the question as the prompt`,
  )
}

// The still-working selector cases: real usage is one command with no prompt.
const COMMAND_BLOCKS = [
  ['/tools', 'off 3', '/tools off 3'],
  ['/tools', 'on', '/tools on'],
  ['/tools', 'off all', '/tools off all'],
  ['/tools', 'restore shell', '/tools restore shell'],
  ['/tools', 'reset', '/tools reset'],
  ['/tools', 'refresh', '/tools refresh'],
  ['/tools', '--all', '/tools --all'],
  ['/sessions', 'new refactor', '/sessions new refactor'],
  ['/sessions', 'rename 2 mine', '/sessions rename 2 mine'],
  ['/sessions', 'delete 3', '/sessions delete 3'],
  ['/sessions', 'list', '/sessions list'],
  ['/web', 'status', '/web status'],
  ['/web', 'start', '/web start'],
  ['/web', 'down', '/web down'],
] as const
for (const [name, block, joined] of COMMAND_BLOCKS) {
  assert.equal(restArguments(name, block), true, `the grammar takes "${block}"`)
  assert.deepEqual(
    realSplit(`${name}\n${block}`),
    { command: joined, prompt: '' },
    `${name} + "${block}" is one command`,
  )
}

console.log(
  'input tests passed (command+prompt, rest-command lines, real rest grammar, no-split, unknown-command cases)',
)

