/**
 * The one piece of parsing the composer needs before a submission means
 * anything: a command on the first line, a prompt under it.
 *
 * The composer submits the whole box, newlines included, so a user who types
 * `/tools`, presses Enter and then types a question sends one string. Read as a
 * single line, that string used to reach `/tools` as an argument (`/tools яка
 * погода`), which the shape check refused, so the question was never answered
 * and the tools list was never shown. Read as a prompt, it asked the model about
 * `/tools`. Both readings lose one half of what was typed.
 *
 * Here it is two things instead: the first line runs as the command it spells,
 * and every line below it is the prompt that follows. Pure string work over a
 * supplied predicate — the command table lives in `chat.ts`, and this module
 * must be importable by a test without running the console.
 */

/** A submission read as `command` then `prompt`. */
export interface CommandSplit {
  /** The first line, trimmed: the command together with its own arguments. */
  readonly command: string
  /** The lines below it, leading blank lines dropped; `''` when none remain. */
  readonly prompt: string
}

/**
 * Whether `name` is a command that can run as typed, given its arguments.
 *
 * Both halves matter for the split: an unknown `/foo` is a prompt the user may
 * want the model to see (a pasted path, a diff), so it must not be swallowed,
 * and a command whose own line has the wrong shape (`/exit now`) must report its
 * usage instead of silently eating the question under it.
 */
export type CommandProbe = (name: string, rest: string) => boolean

/**
 * Whether `name` takes the lines below it as its own arguments. `rest: true`
 * commands (`/tools`, `/sessions`, `/web`) have a sub-grammar, so
 *
 *     /tools
 *     off 3
 *
 * is one command (`/tools off 3`), not a picker plus a prompt containing
 * `off 3`. The probe sees the joined text so the caller can accept only a real
 * subcommand: `/tools` + `what is the weather` must stay a prompt.
 */
export type RestProbe = (name: string, args: string) => boolean

const FIRST_TOKEN = /\s+/

/**
 * The sub-grammar each `rest: true` command accepts in the lines below it, as
 * data: the words that may open the block, and how many selector tokens may
 * follow. The whole block has to match, not just its first word — `on`, `all`,
 * `new` and `start` are ordinary English too, and a first-word check ran
 * `/tools` + "on the record, why is this slow?" as `/tools on …`, losing the
 * question entirely. A bounded tail keeps the real usage (`/tools off 3`,
 * `/sessions rename 2 mine`) one command while a sentence under the command
 * stays the prompt, which is what the README promises.
 */
const REST_GRAMMAR: Record<string, readonly { verb: string; maxTail: number }[]> = {
  // `on/off/delete/restore <n|name>`; `reset`, `refresh` and the `--all`/`all`
  // listing forms stand alone. A selector is a number or a tool name, so a few
  // tokens bound it.
  '/tools': [
    { verb: 'on', maxTail: 3 },
    { verb: 'off', maxTail: 3 },
    { verb: 'delete', maxTail: 3 },
    { verb: 'restore', maxTail: 3 },
    { verb: 'reset', maxTail: 0 },
    { verb: 'refresh', maxTail: 0 },
    { verb: '--all', maxTail: 0 },
    { verb: 'all', maxTail: 0 },
  ],
  // A selector is a number, an id prefix or a name; `rename` carries the new
  // name after the ref, `new` optionally names the session, and `--all`/`all`
  // /`list` stand alone.
  '/sessions': [
    { verb: 'new', maxTail: 1 },
    { verb: 'rename', maxTail: 2 },
    { verb: 'delete', maxTail: 1 },
    { verb: 'archive', maxTail: 1 },
    { verb: 'unarchive', maxTail: 1 },
    { verb: 'list', maxTail: 0 },
    { verb: '--all', maxTail: 0 },
    { verb: 'all', maxTail: 0 },
  ],
  // Exactly one of the three verbs; anything longer is a question.
  '/web': [
    { verb: 'status', maxTail: 0 },
    { verb: 'start', maxTail: 0 },
    { verb: 'down', maxTail: 0 },
  ],
  // A mode word, so `/view` ↵ `compact` is one command. The one-letter forms
  // are accepted by the same parser; the whole block must still match.
  '/view': [
    { verb: 'compact', maxTail: 0 },
    { verb: 'medium', maxTail: 0 },
    { verb: 'full', maxTail: 0 },
    { verb: 'c', maxTail: 0 },
    { verb: 'm', maxTail: 0 },
    { verb: 'f', maxTail: 0 },
  ],
}

