/**
 * The output sanitizer — the safety net for a model that answers a 0-tool turn
 * with raw provider syntax (`<|DSML| calls>`, `<invoke>`, `parameter` rows).
 *
 * The screenshot block is fed at every possible split and one byte at a time:
 * a streaming sanitizer that only works on whole strings is the bug, not the fix.
 * The other checks pin the two promises the module makes: ordinary HTML and
 * fenced code survive, and a partial `<|` is never held forever.
 */
import assert from 'node:assert/strict'

import {
  MARKUP_ONLY_NOTICE,
  NO_TOOLS_NOTICE,
  UNCLOSED_BLOCK_NOTICE,
  createOutputSanitizer,
  finalizeAssistantReply,
  sanitizeOutput,
} from '../output.ts'

// The exact failure from the report: a 0-of-27 turn answered with DSML.
const BLOCK = [
  '<|DSML| calls>',
  '<|DSML| invoke name="process.kill">',
  '<|DSML| parameter name="id" string="true">bg_7c4fcd0d</|DSML| parameter>',
  '</|DSML| invoke>',
  '</|DSML| calls>',
].join('\n')

// ------------------------------------------------- the screenshot, every split
const whole = sanitizeOutput(BLOCK)
assert.equal(whole.text, '', 'the block on its own leaves nothing')
assert.equal(whole.removed, true, 'and the caller is told something was removed')

for (let split = 0; split <= BLOCK.length; split += 1) {
  const sanitizer = createOutputSanitizer()
  const text = sanitizer.push(BLOCK.slice(0, split)) + sanitizer.push(BLOCK.slice(split)) + sanitizer.flush()
  assert.equal(text.trim(), '', `two deltas split at ${String(split)} leak no block`)
}

// One character per delta is how a provider streams a token at a time.
{
  const sanitizer = createOutputSanitizer()
  let text = ''
  for (const char of BLOCK) text += sanitizer.push(char)
  text += sanitizer.flush()
  assert.equal(text, '', 'one-byte deltas remove the whole block')
}

// A trailing newline is part of the line the block owned.
{
  const sanitizer = createOutputSanitizer()
  const text = sanitizer.push(`${BLOCK}\n`) + sanitizer.flush()
  assert.equal(text, '', 'the block and its line ending are gone')
}

// ------------------------------------------- the spaced form a model emitted
// The reported text, exactly: the model put spaces inside the control token
// (`<| DSML | calls>`), which the tight matcher left as ` calls>` prose.
const SPACED = [
  '<| DSML | calls>',
  '<| DSML | invoke name="process.kill">',
  '<| DSML | parameter name="id" string="true">bg_7c4fcd0d</| DSML | parameter>',
  '</| DSML | invoke>',
  '</| DSML | calls>',
].join('\n')

{
  const spaced = sanitizeOutput(SPACED)
  assert.equal(spaced.text, '', 'the spaced block leaves no text')
  assert.equal(spaced.removed, true, 'and the caller is told something was removed')
}

for (let split = 0; split <= SPACED.length; split += 1) {
  const sanitizer = createOutputSanitizer()
  const text = sanitizer.push(SPACED.slice(0, split)) + sanitizer.push(SPACED.slice(split)) + sanitizer.flush()
  assert.equal(text, '', `two spaced deltas split at ${String(split)} leak nothing`)
}

{
  const sanitizer = createOutputSanitizer()
  let text = ''
  for (const char of SPACED) text += sanitizer.push(char)
  text += sanitizer.flush()
  assert.equal(text, '', 'one-byte deltas remove the spaced block too')
}

// Mixed shapes: models are inconsistent about the spacing from line to line.
{
  const mixed = [
    '<|DSML| calls>',
    '<| DSML | invoke name="process.kill">',
    '<|DSML| parameter name="id" string="true">bg_7c4fcd0d</| DSML | parameter>',
    '</| DSML | invoke>',
    '</|DSML| calls>',
  ].join('\n')
  assert.equal(sanitizeOutput(mixed).text, '', 'tight and spaced markers pair inside one block')
  for (let split = 0; split <= mixed.length; split += 1) {
    const sanitizer = createOutputSanitizer()
    const text = sanitizer.push(mixed.slice(0, split)) + sanitizer.push(mixed.slice(split)) + sanitizer.flush()
    assert.equal(text, '', `a mixed block split at ${String(split)} leaks nothing`)
  }
}

