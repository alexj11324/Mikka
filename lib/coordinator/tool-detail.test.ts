import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previewFields, toolDetail } from './tool-detail'

const RUN = '2b2ff606-ecb7-4b11-a211-0000000000c3'
const TASK = '0a5c49d1-0d4d-489c-8f9e-0000000000a1'

test('a dispatch is its thread, then its note as a quote, then its task; never an id as text', () => {
  const lines = toolDetail({ name: 'dispatch_run', input: JSON.stringify({ issueId: TASK, botId: 'b1', note: 'Fix the redirect' }), output: JSON.stringify({ runId: RUN, status: 'queued' }) })
  assert.deepEqual(lines, [{ kind: 'object', id: RUN }, { kind: 'quote', text: 'Fix the redirect' }, { kind: 'object', id: TASK }])
})

test('a dispatch with no thread yet says the answer\'s status', () => {
  assert.deepEqual(toolDetail({ name: 'dispatch_run', input: '{"prompt": "Go"}', output: '{"status": "queued"}' }),
    [{ kind: 'field', label: 'status', value: 'queued' }, { kind: 'quote', text: 'Go' }])
})

test('a search says what it looked for and how many came back', () => {
  assert.deepEqual(toolDetail({ name: 'list_issues', input: '{"query": "login"}', output: '{"issues": [{}, {}, {}]}' }),
    [{ kind: 'field', label: 'query', value: 'login' }, { kind: 'field', label: 'count', value: 3 }])
})

test('an unregistered tool is its own fields, without ids or nested objects, values cut short, at most six', () => {
  const input = JSON.stringify({ id: 'x1', ownerId: 'x2', uuid: RUN, nested: { a: 1 }, long: 'a'.repeat(200), a: 1, b: true, c: 'c', d: 'd', e: 'e', f: 'f' })
  const lines = toolDetail({ name: 'mystery_tool', input })
  assert.equal(lines.length, 6)
  assert.deepEqual(lines.map(line => line.kind === 'pair' && line.key), ['long', 'a', 'b', 'c', 'd', 'e'])
  assert.equal(lines[0].kind === 'pair' && lines[0].value.length, 80)
})

test('a preview cut at 200 characters still gives its whole leading fields', () => {
  assert.deepEqual(previewFields(`{"query": "login", "limit": 5, "note": "${'x'.repeat(300)}`), { query: 'login', limit: 5 })
  assert.deepEqual(previewFields('not json'), {})
  assert.deepEqual(previewFields('[1, 2]'), { items: [1, 2] })
})
