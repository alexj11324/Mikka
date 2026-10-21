import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isLocalSettingsNavigation, pushSettingsHistory } from '../lib/settings-navigation.ts'

const url = path => new URL(path, 'https://orvilo.example')

test('个人设置与同工作区团队子页使用即时导航', () => {
  for (const [from, to, workspace] of [
    ['/settings?section=preferences', '/settings?section=profile'],
    ['/settings?section=profile', '/settings?section=workspace'],
    ['/settings/teams?workspace=a', '/settings/teams?workspace=a&create=1'],
    ['/settings/teams?workspace=a&team=one', '/settings/teams?workspace=a&team=two&view=general'],
    ['/settings/teams?workspace=a&team=one', '/settings/teams?workspace=a&team=one&view=members'],
    ['/settings/teams', '/settings/teams?workspace=a&team=one', 'a'],
  ]) assert.equal(isLocalSettingsNavigation(url(from), url(to), workspace), true)
})

test('跨页、跨工作区与不明默认工作区必须重新经过服务端', () => {
  for (const [from, to] of [
    ['/settings', '/settings/teams'],
    ['/settings/teams', '/settings/members'],
    ['/settings/teams?workspace=a', '/settings/teams?workspace=b'],
    ['/settings/teams', '/settings/teams?workspace=a'],
    ['/settings/members?workspace=a', '/settings/members?workspace=a&invite=1'],
    ['/', '/?team=one'],
    ['/settings', 'https://other.example/settings'],
  ]) assert.equal(isLocalSettingsNavigation(url(from), url(to)), false)
})

test('即时导航只写入一次历史记录，跨工作区不改写 URL', t => {
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
  assert.equal(pushSettingsHistory('/settings/teams?workspace=b'), false)
  assert.deepEqual(entries, ['/settings/teams?workspace=a&team=one'])
  assert.deepEqual(scrolls, [{ top: 0 }])
})