// Prose on both sides of a spaced block survives, at every split.
for (const split of [0, 3, 17, 40, 61, 90, 120, 200]) {
  const doc = `I cannot run that.\n${SPACED}\nDone.`
  const sanitizer = createOutputSanitizer()
  const text =
    sanitizer.push(doc.slice(0, split)) + sanitizer.push(doc.slice(split)) + sanitizer.flush()
  assert.equal(text, 'I cannot run that.\nDone.', `prose around a spaced block survives a split at ${String(split)}`)
}

// The same text inside a fence is code: nobody touches it.
{
  const fenced = `\`\`\`\n${SPACED}\n\`\`\``
  assert.equal(sanitizeOutput(fenced).text, fenced, 'a fence holding the spaced block is untouched')
  assert.equal(sanitizeOutput(fenced).removed, false, 'nothing was removed from the fence')
  const sanitizer = createOutputSanitizer()
  let text = ''
  for (const char of fenced) text += sanitizer.push(char)
  text += sanitizer.flush()
  assert.equal(text, fenced, 'the fence survives one-byte deltas with the block inside')
}

// A `calls>` that is part of a sentence is prose, not a block opener.
assert.equal(
  sanitizeOutput('The tool makes calls> often, and the parameter is optional.').text,
  'The tool makes calls> often, and the parameter is optional.',
  'prose containing calls>/parameter survives',
)
assert.equal(
  sanitizeOutput('The function calls invoke and parameter rows.').text,
  'The function calls invoke and parameter rows.',
  'a sentence using all three words is untouched',
)
assert.equal(
  sanitizeOutput('A stray opener:\ncalls>\nthen ordinary prose continues.').text,
  'A stray opener:\nthen ordinary prose continues.',
  'a lone calls> line drops only itself, not the prose under it',
)
assert.equal(
  sanitizeOutput('> a markdown quote\n> another one').text,
  '> a markdown quote\n> another one',
  'markdown blockquotes are prose',
)

// The turn-level result: nothing left, so the user sees the 0-tool notice.
{
  const clean = sanitizeOutput(SPACED).text
  assert.deepEqual(
    finalizeAssistantReply(clean, false),
    { text: NO_TOOLS_NOTICE, notice: NO_TOOLS_NOTICE },
    'the spaced block becomes the /tools notice, not blank text',
  )
}

// ------------------------------------------------------ block inside prose
assert.equal(
  sanitizeOutput(`I cannot run that.\n${BLOCK}\nDone.`).text,
  'I cannot run that.\nDone.',
  'prose before and after a dropped block survives',
)
{
  // The block can arrive in the middle of a sentence too: the prose stays and
  // only the markup between it disappears.
  const sanitizer = createOutputSanitizer()
  const text =
    sanitizer.push('No tool is enabled. ') +
    sanitizer.push('<|DSML| calls>\n<|DSML| invoke name="shell">\n') +
    sanitizer.push('</|DSML| invoke>\n</|DSML| calls>') +
    sanitizer.push(' Enable one with /tools.') +
    sanitizer.flush()
  assert.equal(text, 'No tool is enabled.  Enable one with /tools.', 'inline block around prose is dropped')
}

// ------------------------------------------------------------- other shapes
assert.equal(sanitizeOutput('<|end▁of▁sentence|>').text, '', 'an end-of-sentence token is removed')
assert.equal(
  sanitizeOutput('hi<|end▁of▁sentence|> there').text,
  'hi there',
  'an inline end-of-sentence token is removed without eating the prose',
)
assert.equal(sanitizeOutput('<|tool▁call|>').text, '', '<|tool▁call|> is removed')
assert.equal(sanitizeOutput('</|DSML| calls>').text, '', 'a lone DSML close line is removed')
assert.equal(sanitizeOutput('<|DSML|').text, '', 'a bare DSML marker token is removed')
assert.equal(sanitizeOutput('<|DSML').text, '<|DSML', 'only the partial form without the pipe is literal')
assert.equal(
  sanitizeOutput('<tool_call>\n{"name":"shell"}\n</tool_call>').text,
  '',
  'a <tool_call> block is removed',
)
assert.equal(
  sanitizeOutput('<function_call name="x">{"a":1}</function_call>after').text,
  'after',
  'a <function_call> block is removed and the text after it survives',
)
assert.equal(
  sanitizeOutput('<invoke name="process.kill">\n<parameter name="id">bg_1</parameter>\n</invoke>').text,
  '',
  'an <invoke>/<parameter> block is removed',
)
assert.equal(
  sanitizeOutput('<tool_calls><invoke name="x"></invoke></tool_calls>').text,
  '',
  'plural <tool_calls> is removed with its contents',
)

