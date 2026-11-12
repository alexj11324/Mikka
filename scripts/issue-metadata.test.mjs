import test from 'node:test'
import { taskProjectOptions } from '../lib/task-project-options.ts'
import assert from 'node:assert/strict'
import { issueWithMetadata, readIssueMetadata, withIssueMetadata, metadataSchema, pullRequestSchema } from '../lib/issue-metadata.ts'

const metadata = { number: 155, assignee: { kind: 'member', id: 'member-1', name: '测试成员', image: null }, project: '任务管理', labels: [{ name: 'Feature', color: 'violet' }], pullRequests: [{ url: 'https://github.com/alexj11324/Orvilo3/pull/81', state: 'open' }] }

test('legacy documents have no invented attributes', () => {
  assert.deepEqual(readIssueMetadata({ type: 'doc' }), metadataSchema.parse({}))
})
test('attributes round-trip through persisted JSON without altering body content', () => {
  const content = { type: 'doc', attrs: { other: 'preserved' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '真实正文' }] }] }
  const saved = JSON.parse(JSON.stringify(withIssueMetadata(content, metadata)))
  assert.deepEqual(readIssueMetadata(saved), metadataSchema.parse(metadata))
  assert.deepEqual(saved.content, content.content)
  assert.equal(saved.attrs.other, 'preserved')
  assert.equal(content.attrs.orvilo, undefined)
})
test('pre-rename orvilo metadata is read and moved to the mikka key on write', () => {
  const legacy = { type: 'doc', attrs: { orvilo: metadata } }
  assert.deepEqual(readIssueMetadata(legacy), metadataSchema.parse(metadata))
  const saved = withIssueMetadata(legacy, readIssueMetadata(legacy))
  assert.equal(saved.attrs.orvilo, undefined)
  assert.deepEqual(saved.attrs.mikka, metadataSchema.parse(metadata))
})
test('collaborative body replacement preserves the latest card attributes', () => {
  const latest = withIssueMetadata({ type: 'doc' }, metadata)
  const synchronized = withIssueMetadata({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '协作更新' }] }] }, readIssueMetadata(latest))
  assert.deepEqual(readIssueMetadata(synchronized), metadataSchema.parse(metadata))
  assert.equal(synchronized.content[0].content[0].text, '协作更新')
})
test('issue hydration exposes stable numeric identifiers', () => {
  const saved = issueWithMetadata({ id: 'opaque-id', content: withIssueMetadata({ type: 'doc' }, metadata) })
  assert.equal(saved.metadata.number, 155)
})
test('PR links reject unsafe schemes and non-PR URLs', () => {
  for (const url of ['javascript:alert(1)', 'https://example.com/pull/81', 'https://github.com/owner/repo/issues/81', 'https://github.com/owner/repo/pull/0', 'https://github.com.evil.test/owner/repo/pull/81']) assert.equal(pullRequestSchema.safeParse({ url, state: 'open' }).success, false)
  assert.equal(pullRequestSchema.safeParse(metadata.pullRequests[0]).success, true)
})
test('metadata enforces collection and field bounds', () => {
  assert.equal(metadataSchema.safeParse({ ...metadata, labels: Array(13).fill(metadata.labels[0]) }).success, false)
  assert.equal(metadataSchema.safeParse({ ...metadata, number: -1 }).success, false)
  assert.equal(metadataSchema.safeParse({ ...metadata, project: 'x'.repeat(101) }).success, false)
})

test('a PR keeps its line counts when GitHub reported them; they are optional, whole and never negative', () => {
  const url = 'https://github.com/alexj11324/Mikka/pull/92'
  assert.deepEqual(pullRequestSchema.parse({ url, state: 'merged', additions: 18, deletions: 0 }), { url, state: 'merged', additions: 18, deletions: 0 })
  assert.deepEqual(pullRequestSchema.parse({ url, state: 'open' }), { url, state: 'open' })
  for (const bad of [{ additions: -1 }, { deletions: 1.5 }, { additions: '3' }]) assert.equal(pullRequestSchema.safeParse({ url, state: 'open', ...bad }).success, false)
  const saved = JSON.parse(JSON.stringify(withIssueMetadata({ type: 'doc' }, metadataSchema.parse({ pullRequests: [{ url, state: 'open', additions: 7, deletions: 2 }] }))))
  assert.deepEqual(readIssueMetadata(saved).pullRequests, [{ url, state: 'open', additions: 7, deletions: 2 }])
})

test('Project choices retain same-name IDs and follow the linked ID across a rename', () => {
  const first = '40000000-0000-4000-8000-000000000001'
  const second = '40000000-0000-4000-8000-000000000002'
  const records = [{ id: first, name: 'Shared name' }, { id: second, name: 'Shared name' }]
  assert.deepEqual(taskProjectOptions(records, second), [
    { id: first, label: 'Shared name', description: first, checked: false },
    { id: second, label: 'Shared name', description: second, checked: true },
  ])
  records[1].name = 'Updated name'
  assert.deepEqual(taskProjectOptions(records, second)[1], { id: second, label: 'Updated name', checked: true, description: undefined })
  assert.equal(taskProjectOptions(records, null).some(item => item.checked), false)
})
