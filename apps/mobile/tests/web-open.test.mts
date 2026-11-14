import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import messages from '../../../messages/zh-CN.json'
import { apiCache } from '../lib/api-cache.ts'

const urls: string[] = [], alerts: string[] = []
const confirmations: { title: string; body?: string; actions?: { text: string; onPress?: () => void }[] }[] = []
let finishApple: (id: string) => Promise<boolean> = async () => false
const calls: { path: string; connection: unknown }[] = []
const platform = { OS: 'ios' }
let account = { id: 'fixture-account-a', server: { url: 'https://fixture.example/mikka' } }
let read: () => Promise<unknown> = async () => ({ token: 'fixture-one-time-token' })
let openURL: (url: string) => Promise<void> = async url => { urls.push(url) }
mock.module('react-native', { namedExports: { Platform: platform, Alert: { alert: (title: string, body?: string, actions?: { text: string; onPress?: () => void }[]) => { alerts.push(title); confirmations.push({ title, body, actions }) } }, Linking: { openURL: (url: string) => openURL(url) } } })
mock.module('expo-web-browser', { namedExports: { openBrowserAsync: async (url: string) => { urls.push(url) } } })
mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: { api: (path: string, _init: unknown, connection: unknown) => { calls.push({ path, connection }); return read() }, apiConnection: () => ({ account }) } })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { API_URL: 'https://fixture.example/mikka', currentAccount: () => account } })
mock.module(new URL('../lib/apple-auth.ts', import.meta.url).href, { namedExports: { finishAppleDeletionHandoff: (id: string) => finishApple(id) } })
mock.module(new URL('../lib/messages.ts', import.meta.url).href, { namedExports: { mobileMessages: messages } })
const { confirmDestructiveAction, showSystemAlert } = await import('../lib/system-alert.ts')
const { openAccountDeletion, openCloudBilling, openOnWeb, openPrivacyPolicy } = await import('../lib/web.ts')
beforeEach(() => { urls.length = 0; alerts.length = 0; calls.length = 0; confirmations.length = 0; finishApple = async () => false; platform.OS = 'ios'; account = { id: 'fixture-account-a', server: { url: 'https://fixture.example/mikka' } }; apiCache.clear(); read = async () => ({ token: 'fixture-one-time-token' }); openURL = async url => { urls.push(url) } })

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

test('Expo Task properties use the account-bound handoff even with a different active browser workspace', async () => {
  platform.OS = 'web'
  const target = '/?issue=11111111-1111-4111-8111-111111111111'
  let finish!: (value: unknown) => void
  read = () => new Promise(resolve => { finish = resolve })
  const tab = { opener: {}, closed: false, close() { this.closed = true }, location: { replace: (url: string) => urls.push(url) } }
  const web = { open: mock.fn(() => tab), location: { assign: (url: string) => urls.push(url) } }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: web })
  try {
    const opened = openOnWeb(target)
    assert.deepEqual(web.open.mock.calls[0].arguments, ['about:blank', '_blank'])
    assert.equal(tab.opener, null)
    assert.deepEqual(urls, [])
    finish({ token: 'fixture-one-time-token' })
    await opened
    const handoff = new URL(urls[0])
    assert.equal(handoff.origin + handoff.pathname, account.server.url + '/api/mobile/open')
    assert.equal(handoff.searchParams.get('to'), target)
    assert.equal(handoff.searchParams.get('token'), 'fixture-one-time-token')

    urls.length = 0
    const switched = openOnWeb(target)
    account = { ...account, id: 'different-test-account' }
    finish({ token: 'fixture-former-account' })
    await switched
    assert.equal(tab.closed, true)
    assert.deepEqual(urls, [])
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
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

test('an ended Apple session after the deletion handoff offers the public Apple authorization page', async () => {
  finishApple = async id => { assert.equal(id, 'fixture-account-a'); assert.equal(urls.length, 1); return true }
  await openAccountDeletion()
  assert.equal(new URL(urls[0]).searchParams.get('to'), '/settings?section=account')
  assert.equal(confirmations[0].title, messages.Auth.appleAuthorizationTitle)
  assert.equal(confirmations[0].body, messages.Auth.appleRevocationBody)
  confirmations[0].actions?.[1].onPress?.()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(urls[1], 'https://account.apple.com/')
  assert.equal(new URL(urls[1]).search, '')
})

test('a deletion handoff that retains its session has no Apple revocation alert', async () => {
  await openAccountDeletion()
  assert.deepEqual(alerts, [])
})

test('unknown deletion-session status reports uncertainty without an Apple management action', async () => {
  finishApple = async () => { throw new Error('fixture-private-session-error') }
  await openAccountDeletion()
  assert.deepEqual(alerts, [messages.Auth.accountDeletionUnconfirmed])
  assert.equal(confirmations[0].actions, undefined)
})

test('an Apple management link failure preserves the manual revocation instructions', async () => {
  finishApple = async () => true
  await openAccountDeletion()
  openURL = async () => { throw new Error('fixture-private-browser-error') }
  confirmations[0].actions?.[1].onPress?.()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(alerts, [messages.Auth.appleAuthorizationTitle, messages.Auth.webOpenUnconfirmed])
})

test('Expo Web uses a real system confirmation and invokes the destructive action only after consent', () => {
  platform.OS = 'web'
  const savedConfirm = Object.getOwnPropertyDescriptor(globalThis, 'confirm')
  const savedAlert = Object.getOwnPropertyDescriptor(globalThis, 'alert')
  let accepted = false
  const shown: string[] = []
  let deletes = 0
  try {
    Object.defineProperty(globalThis, 'confirm', { configurable: true, value: (title: string) => { shown.push(title); return accepted } })
    Object.defineProperty(globalThis, 'alert', { configurable: true, value: (title: string) => { shown.push(title) } })
    confirmDestructiveAction('Remove fixture?', 'Remove', () => { deletes++ })
    assert.equal(deletes, 0)
    accepted = true
    confirmDestructiveAction('Remove fixture?', 'Remove', () => { deletes++ })
    assert.equal(deletes, 1)
    showSystemAlert('Read failed', 'Try again')
    assert.deepEqual(shown, ['Remove fixture?', 'Remove fixture?', 'Read failed\nTry again'])
    assert.deepEqual(confirmations, [])
  } finally {
    if (savedConfirm) Object.defineProperty(globalThis, 'confirm', savedConfirm)
    else Reflect.deleteProperty(globalThis, 'confirm')
    if (savedAlert) Object.defineProperty(globalThis, 'alert', savedAlert)
    else Reflect.deleteProperty(globalThis, 'alert')
  }
})

test('native system confirmation keeps cancellation and destructive actions distinct', () => {
  let deletes = 0
  confirmDestructiveAction('Remove fixture?', 'Remove', () => { deletes++ })
  const buttons = confirmations[0].actions!
  assert.deepEqual(buttons.map(button => button.text), [messages.Common.cancel, 'Remove'])
  buttons[0].onPress?.()
  assert.equal(deletes, 0)
  buttons[1].onPress?.()
  assert.equal(deletes, 1)
})
