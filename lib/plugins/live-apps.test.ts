// No hard-coded app list decides which Composio apps can be listed, connected, governed or have an
// identity: each of these takes any toolkit Composio lists and keeps per-app code as an optional extra.
import assert from 'node:assert/strict'
import test from 'node:test'
import { suggestedConnectApps, storeSections, type StoreApp } from './catalog'
import { policyRows, setAppPolicyInput } from '@/lib/app-policy/apps'
import { isComposioToolkitSlug, providerIdentity } from '@/lib/composio-accounts'

const app = (id: string, connect: StoreApp['connect'] = 'managed'): StoreApp => ({ id, name: id, description: '', iconUrl: null, categories: [], createdAt: null, connect })

test('onboarding offers Composio’s most used one-click apps, then any the person already connected', () => {
  const catalog = storeSections([app('composio', 'none'), app('hubspot'), app('airtable', 'credentials'), app('googlesheets'), app('salesforce'), app('zendesk'), app('jira')])
  assert.deepEqual(suggestedConnectApps(catalog, 3).map(item => item.id), ['hubspot', 'googlesheets', 'salesforce'])
  // Already connected apps outside the first few stay listed with their ✓.
  assert.deepEqual(suggestedConnectApps(catalog, 3, ['jira', 'hubspot', 'missing']).map(item => item.id), ['hubspot', 'googlesheets', 'salesforce', 'jira'])
  assert.deepEqual(suggestedConnectApps(undefined, 3), [])
})

test('the workspace app policy lists and accepts any Composio toolkit, never Mikka’s own integrations', () => {
  const stored = new Map([['hubspot', 'deny' as const], ['github', 'deny' as const]])
  assert.deepEqual(policyRows(stored, ['zendesk', 'hubspot', 'linear', 'BAD SLUG', 'gmail']), [
    { app: 'gmail', access: 'allow' }, { app: 'hubspot', access: 'deny' }, { app: 'zendesk', access: 'allow' },
  ])
  assert.ok(setAppPolicyInput.safeParse({ app: 'salesforce', access: 'deny' }).success)
  assert.ok(setAppPolicyInput.safeParse({ app: 'googledrive', access: 'allow' }).success)
  for (const app of ['github', 'linear', 'telegram', 'Gmail', '']) assert.equal(setAppPolicyInput.safeParse({ app, access: 'deny' }).success, false, app)
})

test('an identity lookup is an optional extra: any other toolkit has none and is still a Composio toolkit', () => {
  assert.ok(providerIdentity('gmail'))
  assert.equal(providerIdentity('hubspot'), null)
  assert.equal(providerIdentity('constructor'), null)
  assert.equal(isComposioToolkitSlug('hubspot'), true)
  assert.equal(isComposioToolkitSlug('github'), false)
  assert.equal(isComposioToolkitSlug('BAD SLUG'), false)
})
