import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replySegments } from './reply-segments'
import type { ChatTool } from './context'

const tool = (call: string, at?: number): ChatTool => ({ call, name: 'create_issue', state: 'done', ...(at === undefined ? {} : { at }) })

test('tools sit after the words said before they ran, top to bottom', () => {
  const text = 'I will create the task first.\n\nDone: the task is open.'
  assert.deepEqual(replySegments(text, [tool('a', 29), tool('b', 29)]), [
    { kind: 'text', text: 'I will create the task first.' },
    { kind: 'tools', tools: [tool('a', 29), tool('b', 29)] },
    { kind: 'text', text: 'Done: the task is open.' },
  ])
})

test('a tool before any words leads; one without an offset counts as before them', () => {
  assert.deepEqual(replySegments('Found it.', [tool('a', 0), tool('b')]), [{ kind: 'tools', tools: [tool('a', 0), tool('b')] }, { kind: 'text', text: 'Found it.' }])
})

test('while the words are still arriving, a tool waits after what has shown so far', () => {
  assert.deepEqual(replySegments('I will', [tool('a', 29)]), [{ kind: 'text', text: 'I will' }, { kind: 'tools', tools: [tool('a', 29)] }])
  assert.deepEqual(replySegments('', [tool('a', 29)]), [{ kind: 'tools', tools: [tool('a', 29)] }])
})

test('tools out of order never repeat or drop words', () => {
  const text = 'one two three'
  const segments = replySegments(text, [tool('a', 8), tool('b', 3)])
  assert.equal(segments.flatMap(segment => segment.kind === 'text' ? [segment.text] : []).join(' '), text)
  assert.equal(segments.flatMap(segment => segment.kind === 'tools' ? segment.tools : []).length, 2)
})
