import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isLocalSettingsNavigation, pushSettingsHistory } from '../lib/settings-navigation.ts'

const url = path => new URL(path, 'https://orvilo.example')

test('设置页面间与团队子页使用即时导航', () => {
  for (const [from, to, workspace] of [
    ['/settings?section=preferences', '/settings?section=profile'],
    ['/settings', '/settings/teams'],
    ['/settings/teams', '/settings/members'],
    ['/settings/teams?workspace=a', '/settings/teams?workspace=b'],
    ['/settings/teams', '/settings/teams?workspace=a'],
    ['/settings/members?workspace=a', '/settings/members?workspace=a&invite=1'],
    ['/settings?section=profile', '/settings?section=workspace'],
    ['/settings/teams?workspace=a', '/settings/teams?workspace=a&create=1'],
    ['/settings/teams?workspace=a&team=one', '/settings/teams?workspace=a&team=two&view=general'],
    ['/settings/teams?workspace=a&team=one', '/settings/teams?workspace=a&team=one&view=members'],
    ['/settings/teams', '/settings/teams?workspace=a&team=one', 'a'],
  ]) assert.equal(isLocalSettingsNavigation(url(from), url(to), workspace), true)
})

test('工作台与设置之间的路由切换交给 Next.js', () => {
  assert.equal(isLocalSettingsNavigation(url('/'), url('/settings')), false)
  assert.equal(isLocalSettingsNavigation(url('/settings'), url('/')), false)
})

test('带 basePath 与 locale 前缀的设置路由仍使用即时导航', () => {
  for (const [from, to] of [
    ['/mikka/settings?section=preferences', '/mikka/settings/teams'],
    ['/mikka/en/settings', '/mikka/en/settings/members'],
  ]) assert.equal(isLocalSettingsNavigation(url(from), url(to), undefined, '/mikka'), true)
  assert.equal(isLocalSettingsNavigation(url('/mikka'), url('/mikka/settings'), undefined, '/mikka'), false)
  assert.equal(isLocalSettingsNavigation(url('/mikka/en'), url('/mikka/en/settings'), undefined, '/mikka'), false)
})

test('认证页、未知页面及外站不绕过 Next.js 路由', () => {
  for (const [from, to] of [
    ['/sign-in', '/settings'],
    ['/settings', '/sign-in'],
    ['/acceptance', '/settings'],
    ['/settings', '/settings/unknown'],
    ['/settings', 'https://other.example/settings'],
    ['/mikka/sign-in', '/mikka/settings'],
    ['/mikkax/settings', '/mikkax/settings/teams'],
  ]) assert.equal(isLocalSettingsNavigation(url(from), url(to), undefined, from.startsWith('/mikka') ? '/mikka' : ''), false)
})

test('即时导航只写入一次历史记录，未知路径不改写 URL', t => {
  const entries = []
  const scrolls = []
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const location = { href: url('/settings/teams?workspace=a').href }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location, history: { pushState: (_state, _title, href) => { entries.push(href); location.href = url(href).href } } } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => ({ scrollTo: options => scrolls.push(options) }) } })
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else delete globalThis.window
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else delete globalThis.document
  })
  assert.equal(pushSettingsHistory('/settings/teams?workspace=a&team=one'), true)
  assert.equal(pushSettingsHistory('/settings/teams?workspace=a&team=one'), true)
  assert.equal(pushSettingsHistory('/sign-in'), false)
  assert.deepEqual(entries, ['/settings/teams?workspace=a&team=one'])
  assert.deepEqual(scrolls, [{ top: 0 }])
})

test('带 basePath 与 locale 的 history 写入保留部署路径和当前语言', t => {
  const entries = []
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const location = { href: url('/mikka/en/settings/teams?workspace=a').href }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location, history: { pushState: (_state, _title, href) => { entries.push(href); location.href = url(href).href } } } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null } })
  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else delete globalThis.window
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else delete globalThis.document
  })
  assert.equal(pushSettingsHistory('/settings/members?invite=1', undefined, '/mikka'), true)
  assert.deepEqual(entries, ['/mikka/en/settings/members?invite=1'])
})
