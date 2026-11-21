// Launch checks for updates, but never longer than its limit and never locking the person out.
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { buildTooOld, requireMobileUpdate, within } from '../lib/startup.ts'

test('a build older than the minimum is stopped; an unknown one is let in', () => {
  assert.equal(buildTooOld('6', 7), true)
  assert.equal(buildTooOld('7', 7), false)
  assert.equal(buildTooOld('12', 7), false)
  assert.equal(buildTooOld(null, 7), false)
  assert.equal(buildTooOld('6', undefined), false)
  assert.equal(buildTooOld('6', '9'), false)
  assert.equal(buildTooOld('abc', 7), false)
})

test('a check that answers in time gives its answer', async () => {
  assert.equal(await within(Promise.resolve('new'), 50, 'skip'), 'new')
})

test('a check that hangs or fails gives the fallback', async () => {
  assert.equal(await within(new Promise<string>(() => {}), 20, 'skip'), 'skip')
  assert.equal(await within(Promise.reject(new Error('offline')), 50, 'skip'), 'skip')
})

test('a running mobile app turns a server upgrade refusal into its existing update screen', async t => {
  const { Window } = await import('happy-dom')
  const browser = new Window({ url: 'https://fixture.example' })
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, __DEV__: true })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const opened: string[] = []
  const base = 'https://mobile.example.test/mikka', update = 'https://testflight.apple.com/join/fixture'
  const View = ({ children }: { children: unknown }) => createElement('div', null, children)
  const Text = ({ children }: { children: unknown }) => createElement('span', null, children)
  mock.module('react-native', { namedExports: {
    View, StyleSheet: { create: (value: unknown) => value }, Linking: { openURL: async (url: string) => { opened.push(url) } },
    Pressable: ({ children, onPress, disabled }: { children: unknown; onPress: () => void; disabled: boolean }) => createElement('button', { onClick: onPress, disabled }, children),
  } })
  mock.module('expo-application', { namedExports: { nativeBuildVersion: '100' } })
  mock.module('expo-updates', { namedExports: { isEnabled: false } })
  mock.module(new URL('../components/icons.tsx', import.meta.url).href, { namedExports: { Spinner: () => createElement('span', null, 'checking') } })
  mock.module(new URL('../components/Text.tsx', import.meta.url).href, { namedExports: { Text } })
  mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { API_URL: base } })
  mock.module(new URL('../lib/tracing.ts', import.meta.url).href, { namedExports: { mobileTraceHeaders: () => ({}) } })
  mock.module(new URL('../lib/theme.ts', import.meta.url).href, { namedExports: { colors: {} } })
  t.mock.method(globalThis, 'fetch', async () => Response.json({ minMobileBuild: 0, minApiVersion: 0, mobileUpdateUrl: update }))
  const { StartupGate } = await import('../components/StartupGate.tsx')
  const root = createRoot(document.body)
  try {
    await act(async () => root.render(createElement(StartupGate, null, createElement('span', null, 'signed-in app'))))
    assert.equal(document.body.textContent, 'signed-in app')
    await act(async () => requireMobileUpdate('https://other.example.test/mikka'))
    assert.equal(document.body.textContent, 'signed-in app')
    await act(async () => requireMobileUpdate(base))
    assert.equal(document.body.textContent, '请更新到最新版更新')
    await act(async () => document.querySelector('button')!.click())
    assert.deepEqual(opened, [update])
  } finally {
    await act(async () => root.unmount())
    await browser.happyDOM.close()
  }
})
