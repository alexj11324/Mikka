import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { auditFocusRefetch, auditRepository, focusListenerAllowlist, thirdPartyStatusFiles } from './focus-refetch-policy.mjs'

const rules = (source, file = 'components/example.tsx') => auditFocusRefetch(file, source).map(d => d.rule)

test('nothing in the repository re-reads data on focus, visibility or foreground', () => {
  assert.deepEqual(auditRepository().map(d => `${d.file}:${d.line}:${d.column} ${d.rule}`), [])
})

test('every allowlisted listener exists and says why it is not a re-read', () => {
  for (const [file, reason] of Object.entries(focusListenerAllowlist)) {
    assert.ok(existsSync(file), file)
    assert.ok(reason.length > 10, file)
    assert.match(readFileSync(file, 'utf8'), /addEventListener\(\s*['"](?:focus|visibilitychange|pageshow|change)['"]/, file)
  }
})

test('every SWR hook gets the site defaults: focus behind the freshness gate, polling only while visible', () => {
  const defaults = readFileSync('components/swr-defaults.tsx', 'utf8')
  assert.match(defaults, /use: \[staleOnFocus\]/)
  assert.match(defaults, /focusThrottleInterval: FRESH_FOR_MS/)
  assert.match(defaults, /refreshWhenHidden: false/)
  assert.match(defaults, /FRESH_FOR_MS = 60_000/)
  assert.match(readFileSync('app/[locale]/layout.tsx', 'utf8'), /<SWRDefaults>\{children\}<\/SWRDefaults>/)
})

test('third-party status files exist and turn focus off', () => {
  for (const file of thirdPartyStatusFiles) assert.ok(existsSync(file), file)
  assert.deepEqual(rules("useSWR(key, read, { refreshInterval: 0 })", thirdPartyStatusFiles[0]), ['focus/third-party-status'])
  assert.deepEqual(rules("useSWR(key, read, { revalidateOnFocus: false })", thirdPartyStatusFiles[0]), [])
})

for (const [name, source] of [
  ['SWR focus on', "useSWR(key, read, { revalidateOnFocus: true })"],
  ['polling while hidden', "useSWR(key, read, { refreshInterval: 2000, refreshWhenHidden: true })"],
  ['react-query focus refetch', "useQuery({ queryKey, queryFn, refetchOnWindowFocus: true })"],
  ['react-query focus manager', "focusManager.setEventListener(handle)"],
  ['window focus listener', "window.addEventListener('focus', reload)"],
  ['visibility listener', 'document.addEventListener("visibilitychange", reload)'],
  ['pageshow listener', "window.addEventListener('pageshow', reload)"],
  ['app foreground listener', "AppState.addEventListener('change', state => { if (state === 'active') reload() })"],
]) test(`rejects ${name}`, () => assert.ok(rules(source).length > 0, source))

for (const [name, source] of [
  ['SWR focus off', "useSWR(key, read, { revalidateOnFocus: false })"],
  ['SWR focus off on its own line', "useSWR(key, read, {\n  revalidateOnFocus:\n    false,\n})"],
  ['react-query focus off', "useQuery({ queryKey, refetchOnWindowFocus: false })"],
  ['focus inside an element', "node.addEventListener('focusin', open)"],
  ['explicit polling', "useSWR(key, read, { refreshInterval: 15000 })"],
  ['focus paused by condition', "useSWR(key, read, { revalidateOnFocus: !dragging })"],
]) test(`allows ${name}`, () => assert.deepEqual(rules(source), [], source))

test('an allowlisted file may listen, but not turn SWR focus on', () => {
  const file = 'components/nav/bot-avatar.tsx'
  assert.deepEqual(rules("document.addEventListener('visibilitychange', resync)", file), [])
  assert.deepEqual(rules("useSWR(key, read, { revalidateOnFocus: true })", file), ['focus/swr-revalidate-on-focus'])
})
