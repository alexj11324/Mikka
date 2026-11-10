import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { navBarOptions, needsTopFade, scrolledUnderBar } from '../components/nav-bar-options.ts'

// Alex 2026-11-08 on TestFlight: 「Bot」 showed twice (a left-hand title plus the native one), and the chat bar was an
// opaque grey slab with no name. These pin the iOS header options each kind of screen gets.

test('a tab root has one title: the native one, centred, not large, with no custom title view', () => {
  const options = navBarOptions({ title: 'Bot', topTitle: true })
  assert.equal(options.title, 'Bot')
  assert.equal(options.headerTitle, undefined)
  assert.equal(options.headerLargeTitle, false)
  assert.equal(navBarOptions({ title: '任务', topTitle: true, large: true }).headerLargeTitle, false)
})

test('no bar is a slab: transparent, no material, no hairline, the soft top edge', () => {
  for (const options of [navBarOptions({ title: 'Bot', topTitle: true }), navBarOptions({ titleView: 'name' }), navBarOptions({ title: '资料' })]) {
    assert.equal(options.headerTransparent, true)
    assert.equal(options.headerShadowVisible, false)
    assert.equal('headerBlurEffect' in options, false)
    assert.deepEqual(options.scrollEdgeEffects, { top: 'soft', bottom: 'soft' })
  }
})

test('a chat keeps its title view (the bot name and its menu) in the centre', () => {
  const view = 'Bot name'
  const options = navBarOptions({ title: 'Bot name', titleView: view })
  assert.equal(typeof options.headerTitle, 'function')
  assert.equal((options.headerTitle as () => unknown)(), view)
})

test('the fade under the bar is drawn only on iOS before 26', () => {
  assert.equal(needsTopFade('ios', '18.5'), true)
  assert.equal(needsTopFade('ios', '26.1'), false)
  assert.equal(needsTopFade('web', '18'), false)
})

test('every tab root uses topTitle and nothing on the left', () => {
  const roots = ['features/home/screens/home-screen.tsx', 'features/tasks/screens/tasks-screen.tsx', 'app/(tabs)/suggestions/index.tsx', 'app/(tabs)/settings/index.tsx', 'features/search/screens/search-screen.tsx']
  for (const file of roots) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const bar = source.slice(source.indexOf('<NavBar'), source.indexOf('/>', source.indexOf('<NavBar')))
    assert.match(bar, /\btopTitle\b/, file)
    assert.doesNotMatch(bar, /\bleft=/, file)
    assert.doesNotMatch(bar, /\blarge\b/, file)
  }
})

// Alex 2026-11-08: on a task's conversation the title, back button and messages overlapped under the floating bar.
test('content counts as under the bar once it scrolls past the bar height', () => {
  const bar = 59 + 44
  assert.equal(scrolledUnderBar(-bar, bar), false)
  assert.equal(scrolledUnderBar(-bar + 1, bar), false)
  assert.equal(scrolledUnderBar(-bar + 3, bar), true)
  assert.equal(scrolledUnderBar(0, bar), true)
})

test('every screen whose conversation scrolls under the bar gives the bar its backdrop', () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  for (const path of ['features/tasks/screens/task-conversation-screen.tsx', 'app/thread/[id].tsx', 'features/tasks/screens/task-screen.tsx', 'app/groups/[id].tsx', 'features/chat/screens/chat-screen.tsx']) {
    const source = read(path)
    assert.match(source, /useScrolledUnderBar\(\)/, `${path} does not track scrolling under the bar`)
    assert.match(source, /scrolled=\{(bar|underBar)\.scrolled\}/, `${path} does not pass it to its bar`)
  }
  assert.match(read('features/chat/components/chat-header.ios.tsx'), /<NavBar[^>]*scrolled=\{scrolled\}/)
  assert.match(read('components/NavBar.tsx'), /scrolled !== undefined \? <BarBackdrop visible=\{scrolled\} \/>/)
})