// -------------------------------------------------------- partial at flush
{
  const sanitizer = createOutputSanitizer()
  const before = sanitizer.push('hello <|DSML')
  const after = sanitizer.flush()
  assert.equal(before, 'hello ', 'ordinary text before the partial token is emitted at once')
  assert.equal(after, '<|DSML', 'a partial <| token is emitted literally at flush')
  assert.equal(sanitizeOutput('hello <|DSML').text, 'hello <|DSML', 'sanitizeOutput matches push+flush')
}
{
  const sanitizer = createOutputSanitizer()
  assert.equal(sanitizer.push('a < b'), 'a < b', 'a lone < is emitted immediately, not held')
}

// ------------------------------------------------------------ code is code
const FENCED = '```html\n<div>\n<tool_call>x</tool_call>\n</div>\n```'
assert.equal(sanitizeOutput(FENCED).text, FENCED, 'fenced code is untouched, markup inside included')
assert.equal(sanitizeOutput(FENCED).removed, false, 'nothing was removed from the fence')
{
  const sanitizer = createOutputSanitizer()
  let text = ''
  for (const char of FENCED) text += sanitizer.push(char)
  text += sanitizer.flush()
  assert.equal(text, FENCED, 'a fence streamed one byte at a time is still untouched')
}
assert.equal(
  sanitizeOutput('```\n<|DSML| calls>\n```').text,
  '```\n<|DSML| calls>\n```',
  'a token-looking line inside a fence is code, not markup',
)

// -------------------------------------------------------- ordinary HTML/text
const PROSE = 'Use <div>, <p class="x">, 3<4, a < b and &lt; to mean <.'
assert.equal(sanitizeOutput(PROSE).text, PROSE, 'ordinary HTML and comparison signs are unchanged')
assert.equal(sanitizeOutput(PROSE).removed, false, 'nothing was removed from prose')
assert.equal(sanitizeOutput('hello\n').text, 'hello\n', 'a normal newline survives')

// ----------------------------------------------------------- 2 KB hold bound
{
  const sanitizer = createOutputSanitizer()
  const under = sanitizer.push(`<|${'x'.repeat(2046)}`)
  assert.equal(under, '', 'a partial token under 2 KB is held')
  const over = sanitizer.push('x')
  assert.equal(over, `<|${'x'.repeat(2047)}`, 'crossing 2 KB emits the held text literally')
  assert.equal(sanitizer.flush(), '', 'nothing is left after the literal release')
}
{
  // A slow drip also crosses the bound: it is not held until flush.
  const sanitizer = createOutputSanitizer()
  let text = sanitizer.push('<|')
  for (let index = 0; index < 40; index += 1) text += sanitizer.push('y'.repeat(100))
  assert.ok(text.length >= 2048, `the drip is released after 2 KB (got ${String(text.length)})`)
}

// ------------------------------------------------------- turn-level notices
assert.deepEqual(
  finalizeAssistantReply('', false),
  { text: NO_TOOLS_NOTICE, notice: NO_TOOLS_NOTICE },
  'an empty 0-tool turn becomes the /tools notice',
)
assert.equal(NO_TOOLS_NOTICE, 'no tools are enabled this turn · /tools to enable one')
assert.deepEqual(
  finalizeAssistantReply('  \n', false),
  { text: NO_TOOLS_NOTICE, notice: NO_TOOLS_NOTICE },
  'whitespace left by removed markup counts as empty',
)
assert.deepEqual(
  finalizeAssistantReply('', true),
  { text: MARKUP_ONLY_NOTICE, notice: MARKUP_ONLY_NOTICE },
  'a markup-only tools-enabled turn says nothing ran',
)
assert.deepEqual(
  finalizeAssistantReply('Enabled read and glob; ask again.', true),
  { text: 'Enabled read and glob; ask again.', notice: undefined },
  'real prose keeps its own text',
)

