import assert from 'node:assert/strict'
import test from 'node:test'
import { createDecisionSubmission } from '../../../hooks/decision-submission'
import { handoffSuggestion } from '../lib/suggestion-handoff'

test('native suggestion taps wait for one canonical receipt and retry a lost ACK with the same ID', async () => {
  const delivery = createDecisionSubmission(() => {})
  const writes: string[][] = []
  let finish!: () => void
  const wait = new Promise<void>(resolve => { finish = resolve })
  const submit = () => delivery.submit('scope:source-id', () => handoffSuggestion('source-id', async (path, init) => {
    assert.equal(path, '/api/rpc')
    assert.equal(init.body.action, 'coordinator.sendSuggestion')
    writes.push(init.body.args)
    if (writes.length === 1) { await wait; throw new Error('response lost') }
    return { version: init.body.version, ok: true, result: { queued: true } }
  }), 'decisionUnconfirmed')
  const first = submit()
  assert.equal(delivery.state('scope:source-id').status, 'submitting')
  assert.equal(await submit(), false)
  finish()
  assert.equal(await first, false)
  assert.equal(delivery.state('scope:source-id').status, 'uncertain')
  assert.equal(await submit(), true)
  assert.equal(await submit(), false)
  assert.deepEqual(writes, [['source-id'], ['source-id']])
})

test('withdrawn, inaccessible and incomplete replies do not open Coordinator', async () => {
  const refused = await handoffSuggestion('source-id', async () => ({ version: 1, ok: true, result: { error: 'suggestionNotFound' } }))
  assert.deepEqual(refused, { status: 'unavailable', error: 'suggestionNotFound' })
  for (const status of [401, 403, 404]) {
    const denied = await handoffSuggestion('source-id', async () => { throw { status, code: 'workspaceAccessDenied' } })
    assert.equal(denied.status, 'unavailable')
  }
  for (const status of [409, 429]) {
    const retryable = await handoffSuggestion('source-id', async () => { throw { status, code: 'generic' } })
    assert.equal(retryable.status, 'failed')
  }
  for (const result of [{}, { queued: false }]) {
    assert.equal((await handoffSuggestion('source-id', async () => ({ version: 1, ok: true, result }))).status, 'uncertain')
  }
  assert.equal((await handoffSuggestion('source-id', async () => { throw { status: 503 } })).status, 'uncertain')
})
