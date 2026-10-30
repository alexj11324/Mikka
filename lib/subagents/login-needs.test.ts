import assert from 'node:assert/strict'
import test from 'node:test'
import { withBasePath } from '@/lib/base-path'
import { applySubagentUpdate, loginNeeds, siteOrigin, type SubagentUpdate } from './login-needs'

const BOT = '00000000-0000-4000-8000-0000000000b0'
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000a2'
const update = (over: Partial<SubagentUpdate>): SubagentUpdate => ({ botId: BOT, subagentId: A, task: 'Check billing', state: 'needs_you', step: 'Sign in', needs: { kind: 'login', site: 'dash.cloudflare.com' }, ...over })

test('site becomes an https origin and a display name', () => {
  assert.deepEqual(siteOrigin('dash.cloudflare.com'), { origin: 'https://dash.cloudflare.com', name: 'dash.cloudflare.com' })
  assert.deepEqual(siteOrigin('https://www.github.com/login'), { origin: 'https://www.github.com', name: 'github.com' })
  assert.equal(siteOrigin('javascript:alert(1)'), null)
  assert.equal(siteOrigin('file:///etc/passwd'), null)
  assert.equal(siteOrigin('not a host'), null)
})

test('only the latest needs_you + login update of this bot shows a card', () => {
  let state = applySubagentUpdate(new Map(), update({}))
  assert.deepEqual(loginNeeds(state, BOT), [{ subagentId: A, botId: BOT, origin: 'https://dash.cloudflare.com', name: 'dash.cloudflare.com', prefix: withBasePath(`/api/bots/${BOT}/subagents/${A}/credentials`) }])
  state = applySubagentUpdate(state, update({ subagentId: B, needs: { kind: 'code', site: 'github.com' } }))
  state = applySubagentUpdate(state, update({ subagentId: 'x', botId: '00000000-0000-4000-8000-0000000000ff' }))
  assert.equal(loginNeeds(state, BOT).length, 1, 'code needs and other bots are ignored')
  state = applySubagentUpdate(state, update({ state: 'running', step: 'Signing in', needs: null }))
  assert.deepEqual(loginNeeds(state, BOT), [], 'a later update clears the card')
})

test('a login need while the sub-agent is still running is not a card', () => {
  const state = applySubagentUpdate(new Map(), update({ state: 'running', needs: { kind: 'login', site: 'dash.cloudflare.com' } }))
  assert.deepEqual(loginNeeds(state, BOT), [])
})

test('the same update delivered twice (SSE replay) still shows one card', () => {
  let state = applySubagentUpdate(new Map(), update({}))
  state = applySubagentUpdate(state, update({}))
  assert.equal(loginNeeds(state, BOT).length, 1)
})
