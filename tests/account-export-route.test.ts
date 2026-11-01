import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

let user: { id: string } | null = { id: 'owner' }, valid = true
const calls: Array<{ kind: string; owner?: string; options?: unknown }> = []
let authority: (() => Promise<void>) | undefined
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../lib/auth.ts', { auth: { api: { getSession: async (options: { headers: Headers }) => {
  calls.push({ kind: 'browser', options })
  return options.headers.get('cookie') === 'browser-fixture' && user ? { user } : null
} } } })
stub('../lib/api-auth.ts', { auth: { api: { getSession: async () => { throw Error('Workspace API token identity cannot authorize a complete account export') } } } })
stub('../lib/account/export.ts', {
  claimExport: async (owner: string) => { calls.push({ kind: 'claim', owner }); return valid },
  buildAccountExport: async (owner: string) => { calls.push({ kind: 'data', owner }); return { format: 'mikka-account-export', version: 1 } },
})
stub('../lib/account/export-files.ts', {
  accountExportFiles: async (owner: string) => { calls.push({ kind: 'files', owner }); return [] },
  accountExportBody: (_data: unknown, _files: unknown, owner: string, options: { assertCurrent: () => Promise<void> }) => {
    calls.push({ kind: 'body', owner }); authority = options.assertCurrent
    return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"format":"mikka-account-export"}')); controller.close() } })
  },
})
let GET: typeof import('../app/api/account/export/[token]/route').GET
before(async () => { GET = (await import('../app/api/account/export/[token]/route')).GET })
function request(browser = true) { return new Request('https://app.example.invalid/mikka/api/account/export/fixture-token', { headers: browser ? { cookie: 'browser-fixture' } : { authorization: 'Bearer mkp_fixture' } }) }
const params = { params: Promise.resolve({ token: 'fixture-token' }) }
function reset() { user = { id: 'owner' }; valid = true; authority = undefined; calls.length = 0 }

test('a workspace API token without a browser session cannot read account-wide data or files', async () => {
  reset()
  assert.equal((await GET(request(false), params)).status, 401)
  assert.deepEqual(calls.map(call => call.kind), ['browser'])
})
test('an expired or foreign export grant refuses before account metadata or object enumeration', async () => {
  reset(); valid = false
  assert.equal((await GET(request(), params)).status, 404)
  assert.deepEqual(calls.map(call => call.kind), ['browser', 'claim'])
})
test('the streamed response retains JSON/download privacy and rechecks live browser and grant authority', async () => {
  reset()
  const response = await GET(request(), params)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.match(response.headers.get('content-disposition')!, /mikka-export-\d{4}-\d{2}-\d{2}\.json/)
  assert.ok(authority)
  await authority()
  const browserCalls = calls.filter(call => call.kind === 'browser')
  for (const call of browserCalls) assert.deepEqual((call.options as { query: unknown }).query, { disableCookieCache: true, disableRefresh: true })
  assert.ok(calls.filter(call => ['data', 'files', 'body', 'claim'].includes(call.kind)).every(call => call.owner === 'owner'))
  valid = false
  await assert.rejects(authority(), /authorization expired/)
  valid = true; user = null
  const before = calls.filter(call => call.kind === 'claim').length
  await assert.rejects(authority(), /authorization expired/)
  assert.equal(calls.filter(call => call.kind === 'claim').length, before, 'revoked session cannot reach grant renewal')
})
