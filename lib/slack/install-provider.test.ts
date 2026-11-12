import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import {
  authorizeSlack,
  installPlatform,
  redeemSlackCode,
  rotateSlack,
  slackChannels,
  SLACK_SCOPES,
  uninstallSlack,
} from './install-provider'
import { slackGrantProof, validSlackGrantProof } from './grant-proof'
import { signedCoordinates, signedRevocation } from './installed-routing'

test('OAuth and channel visibility use fixed Slack methods with the proper identity at a real HTTP boundary', async (t) => {
  const secret = randomBytes(32).toString('hex'),
    token = randomBytes(24).toString('hex')
  const platform = installPlatform({
    SLACK_APP_ID: 'AAPP',
    SLACK_CLIENT_ID: '56.123',
    SLACK_CLIENT_SECRET: secret,
    BETTER_AUTH_URL: 'https://example.test',
  })!
  const url = new URL(authorizeSlack(platform, 'single-use-state'))
  assert.deepEqual(
    [url.origin, url.pathname, url.searchParams.get('state')],
    ['https://slack.com', '/oauth/v2/authorize', 'single-use-state'],
  )
  assert.ok(!url.href.includes(secret))
  let wrongTeam = false
  const requests: string[] = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const fields = new URLSearchParams(raw),
      op = req.url!.split('/').at(-1)
    requests.push(String(op))
    let data: Record<string, unknown> = { ok: false }
    if (
      op === 'oauth.v2.access' &&
      req.headers.authorization === 'Basic ' + Buffer.from(platform.clientId + ':' + secret).toString('base64')
    ) {
      data = {
        ok: true,
        app_id: 'AAPP',
        team: { id: 'TTEAM', name: 'Team' },
        authed_user: { id: 'UA' },
        bot_user_id: 'UBOT',
        token_type: 'bot',
        scope: SLACK_SCOPES.join(','),
        access_token: token,
        ...(fields.get('grant_type') === 'refresh_token' ? { expires_in: 43200, refresh_token: 'test-next' } : {}),
      }
    } else if (req.headers.authorization === 'Bearer ' + token) {
      if (op === 'auth.test')
        data = { ok: true, team_id: wrongTeam ? 'TWRONG' : 'TTEAM', user_id: 'UBOT', bot_id: 'BBOT' }
      if (op === 'apps.uninstall') data = { ok: fields.get('client_secret') === secret }
      if (op === 'users.conversations') {
        const user = fields.get('user')
        const ids = user === 'UA' ? ['CBOTH', 'CHUMAN'] : ['CBOTH', 'CBOT', 'CEXTERNAL']
        data = {
          ok: true,
          channels: ids.map((id) => ({ id, name: id, is_ext_shared: id === 'CEXTERNAL' })),
          response_metadata: { next_cursor: '' },
        }
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const addr = server.address()
  assert.ok(addr && typeof addr !== 'string')
  const send: typeof fetch = async (input, options) => {
    const target = new URL(String(input))
    assert.equal(target.origin, 'https://slack.com')
    assert.equal(options?.redirect, 'error')
    return fetch('http://127.0.0.1:' + addr.port + target.pathname, options)
  }
  const grant = await redeemSlackCode(platform, 'test-code', send)
  assert.equal(grant.slackUserId, 'UA')
  assert.equal(grant.credential.token, token)
  assert.deepEqual(await slackChannels(token, grant.slackUserId, send), [{ id: 'CBOTH', name: 'CBOTH' }])
  const refreshed = await rotateSlack(platform, 'test-rotating', 'TTEAM', 'UBOT', send)
  assert.ok(refreshed.expires && refreshed.expires > Date.now())
  assert.equal(refreshed.refresh, 'test-next')
  assert.equal(await uninstallSlack(platform, token, send), true)
  wrongTeam = true
  await assert.rejects(redeemSlackCode(platform, 'test-code', send), /slackInstallNotAuthorized/)
  assert.ok(requests.includes('auth.test') && requests.includes('apps.uninstall'))
})

test('separate credential proof cannot be reused with changed sender, installation, team or Eve authorization', () => {
  const previous = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex')
  try {
    const grant = { installationId: randomUUID(), teamId: 'TTEAM', slackUserId: 'UMEMBER' },
      auth = 'Bearer ' + randomBytes(32).toString('base64url')
    const proof = slackGrantProof(auth, grant)
    assert.ok(validSlackGrantProof(auth, grant, proof))
    assert.equal(validSlackGrantProof(auth, grant, null), false)
    for (const patch of [{ installationId: randomUUID() }, { teamId: 'TOTHER' }, { slackUserId: 'UOTHER' }])
      assert.equal(validSlackGrantProof(auth, { ...grant, ...patch }, proof), false)
    assert.equal(validSlackGrantProof(auth + 'x', grant, proof), false)
  } finally {
    if (previous === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = previous
  }
})

test('signed workspace/installation boundaries and provider uninstall scope', () => {
  const p = {
    type: 'event_callback',
    api_app_id: 'AAPP',
    team_id: 'TTEAM',
    event_id: 'Ev01',
    event: { type: 'message', channel: 'CONE', text: 'hello', user: 'UA' },
  }
  assert.equal(signedCoordinates('AAPP', p)?.sender, 'UA')
  for (const patch of [
    { api_app_id: 'AOTHER' },
    { is_ext_shared_channel: true },
    { authorizations: [{ is_bot: true, team_id: 'TOTHER' }] },
    { event: { ...p.event, user_team: 'TOTHER' } },
  ])
    assert.equal(signedCoordinates('AAPP', { ...p, ...patch }), null)
  const revoke = { ...p, event_time: 1870000000, event: { type: 'tokens_revoked', tokens: { bot: ['UBOT'] } } }
  assert.deepEqual(signedRevocation('AAPP', revoke), { team: 'TTEAM', bots: ['UBOT'], eventAt: revoke.event_time })
  assert.equal(signedRevocation('AOTHER', revoke), null)
})
