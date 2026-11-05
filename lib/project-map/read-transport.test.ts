import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fingerprint } from './cursor'
import { decodeMapRows } from './read-transport'

const issue = 'a0000000-0000-4000-8000-000000000001'
const other = 'b0000000-0000-4000-8000-000000000002'
// PostgreSQL jsonb uses this order for these known ASCII keys. The database
// regression also compares real jsonb objects with the compact SQL result.
const jsonbOrder = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)))
function encode(rows: Record<string, unknown>[], fields: string[]) {
  return { count: rows.length, columns: jsonbOrder(Object.fromEntries(fields.map(key => {
    const values = rows.map(row => row[key])
    return [key, values.length && values.every(value => JSON.stringify(value) === JSON.stringify(values[0])) ? [values[0]] : values]
  }))) }
}
const issueFields = ['id', 'title', 'status', 'createdAt', 'blockedByIds']
const runFields = ['id', 'issueId', 'status', 'outcome', 'createdAt', 'finishedAt', 'retryOf', 'continuesRunId', 'threadReplacedBy', 'harness', 'modelId', 'owned']

test('constant columns distinguish empty tables, null values, empty arrays and mixed values', () => {
  assert.deepEqual(decodeMapRows(encode([], issueFields), 'issues', [], 100), [])
  const rows = [
    { id: issue, title: 'One', status: 'todo', createdAt: 0, blockedByIds: [] },
    { id: other, title: 'Two', status: 'todo', createdAt: -1, blockedByIds: [issue] },
  ]
  const decoded = decodeMapRows(encode(rows, issueFields), 'issues', [], 100)
  const expected = rows.map(row => jsonbOrder({ ...row, createdAt: new Date(row.createdAt).toISOString() }))
  assert.equal(JSON.stringify(decoded), JSON.stringify(expected))
  assert.equal(fingerprint(decoded), fingerprint(expected))
  const single = { ...rows[0], blockedByIds: null }
  assert.deepEqual(decodeMapRows(encode([single], issueFields), 'issues', [], 100), [jsonbOrder({ ...single, createdAt: new Date(0).toISOString() })])
})

test('run columns restore UUIDs, null fields, mixed ownership and exact fingerprint key order', () => {
  const rows = [0, 1].map(index => ({ id: index ? other : issue, issueId: index, status: 'cancelled', outcome: null,
    createdAt: index ? 123 : -877, finishedAt: index ? null : -877, retryOf: index ? issue : null,
    continuesRunId: null, threadReplacedBy: null, harness: index ? 'codex' : null, modelId: null, owned: index === 0 }))
  const expected = rows.map(row => jsonbOrder({ ...row, issueId: [issue, other][row.issueId], createdAt: new Date(row.createdAt).toISOString(),
    finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString() }))
  const decoded = decodeMapRows(encode(rows, runFields), 'runs', [issue.toUpperCase(), other], 2000)
  assert.equal(JSON.stringify(decoded), JSON.stringify(expected))
  assert.equal(fingerprint(decoded), fingerprint(expected))
})

test('invalid columns and issue dictionary indices fail before facts can be returned', () => {
  const row = { id: issue, title: 'One', status: 'todo', createdAt: 0, blockedByIds: [] }
  const valid = encode([row, row], issueFields)
  for (const raw of [null, [], {}, { ...valid, count: -1 }, { ...valid, count: 101 }, { ...valid, count: 1.5 },
    { count: 0, columns: valid.columns }, { ...valid, columns: { ...valid.columns, extra: [] } },
    { ...valid, columns: { ...valid.columns, id: [] } }, { ...valid, columns: { ...valid.columns, title: ['a', 'b', 'c'] } },
    { ...valid, columns: { ...valid.columns, createdAt: [Number.NaN] } }])
    assert.throws(() => decodeMapRows(raw, 'issues', [], 100), { code: 'map_unavailable' })
  const run = { id: issue, issueId: 0, status: 'cancelled', outcome: null, createdAt: 0, finishedAt: null,
    retryOf: null, continuesRunId: null, threadReplacedBy: null, harness: 'codex', modelId: null, owned: true }
  for (const index of [-1, 1, 0.5, null, '0'])
    assert.throws(() => decodeMapRows(encode([{ ...run, issueId: index }], runFields), 'runs', [issue], 2000), { code: 'map_unavailable' })
  assert.throws(() => decodeMapRows(encode([run], runFields), 'runs', ['invalid'], 2000), { code: 'map_unavailable' })
})
