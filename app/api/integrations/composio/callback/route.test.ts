import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

let followUpResult = true
let listFails = false
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { exports })
mock.module('next/server', { exports: { NextRequest, NextResponse, after: () => {} } })
stub('../../../../../lib/request-log.ts', { noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler })
stub('../../../../../lib/auth.ts', { auth: { api: { getSession: async () => ({ user: { id: 'synthetic-user' } }) } }, authBaseURL: 'https://example.test' })
stub('../../../../../lib/composio.ts', { getComposio: () => ({ connectedAccounts: { completeAuth: async () => ({ connectedAccountId: 'new' }), list: async () => ({ items: [] }) } }), readComposioAccountEmail: () => {}, renameComposioAccount: () => {}, retireComposioAccount: () => {} })
stub('../../../../../lib/composio-account-store.ts', { chooseComposioDefault: () => {}, listComposioAccountRecords: async () => [], noteComposioEmailAttempt: () => {}, saveComposioAccountEmail: () => {} })
stub('../../../../../lib/composio-connect.ts', { followUpComposioConnect: async () => followUpResult })
stub('../../../../../lib/composio-pagination.ts', { listComposioPages: async () => { if (listFails) throw new Error('unavailable'); return [] } })
stub('../../../../../lib/composio-config.ts', { isComposioCallbackVerifierConfigured: () => true })
stub('../../../../../lib/suggestions/sources.ts', { bootstrapSuggestions: () => {} })
let GET: typeof import('./route').GET
before(async () => { GET = (await import('./route')).GET })
function request() {
  const flow = Buffer.from(JSON.stringify({ link: 'new', replace: 'old', returnTo: '/?settings=integrations' })).toString('base64url')
  return new NextRequest('https://example.test/api/integrations/composio/callback?session_uri=synthetic', { headers: { cookie: `mikka_composio_flow=${flow}` } })
}
test('reconnect redirects to failure if follow-up fails or the account list cannot be read', async () => {
  followUpResult = false; listFails = false
  let response = await GET(request())
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('composio'), 'callback-failed')
  followUpResult = true; listFails = true
  response = await GET(request())
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('composio'), 'callback-failed')
  listFails = false
  response = await GET(request())
  assert.equal(new URL(response.headers.get('location')!).searchParams.get('composio'), 'connected')
})
