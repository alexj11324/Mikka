import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { chatPlace, ChatRowActionError, setChatUnread } from './chat-row-actions'

const BOT = '11111111-1111-4111-8111-111111111111'
const GROUP = '22222222-2222-4222-8222-222222222222'
const MESSAGE = '33333333-3333-4333-8333-333333333333'

function capture(status = 200) {
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status }) }) as typeof fetch
  return () => calls.map(({ url, init }) => ({ url: String(url).replace(/^.*\/api\//, '/api/'), method: init?.method, body: JSON.parse(String(init?.body)) }))
}

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe('setChatUnread', () => {
  it('marks a chat unread through the person’s own chat preference', async () => {
    const calls = capture()
    await setChatUnread({ kind: 'bot', botId: BOT, latestMessageId: MESSAGE }, true)
    await setChatUnread({ kind: 'group', id: GROUP }, true)
    assert.deepEqual(calls(), [
      { url: `/api/mobile/bots/${BOT}`, method: 'PATCH', body: { markedUnread: true } },
      { url: `/api/mobile/groups/${GROUP}`, method: 'PATCH', body: { markedUnread: true } },
    ])
  })

  it('marks a chat read by moving its read position to the latest message', async () => {
    const calls = capture()
    await setChatUnread({ kind: 'bot', botId: BOT, latestMessageId: MESSAGE }, false)
    await setChatUnread({ kind: 'group', id: GROUP, latestMessageId: MESSAGE }, false)
    assert.deepEqual(calls(), [
      { url: `/api/conversations/bot%3A${BOT}/read`, method: 'POST', body: { messageId: MESSAGE } },
      { url: `/api/conversations/${GROUP}/read`, method: 'POST', body: { messageId: MESSAGE } },
    ])
  })

  it('clears only the manual mark of a chat with no message', async () => {
    const calls = capture()
    await setChatUnread({ kind: 'bot', botId: BOT }, false)
    assert.deepEqual(calls(), [{ url: `/api/mobile/bots/${BOT}`, method: 'PATCH', body: { markedUnread: false } }])
  })

  it('rejects when the writer refuses, so the row can say it was not saved', async () => {
    capture(409)
    await assert.rejects(setChatUnread({ kind: 'group', id: GROUP }, true), ChatRowActionError)
  })
})

describe('chatPlace', () => {
  it('opens each chat at the address its row opens', () => {
    assert.deepEqual(chatPlace({ kind: 'coordinator' }), { section: 'coordinator' })
    assert.deepEqual(chatPlace({ kind: 'bot', botId: BOT }), { section: 'coordinator', bot: BOT })
    assert.deepEqual(chatPlace({ kind: 'group', id: GROUP, title: 'x', workspaceId: 'w' }), { section: 'group', group: GROUP })
  })
})
