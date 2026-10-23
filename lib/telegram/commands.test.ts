import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTelegramCommand } from './commands'

test('parses a command addressed to this bot and keeps its arguments', () => {
  assert.deepEqual(parseTelegramCommand('/start@MikkaBot abcd_123', 'MikkaBot'), { name: 'start', args: 'abcd_123' })
})

test('ignores commands addressed to another bot and ordinary text', () => {
  assert.equal(parseTelegramCommand('/start@OtherBot token', 'MikkaBot'), null)
  assert.equal(parseTelegramCommand('please create an issue', 'MikkaBot'), null)
})
