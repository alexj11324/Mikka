import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { auditNavigation, auditRepository, navigationAllowlist, navigationModules, staleAllowances } from './navigation-policy.mjs'

const rules = (source, file = 'components/example.tsx') => auditNavigation(file, source).map(d => d.rule)

test('nothing in the app writes history or builds a workspace address outside the navigation modules', () => {
  assert.deepEqual(auditRepository().map(d => `${d.file}:${d.line}:${d.column} ${d.rule}`), [])
})

test('every allowance exists, says why, and is no larger than the file needs', () => {
  for (const file of navigationModules) assert.ok(existsSync(file), file)
  for (const [file, entries] of Object.entries(navigationAllowlist)) {
    assert.ok(existsSync(file), file)
    for (const { reason } of Object.values(entries)) assert.ok(reason.length > 10, file)
  }
  assert.deepEqual(staleAllowances(), [])
})

test('direct history writes, router moves and hand-built addresses fail', () => {
  assert.deepEqual(rules("window.history.pushState(null, '', url)"), ['navigation/history'])
  assert.deepEqual(rules('history.replaceState(state, "", next)'), ['navigation/history'])
  assert.deepEqual(rules("router.push('/settings')"), ['navigation/router'])
  assert.deepEqual(rules('const href = `/?issue=${id}`'), ['navigation/address'])
  assert.deepEqual(rules("url.searchParams.set('bot', id)"), ['navigation/address'])
  assert.deepEqual(rules("<Link href=\"/?section=artifacts\" />"), ['navigation/address'])
  assert.deepEqual(rules("url.searchParams.set('section', 'all-issues')"), ['navigation/address'])
})

test('the navigation module itself, comments and Settings sections pass', () => {
  assert.deepEqual(rules("window.history.pushState(null, '', url)", 'components/workspace/workspace-navigation.ts'), [])
  assert.deepEqual(rules('// opens /?issue=<id>\n/** e.g. ?bot=<id> */\nconst a = 1'), [])
  assert.deepEqual(rules("const href = '/settings?section=models'"), [])
  assert.deepEqual(rules("const href = 'https://example.com/?issue=1'"), ['navigation/address'])
})

test('an allowance covers exactly its count', () => {
  const file = 'components/nav-user.tsx'
  assert.deepEqual(rules('router.replace(a)', file), [])
  assert.deepEqual(rules('router.replace(a); router.push(b)', file), ['navigation/router'])
})
