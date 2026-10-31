import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import { PluginError } from '../../../../lib/plugins/contracts'

// The generic connect flow: any store toolkit with Composio-managed auth can
// be connected per person; anything else is refused before Composio is asked.
const authorized: { user: string; toolkit: string }[] = []
const store = new Set(['gmail', 'hubspot', 'googlesheets'])
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { exports })
mock.module('next/server', { exports: { NextRequest, NextResponse, after: () => {} } })
stub('../../../../lib/request-log.ts', { noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler })
stub('../../../../lib/api-auth.ts', { auth: { api: { getSession: async () => ({ user: { id: 'synthetic-user' } }) } } })
stub('../../../../lib/auth.ts', { authBaseURL: 'https://example.test' })
stub('../../../../lib/composio.ts', {
  getComposio: () => ({ create: async (user: string) => ({ authorize: async (toolkit: string) => { authorized.push({ user, toolkit }); return { id: 'link_1', redirectUrl: 'https://connect.composio.dev/link_1' } } }) }),
  readComposioAccountEmail: () => {}, renameComposioAccount: () => {}, retireComposioAccount: () => {},
})
stub('../../../../lib/composio-account-store.ts', { chooseComposioDefault: () => {}, listComposioAccountRecords: async () => [], noteComposioEmailAttempt: () => {}, saveComposioAccountEmail: () => {} })
stub('../../../../lib/composio-pagination.ts', { listComposioPages: async () => [] })
stub('../../../../lib/composio-config.ts', { isComposioCallbackVerifierConfigured: () => true })
stub('../../../../lib/plugins/catalog.ts', {
  composioToolkitLister: () => async () => ({ items: [] }),
  assertCatalogToolkit: async (_list: unknown, id: string) => { if (!store.has(id)) throw new PluginError('integrationToolkitNotSupported', 400) },
})
let POST: typeof import('./route').POST
before(async () => { POST = (await import('./route')).POST })
const connect = (body: unknown, origin = 'https://example.test') => new Request('https://example.test/api/integrations/composio', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('any store toolkit starts a per-person Composio connect link', async () => {
  authorized.length = 0
  for (const toolkit of ['hubspot', 'googlesheets']) {
    const response = await POST(connect({ toolkit, returnTo: '/plugins' }) as never)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { redirectUrl: 'https://connect.composio.dev/link_1' })
    assert.match(response.headers.get('set-cookie') ?? '', /mikka_composio_flow=/)
  }
  assert.deepEqual(authorized, [{ user: 'synthetic-user', toolkit: 'hubspot' }, { user: 'synthetic-user', toolkit: 'googlesheets' }])
})

test('a toolkit outside the store, a malformed slug or a cross-origin request never reaches Composio', async () => {
  authorized.length = 0
  const outside = await POST(connect({ toolkit: 'needs_own_keys' }) as never)
  assert.equal(outside.status, 400)
  assert.deepEqual(await outside.json(), { error: 'integrationToolkitNotSupported' })
  assert.equal((await POST(connect({ toolkit: 'Not A Slug' }) as never)).status, 400)
  assert.equal((await POST(connect({ toolkit: 'hubspot', userId: 'someone-else' }) as never)).status, 400)
  assert.equal((await POST(connect({ toolkit: 'hubspot' }, 'https://evil.test') as never)).status, 403)
  assert.deepEqual(authorized, [])
})
