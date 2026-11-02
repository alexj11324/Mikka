import assert from 'node:assert/strict'
import test from 'node:test'
import { webChatPath } from '../lib/web-chat.ts'

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', BOT = '33333333-3333-4333-8333-333333333333'
test('a Coordinator fallback follows the selected workspace instead of browser cookies', () => {
  assert.equal(webChatPath(null, A), `/?section=coordinator&workspace=${A}`)
  assert.equal(webChatPath(null, B), `/?section=coordinator&workspace=${B}`)
  assert.equal(webChatPath(null), null)
})
test('an actual Bot retains its identity with the selected workspace', () => {
  assert.equal(webChatPath(BOT, A), `/?section=coordinator&bot=${BOT}&workspace=${A}`)
  assert.equal(webChatPath(BOT), `/?section=coordinator&bot=${BOT}`)
  assert.equal(webChatPath('bad-bot', A), null)
  assert.equal(webChatPath(null, 'not-a-workspace'), null)
})
