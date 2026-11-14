import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createHmac } from 'node:crypto'
import { createMikkaSlackChannel } from '../lib/slack/eve-channel.ts'

const env = {
  SLACK_SIGNING_SECRET: 'test-only-signing-secret',
  SLACK_APP_ID: 'A123',
}
const workspaceId = '00000000-0000-4000-8000-000000000001'
const linkId = '00000000-0000-4000-8000-000000000007'
const installationId = '00000000-0000-4000-8000-000000000004'
const botId = '00000000-0000-4000-8000-000000000002'
const event = (id, text, patch = {}) => ({
  type: 'event_callback', api_app_id: 'A123', team_id: 'T123', event_id: `Ev${id}`,
  authorizations: [{ team_id: 'T123', user_id: 'U123', is_bot: true }],
  event: { type: 'message', channel: 'C123', channel_type: 'channel', user: 'U456', text,
    ts: `1700000000.00000${id}`, ...patch },
})
function signed(payload, interaction = false) {
  const json = JSON.stringify(payload)
  const body = interaction ? new URLSearchParams({ payload: json }).toString() : json
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = 'v0=' + createHmac('sha256', env.SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')
  return new Request('http://localhost/eve/v1/slack', { method: 'POST', body, headers: {
    'content-type': interaction ? 'application/x-www-form-urlencoded' : 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature,
  } })
}
function harness({ respond = false, failure = false, channelEnv = env } = {}) {
  const sends = [], classifications = [], scopes = [], api = [], addresses = [], tasks = []
  const channel = createMikkaSlackChannel({
    env: () => channelEnv,
    binding: async (app, team, sender) => app==='A123' && team==='T123' && ['U456','U789'].includes(sender)
      ? { installationId, linkId, ownerId:sender==='U456'?'owner-a':'owner-b',workspaceId,teamId:team,slackUserId:sender,botUserId:'U123',watched:['C123'] } : null,
    token: async scope => { assert.equal(scope.installationId,installationId); return 'unit-only-bot-token' },
    resolveScope: async (ownerId, selected) => { scopes.push([ownerId, selected]); return { ownerId, botId, workspaceId } },
    shouldJoin: async (scope, text) => { classifications.push([scope, text]); if (failure) throw new Error('provider unavailable'); return respond },
    recordSource: async () => '00000000-0000-4000-8000-000000000003',
    api: { fetch: async (input) => {
      const operation = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
      api.push(operation)
      return Response.json({ ok: true, user_id: 'U123', team_id: 'T123', bot_id: 'B123',
        user: { id: 'U456', is_bot: false, real_name: 'Test member' },
        channel: { id: 'C123', is_private: false }, messages: [], ts: '1700000001.000001' })
    } },
  })
  const route = channel.routes.find(route => route.transport !== 'websocket' && route.method === 'POST')
  assert.ok(route)
  const args = {
    from(address) {
      addresses.push(address)
      return {
        async send(message, options) { sends.push({ address, message, options }); return { sessionId: 'wrun_test', deliveryId: 'delivery_test', result: async () => ({ outcome: 'completed' }) } },
      }
    },
    resolveSession: async () => undefined,
    waitUntil: task => tasks.push(task), params: {}, requestIp: '127.0.0.1',
  }
  return { sends, classifications, scopes, api, addresses, async post(payload, interaction = false) {
    const response = await route.handler(signed(payload, interaction), args)
    await Promise.all(tasks.splice(0))
    return response
  }, route, args }
}

test('signed URL verification does no DB, model or Slack API work', async () => {
  const h = harness()
  const response = await h.post({ type: 'url_verification', challenge: 'test-challenge' })
  assert.deepEqual(await response.json(), { challenge: 'test-challenge' })
  assert.deepEqual([h.scopes, h.api, h.classifications, h.sends], [[], [], [], []])
})

test('an app can verify its URL before a team installs the bot', async () => {
  const h = harness({ channelEnv: { SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET } })
  const challenge = { type: 'url_verification', challenge: 'before-installation' }
  const response = await h.post(challenge)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { challenge: challenge.challenge })
  const tampered = signed(challenge)
  tampered.headers.set('x-slack-signature', 'v0=' + '0'.repeat(64))
  assert.equal((await h.route.handler(tampered, h.args)).status, 401)
  assert.equal((await h.post(event('1', 'help'))).status, 503)
  assert.equal((await harness({ channelEnv: {} }).post(challenge)).status, 503)
  assert.deepEqual([h.scopes, h.api, h.classifications, h.sends], [[], [], [], []])
})

test('wrong signatures and foreign app, team, sender and bot events are rejected before acknowledgement', async () => {
  const h = harness()
  const bad = signed(event('1', 'help'))
  bad.headers.set('x-slack-signature', 'v0=' + '0'.repeat(64))
  assert.equal((await h.route.handler(bad, h.args)).status, 401)
  for (const payload of [
    { ...event('2', 'help'), api_app_id: 'A999' }, { ...event('3', 'help'), team_id: 'T999' },
    event('4', 'help', { user: 'U999' }), event('5', 'help', { bot_id: 'B999' }),
    event('6', 'help', { subtype: 'bot_message' }), event('7', 'help', { user: 'U123' }),
  ]) assert.equal((await h.post(payload)).status, 204)
  assert.deepEqual([h.scopes, h.api, h.classifications, h.sends], [[], [], [], []])
})

