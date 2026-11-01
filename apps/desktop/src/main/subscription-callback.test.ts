import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { catchClaudeCallback, claudeAuthorizationState } from './subscription-callback'

const state = 'a'.repeat(43)
const page = (value = state) => `https://claude.ai/oauth/authorize?code=true&redirect_uri=${encodeURIComponent('http://localhost:54545/callback')}&state=${value}`
const hit = (query: string) => fetch(`http://localhost:54545/callback?${query}`)

test('only a Claude page returning to the registered callback is accepted', () => {
  assert.equal(claudeAuthorizationState(page()), state)
  for (const bad of [undefined, 'nope', page().replace('claude.ai', 'evil.test'), page().replace('54545', '1'), page('short')]) assert.equal(claudeAuthorizationState(bad), null)
})

test('catches the return, opens the browser once, and frees the port', async () => {
  const opened: string[] = []
  const caught = catchClaudeCallback(page(), async url => { opened.push(url); assert.equal((await hit('code=c&state=wrong')).status, 404); assert.equal((await hit(`code=the-code&state=${state}`)).status, 200) })
  assert.equal(await caught, `http://localhost:54545/callback?code=the-code&state=${state}`)
  assert.deepEqual(opened, [page()])
  const again = createServer()
  await new Promise<void>((resolve, reject) => { again.once('error', reject); again.listen(54545, 'localhost', () => resolve()) })
  await new Promise(resolve => again.close(resolve))
})

test('a declined sign-in, a newer attempt and a timeout resolve null', async () => {
  assert.equal(await catchClaudeCallback(page(), async () => { await hit(`error=access_denied&state=${state}`) }), null)
  const first = catchClaudeCallback(page(), async () => undefined)
  await new Promise(resolve => setTimeout(resolve, 50))
  const second = catchClaudeCallback(page('b'.repeat(43)), async () => undefined, 20)
  assert.equal(await first, null)
  assert.equal(await second, null)
})

test('a taken port rejects so the page can offer the paste', async () => {
  const taken = createServer()
  await new Promise<void>(resolve => taken.listen(54545, 'localhost', () => resolve()))
  try { await assert.rejects(catchClaudeCallback(page(), async () => assert.fail('must not open'))) } finally { await new Promise(resolve => taken.close(resolve)) }
})
