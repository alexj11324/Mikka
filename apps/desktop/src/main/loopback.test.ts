import test from 'node:test'
import assert from 'node:assert/strict'

import { startLoopbackAuth } from './loopback'

const APP = 'https://app.aspectlylabs.com/mikka'
const state = 'b'.repeat(32)
const code = 'a'.repeat(32)

test('the loopback listener hands back the in-app finish URL', async () => {
  let finish: string | null = null
  const listener = await startLoopbackAuth({ state, appUrl: APP, onFinish: url => { finish = url } })
  const response = await fetch(`${listener.callback}?${new URLSearchParams({ code, state, next: '/settings' })}`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '<!doctype html><meta charset="utf-8"><title>Returning to Mikka</title><p>Returning to Mikka…</p>')
  assert.ok(finish)
  const url = new URL(finish)
  assert.equal(url.pathname, '/mikka/api/desktop/finish')
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('state'), state)
})

test('a callback with the wrong nonce never reaches the finish page', async () => {
  let finish: string | null = null
  const listener = await startLoopbackAuth({ state, appUrl: APP, onFinish: url => { finish = url } })
  const response = await fetch(`${listener.callback}?${new URLSearchParams({ code, state: 'c'.repeat(32), next: '/' })}`)
  assert.equal(response.status, 400)
  assert.equal(finish, null)
})
