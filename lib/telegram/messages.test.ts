import assert from 'node:assert/strict'
import test from 'node:test'
import { TELEGRAM_MESSAGE_LIMIT, splitTelegramText } from './messages'

test('splits long Telegram replies without losing text or breaking surrogate pairs', () => {
  const text = 'a'.repeat(TELEGRAM_MESSAGE_LIMIT - 1) + '😀' + 'b'.repeat(TELEGRAM_MESSAGE_LIMIT)
  const chunks = splitTelegramText(text)

  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every(chunk => chunk.length <= TELEGRAM_MESSAGE_LIMIT))
  assert.deepEqual(splitTelegramText(''), [])
})
