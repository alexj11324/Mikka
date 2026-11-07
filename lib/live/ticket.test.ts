import assert from 'node:assert/strict'
import test, { before, after, mock } from 'node:test'
import { liveChannelId, liveTicket } from './scope'
import { deviceGatewayTicketValid } from '../device-gateway-ticket'
import { readSessionLiveTicket } from './session-ticket'

const workspace = '19df8afd-0f8c-4c6b-bc9c-20df0b046a72'
const second = 'e4ec7f73-0a59-4ad4-8b3c-41f8cd510c6d'
const secret = 'local-browser-ticket-test-secret'
let owner: string | null = null
const memberships = new Set<string>()
const personalHomes = new Set<string>()
const membershipReads: unknown[][] = []
let sessionHeaders: Headers | undefined
let route: typeof import('../../app/api/live/ticket/route')
const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }

before(async () => {
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.test'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = secret
  mock.module(new URL('../api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async (input: { headers: Headers; query: { disableCookieCache: boolean } }) => {
    assert.equal(input.query.disableCookieCache, true)
    sessionHeaders = input.headers
    return owner ? { user: { id: owner }, session: { id: `session-${owner}` } } : null
  } } } } })
  // Route/codec fixture only. The real membership, SSO and revocation barriers
  // are exercised without authorization mocks in live-authority.db.test.ts.
  mock.module(new URL('../task-workspace.ts', import.meta.url).href, { namedExports: { activeTaskWorkspaces: async (reader: { id: string }, workspaceId: string) => {
    membershipReads.push([workspaceId, reader.id])
    const key = `${reader.id}:${workspaceId}`
    return memberships.has(key) ? [{ id: workspaceId, kind: personalHomes.has(key) ? 'personal' : 'team' }] : []
  } } })
  mock.module(new URL('../enterprise/live-authority.ts', import.meta.url).href, { namedExports: { workspaceLiveTicket: async (
    scope: { ownerId: string; workspaceId: string }, sessionId: string, config: Parameters<typeof liveTicket>[1],
  ) => ({ status: 'allowed', ticket: liveTicket(scope, config, Date.now(), sessionId) }) } })
  mock.module(new URL('../request-log.ts', import.meta.url).href, { namedExports: { noteLogRpcAction: () => {}, withRequestLog: (_name: string, handler: (request: Request) => Promise<Response>) => handler } })
  route = await import('../../app/api/live/ticket/route')
})

after(() => {
  if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
  if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
})

const request = (id = workspace, headers: Record<string, string> = {}) => route.GET(new Request(`https://app.test/mikka/api/live/ticket?workspace=${id}&ownerId=someone-else`, { headers }))

test('the real ticket route requires a browser session before reading membership', async () => {
  owner = null
  assert.equal((await request()).status, 401)
  owner = 'owner'
  assert.equal((await request(workspace, { authorization: 'Bearer synthetic-api-token' })).status, 401)
  assert.deepEqual(membershipReads, [])
})

test('unauthorized, suspended and malformed workspace selections cannot mint a ticket', async () => {
  owner = 'owner'; memberships.clear()
  assert.equal((await request()).status, 403)
  assert.equal((await request('invalid')).status, 403)
  memberships.add(`owner:${workspace}`)
  assert.equal((await request()).status, 200)
  memberships.delete(`owner:${workspace}`)
  assert.equal((await request()).status, 403)
})

test('the route signs the session owner and exact authorized workspace, ignoring a caller-supplied owner', async () => {
  owner = 'owner'; memberships.add(`owner:${workspace}`); memberships.add(`owner:${second}`)
  const response = await request()
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const ticket = await response.json()
  const channel = liveChannelId({ ownerId: 'owner', workspaceId: workspace })
  assert.equal(deviceGatewayTicketValid(`live:${channel}`, ticket.protocol, secret), true)
  assert.equal(ticket.url, `wss://gateway.test/v1/live/${channel}/socket`)
  assert.equal(deviceGatewayTicketValid(`live:${liveChannelId({ ownerId: 'someone-else', workspaceId: workspace })}`, ticket.protocol, secret), false)
  const other = await (await request(second)).json()
  assert.notEqual(ticket.url, other.url)
  assert.equal(deviceGatewayTicketValid(`live:${channel}`, other.protocol, secret), false)
})

test('native session bearer uses the same membership boundary without trusting accompanying cookies', async () => {
  owner = 'native-owner'; memberships.add(`native-owner:${workspace}`)
  const authorization = `Bearer ${'n'.repeat(32)}`
  const response = await request(workspace, { authorization, cookie: 'other-account=ignored' })
  assert.equal(response.status, 200)
  assert.equal(sessionHeaders?.get('authorization'), authorization)
  assert.equal(sessionHeaders?.has('cookie'), false)
  const ticket = await response.json()
  assert.equal(deviceGatewayTicketValid(`live:${liveChannelId({ ownerId: 'native-owner', workspaceId: workspace })}`, ticket.protocol, secret), true)
  memberships.delete(`native-owner:${workspace}`)
  assert.equal((await request(workspace, { authorization })).status, 403)
  owner = null
  assert.equal((await request(workspace, { authorization })).status, 401)
})

test('only the actual personal home receives a bounded routing proof from the selected workspace', async () => {
  owner = 'scope-owner'; memberships.add(`${owner}:${workspace}`); memberships.add(`${owner}:${second}`)
  personalHomes.add(`${owner}:${workspace}`)
  const before = membershipReads.length
  const home = await (await request()).json()
  assert.ok(home.homeScope)
  assert.equal(home.homeScope.ownerId, owner)
  assert.equal(home.homeScope.workspaceId, workspace)
  assert.equal(home.homeScope.expiresAt, home.expiresAt)
  assert.match(home.homeScope.token, /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/)
  assert.equal(membershipReads.length, before + 1)
  const team = await (await request(second)).json()
  assert.equal(typeof team.protocol, 'string')
  assert.equal(team.homeScope, undefined)
  assert.equal(membershipReads.length, before + 2)
})

test('built-in tickets bind the freshly authenticated session while the public response stays opaque', async () => {
  const keys = ['DEVICE_GATEWAY_URL', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'MIKKA_EDITION', 'VERCEL'] as const
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    delete process.env.DEVICE_GATEWAY_URL
    delete process.env.VERCEL
    process.env.BETTER_AUTH_URL = 'https://self.test'
    process.env.BETTER_AUTH_SECRET = 'isolated-session-ticket-secret'
    process.env.MIKKA_EDITION = 'community'
    owner = 'bound-owner'; memberships.add(`${owner}:${workspace}`)
    const response = await request()
    assert.equal(response.status, 200)
    const issued = await response.json()
    const channel = liveChannelId({ ownerId: owner, workspaceId: workspace })
    const claims = readSessionLiveTicket(channel, issued.protocol, secret)
    assert.equal(claims?.sessionId, `session-${owner}`)
    assert.equal(claims?.expiresAt, issued.expiresAt)
    assert.equal(issued.url, `wss://self.test/mikka/v1/live/${channel}/socket`)
    assert.equal('sessionId' in issued, false)
    assert.equal(deviceGatewayTicketValid(`live:${channel}`, issued.protocol, secret), false)
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})
