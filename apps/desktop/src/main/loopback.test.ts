import test from 'node:test'
import assert from 'node:assert/strict'

import { loopbackLocale, startLoopbackAuth } from './loopback'

const APP = 'https://app.aspectlylabs.com/mikka'
const state = 'b'.repeat(32)
const code = 'a'.repeat(32)

test('the loopback listener hands back the in-app finish URL', async () => {
  let finish: string | null = null
  const listener = await startLoopbackAuth({ state, appUrl: APP, onFinish: url => { finish = url } })
  const response = await fetch(`${listener.callback}?${new URLSearchParams({ code, state, next: '/settings' })}`, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Mikka</title><p>Returning to Mikka…</p></html>')
  assert.ok(finish)
  const url = new URL(finish)
  assert.equal(url.pathname, '/mikka/api/desktop/finish')
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('state'), state)
})

test('a callback with the wrong nonce never reaches the finish page', async () => {
  let finish: string | null = null
  const listener = await startLoopbackAuth({ state, appUrl: APP, onFinish: url => { finish = url } })
  const response = await fetch(`${listener.callback}?${new URLSearchParams({ code, state: 'c'.repeat(32), next: '/' })}`, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } })
  assert.equal(response.status, 400)
  assert.equal(await response.text(), '登录链接无效或已过期')
  assert.equal(finish, null)
})

test('the return page follows the browser language and defaults to Chinese', async () => {
  assert.equal(loopbackLocale('zh-CN,zh;q=0.9,en;q=0.8'), 'zh-CN')
  assert.equal(loopbackLocale('zh-TW'), 'zh-CN')
  assert.equal(loopbackLocale('en-GB,en;q=0.9'), 'en')
  assert.equal(loopbackLocale('fr-FR,en;q=0.5,zh;q=0.4'), 'en')
  assert.equal(loopbackLocale('en;q=0.2,zh-CN;q=0.8'), 'zh-CN')
  assert.equal(loopbackLocale(undefined), 'zh-CN')
  assert.equal(loopbackLocale('fr'), 'zh-CN')
  let finish: string | null = null
  const listener = await startLoopbackAuth({ state, appUrl: APP, onFinish: url => { finish = url } })
  const response = await fetch(`${listener.callback}?${new URLSearchParams({ code, state, next: '/' })}`, { headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' } })
  assert.equal(await response.text(), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Mikka</title><p>正在返回 Mikka…</p></html>')
  assert.ok(finish)
})
