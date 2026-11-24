/**
 * The project's own rules in the system prompt: which `AGENTS.md` files a turn
 * carries, what a budget cut leaves behind, and what a broken file costs.
 *
 * The real bug this pins: a session started anywhere in a repository knows
 * nothing about the repository's rules, so every first prompt had to repeat
 * them. The chain also has to survive what a real tree contains — a directory
 * named `AGENTS.md`, a CRLF file with a BOM, a 40 KiB root file, and a
 * multi-byte character sitting exactly on the cut.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  CHAIN_BYTES,
  PER_FILE_BYTES,
  PROJECT_CONTEXT_FILE,
  STACK_BUDGET_TOKENS,
  discoverProjectContextFiles,
  projectContextBudget,
  projectContextLabel,
  projectContextRoot,
  projectContextSummary,
  projectContextText,
} from '../project-context.ts'

const base = mkdtempSync(join(tmpdir(), 'z1-project-context-'))

/** `write` with the parent directory created, so a case reads as one line. */
const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** The kept text of a cut file: everything before the marker's own line. */
const head = (text: string): string => {
  const marker = text.indexOf('\n\n…')
  return marker < 0 ? text : text.slice(0, marker)
}

try {
  // ---------------------------------------------------------------- 1. hierarchy
  {
    const root = join(base, 'chain')
    mkdirSync(join(root, '.git'), { recursive: true })
    write(join(root, PROJECT_CONTEXT_FILE), 'root rules')
    write(join(root, 'a', PROJECT_CONTEXT_FILE), 'a rules')
    write(join(root, 'a', 'b', PROJECT_CONTEXT_FILE), 'b rules')
    const cwd = join(root, 'a', 'b')

    const files = discoverProjectContextFiles(cwd)
    assert.equal(files.length, 3, 'one file per level from the repo root down')
    assert.deepEqual(
      files.map((file) => file.path),
      [join(root, PROJECT_CONTEXT_FILE), join(root, 'a', PROJECT_CONTEXT_FILE), join(cwd, PROJECT_CONTEXT_FILE)],
      'farthest first, the nearest last',
    )
    assert.equal(files[0]?.text, 'root rules', 'the file is read as it is')
    assert.equal(files[0]?.truncated, false, 'a small file is not cut')

    const text = projectContextText(files, projectContextRoot(cwd))
    assert.ok(text.startsWith('## Project context (AGENTS.md)'), 'the section leads with its heading')
    assert.equal(text.split('### ').length - 1, 3, 'one block per file')
    assert.ok(
      text.indexOf('### AGENTS.md') < text.indexOf('### a/AGENTS.md') &&
        text.indexOf('### a/AGENTS.md') < text.indexOf('### a/b/AGENTS.md'),
      'the blocks run root first',
    )
    assert.ok(text.includes('b rules'), 'the nearest file is carried')
  }

  // ------------------------------------------------------------------- 2. no git
  {
    const cwd = join(base, 'plain', 'deep')
    write(join(cwd, PROJECT_CONTEXT_FILE), 'only here')
    // Nothing above it is a repository, so the chain is the workspace alone.
    const files = discoverProjectContextFiles(cwd)
    assert.equal(files.length, 1, 'without a repo root only the workspace is read')
    assert.equal(files[0]?.path, join(cwd, PROJECT_CONTEXT_FILE), 'the workspace file is the one')
  }

  // --------------------------------------------------- 3. nothing to say at all
  assert.equal(projectContextText([]), '', 'no files and no omission means no section at all')

  // --------------------------------------------------------- 4. per-file cutting
  {
    const root = join(base, 'huge')
    mkdirSync(join(root, '.git'), { recursive: true })
    write(join(root, PROJECT_CONTEXT_FILE), 'a'.repeat(40 * 1024))

    const files = discoverProjectContextFiles(root)
    assert.equal(files.length, 1, 'the file is still carried')
    const file = files[0]
    assert.equal(file?.truncated, true, 'a 40 KiB file is cut')
    assert.ok(
      file.text.includes('[z1: AGENTS.md truncated at 32768 bytes]'),
      'the cut is visible, with the real limit in it',
    )
    assert.ok(file.text.startsWith('a'.repeat(1024)), 'the kept part is the head')
    assert.ok(
      file.text.length < PER_FILE_BYTES + 128,
      `the marker is all that is added (got ${String(file.text.length)} chars)`,
    )
    assert.ok(file.bytes < PER_FILE_BYTES + 128, 'the record spends the kept bytes, not the file size')
    assert.ok(
      projectContextText(files, root).includes('[z1: AGENTS.md truncated at 32768 bytes]'),
      'the marker reaches the section',
    )
  }

  // ------------------------------------------------ 5. a character on the cut line
  {
    const root = join(base, 'multibyte')
    mkdirSync(join(root, '.git'), { recursive: true })
    // 'ї' is two bytes: with 63 ASCII bytes before it, a 64-byte cut falls
    // between them and a naive cut leaves half a character.
    write(join(root, PROJECT_CONTEXT_FILE), `${'a'.repeat(63)}ї${'🙂'.repeat(4)}`)
    const split2 = discoverProjectContextFiles(root, { perFileBytes: 64 })[0]
    assert.equal(split2?.truncated, true, 'the file is cut')
    assert.ok(!split2.text.includes('\uFFFD'), 'no replacement character from a split two-byte character')
    assert.equal(head(split2.text), 'a'.repeat(63), 'the cut steps back to the character start')

    // The same for a four-byte emoji: bytes 62/63/64/65, so a 64-byte cut lands
    // inside it and must step back three bytes.
    write(join(root, PROJECT_CONTEXT_FILE), `${'a'.repeat(62)}🙂 tail`)
    const split4 = discoverProjectContextFiles(root, { perFileBytes: 64 })[0]
    assert.ok(!split4?.text.includes('\uFFFD'), 'no replacement character from a split emoji')
    assert.equal(head(split4?.text ?? ''), 'a'.repeat(62), 'the whole emoji is dropped, not halved')

    // A file that ends exactly on the limit is not cut at all.
    write(join(root, PROJECT_CONTEXT_FILE), 'b'.repeat(64))
    const exact = discoverProjectContextFiles(root, { perFileBytes: 64 })[0]
    assert.equal(exact?.truncated, false, 'a file that fits is untouched')
    assert.equal(exact?.text, 'b'.repeat(64), 'and reads whole')
  }

  // --------------------------------------------------------------- 6. BOM and CRLF
  {
    const root = join(base, 'bom')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, PROJECT_CONTEXT_FILE), `\uFEFFline one\r\nline two\r\n`)
    const files = discoverProjectContextFiles(root)
    assert.equal(files[0]?.text, 'line one\nline two\n', 'a BOM and every CRLF are gone')
    const text = projectContextText(files, root)
    assert.ok(!text.includes('\uFEFF'), 'no BOM reaches the prompt')
    assert.ok(!text.includes('\r'), 'no CR reaches the prompt')
  }

  // -------------------------------------------------- 7. a directory named AGENTS.md
  {
    const root = join(base, 'directory')
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, PROJECT_CONTEXT_FILE), { recursive: true })
    write(join(root, PROJECT_CONTEXT_FILE, 'inside.txt'), 'not rules')
    write(join(root, 'a', PROJECT_CONTEXT_FILE), 'a rules')

    let files: ReturnType<typeof discoverProjectContextFiles> = []
    assert.doesNotThrow(() => {
      files = discoverProjectContextFiles(join(root, 'a'))
    }, 'a directory with the file name is skipped, not thrown')
    assert.equal(files.length, 1, 'only the real file is carried')
    assert.equal(files[0]?.path, join(root, 'a', PROJECT_CONTEXT_FILE), 'and it is the one below')
  }

  // ------------------------------------------------------------- 8. chain budget
  {
    const root = join(base, 'budget')
    mkdirSync(join(root, '.git'), { recursive: true })
    write(join(root, PROJECT_CONTEXT_FILE), 'a'.repeat(60 * 1024))
    write(join(root, 'near', PROJECT_CONTEXT_FILE), 'near rules')

    // 4 KiB per file and 2 KiB for the chain: the near file fits, the far one
    // cannot, so the near one survives and the far one is named as omitted.
    const files = discoverProjectContextFiles(join(root, 'near'), {
      perFileBytes: 4096,
      chainBytes: 2048,
    })
    assert.equal(files.length, 1, 'only the nearest file fits the chain budget')
    assert.equal(files[0]?.path, join(root, 'near', PROJECT_CONTEXT_FILE), 'the nearest file is the survivor')
    const text = projectContextText(files, root)
    assert.ok(
      text.includes('[z1: 1 earlier project context file omitted: 2 KiB budget: AGENTS.md]'),
      'the omission is named, counted and sized',
    )
    assert.ok(text.startsWith('[z1:'), 'the marker leads the section')
    assert.ok(text.indexOf('[z1:') < text.indexOf('## Project context'), 'it comes before the heading')
    assert.ok(!text.includes('a'.repeat(1024)), 'the dropped file contributes nothing')
  }

  // ------------------------------------------------------ 9. posix relative labels
  {
    const root = join(base, 'labels')
    mkdirSync(join(root, '.git'), { recursive: true })
    write(join(root, 'a', 'b', PROJECT_CONTEXT_FILE), 'deep rules')
    const files = discoverProjectContextFiles(join(root, 'a', 'b'))
    const text = projectContextText(files, root)
    assert.ok(text.includes('### a/b/AGENTS.md'), 'the heading is the path from the root, posix')
    assert.ok(!text.includes('\\'), 'no backslash reaches the prompt')
    assert.equal(projectContextLabel(join(root, 'a', 'b', PROJECT_CONTEXT_FILE), root), 'a/b/AGENTS.md', 'one label rule')
    // Outside the labelled root the path stays absolute: a `..` would name a
    // file the model cannot place.
    const outside = projectContextLabel(join(base, 'elsewhere', PROJECT_CONTEXT_FILE), root)
    assert.ok(!outside.includes('..'), 'no relative escape in a label')
    assert.ok(outside.endsWith('AGENTS.md'), 'the absolute label still names the file')
  }

  // ------------------------------- 10. a budget that drops the only file
  {
    const root = join(base, 'all-dropped')
    mkdirSync(join(root, '.git'), { recursive: true })
    write(join(root, PROJECT_CONTEXT_FILE), 'r'.repeat(2000))

    // 4 KiB per file but only 1000 bytes for the chain: the single file does
    // not fit, so the section is the omission marker and nothing else — the
    // alternative would be silence, which claims the project has no rules.
    const files = discoverProjectContextFiles(root, { perFileBytes: 4096, chainBytes: 1000 })
    assert.equal(files.length, 0, 'the only file is dropped')
    const text = projectContextText(files, root)
    assert.notEqual(text, '', 'an empty chain that dropped a file still speaks')
    assert.ok(
      text.startsWith('[z1: 1 earlier project context file omitted:'),
      'the marker leads the section',
    )
    assert.equal(
      text,
      '[z1: 1 earlier project context file omitted: 1000 bytes budget: AGENTS.md]',
      'and it is the whole section',
    )
  }

  // --------------------------------- 11. a budget smaller than one KiB
  {
    const root = join(base, 'tiny-budget')
    mkdirSync(join(root, '.git'), { recursive: true })
    write(join(root, PROJECT_CONTEXT_FILE), 'r'.repeat(2000))
    const files = discoverProjectContextFiles(root, { perFileBytes: 4096, chainBytes: 200 })
    const text = projectContextText(files, root)
    assert.ok(text.includes('200 bytes budget'), `a sub-KiB budget keeps its own unit (got ${text})`)
    assert.ok(!text.includes('KiB'), 'a 200-byte budget never rounds to `0 KiB`')
  }

  // -------------------------------------- 12. the `/context` summary line
  {
    const root = join(base, 'summary')
    mkdirSync(join(root, '.git'), { recursive: true })
    write(join(root, 'work', PROJECT_CONTEXT_FILE), 'r\n')
    const cwd = join(root, 'work')
    const clock = new Date(2026, 0, 2, 20, 28, 0)

    const plain = projectContextSummary(discoverProjectContextFiles(cwd), root, clock)
    assert.equal(
      plain,
      'project · 1 AGENTS.md file · ~13 tokens · as of 20:28 · work/AGENTS.md',
      'count, chars/4 estimate, clock and the relative paths',
    )
    assert.equal(
      projectContextSummary([], root, clock),
      'project · no AGENTS.md in this project',
      'no files and no omission is said plainly',
    )

    // A dropped file is named in the line, not hidden behind the kept one.
    const budget = join(base, 'summary-budget')
    mkdirSync(join(budget, '.git'), { recursive: true })
    write(join(budget, PROJECT_CONTEXT_FILE), 'a'.repeat(4000))
    write(join(budget, 'work', PROJECT_CONTEXT_FILE), 'b'.repeat(400))
    const dropped = discoverProjectContextFiles(join(budget, 'work'), {
      perFileBytes: 4096,
      chainBytes: 500,
    })
    const withOmission = projectContextSummary(dropped, budget, clock)
    assert.ok(
      withOmission.startsWith('project · 1 AGENTS.md file · 1 earlier omitted · ~'),
      `the omitted count follows the file count (got ${withOmission})`,
    )
    assert.ok(withOmission.endsWith(' · as of 20:28 · work/AGENTS.md'), 'and the rest keeps its order')

    // Nothing kept, one dropped: the line still names the source it dropped.
    const single = join(base, 'summary-single')
    mkdirSync(join(single, '.git'), { recursive: true })
    write(join(single, 'sub', PROJECT_CONTEXT_FILE), 'r'.repeat(300))
    const onlyDropped = projectContextSummary(
      discoverProjectContextFiles(join(single, 'sub'), { perFileBytes: 4096, chainBytes: 100 }),
      single,
      clock,
    )
    assert.ok(
      onlyDropped.startsWith('project · 1 earlier omitted · ~'),
      `a marker-only chain reports what was dropped (got ${onlyDropped})`,
    )
    assert.ok(
      onlyDropped.endsWith(' · as of 20:28 · sub/AGENTS.md'),
      `and ends with the dropped file's label (got ${onlyDropped})`,
    )
  }

  // ------------------------------------------ 13. a 1 MiB file is head-read
  {
    const root = join(base, 'megabyte')
    mkdirSync(join(root, '.git'), { recursive: true })
    write(join(root, PROJECT_CONTEXT_FILE), 'm'.repeat(1024 * 1024))

    // Over the ceiling only the head is read, so this costs 32 KiB of I/O and
    // works the same for a file larger than Node's 2 GiB string limit.
    const files = discoverProjectContextFiles(root)
    assert.equal(files.length, 1, 'a 1 MiB file is still carried')
    assert.equal(files[0]?.truncated, true, 'and cut at the ceiling')
    assert.equal(head(files[0]?.text ?? '').length, PER_FILE_BYTES, 'the kept prefix is the ceiling')
    assert.ok(files[0].text.endsWith('[z1: AGENTS.md truncated at 32768 bytes] …'), 'the marker closes it')
    assert.ok(files[0].bytes < PER_FILE_BYTES + 128, 'the record stays near the ceiling')
  }

  // -------------------------------- 14. an empty file is not project context
  {
    const root = join(base, 'empty')
    mkdirSync(join(root, '.git'), { recursive: true })
    const path = join(root, PROJECT_CONTEXT_FILE)

    write(path, '')
    assert.equal(discoverProjectContextFiles(root).length, 0, 'a zero-byte file carries no rules')
    assert.equal(projectContextText(discoverProjectContextFiles(root), root), '', 'and adds no heading')

    write(path, '  \n\t\n\n')
    assert.equal(discoverProjectContextFiles(root).length, 0, 'blank lines only is still nothing')

    writeFileSync(path, '\uFEFF\r\n\r\n')
    assert.equal(discoverProjectContextFiles(root).length, 0, 'a BOM and blank lines is nothing')

    // An empty parent next to a real file: one block, not two.
    write(join(root, 'a', PROJECT_CONTEXT_FILE), 'a rules')
    const files = discoverProjectContextFiles(join(root, 'a'))
    assert.equal(files.length, 1, 'the empty parent contributes no block')
    assert.ok(
      !projectContextText(files, root).includes('### AGENTS.md'),
      'and no heading without a body',
    )
  }

  // ------------------- 15. CRLF decides on normalized bytes, not disk bytes
  {
    const root = join(base, 'crlf-budget')
    mkdirSync(join(root, '.git'), { recursive: true })
    const path = join(root, PROJECT_CONTEXT_FILE)

    // 36000 disk bytes, 24000 normalized: the file fits, so it must not be cut.
    // Deciding on the disk size alone left a fake marker on a file that fitted.
    write(path, 'x\r\n'.repeat(12000))
    const fits = discoverProjectContextFiles(root)[0]
    assert.equal(fits?.truncated, false, 'a CRLF file under the limit is not cut')
    assert.ok(!fits.text.includes('truncated at'), 'and carries no marker')
    assert.ok(!fits.text.includes('\r'), 'no CR reaches the prompt')
    assert.equal(fits?.bytes, 24000, 'the budget counts normalized bytes')

    // 49152 disk bytes, exactly 32768 normalized: it still fits, byte for byte.
    write(path, 'x\r\n'.repeat(16384))
    const exact = discoverProjectContextFiles(root)[0]
    assert.equal(exact?.truncated, false, 'a CRLF file normalized to the limit fits')
    assert.equal(exact?.bytes, PER_FILE_BYTES, 'and spends exactly the limit')

    // 60000 disk bytes, 40000 normalized: over the limit, so cut and marked —
    // and the kept text spends the whole budget instead of a third of it on CRs.
    write(path, 'x\r\n'.repeat(20000))
    const cut = discoverProjectContextFiles(root)[0]
    assert.equal(cut?.truncated, true, 'a CRLF file over the limit is cut')
    assert.equal(
      head(cut?.text ?? '').length,
      PER_FILE_BYTES - 1,
      'the limit is spent on text, minus the one stripped trailing line break',
    )
    assert.ok(!cut.text.includes('\r'), 'no CR survives the cut')
    assert.ok(!cut.text.includes('\uFFFD'), 'and no character is halved')
    assert.ok(cut.text.includes('[z1: AGENTS.md truncated at 32768 bytes]'), 'the marker is there')

    // A cut landing right after a lone CR must not leave that CR before the
    // marker: a bare CR in the prompt is a line break nobody wrote.
    write(path, `${'x'.repeat(PER_FILE_BYTES - 1)}\ryyy`)
    const lone = discoverProjectContextFiles(root)[0]
    assert.equal(lone?.truncated, true, 'the file is over the limit')
    assert.equal(head(lone.text).length, PER_FILE_BYTES - 1, 'the trailing CR is stripped')
    assert.ok(!lone.text.includes('\r'), 'and no raw CR reaches the prompt')
  }

  // ------------------------- 16. a blank head on a real file is a cut, not silence
  {
    const root = join(base, 'blank-head')
    mkdirSync(join(root, '.git'), { recursive: true })
    write(join(root, PROJECT_CONTEXT_FILE), `${' '.repeat(40000)}RULES: be kind`)

    // The rules sit past the ceiling, but the file is not empty: dropping it
    // would report "no rules here" about a file that has 40000 bytes of them.
    const files = discoverProjectContextFiles(root)
    assert.equal(files.length, 1, 'a cut file with a blank head is still carried')
    assert.equal(files[0]?.truncated, true, 'it is cut, so it is not silence')
    const text = projectContextText(files, root)
    assert.notEqual(text, '', 'the project section is not empty')
    assert.ok(text.includes('### AGENTS.md'), 'the block is there')
    assert.ok(text.includes('[z1: AGENTS.md truncated at 32768 bytes]'), 'the marker is the honest part')
  }

  // ------------------------------ 17. the stack budget the section asks for
  {
    // The stack drops the whole custom section at its ceiling, so the CLI has to
    // raise it by this section's own estimate — and by nothing when there is no
    // section, or a project without `AGENTS.md` would start paying for one.
    assert.equal(projectContextBudget(''), STACK_BUDGET_TOKENS, 'no section means no budget change')
    assert.equal(STACK_BUDGET_TOKENS, 6000, 'the mirrored SDK default')
    assert.equal(projectContextBudget('a'.repeat(4000)), 7256, '6000 + 1000 + 256')
    assert.equal(
      projectContextBudget('a'.repeat(PER_FILE_BYTES)),
      6000 + PER_FILE_BYTES / 4 + 256,
      'a full-size file: 6000 + 8192 + 256',
    )
    assert.equal(projectContextBudget('a'.repeat(1)), 6001 + 256, 'an estimate is rounded up')
  }

  // ------------------------------------------------------------------- constants
  assert.equal(PROJECT_CONTEXT_FILE, 'AGENTS.md', 'the well-known name')
  assert.equal(PER_FILE_BYTES, 32_768, '32 KiB per file')
  assert.equal(CHAIN_BYTES, 65_536, '64 KiB for the chain')
} finally {
  rmSync(base, { recursive: true, force: true })
}

console.log('project-context tests passed (chain order, budgets, BOM/CRLF, posix labels, summary line, stack budget)')
