/**
 * The look of the transcript: what a row says and how much of it.
 *
 * These are the four changes that made the output readable, pinned so they
 * cannot silently regress:
 *
 * 1. a call is a verb and its target (`Read package.json`), never argument JSON;
 * 2. a result says what came back (`Read 7 lines`), not how long it took;
 * 3. a failure names the code and the sentence, not the absolute path;
 * 4. the user's own words carry `❯`, not a full-width grey bar.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { shortError } from '../view.ts'
import { callLine, resultSummary } from '../tool-label.ts'

// --------------------------- failures

// The headline case: the tool decorates the message with the file it already
// named in the call row, and the absolute path is where the home directory is.
{
  const raw =
    'cannot read "tests/does-not-exist.ts": ENOENT: no such file or directory, lstat \'C:\\Users\\oleksii\\Documents\\z1-projects\\z1-cli\\tests\\does-not-exist.ts\''
  const short = shortError(raw)
  assert.match(short, /^ENOENT/, 'the code leads, without the tool prefix')
  assert.ok(!short.includes('cannot read'), 'the call row already says what could not be read')
  assert.ok(!short.includes('C:\\Users'), 'the home directory is not the failure')
  assert.ok(short.includes('does-not-exist.ts'), 'the file name survives: it identifies the failure')
}

// A relative path is the file's own name and must not be mangled. The first
// version of this function matched a bare `/` and turned
// `tests/does-not-exist.ts` into `testsdoes-not-exist.ts`.
{
  const short = shortError('cannot read "tests/does-not-exist.ts": ENOENT: no such file or directory')
  assert.ok(short.includes('ENOENT'), 'the code is kept')
  assert.ok(!short.includes('testsdoes'), 'a relative path is not joined to its own prefix')
}

// A POSIX absolute path is shortened the same way as a Windows one.
{
  const short = shortError("ENOENT: no such file or directory, open '/home/u/projects/app/x.ts'")
  assert.ok(!short.startsWith('/home'), 'the root is dropped')
  assert.ok(short.includes('x.ts'), 'and the file name is kept')
}

// A message with no path is untouched apart from whitespace.
assert.equal(shortError('exit 1'), 'exit 1')
assert.equal(shortError('  exit   1  '), 'exit 1', 'runs of whitespace collapse')

// A very long message is capped rather than wrapping the row.
{
  const long = `E: ${'x'.repeat(400)}`
  const short = shortError(long)
  assert.ok(short.length <= 100, 'the row stays one line')
  assert.ok(short.endsWith('…'), 'and says it was cut')
}

// --------------------------- the user's own words

// The prompt keeps a full-width tinted band: it is the one row that is not the
// agent talking, and the band is what makes a long transcript scannable. `❯`
// sits in front of it, so the marker survives a pipe (where the band cannot be
// drawn) and a theme that renders the background faintly.
{
  const source = readFileSync(join(import.meta.dirname, '..', 'chat.ts'), 'utf8')
  assert.match(source, /\? '❯ ' : '  '/, 'the live prompt is marked with ❯')
  assert.match(source, /paint\('48;5;237', bar\)/, 'the live prompt is a full-width band')
  assert.match(source, /padTo\(line, Math\.max\(1, terminalColumns\(\) - 1\)\)/, 'the band spans the row')
  // A reopened session must look like the one that produced it.
  const stored = source.slice(source.indexOf('const printStoredUser'))
  assert.match(stored.slice(0, 600), /48;5;237/, 'the stored prompt draws the same band')
  assert.match(stored.slice(0, 600), /'❯ ' : '  '/, 'and the same marker')
}

// The exact complaint that started this work: `read({"path":"a.ts"})`.
{
  const line = callLine('read', { path: 'a.ts' })
  assert.equal(line, 'Read a.ts')
  assert.ok(!line.includes('{'), 'no JSON object')
  assert.ok(!line.includes('"'), 'no JSON quotes')
}

// --------------------------- the result row is not telemetry

// `✓ 408ms · 163 B` answers a question nobody asked; `Read 7 lines` is the
// answer to "did it work".
{
  const summary = resultSummary('read', 'a\nb\nc\nd\ne\nf\ng')
  assert.equal(summary, 'Read 7 lines')
  assert.ok(!/\d+ms/.test(summary ?? ''), 'no duration in the result row')
}

console.log('PASS: cli-look (short failures, human call rows, result summaries)')
