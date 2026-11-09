import assert from 'node:assert/strict'
import test from 'node:test'
import { delegateSchema, metadataSchema, readIssueMetadata, withIssueMetadata } from './issue-metadata'

const agent = { kind: 'agent' as const, id: 'agent-1', name: 'Worker', image: null }
const human = { kind: 'member' as const, id: 'member-1', name: 'Owner', image: null }

test('legacy agent assignment reads as delegation without a human assignee', () => {
  const result = readIssueMetadata({ type: 'doc', attrs: { mikka: { number: 8, assignee: agent } } })
  assert.equal(result.assignee, null)
  assert.deepEqual(result.delegate, agent)
  assert.equal(result.number, 8)
})

test('human responsibility and delegation round trip independently', () => {
  const metadata = metadataSchema.parse({ assignee: human, delegate: agent })
  const content = withIssueMetadata({ type: 'doc', content: [{ type: 'paragraph' }] }, metadata)
  assert.deepEqual(readIssueMetadata(content).assignee, human)
  assert.deepEqual(readIssueMetadata(content).delegate, agent)
  assert.deepEqual(content.content, [{ type: 'paragraph' }])
  const cleared = readIssueMetadata(withIssueMetadata(content, { ...metadata, delegate: null }))
  assert.deepEqual(cleared.assignee, human)
  assert.equal(cleared.delegate, null)
})

test('an explicit delegate, including null, wins over a stale agent assignee', () => {
  for (const delegate of [null, { ...agent, id: 'new-agent' }]) {
    const content = { type: 'doc', attrs: { orvilo: { assignee: agent, delegate } } }
    const result = readIssueMetadata(content)
    assert.equal(result.assignee, null)
    assert.deepEqual(result.delegate, delegate)
    const saved = withIssueMetadata(content, result)
    assert.equal(saved.attrs?.orvilo, undefined)
    assert.equal(readIssueMetadata(saved).assignee, null)
  }
})

test('delegates are execution references; a human is not a delegate', () => {
  assert.equal(delegateSchema.safeParse(human).success, false)
  for (const kind of ['agent', 'bot', 'profile']) assert.equal(delegateSchema.safeParse({ ...agent, kind }).success, true)
})
