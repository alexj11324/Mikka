import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeHref, activateTab, addTab, closeTab, createSavedTabs, readSavedTabs,
  persistableHref, recordHistoryLocation, recordNavigation, SAVED_TABS_KEY, writeSavedTabs,
} from './saved-tabs.ts'

function storage(initial: Record<string, string> = {}) {
  const values = { ...initial }
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value },
  }
}

test('saved tabs round-trip and reject malformed or empty stores', () => {
  const store = storage()
  const tabs = createSavedTabs('/mikka/settings')
  assert.equal(writeSavedTabs(store, tabs), true)
  assert.deepEqual(readSavedTabs(store), tabs)
  assert.equal(readSavedTabs(storage({ [SAVED_TABS_KEY]: '{bad' })), null)
  assert.equal(readSavedTabs(storage({ [SAVED_TABS_KEY]: JSON.stringify({ items: [], active: 0 }) })), null)
  assert.equal(writeSavedTabs(storage(), { items: [], active: 0 }), false)
})

test('navigation maintains each tab history, truncates forward history, and tracks back/forward', () => {
  let tabs = createSavedTabs('/mikka')
  tabs = recordNavigation(tabs, '/mikka/settings', 'push')
  tabs = recordNavigation(tabs, '/mikka/settings?section=devices', 'push')
  tabs = recordHistoryLocation(tabs, '/mikka/settings')
  assert.equal(tabs.items[0]?.index, 1)
  tabs = recordNavigation(tabs, '/mikka/devices', 'push')
  assert.deepEqual(tabs.items[0]?.entries, ['/mikka', '/mikka/settings', '/mikka/devices'])
  assert.equal(activeHref(tabs), '/mikka/devices')
  tabs = recordNavigation(tabs, '/mikka/devices?filter=mine', 'replace')
  assert.equal(activeHref(tabs), '/mikka/devices?filter=mine')
})

test('tabs can be added, activated and closed without losing the remaining active route', () => {
  let tabs = createSavedTabs('/mikka')
  tabs = addTab(tabs, '/mikka/settings')
  tabs = activateTab(tabs, 0)
  assert.equal(tabs.active, 0)
  tabs = closeTab(tabs, 0, '/mikka')
  assert.equal(tabs.items.length, 1)
  assert.equal(activeHref(tabs), '/mikka/settings')
  tabs = closeTab(tabs, 0, '/mikka')
  assert.equal(tabs.items.length, 1)
  assert.equal(activeHref(tabs), '/mikka')
})


test('tab recovery excludes authentication, invitation and credential-bearing URLs', () => {
  assert.equal(persistableHref('/mikka/settings?section=devices'), '/mikka/settings?section=devices')
  assert.equal(persistableHref('/mikka/sign-in?next=%2Fsettings'), null)
  assert.equal(persistableHref('/invite/abc123'), null)
  assert.equal(persistableHref('/mikka/oauth/consent?code=secret'), null)
  assert.equal(persistableHref('/settings?access_token=secret'), null)
  assert.equal(persistableHref('https://example.com/'), null)
  assert.equal(persistableHref('//example.com/path'), null)
})
