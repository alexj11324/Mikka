import assert from 'node:assert/strict'
import test from 'node:test'
import { createTelegramLogger } from './logger'

test('omits SDK log context that may contain private Telegram content', () => {
  const logged: string[] = []
  const logger = createTelegramLogger({
    debug: message => logged.push(message),
    info: message => logged.push(message),
    warn: message => logged.push(message),
    error: message => logged.push(message),
  })

  logger.error('Slash command processing error', { text: '/start secret-pairing-token' })

  assert.deepEqual(logged, ['[chat] Slash command processing error'])
})
