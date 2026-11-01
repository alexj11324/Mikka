import test from 'node:test'
import assert from 'node:assert/strict'

import type { MikkaBridge } from '@mikka/protocol/bridge'

import { withBasePath } from '@/lib/base-path'

import type { MikkaWindow } from './detect'
import { openCurrentPageInBrowser, openPathInBrowser, openSettingsInBrowser } from './open-settings'

function windowWith(bridge: Partial<MikkaBridge['app']> | null, href = 'https://app.example/mikka/settings?settings=integrations'): MikkaWindow {
  const url = new URL(href)
  return {
    location: { origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash },
    ...(bridge ? { mikka: { app: bridge } as MikkaBridge } : {}),
  } as MikkaWindow
}

test('web settings stay in the current window', async () => {
  assert.equal(await openSettingsInBrowser('account', null), 'browser')
  assert.equal(await openSettingsInBrowser('integrations', windowWith(null)), 'browser')
})

test('an older desktop shell cannot link from the app window', async () => {
  assert.equal(await openSettingsInBrowser('account', windowWith({ version: '0.1.0', flavor: 'prod', runtime: 'electron' })), 'unsupported')
})

test('the desktop shell reopens the current page for OAuth callbacks', async () => {
  const opened: string[] = []
  const target = windowWith({
    version: '0.1.1',
    flavor: 'prod',
    runtime: 'electron',
    openExternal: async (url: string) => { opened.push(url) },
  }, 'https://app.example/mikka/plugins?app=gmail#accounts')
  assert.equal(await openCurrentPageInBrowser(target), 'desktop')
  assert.deepEqual(opened, ['https://app.example/mikka/plugins?app=gmail#accounts'])
})

test('the desktop shell opens the matching settings section in the system browser', async () => {
  const opened: string[] = []
  const target = windowWith({
    version: '0.1.1',
    flavor: 'prod',
    runtime: 'electron',
    openExternal: async (url: string) => { opened.push(url) },
  })
  assert.equal(await openSettingsInBrowser('integrations', target), 'desktop')
  assert.deepEqual(opened, [new URL(withBasePath('/?settings=integrations'), 'https://app.example').toString()])
})

test('the desktop shell starts an app path such as GitHub connect in the system browser', async () => {
  const opened: string[] = []
  const target = windowWith({
    version: '0.1.1',
    flavor: 'prod',
    runtime: 'electron',
    openExternal: async (url: string) => { opened.push(url) },
  })
  const connect = withBasePath('/api/integrations/github/connect')
  assert.equal(await openPathInBrowser(connect, target), 'desktop')
  assert.deepEqual(opened, [new URL(connect, 'https://app.example').toString()])
  assert.equal(await openPathInBrowser(connect, windowWith(null)), 'browser')
})
