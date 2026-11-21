import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isLocalSettingsNavigation, pushSettingsHistory, rememberWorkspaceBeforeSwitch } from '../lib/settings-navigation.ts'

const url = path => new URL(path, 'https://mikka.example')

test('switching a workspace pins an initially implicit Task entry without losing its origin mark', t => {
  const state = { mikkaEntry: { index: 2 } }
  const location = { href: url('/mikka/en?issue=task-a#comment').href }
  const writes = []
  const history = { state, replaceState(next, _title, href) { writes.push(next); location.href = href.toString() } }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { history, location } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window })
  rememberWorkspaceBeforeSwitch('workspace-a')
  assert.equal(location.href, url('/mikka/en?issue=task-a&workspace=workspace-a#comment').href)
  rememberWorkspaceBeforeSwitch('workspace-b')
  assert.deepEqual(writes, [state], 'an explicit destination remains unchanged')
})

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

test('工作台与设置之间的路由切换使用即时导航', () => {
  assert.equal(isLocalSettingsNavigation(url('/'), url('/settings')), true)
  assert.equal(isLocalSettingsNavigation(url('/settings'), url('/')), true)
})

test('带 basePath 与 locale 前缀的设置路由仍使用即时导航', () => {
  for (const [from, to] of [
    ['/mikka/settings?section=preferences', '/mikka/settings/teams'],
    ['/mikka/en/settings', '/mikka/en/settings/members'],
  ]) assert.equal(isLocalSettingsNavigation(url(from), url(to), undefined, '/mikka'), true)
  assert.equal(isLocalSettingsNavigation(url('/mikka'), url('/mikka/settings'), undefined, '/mikka'), true)
  assert.equal(isLocalSettingsNavigation(url('/mikka/en'), url('/mikka/en/settings'), undefined, '/mikka'), true)
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
  assert.deepEqual(entries, ['/mikka/en/settings/members?invite=1&workspace=a'])
})

function browser(t, initial) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const location = { href: initial }
  const entries = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location,
    history: { pushState: (_state, _title, href) => {
      location.href = new URL(href, location.href).href
      entries.push(location.href)
    } },
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null } })
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete globalThis.window
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
  })
  return { location, entries }
}

test('opening settings preserves the selected workspace instead of triggering a scope reload', t => {
  const { location } = browser(t, 'https://mikka.example/mikka/en/?workspace=team-a&bot=bot-one')
  assert.equal(pushSettingsHistory('/settings', undefined, '/mikka'), true)
  const next = new URL(location.href)
  assert.equal(next.pathname, '/mikka/en/settings')
  assert.equal(next.searchParams.get('workspace'), 'team-a')
  assert.equal(next.searchParams.has('bot'), false)
})

test('leaving settings for chat and board preserves the workspace', t => {
  const { location } = browser(t, 'https://mikka.example/settings?workspace=team-a&section=profile')
  assert.equal(pushSettingsHistory('/'), true)
  assert.equal(new URL(location.href).searchParams.get('workspace'), 'team-a')
  assert.equal(pushSettingsHistory('/?section=all-issues'), true)
  assert.equal(new URL(location.href).searchParams.get('workspace'), 'team-a')
  assert.equal(new URL(location.href).searchParams.get('section'), 'all-issues')
})

test('settings subpages keep the URL scope rather than an older caller workspace', t => {
  const { location } = browser(t, 'https://mikka.example/settings?workspace=team-new')
  assert.equal(pushSettingsHistory('/settings/members?invite=1', 'team-old'), true)
  assert.equal(new URL(location.href).searchParams.get('workspace'), 'team-new')
  assert.equal(new URL(location.href).searchParams.get('invite'), '1')
})

test('an explicit workspace switch still reaches the requested authorization boundary', t => {
  const { location } = browser(t, 'https://mikka.example/settings?workspace=team-a')
  assert.equal(pushSettingsHistory('/settings?workspace=team-b', 'team-a'), true)
  assert.equal(new URL(location.href).searchParams.get('workspace'), 'team-b')
})

test('a default-workspace route stays implicit and repeated settings navigation is a no-op', t => {
  const { location, entries } = browser(t, 'https://mikka.example/settings?section=profile')
  assert.equal(pushSettingsHistory('/settings?section=profile', 'resolved-default'), true)
  assert.equal(new URL(location.href).searchParams.has('workspace'), false)
  assert.equal(entries.length, 0)
})

test('unknown, external, and auth destinations do not write history', t => {
  const { entries } = browser(t, 'https://mikka.example/settings?workspace=team-a')
  for (const href of ['/sign-in', '/settings/unknown', 'https://other.example/settings']) {
    assert.equal(pushSettingsHistory(href), false)
  }
  assert.equal(entries.length, 0)
})


test('an explicitly empty destination workspace is not replaced by the previous scope', t => {
  const { location } = browser(t, 'https://mikka.example/settings?workspace=team-a')
  assert.equal(pushSettingsHistory('/settings?workspace='), true)
  assert.equal(new URL(location.href).searchParams.get('workspace'), '')
})

test('returning to the same settings URL does not add a redundant history entry', t => {
  const { entries } = browser(t, 'https://mikka.example/settings?workspace=team-a')
  assert.equal(pushSettingsHistory('/settings'), true)
  assert.equal(pushSettingsHistory('/settings'), true)
  assert.equal(entries.length, 0)
})

test('installed desktop navigation keeps its workspace without copying the previous view', t => {
  const { location } = browser(t, 'mikka://app/mikka/en/?workspace=team-a&thread=thread-one')
  assert.equal(pushSettingsHistory('/settings?section=models', undefined, '/mikka'), true)
  assert.equal(location.href, 'mikka://app/mikka/en/settings?section=models&workspace=team-a')
})