// -------------------------------------------- streamed === whole, every split
/** Feed `text` in fixed-size deltas plus the flush. */
const streamed = (text: string, step: number): string => {
  const sanitizer = createOutputSanitizer()
  let out = ''
  for (let at = 0; at < text.length; at += step) out += sanitizer.push(text.slice(at, at + step))
  return out + sanitizer.flush()
}

/** Whole-string, every two-delta split, and one byte per delta all agree. */
const everySplit = (doc: string, expected: string, label: string): void => {
  assert.equal(sanitizeOutput(doc).text, expected, `${label}: whole string`)
  for (let split = 0; split <= doc.length; split += 1) {
    const sanitizer = createOutputSanitizer()
    const out = sanitizer.push(doc.slice(0, split)) + sanitizer.push(doc.slice(split)) + sanitizer.flush()
    assert.equal(out, expected, `${label}: two deltas split at ${String(split)}`)
  }
  assert.equal(streamed(doc, 1), expected, `${label}: one byte per delta`)
}

// ------------------------------------- prose that *describes* the call format
// The regression report: `classify` treated any opener as a block and dropped
// the rest of the paragraph. A sentence mentioning the tag is not a call.
const PROSE_SENTENCES = [
  'The element <parameter name="id"> holds the id; you close it with a slash later.',
  'A call starts with <invoke name="search"> and the body holds the arguments. That is the whole format.',
  'You write <tool_call> and put JSON inside; <parameter> is not needed there.',
]
for (const sentence of PROSE_SENTENCES) {
  assert.equal(sanitizeOutput(sentence).text, sentence, 'the prose sentence survives whole')
  assert.equal(sanitizeOutput(sentence).removed, false, 'and nothing was reported removed')
  everySplit(sentence, sentence, 'prose sentence')
}

// An unclosed line-start opener is a block, not prose. A real call streams its
// JSON body gradually, so no window can prove the opener innocent: releasing it
// once CONFIRM_WINDOW elapsed printed the whole arguments blob and only the
// later closer was stripped. The opener is committed as a block instead — body
// dropped, and the flush reports removed markup rather than a truncated call.
{
  const doc = 'A call starts here:\n<invoke name="search">\nand the body holds the arguments.'
  const expected = `A call starts here:\n${UNCLOSED_BLOCK_NOTICE}`
  everySplit(doc, expected, 'an unclosed line-start opener becomes the removal marker')
}

// A real block with a body well over CONFIRM_WINDOW, streamed in 16-char
// chunks: the body is still incomplete JSON when the window elapses, so this
// was exactly the leak — streaming printed the body and only the closer was
// stripped. Streaming and whole-string must both remove it.
{
  const body = JSON.stringify({ name: 'search', arguments: { query: 'x'.repeat(6000) } })
  assert.ok(body.length > 4096, 'the body really is past the confirm window')
  const doc = `<tool_call>\n${body}\n</tool_call>`
  assert.equal(sanitizeOutput(doc).text, '', 'the whole 6 KB call is removed')
  assert.equal(streamed(doc, 16), '', 'and the 6 KB call streamed in 16-char chunks is removed too')
}

// The same block truncated mid-body (the max_tokens shape): the opener was
// confirmed or is still held, and the flush says markup was removed — the
// arguments never reach the screen.
{
  const body = JSON.stringify({ name: 'search', arguments: { query: 'x'.repeat(6000) } })
  const doc = `<tool_call>\n${body.slice(0, 5000)}`
  assert.equal(sanitizeOutput(doc).text, UNCLOSED_BLOCK_NOTICE, 'a truncated 6 KB call emits only the marker')
  assert.equal(streamed(doc, 16), UNCLOSED_BLOCK_NOTICE, 'and streamed truncation agrees')
}

// A mid-line opener with a >4 KB remainder that really is prose: the short
// mid-line window still releases it, verbatim.
{
  const sentence = `The element <parameter name="id"> holds the id; ${'and the paragraph keeps going. '.repeat(150)}`
  assert.ok(sentence.length > 4096 + 30, 'the remainder really is past the mid-line window')
  assert.equal(sanitizeOutput(sentence).text, sentence, 'mid-line prose past 4 KB is released whole')
  assert.equal(sanitizeOutput(sentence).removed, false, 'and nothing was reported removed')
  everySplit(sentence, sentence, 'mid-line prose with a >4 KB remainder')
}

