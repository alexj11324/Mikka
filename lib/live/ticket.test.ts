import assert from 'node:assert/strict'
import test, { before, after, mock } from 'node:test'
import { liveChannelId } from './scope'
import { deviceGatewayTicketValid } from '../device-gateway-ticket'

const workspace = '19df8afd-0f8c-4c6b-bc9c-20df0b046a72'
const second = 'e4ec7f73-0a59-4ad4-8b3c-41f8cd510c6d'
const secret = 'local-browser-ticket-test-secret'
let owner: string | null = null
const memberships = new Set<string>()
const membershipReads: unknown[][] = []
let route: typeof import('../../app/api/live/ticket/route')
const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }

before(async () => {
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.test'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = secret
  mock.module(new URL('../api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => owner ? { user: { id: owner } } : null } } } })
  mock.module(new URL('../workspace-db.ts', import.meta.url).href, { namedExports: { workspacePool: { query: async (_sql: string, values: unknown[]) => {
    membershipReads.push(values)
    return { rowCount: memberships.has(`${values[1]}:${values[0]}`) ? 1 : 0, rows: [] }
  } } } })
  mock.module(new URL('../request-log.ts', import.meta.url).href, { namedExports: { withRequestLog: (_name: string, handler: (request: Request) => Promise<Response>) => handler } })
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