test('irrelevant ambient messages stay silent without creating an agent delivery', async () => {
  const h = harness()
  assert.equal((await h.post(event('1', 'Good morning everyone'))).status, 200)
  assert.equal(h.classifications.length, 1)
  assert.equal(h.sends.length, 0)
  assert.equal(h.api.some(path => path.includes('postMessage') || path.includes('setStatus')), false)
})

test('ambient messages outside selected channels are ignored without a decision request', async () => {
  const h = harness({ respond: true })
  await h.post(event('1', 'Please help', { channel: 'C999' }))
  assert.equal(h.classifications.length, 0)
  assert.equal(h.sends.length, 0)
})

test('decision failure remains silent and never falls through to an expensive agent turn', async () => {
  const h = harness({ failure: true })
  await h.post(event('1', 'Please help with the deployment'))
  assert.equal(h.classifications.length, 1)
  assert.equal(h.sends.length, 0)
  assert.equal(h.api.some(path => path.includes('postMessage') || path.includes('setStatus')), false)
})

test('direct mention uses native eve delivery, bounded identity and stable webhook dedupe key', async () => {
  const h = harness()
  const payload = event('1', '<@U123> list my agents', { type: 'app_mention' })
  assert.equal((await h.post(payload)).status, 200)
  assert.equal(h.classifications.length, 0)
  assert.equal(h.sends.length, 1)
  const { options, address } = h.sends[0]
  assert.equal(options.idempotencyKey, 'slack:T123:Ev1')
  assert.equal(options.auth.principalId, 'owner-a')
  assert.deepEqual(options.auth.attributes, { botId, workspaceId, surface: 'slack', slackUserId: 'U456', teamId:'T123',installationId, linkId, sourceEventId: '00000000-0000-4000-8000-000000000003' })
  assert.deepEqual(JSON.parse(address), ['owner-a', workspaceId, linkId, 'C123:1700000000.000001'])
  assert.equal(options.history, undefined)
  await h.post(payload)
  assert.equal(h.sends.length, 1, 'native eve rejects repeated provider event ids')
})

test('relevant ambient input joins only its thread and each bound owner has a distinct session address', async () => {
  const h = harness({ respond: true })
  await h.post(event('1', 'Can someone inspect the failing deployment?', { thread_ts: '1700000000.999999' }))
  await h.post(event('2', 'I can help', { user: 'U789', thread_ts: '1700000000.999999' }))
  assert.equal(h.sends.length, 2)
  assert.equal(h.classifications.length, 2)
  assert.equal(h.sends[0].options.state.quiet, true)
  assert.notEqual(h.sends[0].address, h.sends[1].address)
  assert.equal(JSON.parse(h.sends[0].address)[3], 'C123:1700000000.999999')
  assert.equal(h.sends[1].options.auth.principalId, 'owner-b')
})

test('signed interactions require the current installation and workspace member', async () => {
  const callback = { type: 'block_actions', api_app_id: 'A123', team: { id: 'T123' }, user: { id: 'U456' }, channel: { id: 'C123' }, actions: [] }
  const modal = { ...callback, type: 'view_submission', channel: undefined, view: { private_metadata: JSON.stringify({ channelId: 'C123' }) } }
  for (const payload of [callback, modal]) {
    const allowed = harness()
    await allowed.post(payload, true)
    assert.deepEqual(allowed.scopes, [['owner-a', workspaceId]])
    for (const patch of [{ user: { id: 'U999' } }, { team: { id: 'T999' } }]) {
      const denied = harness()
      assert.equal((await denied.post({ ...payload, ...patch }, true)).status, 204)
      assert.deepEqual([denied.scopes, denied.sends, denied.api], [[], [], []])
    }
  }
})

let decisionAnswer = 'respond'
const decisionCalls = []
mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: { invokeDecision: async (...args) => {
  const { hostedBillingScope } = await import('../lib/abuse/context.ts')
  decisionCalls.push({ args, scope: hostedBillingScope.getStore() })
  return decisionAnswer === null ? null : { answers: new Map([['response', { type: 'choice', choice: decisionAnswer }]]) }
} } })

test('eve decision screening retains the existing model billing and admission boundary', async () => {
  const { shouldJoinSlack } = await import('../lib/slack/eve-ambient.ts')
  const scope = { ownerId: 'owner-a', botId, workspaceId }
  assert.equal(await shouldJoinSlack(scope, 'Can someone investigate CI?'), true)
  assert.equal(decisionCalls.length, 1)
  assert.deepEqual(decisionCalls[0].scope, scope)
  assert.equal(decisionCalls[0].args[0], 'slack-ambient')
  assert.match(decisionCalls[0].args[1], /Can someone investigate CI/)
  assert.deepEqual(decisionCalls[0].args[2][0].choices.map(choice => choice.value), ['ignore', 'respond'])
  decisionAnswer = 'ignore'
  assert.equal(await shouldJoinSlack(scope, 'Good morning'), false)
  decisionAnswer = null
  await assert.rejects(shouldJoinSlack(scope, 'Help'), /decisionProviderUnavailable/)
})
