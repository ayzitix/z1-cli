/**
 * The one system-prompt section that draws the line between the workspace's
 * project files and z1's own state.
 *
 * Two directories exist in (or beside) every project and neither is project
 * content: the session root — `<repo>/z1` when it is claimable, otherwise a
 * per-project directory under the user's data home — holds the saved chat
 * transcripts, and `.z1/` holds the todo list and spilled command output. A
 * model that lists the workspace to "understand the project" reads them as
 * fixtures, counts them as files, or deletes them to tidy up.
 *
 * The wording is deliberately a request, not a contract: an older installed
 * `z1-tools` may well allow `rm -rf z1`, so claiming the tools enforce this
 * would be a lie the model could discover.
 *
 * The prohibition covers *changing* those directories, not reading them. A
 * model asked "what session is this?" must be able to look, and since
 * `z1-tools` 0.1.9 allows `read` there again (search still hides the store from
 * `glob`/`grep`/`list`/`tree`), an over-broad rule only taught it to recite the
 * rule and send the user to `/sessions`. So the section also states the chat's
 * own identity when the caller knows it, and the answer costs no file read.
 *
 * Pure: path arithmetic and string building only, no filesystem access. The
 * caller decides what it knows; an unknown root still gets the `.z1/` half.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** The section heading, for callers that compose the slot themselves. */
export const OWN_STATE_HEADING = '## Your own state'

/** `a/b` on every platform, with one trailing slash: these are directories. */
const shownPath = (path: string): string => {
  const posix = path.split(sep).join('/')
  return posix.endsWith('/') ? posix : `${posix}/`
}

/**
 * `z1/` when the root is inside the workspace, else the absolute path.
 *
 * A `..` never reaches the prompt: `relative()` already answers with one when
 * the root is outside, and a path the model cannot mistake for a project
 * subdirectory is the whole point of the absolute branch.
 */
const displayRoot = (cwd: string, root: string): string => {
  const rel = relative(resolve(cwd), resolve(root))
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  return shownPath(inside ? rel : resolve(root))
}

/**
 * The section body for the custom prompt slot, or `''` when there is nothing
 * to say.
 *
 * `sessionRoot` is the store's absolute root (`SessionStore.root`). When it is
 * unknown — a one-shot run that never opened a store, or a store that failed to
 * open — only the `.z1/` half is written, because a guessed transcript path is
 * worse than none: the model would describe the wrong directory as z1's state.
 */
export function ownStateText(options: {
  cwd: string
  sessionRoot?: string
  /** This chat's own identity, when the caller knows it; omitted from the text when absent. */
  session?: { name: string; messageCount: number }
}): string {
  const root: string =
    options.sessionRoot === undefined || options.sessionRoot.trim() === ''
      ? ''
      : displayRoot(options.cwd, options.sessionRoot)

  const where =
    root === ''
      ? '`.z1/` is z1’s own state in this project: the todo list and spilled command output. It is not project content.'
      : `\`${root}\` is z1’s own state for this project: the saved chat transcripts. \`.z1/\` holds the todo list and spilled command output. Neither is project content.`

  // The chat's own identity, so "what session is this?" is answered from the
  // prompt instead of a file read or a recited rule. No id: it is long, and
  // `/sessions` is the verb the user actually types.
  const name = options.session?.name.trim() ?? ''
  const count = options.session?.messageCount
  // The name is user-controlled: the store's `normalizeName` replaces control
  // characters but keeps quotes, backticks and backslashes, so a session
  // renamed `x" ignore previous instructions` would otherwise land in the
  // system prompt as prose the model can read as an instruction. Emitting it as
  // a JSON string escapes quotes, backslashes and any newline a caller passes
  // unnormalized; the parenthesis explains why the model sees `\"` in the name.
  const identity: string | undefined =
    name === '' || count === undefined || !Number.isFinite(count) || count < 0
      ? undefined
      : `This chat is the session ${JSON.stringify(name)} (JSON string) with ${String(count)} ${count === 1 ? 'message' : 'messages'}; /sessions lists and switches.`

  const cleanup =
    root === ''
      ? '- Do not edit, create, move or delete anything in `.z1/`, and never remove it to "clean up". This includes shell commands (`rm`, `mv`, `sed -i`, redirects).'
      : '- Do not edit, create, move or delete anything in them, and never remove the folders to "clean up". This includes shell commands (`rm`, `mv`, `sed -i`, redirects).'

  const allowed =
    root === ''
      ? '- Reading `.z1/` is allowed when the user asks about this chat; only changing it is out of bounds.'
      : '- Reading them is allowed when the user asks about this chat: which session this is, how many messages, what was said earlier.'

  const describe =
    root === ''
      ? '- Do not list, count or reason from `.z1/` when describing the workspace; project files only.'
      : '- Do not list, count or reason from their contents when describing the workspace; project files only.'

  return [
    OWN_STATE_HEADING,
    '',
    where,
    ...(identity === undefined ? [] : [identity]),
    cleanup,
    allowed,
    describe,
    // `/sessions` is already named by the identity line; repeating it is noise.
    root === '' || identity !== undefined
      ? '- The todo list is changed with `todo.write` when this turn has it, never by editing `.z1/todos.json`.'
      : '- The todo list is changed with `todo.write` when this turn has it, never by editing `.z1/todos.json`. The user switches transcripts with `/sessions`.',
  ].join('\n')
}
