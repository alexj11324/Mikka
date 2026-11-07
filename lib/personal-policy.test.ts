import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { Pool } from 'pg'

const changed = () => assert.fail('a read cannot emit an execution side effect')
for (const [path, names] of [
  ['./live/panels.ts', ['runChanged']],
  ['./live/lists.ts', ['runListChanged']],
  ['./device-gateway-notify.ts', ['runControlChanged']],
  ['./due-timer.ts', ['armDueTimerAfterCommit']],
] as const) mock.module(new URL(path, import.meta.url).href, {
  namedExports: Object.fromEntries(names.map(name => [name, changed])),
})
const { othersMayUse } = await import('./personal-policy')

function reader(results: { allowOthers: boolean }[][], error?: Error) {
  const calls: { sql: string; values: unknown[] }[] = []
  const query = { async query(sql: string, values: unknown[]) {
    calls.push({ sql, values })
    assert.match(sql, /^SELECT /)
    assert.deepEqual(values, ['payor', 'workspace'])
    if (error) throw error
    assert.ok(calls.length <= results.length, 'one fresh read per permission check')
    return { rows: results[calls.length - 1] }
  } } as unknown as Pick<Pool, 'query'>
  return { query, calls }
}

test('a shared credential check returns its current authorization in one read', async () => {
  const { query, calls } = reader([[{ allowOthers: true }]])
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), true)
  assert.equal(calls.length, 1)
})

for (const [label, rows] of [['missing', []], ['refused', [{ allowOthers: false }]]] as const) {
  test(`a ${label} share does not issue an additional read or write`, async () => {
    const { query, calls } = reader([Array.from(rows)])
    assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
    assert.equal(calls.length, 1)
  })
}

test('repeated permission checks observe revoke and restore without reusing an earlier grant', async () => {
  const { query, calls } = reader([[{ allowOthers: true }], [{ allowOthers: false }], [{ allowOthers: true }]])
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), true)
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), false)
  assert.equal(await othersMayUse(query, 'payor', 'workspace'), true)
  assert.equal(calls.length, 3)
})

test('a failed authorization read propagates its original cause without another query', async () => {
  const error = new Error('fixture_connection_failed')
  const { query, calls } = reader([], error)
  await assert.rejects(othersMayUse(query, 'payor', 'workspace'), cause => cause === error)
  assert.equal(calls.length, 1)
})
