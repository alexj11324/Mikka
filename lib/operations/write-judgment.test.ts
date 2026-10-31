import assert from 'node:assert/strict'
import test from 'node:test'
import { judgeWrite, DESTRUCTIVE_QUESTION } from './write-judgment'
import type { DecisionQuestion } from '../coordinator/decision'

const call = { action: 'send_email', tool: 'GMAIL_SEND_EMAIL', annotations: ['important', 'openWorldHint'], input: { to: ['a@example.invalid'], subject: 's', body: 'b' } }
const answer = (probability: number) => async () => new Map([['destructive', { type: 'predicate' as const, name: 'destructive', probability }]])

test('only a call the Decisions API judges destructive asks', async () => {
  assert.equal(await judgeWrite(answer(0.1), call), 'allow')
  assert.equal(await judgeWrite(answer(0.9), call), 'ask')
  assert.equal(await judgeWrite(answer(0.5), call), 'ask')
})

test('an unavailable, refused or failed judgment asks instead of writing', async () => {
  assert.equal(await judgeWrite(async () => null, call), 'ask')
  assert.equal(await judgeWrite(async () => new Map(), call), 'ask')
  assert.equal(await judgeWrite(async () => { throw Error('down') }, call), 'ask')
})

test('the one predicate sees the action, tool, MCP annotations and concrete arguments', async () => {
  let seen: { purpose: string; input: string; questions: DecisionQuestion[] } | undefined
  await judgeWrite(async (purpose, input, questions) => { seen = { purpose, input, questions }; return null }, { ...call, annotations: ['destructiveHint', 'important'] })
  assert.equal(seen?.purpose, 'write-destructive')
  assert.deepEqual(seen?.questions, [DESTRUCTIVE_QUESTION])
  assert.match(seen!.input, /action: send_email/)
  assert.match(seen!.input, /tool: GMAIL_SEND_EMAIL/)
  assert.match(seen!.input, /annotations: destructiveHint\n/)
  assert.match(seen!.input, /a@example\.invalid/)
})

test('a read-only tool is never asked about', async () => {
  let called = false
  assert.equal(await judgeWrite(async () => { called = true; return null }, { ...call, annotations: ['readOnlyHint'] }), 'allow')
  assert.equal(called, false)
})
