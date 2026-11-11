import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ALE-67 acceptance: the facts the agent's prompt states and the facts 记忆
// shows must come from one source. A source-only test, because the point is
// structural: no settings page may grow its own read of user_facts, and no turn
// path may build a prompt without the section. The behaviour against a real
// database is asserted in lib/profile/store.db.test.ts.

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const store = read('lib/profile/store.ts')
const prompt = read('lib/profile/prompt.ts')
const action = read('app/actions/memory.ts')
const steps = read('workflows/coordinator/steps.ts')
const nativeSteps = read('workflows/coordinator/native-steps.ts')

const bodyOf = (source: string, name: string) => {
  const start = source.indexOf(`export async function ${name}`)
  assert.ok(start >= 0, `${name} must exist`)
  return source.slice(start, start + 1_200)
}

test('记忆 and the agent prompt read the same rows through the same filter', () => {
  for (const name of ['listFacts', 'profilePromptSection']) {
    const body = bodyOf(store, name)
    assert.match(body, /from\(userFacts\)/, `${name} reads user_facts`)
    assert.match(body, /eq\(userFacts\.state, 'active'\)/, `${name} reads only active facts, as 记忆 does`)
  }
  // The settings page has no read of its own: it goes through the store.
  assert.match(action, /from '@\/lib\/profile\/store'/)
  assert.match(action, /\blistFacts\b/)
  assert.doesNotMatch(action, /user_facts/, '记忆 must not query user_facts itself')
})

test('what is stated and what is listed come from one composer', () => {
  assert.match(prompt, /export function profileSection/)
  assert.match(prompt, /export function promptFacts/)
  // The store hands rows to that composer rather than formatting its own text.
  const section = bodyOf(store, 'profilePromptSection')
  assert.match(section, /profileSection\(promptFacts\(/)
})

test('every turn path that builds a system prompt injects the section', () => {
  for (const [name, source] of [['hosted', steps], ['native', nativeSteps]] as const) {
    assert.match(source, /profilePromptSection\(userId, await usedRepositoriesForBot\(userId, botId\)\)/,
      `the ${name} turn states the person's facts`)
    assert.match(source, /promptWithCachedContext\(/, `the ${name} turn builds a prompt`)
  }
  const hostedCall = steps.split('\n').find(line => line.includes('promptWithCachedContext('))!
  assert.match(hostedCall.trim(), /,\s*profile\)$/, 'the section is the tail argument promptWithCachedContext places after the memory')
  const nativeCall = nativeSteps.split('\n').find(line => line.includes('promptWithCachedContext('))!
  assert.match(nativeCall.trim(), /,\s*profile\)\.instructions,?$/, 'likewise for the native runtime')
})

test('the section reaches the model only when 记忆 is on', () => {
  // conversationWithMemory empties `memory` with the switch off, and both paths
  // gate the section on that same value rather than reading a second switch.
  for (const source of [steps, nativeSteps]) {
    assert.match(source, /const profile = memory \?[\s\S]{0,200}?profilePromptSection/, 'the section follows the memory switch')
  }
})