// A turn cut off mid-call leaves a truncated opener in the buffer at flush:
// that is markup, not prose, so the flush says it was removed instead of
// printing the half-written call.
{
  const truncated = '<tool_call>\n{"name": "search", "arguments": {"query": "hi"'
  assert.equal(
    sanitizeOutput(truncated).text,
    UNCLOSED_BLOCK_NOTICE,
    'a truncated call at flush emits the marker, never the raw buffer',
  )
  assert.equal(streamed(truncated, 16), UNCLOSED_BLOCK_NOTICE, 'and streamed truncation agrees')
  // A mid-line partial mention keeps its prose release: only a line-start
  // opener is markup.
  const midline = 'see the docs at <tool_call and the notes that follow it'
  assert.equal(sanitizeOutput(midline).text, midline, 'a mid-line partial opener is still prose at flush')
  assert.equal(sanitizeOutput('hello <|DSML').text, 'hello <|DSML', 'a mid-line partial token is still literal')
}

// ---------------------------------------- a real XML block is still removed
const XML_INVOKE = '<invoke name="process.kill">\n<parameter name="id">bg_1</parameter>\n</invoke>'
everySplit(XML_INVOKE, '', 'an <invoke>/<parameter> block')
const XML_TOOL = '<tool_call>\n{"name":"shell"}\n</tool_call>'
everySplit(XML_TOOL, '', 'a <tool_call> JSON block')
const XML_CALLS = '<tool_calls><invoke name="x"></invoke></tool_calls>'
everySplit(XML_CALLS, '', 'a plural <tool_calls> block')

// An unclosed opener at flush: a line-start opener is markup even with an
// empty body, so it becomes the marker; once a call row proves the block was
// real, the flush leaves the same marker rather than silently erasing a long
// body.
everySplit('<tool_call>', UNCLOSED_BLOCK_NOTICE, 'an unclosed line-start opener is markup at flush')
everySplit(
  '<invoke name="x">\n<parameter name="a">1</parameter>',
  UNCLOSED_BLOCK_NOTICE,
  'a confirmed but unclosed block leaves the removal marker',
)

// A fenced example is code, even when the fence holds the prose sentences and a
// real-looking block; extend the existing fence checks with a full call.
const FENCED_TOOL = '```\n<tool_call>\n{"name":"x"}\n</tool_call>\n```'
everySplit(FENCED_TOOL, FENCED_TOOL, 'a fence holding a <tool_call> example')
const FENCED_PROSE = `\`\`\`\n${PROSE_SENTENCES[1]}\n\`\`\``
everySplit(FENCED_PROSE, FENCED_PROSE, 'a fence holding the prose sentence')

// A drained `calls>` remnant is markup at any split, not the start of prose.
const REMNANT_DOC = 'the tool\ncalls>\nfor it'
assert.equal(sanitizeOutput(REMNANT_DOC).text, 'the tool\nfor it', 'a bare calls> remnant line is dropped')
for (const step of [1, 3]) {
  assert.equal(
    streamed(REMNANT_DOC, step),
    'the tool\nfor it',
    `a calls> remnant holds at every ${String(step)}-byte delta`,
  )
}

// The real 14 KB DSML dump: one block, whatever the delta size.
const bigBlock = (): string => {
  const lines = ['<|DSML| calls>', '<|DSML| invoke name="x">']
  for (let i = 0; i < 200; i += 1) {
    lines.push(`<|DSML| parameter name="p${String(i)}" string="true">value ${String(i)}</|DSML| parameter>`)
  }
  lines.push('</|DSML| invoke>', '</|DSML| calls>')
  return `${lines.join('\n')}\n`
}
const BIG = bigBlock()
assert.equal(BIG.length, 14_453, 'the dump is the 14 453-byte block from the report')
assert.equal(sanitizeOutput(BIG).text, '', 'the 14 KB block leaves nothing, whole or streamed')
assert.equal(streamed(BIG, 1), '', 'the 14 KB block leaves nothing at one byte per delta')
assert.equal(streamed(BIG, 3), '', 'the 14 KB block leaves nothing at three bytes per delta')
assert.equal(streamed(BIG, 7), '', 'the 14 KB block leaves nothing at seven bytes per delta')

