import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linearLabelOptions } from './client'

test('Linear label options retain team visibility across pages and fail on repeated cursors', async t => {
  const after: (string | null)[] = []
  let repeated = false
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body))
    assert.match(query, /issueLabels\(/)
    assert.match(query, /isGroup: \{ eq: false \}/)
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture')
    after.push(variables.after)
    const first = variables.after === null
    return Response.json({ data: { issueLabels: {
      nodes: [first ? { id: 'all', name: 'Bug', team: null } : { id: 'one', name: 'Support', team: { id: 'team' } }],
      pageInfo: { hasNextPage: first || repeated, endCursor: 'cursor' },
    } } })
  })
  assert.deepEqual(await linearLabelOptions('fixture'), [
    { id: 'all', name: 'Bug', teamId: null }, { id: 'one', name: 'Support', teamId: 'team' },
  ])
  assert.deepEqual(after, [null, 'cursor'])
  repeated = true
  await assert.rejects(linearLabelOptions('fixture'), /invalid label cursor/)
  assert.deepEqual(after.slice(2), [null, 'cursor'])
})
