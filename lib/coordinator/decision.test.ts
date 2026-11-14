import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { answersByName, decisionInput } from './decision'

test('answers come back by name, without refusals', () => {
  const answers = answersByName({ answers: [
    { type: 'predicate', name: 'needsPerson', probability: 0.9 },
    { type: 'refusal', name: 'other' },
    { type: 'choice', name: 'responder', choice: 'lead', confidence: 0.4 },
  ] })
  assert.deepEqual([...answers.keys()], ['needsPerson', 'responder'])
  assert.equal(answersByName({}).size, 0)
})

test('state reads as key: value lines', () => {
  assert.equal(decisionInput({ status: 'succeeded', agentSummary: 'Done' }), 'status: succeeded\nagentSummary: Done')
})

test('the standalone vision plan validates both images without starting a paid decision', () => {
  const script = fileURLToPath(new URL('../../scripts/coordinator-vision-functional.mjs', import.meta.url))
  const plan = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(plan.status, 0, plan.stderr)
  const result = JSON.parse(plan.stdout)
  assert.equal(result.inferencePerformed, false)
  assert.equal(result.maximumGatewayRequests, 0)
  assert.deepEqual(result.images.map((image: { sha256: string }) => image.sha256), [
    '12bdfde7f3c89e2135990a79f859455ed472e55e2a9696d1d532689702279421',
    '2774ee7a7c138b7edebc57f38743f439edec4b09cc8c3aedf888d8e749fb8044',
  ])

  const unscoped = spawnSync(process.execPath, [script, '--execute-synthetic-vision'], { encoding: 'utf8' })
  assert.notEqual(unscoped.status, 0)
  assert.match(unscoped.stderr, /authenticated application workspace/)
  assert.equal(unscoped.stdout, '')
})