// Prose on both sides of the same 14 KB block survives it.
{
  const doc = `I cannot run that.\n${BIG}Done.`
  assert.equal(sanitizeOutput(doc).text, 'I cannot run that.\nDone.', 'prose around the 14 KB block survives')
  assert.equal(streamed(doc, 1), 'I cannot run that.\nDone.', 'and it survives one byte per delta')
  assert.equal(streamed(doc, 3), 'I cannot run that.\nDone.', 'and three bytes per delta')
}

// A fence around the dump is code, so it is untouched even at one byte a delta.
{
  const fenced = `\`\`\`\n${BIG}\`\`\`\n`
  assert.equal(sanitizeOutput(fenced).text, fenced, 'a fence holding the 14 KB block is untouched')
  assert.equal(streamed(fenced, 1), fenced, 'and it survives one byte per delta')
}

// An unterminated block past BLOCK_HARD_LIMIT (64 KB) drops the rest of the
// stream instead of emitting the body as prose, but the flush now says that
// markup was removed: a long body never disappears without a trace.
{
  const junk = `<|DSML| calls>\n<|DSML| parameter name="x" string="true">${'z'.repeat(70_000)}`
  assert.equal(sanitizeOutput(junk).text, UNCLOSED_BLOCK_NOTICE, 'a 64 KB unterminated block emits no body')
  assert.equal(streamed(junk, 1), UNCLOSED_BLOCK_NOTICE, 'and one-byte deltas emit no body either')
  const withProse = `before\n${junk}\nafter`
  assert.equal(
    sanitizeOutput(withProse).text,
    `before\n${UNCLOSED_BLOCK_NOTICE}`,
    'the prose before it is kept and the removal is visible',
  )
}
// The same 64 KiB bound on the XML path: a `<tool_call>` with a parameter row
// is confirmed as markup, then abandoned at the hard limit.
{
  const junk = `<tool_call>\n<parameter name="x" string="true">${'z'.repeat(70_000)}`
  assert.equal(sanitizeOutput(junk).text, UNCLOSED_BLOCK_NOTICE, 'a 64 KB open <tool_call> emits no body')
  assert.equal(streamed(junk, 1), UNCLOSED_BLOCK_NOTICE, 'and one-byte deltas agree')
}

// The equality property: push chunks + flush is sanitizeOutput, for any split.
{
  const doc = [
    'Here is the plan.',
    '',
    '1. read the file',
    '2. patch `output.ts`',
    '',
    '```ts',
    'const x = a < b ? 1 : 2',
    '</tool_call>',
    '```',
    '',
    'Then:',
    'calls>',
    '<|DSML| calls>',
    '<|DSML| invoke name="edit">',
    '<|DSML| parameter name="path" string="true">/tmp/x</|DSML| parameter>',
    '</|DSML| invoke>',
    '</|DSML| calls>',
    '',
    'Done. Use <div> and 3<4.',
  ].join('\n')
  const whole = sanitizeOutput(doc).text
  assert.equal(whole.includes('<|DSML|'), false, 'the whole-string form has no markup left')
  let seed = 0x2f6e2b1
  const random = (): number => {
    // xorshift32, so the 300 splits are fixed and a failure is reproducible.
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 0x1_0000_0000
  }
  for (let run = 0; run < 300; run += 1) {
    const sanitizer = createOutputSanitizer()
    let out = ''
    let at = 0
    while (at < doc.length) {
      const width = 1 + Math.floor(random() * 40)
      out += sanitizer.push(doc.slice(at, at + width))
      at += width
    }
    out += sanitizer.flush()
    assert.equal(out, whole, `random split ${String(run)} reproduces the whole-string result`)
  }
  // Every single split point too, since the doc is short enough to afford it.
  for (let split = 0; split <= doc.length; split += 1) {
    const sanitizer = createOutputSanitizer()
    const out = sanitizer.push(doc.slice(0, split)) + sanitizer.push(doc.slice(split)) + sanitizer.flush()
    assert.equal(out, whole, `a two-delta split at ${String(split)} reproduces the whole-string result`)
  }
}

console.log('output tests passed (screenshot block at every split, fences and prose intact, 2 KB bound)')
