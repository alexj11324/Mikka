import assert from 'node:assert/strict'
import test from 'node:test'
import { inventoryWorkflowRuns } from '../ops/vercel-workflow-inventory.mjs'

const item = (number, status, workflowName = 'workflow//eve//workflowEntry') => ({
  runId: 'wrun_0000000000' + number, deploymentId: 'dpl_bound', workflowName, status, input: 'private input',
})

test('lists both primary storage statuses and every page, retaining only redacted nonterminal metadata', async () => {
  const queries = []
  const report = await inventoryWorkflowRuns(async (status, pagination) => {
    queries.push([status, pagination])
    if (status === 'running') return { hasMore: false, data: [item(1, status), item(4, status, 'workflow//./workflows/task//task')] }
    if (pagination.cursor) return { hasMore: false, data: [item(3, status, 'unknown-private-function')] }
    return { hasMore: true, cursor: 'next', data: [item(1, status), item(2, status)] }
  })
  assert.deepEqual(queries.map(([status, p]) => [status, p.cursor]), [['pending', undefined], ['pending', 'next'], ['running', undefined]])
  assert.ok(queries.every(([, p]) => p.sortOrder === 'asc' && p.limit === 100))
  assert.deepEqual(report.activeRuns.map(run => [run.owner, run.status]), [
    ['eve', 'running'], ['eve', 'pending'], ['unclassified', 'pending'], ['mikka', 'running'],
  ])
  assert.match(report.activeRuns[0].fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(Object.hasOwn(report, 'projectId'), false)
  assert.equal(Object.hasOwn(report, 'teamId'), false)
  assert.equal(Object.hasOwn(report, 'environment'), false)
  assert.doesNotMatch(JSON.stringify(report), /wrun_|private|workflowEntry/)
})

test('incomplete, malformed, or denied storage listings fail the whole inventory', async () => {
  for (const bad of [{}, { hasMore: true, data: [], cursor: 'repeat' },
    { hasMore: true, data: [item(1, 'pending')], cursor: 'repeat' },
    { hasMore: false, data: [item(1, 'completed')] },
    { hasMore: false, data: [{ ...item(1, 'pending'), deploymentId: null }] }]) {
    await assert.rejects(inventoryWorkflowRuns(async () => bad), /workflow_inventory_/)
  }
  await assert.rejects(inventoryWorkflowRuns(async status => {
    if (status === 'running') throw new Error('forbidden')
    return { hasMore: false, data: [] }
  }), /forbidden/)
})
