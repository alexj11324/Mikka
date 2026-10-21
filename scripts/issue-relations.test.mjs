import test from 'node:test'
import assert from 'node:assert/strict'
import { compareDescriptions, createsIssueCycle, descriptionKey } from '../lib/issue-relations.ts'
import { metadataSchema, readIssueMetadata, withIssueMetadata } from '../lib/issue-metadata.ts'

const doc = (...lines) => ({ type: 'doc', content: lines.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) })
test('parent and dependency graphs reject self and transitive cycles', () => {
  const graph = new Map([['a', ['b']], ['b', ['c']], ['c', []]])
  assert.equal(createsIssueCycle('a', ['a'], graph), true)
  assert.equal(createsIssueCycle('c', ['a'], graph), true)
  assert.equal(createsIssueCycle('a', ['c'], graph), false)
  assert.equal(createsIssueCycle('d', ['a'], graph), false)
})
test('unrelated existing graph cycles terminate without hanging', () => {
  assert.equal(createsIssueCycle('a', ['b'], new Map([['b', ['c']], ['c', ['b']]])), false)
})
test('description comparisons ignore issue properties', () => {
  const before = withIssueMetadata(doc('正文'), metadataSchema.parse({ project: '旧项目' }))
  const after = withIssueMetadata(doc('正文'), metadataSchema.parse({ project: '新项目', dueDate: '2026-11-01' }))
  assert.equal(descriptionKey(before), descriptionKey(after))
  assert.equal(compareDescriptions(before, after).changes, 0)
})
test('description diff preserves rich nodes and identifies separate changes', () => {
  const result = compareDescriptions(doc('旧段落', '不变', '删除'), doc('新段落', '不变', '添加'))
  assert.equal(result.changes, 2)
  assert.equal(result.content.content.filter(node => node.attrs?.historyChange === 'removed').length, 2)
  assert.equal(result.content.content.filter(node => node.attrs?.historyChange === 'added').length, 2)
  assert.equal(result.content.content.some(node => !node.attrs?.historyChange && node.content[0].text === '不变'), true)
})
test('issue operations round trip without overwriting document or unrelated metadata', () => {
  const metadata = metadataSchema.parse({ parentId: '00000000-0000-4000-8000-000000000001', blockedByIds: ['00000000-0000-4000-8000-000000000002'], favoriteUserIds: ['user-a'], subscriberUserIds: ['user-b'], estimate: 3, dueDate: '2026-12-01' })
  const original = doc('任务描述')
  const saved = withIssueMetadata(original, metadata)
  assert.deepEqual(readIssueMetadata(saved), metadata)
  assert.deepEqual(saved.content, original.content)
  assert.equal(original.attrs, undefined)
})
test('relation fields and personal preferences have bounded validated values', () => {
  assert.equal(metadataSchema.safeParse({ parentId: 'other-task' }).success, false)
  assert.equal(metadataSchema.safeParse({ blockedByIds: Array(101).fill('00000000-0000-4000-8000-000000000001') }).success, false)
  assert.equal(metadataSchema.safeParse({ estimate: -1 }).success, false)
  assert.equal(metadataSchema.safeParse({ estimate: 1.5 }).success, false)
  assert.equal(metadataSchema.safeParse({ dueDate: 'not-a-date' }).success, false)
})
