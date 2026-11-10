import assert from 'node:assert/strict'
import test from 'node:test'
import { githubCallAllowed } from './github-call-policy'

const policy = (agent: unknown, workspace: unknown) => async () => ({ agent, workspace })

test('an explicit deny in either layer blocks github_call; ask stays callable because there is no card', async () => {
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy({ github: 'deny' }, {}) }), false)
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy({}, { github: 'deny' }) }), false)
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy({ github: 'allow' }, { github: 'deny' }) }), false)
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy({ github: 'ask' }, {}) }), true)
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy({ github: 'allow' }, {}) }), true)
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy(null, null) }), true)
  assert.equal(await githubCallAllowed('owner', null, { layers: async () => null }), true)
})

test('a deny on the app key or the legacy write key blocks the same app', async () => {
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy({}, { github: 'deny' }) }), false)
  // Other apps' settings do not govern GitHub.
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy({ slack: 'deny' }, { notion: 'deny' }) }), true)
})

test('an unreadable policy fails closed instead of turning a deny into an allow', async () => {
  const databaseError = async () => { throw new Error('connection terminated') }
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: databaseError }), false)
  // A malformed stored layer throws in explicitSetting; that must not become an allow.
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy({ github: 'maybe' }, {}) }), false)
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy({}, { github: 'maybe' }) }), false)
  assert.equal(await githubCallAllowed('owner', 'bot', { layers: policy({ github: ['deny'] }, {}) }), false)
})

test('the gate reads the caller’s own layer row for the named Bot', async () => {
  const calls: { userId: string; botId: string | null }[] = []
  await githubCallAllowed('owner', 'bot-1', { layers: async (userId, botId) => { calls.push({ userId, botId }); return { agent: {}, workspace: {} } } })
  assert.deepEqual(calls, [{ userId: 'owner', botId: 'bot-1' }])
})
