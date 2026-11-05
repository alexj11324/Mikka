import assert from 'node:assert/strict'
import test from 'node:test'
import { chatMark } from '../lib/mobile-chat-marks.ts'

test('a waiting mark outranks unread, takeover ahead of approval ahead of a question', () => {
  assert.deepEqual(chatMark({ question: true, approval: true, takeover: true, unread: 4 }), { waiting: 'takeover', unread: 4 })
  assert.deepEqual(chatMark({ question: true, approval: true, takeover: false, unread: 2 }), { waiting: 'approval', unread: 2 })
  assert.deepEqual(chatMark({ question: true, approval: false, takeover: false, unread: 0 }), { waiting: 'question', unread: 0 })
  assert.deepEqual(chatMark({ question: false, approval: false, takeover: false, unread: 3.9 }), { waiting: null, unread: 3 })
})
