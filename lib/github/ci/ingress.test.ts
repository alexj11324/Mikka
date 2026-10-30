import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ciWakeup, scheduleCiWakeup } from './ingress'

test('only valid CI and PR wakeups can schedule existing bindings', async () => {
  const payload = { action: 'completed', repository: { id: 1 }, installation: { id: 2 }, workflow_run: { head_branch: 'mikka/issue-1', id: 42, run_attempt: 2, head_sha: 'a'.repeat(40) } }
  const event = ciWakeup('workflow_run', payload)
  assert.deepEqual(event, { repositoryId: 1, installationId: 2, branch: 'mikka/issue-1', prNumber: null, refresh: true, attempt: { runId: '42', attempt: 2, head: 'a'.repeat(40), state: 'completed' } })
  let params: unknown[] = []
  await scheduleCiWakeup({ query: async (_, values) => { params = values; return { rows: [{ scheduled: true }] } } }, event!)
  assert.deepEqual(params, [1, 2, 'mikka/issue-1', null, true, '42', 'a'.repeat(40), 2, 'completed'])
  assert.equal(ciWakeup('workflow_run', { ...payload, installation: { id: '2' } }), null)
  assert.equal(ciWakeup('workflow_run', { ...payload, action: 'deleted' }), null)
  assert.equal(ciWakeup('issue_comment', payload), null)
  assert.equal(ciWakeup('pull_request', { action: 'reopened', repository: { id: 1 }, number: 5 })?.refresh, true)
  assert.deepEqual(ciWakeup('pull_request', { action: 'closed', repository: { id: 1 }, number: 5 }), { repositoryId: 1, installationId: null, branch: null, prNumber: 5, refresh: false, attempt: null })
})

test('a PR base edit fences a pending claim; unrelated edits do not trigger CI', () => {
  const base = { repository: { id: 1 }, number: 5, action: 'edited' }
  assert.equal(ciWakeup('pull_request', base), null)
  assert.equal(ciWakeup('pull_request', { ...base, changes: { title: { from: 'before' } } }), null)
  const wake = ciWakeup('pull_request', { ...base, changes: { base: { ref: { from: 'old' } } } })
  assert.equal(wake?.prNumber, 5)
  assert.equal(wake?.refresh, true)
})
