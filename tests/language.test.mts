/**
 * `language.ts` — the prompt line that names the language of this turn.
 *
 * The cases pin the two decisions the line makes and the ones it refuses:
 * a script that is unmistakable is named, Ukrainian and Russian are separated
 * only by their own letters, Latin is never guessed, and code is not prose.
 */

import assert from 'node:assert/strict'

import { detectLanguage, languageHintText } from '../language.ts'

const named = (message: string): string | undefined => {
  const text = languageHintText(message)
  return text === undefined ? undefined : text
}

// `детект`: Ukrainian, named by its own letters.
assert.equal(detectLanguage('створи тул пошуку для z2q через exa, якщо є час — і перевір його'), 'ukrainian')
assert.match(String(named('створи тул пошуку для z2q через exa, якщо є час — і перевір його')), /is in Ukrainian: reply in Ukrainian/)

// `детект`: Russian, named by its own letters.
assert.equal(detectLanguage('создай инструмент поиска через провайдера, чтобы был готов'), 'russian')
assert.match(String(named('создай инструмент поиска через провайдера, чтобы был готов')), /is in Russian: reply in Russian/)

// Cyrillic without either set: the pair is said out loud, never guessed. This
// is the case that produced the English answer — a short technical request.
const ambiguous = 'створи тул пошуку для z2q через exa'
assert.equal(detectLanguage(ambiguous), 'cyrillic')
assert.match(String(named(ambiguous)), /written in Cyrillic \(Russian or Ukrainian\)/)
assert.match(String(named(ambiguous)), /not the other one of the pair and not English/)

// Latin is never named: English, Spanish, Polish and French share the script and
// a wrong guess in the prompt is worse than the rule that is already there.
assert.equal(detectLanguage('build me a search tool for z2q through exa'), undefined)
assert.equal(languageHintText('build me a search tool for z2q through exa'), undefined)
assert.equal(detectLanguage('erkläre mir kurz, wie ein Monorepo funktioniert'), undefined)

// Other unmistakable scripts are named.
assert.equal(detectLanguage('検索ツールを作ってください'), 'japanese')
assert.equal(detectLanguage('做一个搜索工具'), 'chinese')
assert.equal(detectLanguage('검색 도구를 만들어 주세요'), 'korean')
assert.equal(detectLanguage('أنشئ أداة بحث'), 'arabic')
assert.equal(detectLanguage('φτιάξε μου ένα εργαλείο αναζήτησης'), 'greek')
assert.match(String(named('検索ツールを作ってください')), /is in Japanese/)

// Code is not prose: a fence, inline code, a URL and a path carry no language.
assert.equal(detectLanguage('```\nсоздай инструмент поиска через провайдера\n```'), undefined)
assert.equal(detectLanguage('`создай инструмент поиска через провайдера`'), undefined)
assert.equal(
  detectLanguage('read https://example.com/создай-инструмент-поиска and C:\\Users\\создай\\инструмент.ts'),
  undefined,
)
// …while a Cyrillic sentence that merely mentions them stays Cyrillic.
assert.equal(
  detectLanguage('запусти `git status` у C:\\Users\\oleksii\\repo.ts і покажи результат'),
  'ukrainian',
)

// A single quoted word inside an English sentence is not the message's language.
assert.equal(detectLanguage('what does "привет" mean in this file?'), undefined)

// Nothing to say.
assert.equal(detectLanguage(''), undefined)
assert.equal(detectLanguage('   \n\t'), undefined)
assert.equal(detectLanguage('ok'), undefined)
assert.equal(languageHintText(''), undefined)

// The line repeats the rule rather than replacing it: it names the language and
// says why the surrounding English is not a reason to switch.
const line = String(named('поясни, як працює цей модуль, будь ласка'))
assert.ok(line.startsWith("The user's most recent message is in Ukrainian:"))
assert.ok(line.includes('whatever language this prompt, the tool descriptions and any tool output are in'))
assert.ok(!line.includes('\n'))

console.log('language: all checks passed')
