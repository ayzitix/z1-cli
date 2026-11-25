/**
 * The one system-prompt line that names the language of this turn's message.
 *
 * The SDK's core prompt says "reply in the user's language", and with a strong
 * model that is enough. With a small, fast one it is not: a turn that asked for
 * a tool in Ukrainian was answered in English, because the surrounding prompt,
 * the 29 tool descriptions and the tool's own output were all English and the
 * answer was long and technical. "The user's language" is an abstraction the
 * model has to resolve; naming it outright — twice, in one short line — costs
 * about thirty tokens and removes the resolution step entirely.
 *
 * Only script is inspected, never vocabulary: a language is named when its
 * alphabet is unmistakable, and nothing is claimed otherwise. Latin script is
 * deliberately left unnamed — English, Spanish, Polish and French share it, and
 * a wrong guess written into the prompt is worse than the rule it repeats. A
 * Cyrillic message is named Russian or Ukrainian only when it carries the
 * letters that separate them (`і/ї/є/ґ` versus `ы/э/ё/ъ`); a message with
 * neither, which is the common case for a short technical request, still gets a
 * line — it says the pair out loud instead of picking one and being wrong.
 *
 * Code is not prose: fenced blocks, inline code, URLs and paths are stripped
 * before counting, so a Cyrillic sentence about `git status` and
 * `C:\Users\…\file.ts` stays a Cyrillic sentence.
 */

/** Below this many letters in one script, a short message is not evidence. */
const MIN_LETTERS = 4

/** The clear Cyrillic separators, one set per language. */
const UKRAINIAN_ONLY = /[іїєґ]/giu
const RUSSIAN_ONLY = /[ыэёъ]/giu

/** What the detection can name. `cyrillic` is the honest "one of the two". */
export type DetectedLanguage =
  | 'russian'
  | 'ukrainian'
  | 'cyrillic'
  | 'japanese'
  | 'chinese'
  | 'korean'
  | 'arabic'
  | 'hebrew'
  | 'greek'
  | 'thai'
  | 'hindi'

/** English name of each, as it reads inside the prompt line. */
const NAMES: Readonly<Record<DetectedLanguage, string>> = {
  russian: 'Russian',
  ukrainian: 'Ukrainian',
  cyrillic: 'Russian or Ukrainian',
  japanese: 'Japanese',
  chinese: 'Chinese',
  korean: 'Korean',
  arabic: 'Arabic',
  hebrew: 'Hebrew',
  greek: 'Greek',
  thai: 'Thai',
  hindi: 'Hindi',
}

/**
 * One entry per script that is not Latin. Kana comes before Han so a Japanese
 * sentence, which mixes both, is not counted as Chinese; the winner is the
 * largest count, so the order only breaks ties.
 */
const SCRIPTS: ReadonlyArray<readonly [DetectedLanguage, RegExp]> = [
  ['ukrainian', /[\u0400-\u04FF]/gu],
  ['japanese', /[\u3040-\u30FF]/gu],
  ['chinese', /[\u3400-\u4DBF\u4E00-\u9FFF]/gu],
  ['korean', /[\u1100-\u11FF\uAC00-\uD7AF]/gu],
  ['arabic', /[\u0600-\u06FF\u0750-\u077F]/gu],
  ['hebrew', /[\u0590-\u05FF]/gu],
  ['greek', /[\u0370-\u03FF]/gu],
  ['thai', /[\u0E00-\u0E7F]/gu],
  ['hindi', /[\u0900-\u097F]/gu],
]

/**
 * Prose only. Fences go first so a code sample cannot be read as a sentence,
 * then inline code, then URLs and paths (a path segment can be a word).
 */
function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, ' ')
    .replace(/\b[A-Za-z]:\\\S*/gu, ' ')
    .replace(/\S+\.[A-Za-z]{1,6}\b/gu, ' ')
}

function count(text: string, pattern: RegExp): number {
  const matches = text.match(pattern)
  return matches === null ? 0 : matches.length
}

/**
 * The language of one message, or `undefined` when the script does not decide
 * it (Latin, a mixed message, a one-word question, an empty prompt).
 */
export function detectLanguage(message: string): DetectedLanguage | undefined {
  const text = prose(message)
  const letters = count(text, /\p{L}/gu)
  if (letters < MIN_LETTERS) return undefined

  let best: DetectedLanguage | undefined
  let hits = 0
  for (const [script, pattern] of SCRIPTS) {
    const found = count(text, pattern)
    if (found > hits) {
      best = script
      hits = found
    }
  }
  // The winning script must be a real share of the message, not a quoted word
  // inside an English sentence.
  if (best === undefined || hits < MIN_LETTERS || hits * 2 < letters) return undefined
  if (best !== 'ukrainian') return best

  // Cyrillic: Ukrainian and Russian share most of the alphabet, so the name is
  // only written when the separators are there.
  const ukrainian = count(text, UKRAINIAN_ONLY)
  const russian = count(text, RUSSIAN_ONLY)
  if (ukrainian > russian) return 'ukrainian'
  if (russian > ukrainian) return 'russian'
  return 'cyrillic'
}

/**
 * The prompt line for this turn, or `undefined` when nothing can be claimed.
 *
 * It repeats the rule rather than replacing it: the SDK's `core.language`
 * section is what a session without this line still has.
 */
export function languageHintText(message: string): string | undefined {
  const language = detectLanguage(message)
  if (language === undefined) return undefined
  const name = NAMES[language]
  if (language === 'cyrillic') {
    return `The user's most recent message is written in Cyrillic (${name}): reply in the same language they wrote, not the other one of the pair and not English.`
  }
  return `The user's most recent message is in ${name}: reply in ${name}, whatever language this prompt, the tool descriptions and any tool output are in.`
}
