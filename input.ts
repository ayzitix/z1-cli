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
 * supplied predicate — the command table and its shapes live in `chat.ts`, and
 * this module must be importable by a test without running the console.
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

const FIRST_TOKEN = /\s+/

/**
 * `command` and the prompt under it, or `undefined` when this is one prompt.
 *
 * Only a newline can produce a split: a single line is exactly what the
 * dispatcher has always handled, and a text whose first line is not a runnable
 * command (any other first line) stays one prompt, untouched.
 */
export function splitCommandAndPrompt(text: string, isCommand: CommandProbe): CommandSplit | undefined {
  const lines = text.split('\n')
  // One line has nothing under it to promote to a prompt.
  if (lines.length < 2) return undefined
  const first = (lines[0] ?? '').trim()
  if (!first.startsWith('/')) return undefined
  const name = first.split(FIRST_TOKEN, 1)[0] ?? first
  const rest = first.slice(name.length).trim()
  if (!isCommand(name, rest)) return undefined
  // Blank lines between the command and the question are spacing, not prompt.
  let at = 1
  while (at < lines.length && (lines[at] ?? '').trim() === '') at += 1
  return { command: first, prompt: lines.slice(at).join('\n').trimEnd() }
}
