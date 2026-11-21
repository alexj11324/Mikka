import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wire } from './composio-wire'
import { toStoreApp } from './catalog'
import { credentialForms } from './connect-kind'

// `@composio/core` returns transformed objects; the wire shape must be
// restored at the boundary (#1920: figma read as "unsupported" because the
// managed-auth flag arrived as `composioManagedAuthSchemes`).

test('wire renames transformed toolkit fields back to the wire shape', () => {
  const page = wire({
    items: [{
      slug: 'figma', name: 'Figma', isLocalToolkit: false, noAuth: false,
      composioManagedAuthSchemes: ['OAUTH2'], authSchemes: ['OAUTH2'],
      meta: { createdAt: '2026-01-01T00:00:00Z', categories: [{ slug: 'design', name: 'Design' }] },
    }],
    nextCursor: 'p2',
  }) as { items: Record<string, unknown>[]; next_cursor?: string }
  assert.equal(page.next_cursor, 'p2')
  const item = page.items[0]
  assert.equal(item.is_local_toolkit, false)
  assert.equal(item.no_auth, false)
  assert.deepEqual(item.composio_managed_auth_schemes, ['OAUTH2'])
})

test('a transformed list item still catalogues as managed with its category and date', () => {
  const app = toStoreApp(wire({
    slug: 'figma', name: 'Figma', isLocalToolkit: false, noAuth: false,
    composioManagedAuthSchemes: ['OAUTH2'], authSchemes: ['OAUTH2'],
    meta: { createdAt: '2026-01-01T00:00:00Z', categories: [{ slug: 'design', name: 'Design' }] },
  }) as Parameters<typeof toStoreApp>[0])
  assert.equal(app.connect, 'managed')
  assert.equal(app.createdAt, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(app.categories, [{ id: 'design', name: 'Design' }])
})

test('transformed auth config details still produce credential forms', () => {
  const forms = credentialForms(wire([{
    mode: 'API_KEY',
    fields: { connectedAccountInitiation: { required: [{ name: 'api_key', displayName: 'API Key', isSecret: true, required: true, type: 'string' }], optional: [] } },
  }]))
  assert.equal(forms.length, 1)
  assert.equal(forms[0].fields[0].secret, true)
})

test('wire leaves the raw wire shape and non-plain objects alone', () => {
  const raw = { slug: 'x', composio_managed_auth_schemes: ['OAUTH2'], meta: { created_at: '2026-01-01' } }
  assert.deepEqual(wire(raw), raw)
  assert.equal(wire(null), null)
  assert.equal(wire(new Date(0)).getTime(), 0)
})
