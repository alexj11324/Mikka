import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, mock, test } from 'node:test'
import { CloudServiceError } from './errors'
import { chatFailure, failureMessageKey } from '../chat-failure'
import { failureLine } from '../coordinator/refusal-line'

const workspace = randomUUID(), expected = `https://cloud.example/mikka/settings?workspace=${workspace}&section=billing`
let url: unknown = expected, connected = true, signedIn = true, reads = 0
const saved = process.env.MIKKA_EDITION
process.env.MIKKA_EDITION = 'community'
after(() => { if (saved === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = saved })
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: {
  cloudClient: { capability: async (user: string, scope: string) => { assert.equal(user, 'local-person'); assert.equal(scope, 'models'); return connected ? { serviceUrl: 'https://cloud.example/mikka/cloud' } : null } },
  cloudRequest: async (user: string, scope: string, path: string) => { reads++; assert.deepEqual([user, scope, path], ['local-person', 'models', '/v1/models/billing']); return Response.json({ url }) },
} })
mock.module(new URL('../server-admin.ts', import.meta.url).href, { namedExports: { readServerSession: async () => signedIn ? { user: { id: 'local-person' }, session: { id: 'fixture-local-session' } } : null } })
mock.module(new URL('../request-log.ts', import.meta.url).href, { namedExports: { withRequestLog: (_name: string, handler: unknown) => handler } })
const { cloudModelBillingUrl } = await import('./model-billing')
const { GET } = await import('../../app/api/cloud/models/billing/route')
const request = (redirect = false) => new Request(`https://self.example/mikka/api/cloud/models/billing${redirect ? '?redirect=1' : ''}`)

test('billing links preserve the cloud-authorized workspace and are read only when requested', async () => {
  assert.equal(reads, 0)
  assert.equal(await cloudModelBillingUrl('local-person'), expected)
  const response = await GET(request())
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { url: expected })
  const navigation = await GET(request(true))
  assert.equal(navigation.status, 303); assert.equal(navigation.headers.get('location'), expected)
  assert.equal(navigation.headers.get('referrer-policy'), 'no-referrer')
})

test('upstream billing redirects cannot change origin, credentials or the selected-workspace contract', async () => {
  for (const invalid of [undefined, 123, 'javascript:alert(1)', expected.replace('cloud.example', 'attacker.example'), expected.replace('https:', 'http:'), expected.replace('https://', 'https://secret@'), expected.replace(workspace, 'not-a-workspace'), `${expected}#untrusted`, expected.replace('billing', 'general')]) {
    url = invalid
    await assert.rejects(cloudModelBillingUrl('local-person'), { code: 'cloud_unavailable' })
  }
  url = expected
})

test('only a missing local session is 401; a disconnected cloud binding cannot log the phone out', async () => {
  signedIn = false
  const before = reads, missingSession = await GET(request())
  assert.equal(missingSession.status, 401); assert.equal(reads, before)
  signedIn = true; connected = false
  const disconnected = await GET(request())
  assert.equal(disconnected.status, 403); assert.deepEqual(await disconnected.json(), { error: 'cloud_not_connected' })
  connected = true
})

test('stored cloud quota failures retain compatible chat shape and canonical bilingual copy', () => {
  const failure = chatFailure({ working: false, error: new CloudServiceError('cloud_quota_exhausted', 'response').message })
  assert.deepEqual(failure, { kind: 'failed', cloudCode: 'cloud_quota_exhausted', raw: 'cloud_quota_exhausted (response)' })
  assert.deepEqual(failureMessageKey(failure!), { namespace: 'RunErrors', key: 'cloud_quota_exhausted.default' })
  assert.ok(failureLine('cloud_quota_exhausted', 'zh-CN'))
  assert.ok(failureLine('cloud_quota_exhausted', 'en'))
})
