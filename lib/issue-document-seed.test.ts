import assert from 'node:assert/strict'
import test from 'node:test'
import { Schema } from '@tiptap/pm/model'
import { EMPTY_DOCUMENT, seedableContent } from './issue-document-seed'

const schema = new Schema({ nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: {} } })

test('invalid issue content seeds an empty document and warns once per issue', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  for (const content of [null, undefined, 'text', 42, [], {}, { type: 'paragraph' }, { type: 'doc', content: [{ type: 'mystery' }] }, { type: 'doc', content: [{ type: 'text', text: 'loose' }] }])
    assert.deepEqual(seedableContent(schema, content, 'issue-a'), EMPTY_DOCUMENT)
  assert.equal(warn.mock.callCount(), 1)
  assert.match(String(warn.mock.calls[0].arguments[0]), /issue-a/)
  assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /loose|mystery/)
  seedableContent(schema, null, 'issue-b')
  assert.equal(warn.mock.callCount(), 2)
})

test('a valid document is used unchanged', (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] }] }
  assert.equal(seedableContent(schema, doc, 'issue-c'), doc)
  assert.equal(warn.mock.callCount(), 0)
})
