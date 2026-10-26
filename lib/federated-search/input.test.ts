import assert from 'node:assert/strict'
import test from 'node:test'
import { nextCursor, parseInput, UnsupportedSourceError } from './input'
const owner = 'synthetic-owner', workspaceId = '11111111-1111-4111-8111-111111111111'
const input = (values: Record<string, string>, user = owner) => parseInput(new URLSearchParams(values), user)
test('bounded and explicit source/workspace/query contract', () => {
  assert.equal(input({ source: 'history' }).limit, 20)
  assert.equal(input({ source: 'history', q: '修' }).q, '修')
  for (const values of [{}, { source: 'history', workspaceId }, { source: 'groups' }, { source: 'tasks', workspaceId: 'bad' }, { source: 'history', q: 'a' }, { source: 'history', q: 'x'.repeat(201) }, { source: 'history', limit: '51' }, { source: 'history', limit: '1e1' }, { source: 'history', issueId: workspaceId }]) assert.throws(() => input(values))
  assert.throws(() => parseInput(new URLSearchParams('source=history&source=tasks'), owner))
  for (const source of ['agents', 'knowledge']) assert.throws(() => input({ source }), UnsupportedSourceError)
})
test('cursor preserves microseconds and is bound to owner/source/workspace/query', () => {
  const original = input({ source: 'history', q: 'needle' })
  const key = { time: '2020-01-01T00:00:00.123456Z', id: workspaceId }
  const cursor = nextCursor(original, key)
  assert.deepEqual(input({ source: 'history', q: 'needle', cursor }).cursor, key)
  for (const values of [{ source: 'history', q: 'other' }, { source: 'groups', workspaceId, q: 'needle' }]) assert.throws(() => input({ ...values, cursor }))
  assert.throws(() => input({ source: 'history', q: 'needle', cursor }, 'other'))
  for (const cursor of ['', '%', 'x'.repeat(1025), Buffer.from('{}').toString('base64url')]) assert.throws(() => input({ source: 'history', cursor }))
})
