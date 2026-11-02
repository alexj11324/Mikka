// A refused message to a thread says why, as the web does (same-page flows A3).
import assert from 'node:assert/strict'
import test from 'node:test'
import { threadSendErrorLine } from '../lib/thread-send-error.ts'

test('a refusal the person can act on is named', () => {
  assert.equal(threadSendErrorLine('threadReplaced'), '这个任务已经换到新的线程，请在那里发送。')
  assert.equal(threadSendErrorLine('threadCannotContinue'), '这个线程没有关联任务，无法再次运行。')
})

test('no code, or one the app does not know, keeps the retry line', () => {
  assert.equal(threadSendErrorLine(null), '没发出去，再试一次。')
  assert.equal(threadSendErrorLine('somethingNew'), '没发出去，再试一次。')
})
