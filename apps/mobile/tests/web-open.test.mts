import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'

const urls: string[] = [], alerts: string[] = []
let read: () => Promise<unknown> = async () => ({ token: 'fixture-one-time-token' })
mock.module('react-native', { namedExports: { Platform: { OS: 'ios' }, Alert: { alert: (message: string) => alerts.push(message) } } })
mock.module('expo-web-browser', { namedExports: { openBrowserAsync: async (url: string) => { urls.push(url) } } })
mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: { api: () => read() } })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { API_URL: 'https://fixture.example/mikka' } })
const { openOnWeb } = await import('../lib/web.ts')
beforeEach(() => { urls.length = 0; alerts.length = 0; read = async () => ({ token: 'fixture-one-time-token' }) })

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
