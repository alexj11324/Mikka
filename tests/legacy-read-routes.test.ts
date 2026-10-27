import assert from 'node:assert/strict'
import test, { before, beforeEach, mock } from 'node:test'
import { agentImageQuery } from '../lib/agent-images'
import { hashUserId } from '../lib/request-log'

// Real GET handlers and request-log wrapper; only auth, image transport and the
// history reader are replaced. No database, network, model or credentials used.
let user: string | null = null
let historyError: Error | null = null
let imageError = false
const images: { query: string; signal?: AbortSignal }[] = []
const histories: unknown[][] = []
const logs: string[] = []
const history = { sessions: [], sessionId: null, turns: [] }
const image = { src: 'https://upload.wikimedia.org/fixture.jpg', width: 500, height: 300, title: 'Fixture', source: 'https://commons.wikimedia.org/wiki/File:Fixture.jpg', author: 'Fixture', license: 'CC0' }
class StoreError extends Error { constructor(message: string, public status: number) { super(message) } }
let imageGET: typeof import('../app/api/agent/images/route').GET
let historyGET: typeof import('../app/api/agent/sessions/route').GET

before(async () => {
  mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async () => user ? { user: { id: user } } : null } } } })
  mock.module(new URL('../lib/agent-images.ts', import.meta.url).href, { namedExports: {
    agentImageQuery,
    findAgentImage: async (query: string, signal?: AbortSignal) => {
      images.push({ query, signal })
      if (imageError) throw new Error('private image upstream')
      return image
    },
  } })
  mock.module(new URL('../lib/agent-store.ts', import.meta.url).href, { namedExports: {
    AgentStoreError: StoreError,
    getAgentHistory: async (...args: unknown[]) => {
      histories.push(args)
      if (historyError) throw historyError
      return history
    },
  } })
  for (const method of ['log', 'warn', 'error'] as const) mock.method(console, method, (line: string) => { logs.push(line) })
  imageGET = (await import('../app/api/agent/images/route')).GET
  historyGET = (await import('../app/api/agent/sessions/route')).GET
})

beforeEach(() => {
  user = null; imageError = false; historyError = null
  images.length = 0; histories.length = 0; logs.length = 0
})

function logged(response: Response, route: string) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const entry = JSON.parse(logs.at(-1)!)
  assert.equal(entry.route, route)
  assert.equal(entry.method, 'GET')
  assert.equal(entry.status, response.status)
  assert.equal(entry.userIdHash, user ? hashUserId(user) : null)
  assert.doesNotMatch(logs.at(-1)!, /private-|raw-user|cookie-secret|Fixture|q=/)
}

test('both retained GET routes reject anonymous reads without reaching a transport or reader', async () => {
  for (const [handler, path] of [[imageGET, '/api/agent/images'], [historyGET, '/api/agent/sessions']] as const) {
    const response = await handler(new Request(`https://mikka.test${path}?token=private-token`, { headers: { cookie: 'cookie-secret' } }))
    assert.equal(response.status, 401)
    logged(response, path)
  }
  assert.deepEqual(images, [])
  assert.deepEqual(histories, [])
})

test('cross-site image reads stop before auth; invalid keywords never call the image transport', async () => {
  const blocked = await imageGET(new Request('https://mikka.test/api/agent/images?q=Fixture', { headers: { 'sec-fetch-site': 'cross-site' } }))
  assert.equal(blocked.status, 403)
  logged(blocked, '/api/agent/images')
  user = 'raw-user'
  const invalid = await imageGET(new Request('https://mikka.test/api/agent/images?q=https://private.invalid'))
  assert.equal(invalid.status, 400)
  logged(invalid, '/api/agent/images')
  assert.deepEqual(images, [])
})

test('image GET preserves source metadata, normalized keywords, cancellation signal and safe logging', async () => {
  user = 'raw-user'
  const request = new Request('https://mikka.test/api/agent/images?q=%20Public%20Fixture%20')
  const response = await imageGET(request)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { image })
  assert.deepEqual(images, [{ query: 'Public Fixture', signal: request.signal }])
  logged(response, '/api/agent/images')
})

test('image transport failures are private 502 responses without upstream detail', async () => {
  user = 'raw-user'; imageError = true
  const response = await imageGET(new Request('https://mikka.test/api/agent/images?q=Fixture'))
  assert.equal(response.status, 502)
  assert.doesNotMatch(await response.text(), /private image upstream/)
  logged(response, '/api/agent/images')
})

test('history GET passes only the authenticated owner, validated saved ID and read mode to the reader', async () => {
  user = 'raw-user'
  const id = '11111111-1111-4111-8111-111111111111'
  const response = await historyGET(new Request(`https://mikka.test/api/agent/sessions?sessionId=${id}&userId=other`))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), history)
  assert.deepEqual(histories, [[user, id, false]])
  logged(response, '/api/agent/sessions')
  await historyGET(new Request('https://mikka.test/api/agent/sessions?new=1'))
  assert.deepEqual(histories[1], [user, undefined, true])
})

test('invalid history IDs stop before the reader; reader not-found and failures retain 404/503', async () => {
  user = 'raw-user'
  const invalid = await historyGET(new Request('https://mikka.test/api/agent/sessions?sessionId=private-invalid'))
  assert.equal(invalid.status, 400)
  assert.deepEqual(histories, [])
  logged(invalid, '/api/agent/sessions')
  historyError = new StoreError('not found', 404)
  const missing = await historyGET(new Request('https://mikka.test/api/agent/sessions'))
  assert.equal(missing.status, 404)
  logged(missing, '/api/agent/sessions')
  historyError = new Error('private database detail')
  const unavailable = await historyGET(new Request('https://mikka.test/api/agent/sessions'))
  assert.equal(unavailable.status, 503)
  assert.doesNotMatch(await unavailable.text(), /private database detail/)
  logged(unavailable, '/api/agent/sessions')
})
