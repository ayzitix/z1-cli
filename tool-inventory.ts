/**
 * The one system-prompt section that tells the model which tools this turn has
 * — and, just as importantly, which ones it does not.
 *
 * The provider omits the wire `tools` array when nothing is enabled, so without
 * this block the model has no way to know it has none and invents "basic"
 * tools. Naming only the enabled set was not enough: a session with `read`,
 * `glob`, `grep` and `git.status` on and `write` off still let the model say
 * "I'll check the workspace first, then build the file", run three read-only
 * calls, and only then discover it could not write — then paste the whole file
 * into the reply as a substitute. Naming the turned-off tools lets it say
 * "writing files needs `write`, enable it with /tools" in the first sentence.
 *
 * Names only: the enabled tools' full JSON schemas already travel in the same
 * request, and short names keep the section negligible beside the prompt budget
 * (the custom slot is dropped first when it overflows).
 *
 * Pure: string building over a snapshot, no service calls. The caller decides
 * what it knows; an unknown inventory still gets an honest, claim-free section.
 */

import type { ToolRecord, ToolSnapshot } from './tool-state.ts'

/** The section heading, for callers that compose the slot themselves. */
export const TOOL_INVENTORY_HEADING = '## Tools available this turn'

/** A turned-off section that lists every name is a section that eats the prompt budget. */
const MAX_OFF_NAMES = 24

/**
 * `` `a`, `b`, …, `x` and 6 more `` — record order, never truncated silently.
 *
 * `cap` is opt-in and only the turned-off line passes one: the enabled list is
 * followed by "the complete set of tools you can call", so capping it would
 * make the prompt lie about a tool the request genuinely carries.
 */