/** A selector token: a number, a name or a flag — never a sentence fragment. */
const SELECTOR_TOKEN = /^[A-Za-z0-9_.:-]+$/

/**
 * True when `args` (the lines under the command, joined) matches that command's
 * whole sub-grammar: one of its verbs plus at most the selector tokens the
 * grammar allows, each selector-shaped. Anything else is prose typed under the
 * command and must stay the prompt. (A short tail of plain words — `/tools on
 * the record` — is still ambiguous and reads as the command; only length and
 * punctuation separate it from a sentence.)
 */
export const restArguments = (name: string, args: string): boolean => {
  const forms = REST_GRAMMAR[name]
  if (forms === undefined) return false
  const words = args.trim().split(/\s+/)
  const verb = (words[0] ?? '').toLowerCase()
  if (verb === '') return false
  const form = forms.find((entry) => entry.verb === verb)
  if (form === undefined) return false
  const tail = words.slice(1)
  if (tail.length > form.maxTail) return false
  return tail.every((word) => SELECTOR_TOKEN.test(word))
}

/**
 * `command` and the prompt under it, or `undefined` when this is one prompt.
 *
 * Only a newline can produce a split: a single line is exactly what the
 * dispatcher has always handled, and a text whose first line is not a runnable
 * command (any other first line) stays one prompt, untouched.
 *
 * A command whose `rest` probe answers true owns the lines below it as
 * arguments, so the split has no prompt half. Without a rest probe the old
 * behaviour is kept: the caller may want the lines below to be a question (the
 * `--once /tools` listing does exactly that).
 */
export function splitCommandAndPrompt(
  text: string,
  isCommand: CommandProbe,
  takesRest?: RestProbe,
): CommandSplit | undefined {
  const lines = text.split('\n')
  // One line has nothing under it to promote to a prompt.
  if (lines.length < 2) return undefined
  const first = (lines[0] ?? '').trim()
  if (!first.startsWith('/')) return undefined
  const name = first.split(FIRST_TOKEN, 1)[0] ?? first
  const rest = first.slice(name.length).trim()
  if (!isCommand(name, rest)) return undefined
  // Indentation inside a multi-line argument block is spacing, not content;
  // the handlers split their rest on whitespace anyway.
  const args = promptUnder(lines).replace(/\s*\n\s*/g, ' ').trim()
  if (takesRest !== undefined && takesRest(name, args)) {
    return { command: args === '' ? first : `${first} ${args}`, prompt: '' }
  }
  return { command: first, prompt: promptUnder(lines) }
}

/**
 * `/foo` on the first line, a real question under it, and no such command.
 *
 * The dispatcher prints "unknown command /foo" and stops, which is right for
 * the command line — but it used to take the question with it, because the
 * dispatcher consumed the whole submission. Sending the text below is the less
 * surprising half: the user typed it, the console says what it did with it, and
 * nothing is lost. `isKnown` is asked about the bare name only, so a known
 * command with the wrong shape keeps its usage error instead of becoming a
 * prompt.
 */
export function splitUnknownCommand(text: string, isKnown: (name: string) => boolean): CommandSplit | undefined {
  const lines = text.split('\n')
  if (lines.length < 2) return undefined
  const first = (lines[0] ?? '').trim()
  if (!first.startsWith('/')) return undefined
  const name = first.split(FIRST_TOKEN, 1)[0] ?? first
  if (isKnown(name)) return undefined
  const prompt = promptUnder(lines)
  // Nothing under it: the plain unknown-command line already says everything.
  if (prompt === '') return undefined
  return { command: first, prompt }
}

/** The lines below the first, blank separators dropped, trailing space trimmed. */
const promptUnder = (lines: readonly string[]): string => {
  let at = 1
  while (at < lines.length && (lines[at] ?? '').trim() === '') at += 1
  return lines.slice(at).join('\n').trimEnd()
}
