import test from 'node:test'
import assert from 'node:assert/strict'

import { startReturnListener, type ReturnResult } from './return-listener'

const state = 'r'.repeat(43)

test('the return listener tells the app the result once and shows the browser one line', async () => {
  const results: ReturnResult[] = []
  const listener = await startReturnListener({ state, onReturn: result => { results.push(result) } })
  assert.match(listener.returnTo, /^http:\/\/127\.0\.0\.1:\d+\/return$/)
  const response = await fetch(`${listener.returnTo}?${new URLSearchParams({ state, result: 'connected' })}`, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
  assert.equal(response.status, 200)
  assert.match(await response.text(), /已连接，可以回到 Mikka。/)
  assert.deepEqual(results, ['connected'])
  // One shot: the listener is gone.
  await assert.rejects(fetch(`${listener.returnTo}?${new URLSearchParams({ state, result: 'connected' })}`))
  assert.deepEqual(results, ['connected'])
})

test('a return with another state or result never reaches the app, and the listener keeps waiting', async () => {
  const results: ReturnResult[] = []
  const listener = await startReturnListener({ state, onReturn: result => { results.push(result) } })
  const refused: Record<string, string>[] = [{ state: 's'.repeat(43), result: 'connected' }, { state, result: 'linked' }, { state }]
  for (const query of refused) {
    const response = await fetch(`${listener.returnTo}?${new URLSearchParams(query)}`, { headers: { 'Accept-Language': 'en' } })
    assert.equal(response.status, 400)
    assert.equal(await response.text(), 'This link is invalid or expired')
  }
  assert.equal((await fetch(listener.returnTo.replace('/return', '/other'))).status, 404)
  assert.deepEqual(results, [])
  const cancelled = await fetch(`${listener.returnTo}?${new URLSearchParams({ state, result: 'cancelled' })}`, { headers: { 'Accept-Language': 'en' } })
  assert.match(await cancelled.text(), /Cancelled\. You can return to Mikka\./)
  assert.deepEqual(results, ['cancelled'])
})

test('a state that is not the renderer\'s 43-character nonce is refused before listening', async () => {
  await assert.rejects(startReturnListener({ state: 'short', onReturn: () => {} }))
})
