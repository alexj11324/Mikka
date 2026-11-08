import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { apiCache } from '../lib/api-cache.ts'

const urls: string[] = [], alerts: string[] = []
const calls: { path: string; connection: unknown }[] = []
const platform = { OS: 'ios' }
let account = { id: 'fixture-account-a', server: { url: 'https://fixture.example/mikka' } }
let read: () => Promise<unknown> = async () => ({ token: 'fixture-one-time-token' })
let openURL: (url: string) => Promise<void> = async url => { urls.push(url) }
mock.module('react-native', { namedExports: { Platform: platform, Alert: { alert: (message: string) => alerts.push(message) }, Linking: { openURL: (url: string) => openURL(url) } } })
mock.module('expo-web-browser', { namedExports: { openBrowserAsync: async (url: string) => { urls.push(url) } } })
mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: { api: (path: string, _init: unknown, connection: unknown) => { calls.push({ path, connection }); return read() }, apiConnection: () => ({ account }) } })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { API_URL: 'https://fixture.example/mikka' } })
const { openCloudBilling, openOnWeb, openPrivacyPolicy } = await import('../lib/web.ts')
beforeEach(() => { urls.length = 0; alerts.length = 0; calls.length = 0; platform.OS = 'ios'; account = { id: 'fixture-account-a', server: { url: 'https://fixture.example/mikka' } }; apiCache.clear(); read = async () => ({ token: 'fixture-one-time-token' }); openURL = async url => { urls.push(url) } })

test('privacy opens the public website without requesting an account token', async () => {
  await openPrivacyPolicy()
  assert.deepEqual(urls, ['https://aspectlylabs.com/privacy'])
  assert.deepEqual(calls, [])
  assert.deepEqual(alerts, [])
})

test('a rejected privacy link reports the existing fixed error', async () => {
  openURL = async () => { throw new Error('fixture-private-browser-error') }
  await openPrivacyPolicy()
  assert.deepEqual(alerts, ['网页打开未确认'])
  assert.deepEqual(calls, [])
})

test('deletion entry hands off to the account page without a delete request', async () => {
  await openOnWeb('/settings?section=account')
  assert.deepEqual(calls, [{ path: '/api/auth/one-time-token/generate', connection: { account } }])
  assert.equal(new URL(urls[0]).searchParams.get('to'), '/settings?section=account')
})

test('the native handoff preserves the exact chat target until token acquisition completes', async () => {
  let finish!: (value: unknown) => void
  read = () => new Promise(resolve => { finish = resolve })
  const target = '/?section=coordinator&workspace=11111111-1111-4111-8111-111111111111'
  const opened = openOnWeb(target)
  assert.equal(urls.length, 0)
  finish({ token: 'fixture-one-time-token' })
  await opened
  assert.equal(new URL(urls[0]).searchParams.get('to'), target)
  assert.equal(new URL(urls[0]).searchParams.get('token'), 'fixture-one-time-token')
})

test('failed token acquisition stays in the native screen instead of using a browser old session', async () => {
  read = async () => { throw new Error('fixture-private-provider-text') }
  await openOnWeb('/?section=coordinator&workspace=11111111-1111-4111-8111-111111111111')
  assert.deepEqual(urls, [])
  assert.deepEqual(alerts, ['网页打开未确认'])
})

const billing = 'https://operator-cloud.example/mikka/settings?section=billing&workspace=11111111-1111-4111-8111-111111111111'

test('cloud billing is fetched on demand for the selected account and opens without forwarding its token', async () => {
  read = async () => ({ url: billing })
  assert.deepEqual(calls, [])
  await openCloudBilling()
  assert.deepEqual(calls, [{ path: '/api/cloud/models/billing', connection: { account } }])
  assert.deepEqual(urls, [billing])
  assert.deepEqual(alerts, [])
})

test('cloud billing rejects unsafe, malformed or non-billing destinations with fixed copy', async () => {
  for (const url of ['javascript:alert(1)', billing.replace('https:', 'http:'), billing.replace('//', '//fixture-secret@'),
    `${billing}#fixture-secret`, `${billing}&token=fixture-secret`, `${billing}&workspace=22222222-2222-4222-8222-222222222222`,
    billing.replace('workspace=11111111-1111-4111-8111-111111111111', 'workspace=fixture-private-text'), billing.replace('/settings?', '/login?')]) {
    read = async () => ({ url })
    await openCloudBilling()
    assert.deepEqual(urls, [])
    assert.equal(alerts.pop(), '网页打开未确认')
  }
})

test('a late cloud billing answer for a previous account or workspace cannot open a page', async () => {
  for (const change of [() => { account = { ...account, id: 'fixture-account-b' } }, () => apiCache.clear()]) {
    let finish!: (value: unknown) => void
    read = () => new Promise(resolve => { finish = resolve })
    const pending = openCloudBilling()
    change()
    finish({ url: billing })
    await pending
    assert.deepEqual(urls, [])
    assert.deepEqual(alerts, [])
  }
})

test('a billing failure on an old server cannot interrupt the next account', async () => {
  let reject!: (error: Error) => void
  read = () => new Promise((_resolve, fail) => { reject = fail })
  const pending = openCloudBilling()
  account = { ...account, id: 'fixture-account-b' }
  reject(new Error('fixture-private-cloud-error'))
  await pending
  assert.deepEqual(alerts, [])
  assert.deepEqual(urls, [])
})

test('Expo Web uses the selected server authenticated redirect directly from the tap', async () => {
  platform.OS = 'web'
  const opened: unknown[][] = []
  const previous = globalThis.window
  Object.assign(globalThis, { window: { open: (...args: unknown[]) => opened.push(args) } })
  try { await openCloudBilling() }
  finally { Object.assign(globalThis, { window: previous }) }
  assert.deepEqual(opened, [['https://fixture.example/mikka/api/cloud/models/billing?redirect=1', '_blank', 'noopener']])
  assert.deepEqual(calls, [])
  assert.deepEqual(urls, [])
})
