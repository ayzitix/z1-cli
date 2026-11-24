/**
 * How a tool call reads to a person.
 *
 * The complaint that started this: the transcript printed `read({"path":
 * "package.json"})` in the middle of prose. These tests pin the translation
 * table, because the wording is the whole point - a regression here is
 * immediately visible on screen, but only if something checks it.
 */

import assert from 'node:assert/strict'

import {
  MAX_LABEL,
  callLine,
  resultSummary,
  tailPath,
  toolLabel,
  toolVerb,
} from '../tool-label.ts'

// --------------------------- verbs

// A known tool gets a capitalised verb, not its id.
assert.equal(toolVerb('read'), 'Read')
assert.equal(toolVerb('web.search'), 'Search', 'a namespaced tool reads as the operation')
assert.equal(toolVerb('web.fetch'), 'Fetch')
assert.equal(toolVerb('git.status'), 'Git status')
assert.equal(toolVerb('apply_patch'), 'Patch')

// An unknown tool is still readable: separators become spaces, the first word
// is capitalised. It must never be dropped or shown as JSON.
assert.equal(toolVerb('acme.frobnicate'), 'Acme frobnicate')
assert.equal(toolVerb('some_new_tool'), 'Some new tool')
assert.equal(toolVerb('weird-tool'), 'Weird tool')

// --------------------------- the call line

// The headline case: a path argument becomes the label, and the path keeps its
// tail because the file name is what identifies the file.
assert.equal(callLine('read', { path: 'package.json' }), 'Read package.json')
{
  const deep = callLine('read', { path: 'C:\\Users\\oleksii\\Documents\\z1-projects\\z1-cli\\chat.ts' })
  assert.ok(deep.startsWith('Read …/'), 'an absolute path drops its root')
  assert.ok(deep.endsWith('chat.ts'), 'and keeps the file name')
  assert.ok(!deep.includes('C:'), 'the drive letter is not a segment')
  assert.ok(deep.length <= 'Read '.length + MAX_LABEL, 'and stays within the budget')
}
// A path too deep to read keeps only its last few segments: `a/a/a/…/file.ts`
// fits in 64 characters and is still unreadable, so depth has its own budget.
{
  const veryDeep = callLine('read', { path: `C:\\${'a\\'.repeat(40)}file.ts` })
  assert.equal(veryDeep, 'Read …/a/a/file.ts', 'a deep path keeps its last three segments')
}
assert.equal(callLine('read', '{"path":"src/main.ts"}'), 'Read src/main.ts', 'a JSON string argument works too')

// Other identifying arguments.
assert.equal(callLine('grep', { pattern: 'TODO' }), 'Grep TODO')
assert.equal(callLine('web.search', { query: 'gta 6 price' }), 'Search gta 6 price')
assert.equal(callLine('list', { path: 'tests' }), 'List tests')

// A command keeps its head: `git status --short` is a different operation from
// `git push`, and the subcommand is what says which.
assert.equal(callLine('shell', { command: 'git', args: ['status', '--short'] }), 'Shell git status --short')

// A pair reads as a transition.
assert.equal(callLine('move', { from: 'a/old.ts', to: 'b/new.ts' }), 'Move a/old.ts → b/new.ts')

// A tool with no useful argument is its verb alone - never a pair of braces.
assert.equal(callLine('read', {}), 'Read')
assert.equal(callLine('read', undefined), 'Read')
assert.equal(callLine('read', ''), 'Read')
assert.equal(callLine('read', '{}'), 'Read')

// An unrecognised payload still names something, rather than printing JSON.
{
  const line = callLine('acme.thing', { zeta: 'value', alpha: 'other' })
  assert.equal(line, 'Acme thing value', 'the first string value names the call')
  assert.ok(!line.includes('{'), 'never a JSON brace')
}

// --------------------------- truncation

// A long value is cut with an ellipsis, and the ellipsis is the last char.
{
  const long = 'x'.repeat(300)
  const line = callLine('grep', { pattern: long })
  assert.ok(line.length <= 'Grep '.length + MAX_LABEL + 1, 'the label respects its budget')
  assert.ok(line.endsWith('…'), 'and says it was cut')
}

// A path keeps its last segment when cut.
{
  const path = `${'a/'.repeat(60)}file.ts`
  const cut = tailPath(path, 30)
  assert.ok(cut.startsWith('…'), 'a cut path starts with the ellipsis')
  assert.ok(cut.endsWith('file.ts'), 'and keeps the file name')
  assert.ok(cut.length <= 30, 'within its budget')
}

// --------------------------- result summaries

// The result row answers "what came back", not "how long it took".
assert.equal(resultSummary('read', 'line one\nline two\nline three'), 'Read 3 lines')
assert.equal(resultSummary('read', ''), '(no output)')
assert.equal(resultSummary('read', 'one line'), 'one line', 'a single line is its own summary')

// A list-shaped result names its size.
assert.equal(resultSummary('list', { entries: ['a', 'b', 'c'] }), 'List 3 entries')
assert.equal(resultSummary('list', { entries: [] }), '(no entries)')
assert.equal(resultSummary('glob', { files: ['a', 'b'] }), 'Glob 2 files')

// A shell result counts the lines of its output.
assert.equal(resultSummary('shell', { output: 'a\nb\nc\nd' }), 'Shell 4 lines')

// An error field is surfaced as the summary.
assert.equal(resultSummary('read', { error: 'ENOENT: no such file' }), 'ENOENT: no such file')

// A subagent result is not summarised here: its row is built by
// `agents-output.ts`, and a generic "Subagent N lines" would duplicate it.
assert.equal(resultSummary('subagent', { status: 'running', runId: 'run_x' }), undefined)

// No value at all is not a summary.
assert.equal(resultSummary('read', undefined), undefined)
assert.equal(resultSummary('read', null), undefined)

// --------------------------- the label is not the placeholder

// A regression guard on the exact complaint: no call line may contain the raw
// argument JSON syntax that made the transcript unreadable.
for (const [name, args] of [
  ['read', { path: 'a.ts' }],
  ['grep', { pattern: 'x' }],
  ['shell', { command: 'ls' }],
  ['web.search', { query: 'q' }],
] as const) {
  const line = callLine(name, args)
  assert.ok(!line.includes('{"'), `${name}: no JSON object in the row`)
  assert.ok(!line.includes('":'), `${name}: no JSON key syntax in the row`)
}

console.log('PASS: tool-label (human verbs, identifying args, tail paths, result summaries)')