const nameList = (records: readonly ToolRecord[], cap?: number): string => {
  const kept = cap === undefined ? records : records.slice(0, cap)
  const shown = kept.map((record) => `\`${record.name}\``)
  const rest = records.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${String(rest)} more` : shown.join(', ')
}

/**
 * Installed but not enabled: the tools the user could turn on with `/tools`.
 * Orphan preferences (a decision about a tool no module ships now) are excluded,
 * because `/tools on ghost` cannot make it callable.
 */
const turnedOff = (snapshot: ToolSnapshot): readonly ToolRecord[] =>
  snapshot.records.filter((record) => record.installed && record.state !== 'enabled')

const offLine = (snapshot: ToolSnapshot): string | undefined => {
  const records = turnedOff(snapshot)
  if (records.length === 0) return undefined
  // A deleted tool is restorable, not merely disabled: `/tools on` refuses it.
  const action = records.some((record) => record.state === 'deleted')
    ? 'enable or restore with /tools'
    : 'enable one with /tools'
  return `Turned off: ${nameList(records, MAX_OFF_NAMES)} (${action}).`
}

/**
 * The fail-fast rule. All four clauses matter: check before acting, name the
 * missing tool in the first sentence, do not explore or promise first, and do
 * not deliver the content inline instead of the file.
 */
const RULE =
  'Before your first action, check the request against this list. If it needs a tool you do not have — creating or editing a file, running a command, reading a page — say so in your first sentence, name the missing tool, and ask the user to enable it with /tools. Do not explore first, do not promise the result, and do not paste the content as a substitute unless the user asks for it.'

/** The same rule when the list is empty, so "this list" would name nothing. */
const NO_TOOLS_RULE =
  'Before your first action, check the request against what you have. If it needs any tool — creating or editing a file, running a command, reading a page — say so in your first sentence, name the tool you would need, and ask the user to enable it with /tools. Do not explore first, do not promise the result, and do not paste the content as a substitute unless the user asks for it.'

/**
 * The no-markup rule. The fail-fast rule above still let a 0-of-28 session
 * answer with raw provider syntax — `<|DSML| calls>`, `<invoke>`, `parameter`
 * rows — which the terminal rendered verbatim. Naming the shapes keeps the
 * model from imitating a call it cannot make, and the last sentence gives it
 * the one honest alternative: a plain sentence and the /tools pointer.
 */
const NO_MARKUP_RULE =
  'Do not write tool-call markup of any kind — no `<|...|>` tokens, no XML/DSML, no `invoke`/`parameter`/`function_call`/`tool_call` blocks, and no JSON that imitates a call. Answer in plain language. If the request needs a tool, say in one sentence which tool and ask the user to enable it with /tools.'


/** The two tool names this rule is about; nothing else in this module names a tool. */
const WEB_SEARCH = 'web.search'
const WEB_FETCH = 'web.fetch'

/**
 * The tool-state supplement for the shared `core.current_facts` section.
 *
 * The current-facts policy, the search-then-fetch order and the citation rules
 * live in the global core prompt. This section only states what the static
 * core cannot know: both halves of the web pair are callable in this run, so no
 * dedicated API is required and a snippet alone is not a reason to refuse.
 */
const WEB_RULE =
  '- Both `web.search` and `web.fetch` are callable this turn: search for a result, then read the page that carries the numbers. No dedicated API is required, and a snippet alone is not a reason to refuse.'

/**
 * The same state rule with the pair only half on: search still works, but page
 * bodies are not readable this turn, so the honest fallback is a citation of the
 * result rather than a refusal. Never names `web.fetch`: it is not callable.
 */
const SEARCH_ONLY_RULE =
  '- `web.search` works this turn: search for a result that carries the numbers and cite which one. Page bodies cannot be read this turn, so a snippet is what you have; do not refuse because no dedicated API is offered.'

/** Which of the two rules applies — `undefined` when search itself is off. */
const webRule = (snapshot: ToolSnapshot): string | undefined => {
  const enabled = (name: string): boolean => snapshot.enabled.some((record) => record.name === name)
  if (enabled(WEB_SEARCH) && enabled(WEB_FETCH)) return WEB_RULE
  if (enabled(WEB_SEARCH)) return SEARCH_ONLY_RULE
  return undefined
}

/**
 * The section body for the custom prompt slot.
 *
 * Four cases, each honest about what the request actually carries: an unknown
 * inventory claims neither enabled nor disabled tools, an empty one says "no
 * tools" plainly, and a partly enabled one names both halves.
 */
export function toolInventoryText(snapshot: ToolSnapshot): string {
  if (!snapshot.inventoryKnown) {
    // The guard reads the overlay on its own, so the request may well carry
    // tools even though this read failed. Claiming "no tools" here told the
    // model the opposite of what the wire said, so only promise the attached set.
    return [
      TOOL_INVENTORY_HEADING,
      '',
      'The tool inventory could not be read before this turn, so only the tools actually attached to this request are known. Do not claim or call any tool that is not offered to you. If the task needs a tool that is missing, say so in your first sentence and name it, before exploring, promising the result, or pasting the content as a substitute.',
    ].join('\n')
  }

  if (snapshot.enabled.length === 0) {
    const none = [
      TOOL_INVENTORY_HEADING,
      '',
      'None. You have no tools this turn: you cannot read files, edit files, run commands, search, browse, or use any other tool. Do not claim to have done so.',
    ]
    const off = offLine(snapshot)
    if (off !== undefined) none.push(off)
    none.push(NO_MARKUP_RULE)
    none.push(NO_TOOLS_RULE)
    return none.join('\n')
  }

  const names = nameList(snapshot.enabled)
  const off = Math.max(0, snapshot.installedCount - snapshot.enabled.length)
  const count =
    off > 0
      ? `${String(snapshot.enabled.length)} of ${String(snapshot.installedCount)} installed; ${String(off)} turned off`
      : `all ${String(snapshot.installedCount)} installed`
  const body = [
    TOOL_INVENTORY_HEADING,
    '',
    `You have: ${names} (${count}).`,
    'That is the complete set of tools you can call this turn: the ones in the You have list. Never claim or call anything else, including the turned-off names below. Their schemas are attached to this request.',
  ]
  const offNames = offLine(snapshot)
  if (offNames !== undefined) body.push(offNames)
  body.push(RULE)
  const web = webRule(snapshot)
  if (web !== undefined) body.push(web)
  return body.join('\n')
}
