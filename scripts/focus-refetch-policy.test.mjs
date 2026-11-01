import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { auditFocusRefetch, auditRepository, focusListenerAllowlist } from './focus-refetch-policy.mjs'

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

test('the site turns focus revalidation off for every SWR hook', () => {
  assert.match(readFileSync('components/swr-defaults.tsx', 'utf8'), /revalidateOnFocus: false/)
  assert.match(readFileSync('app/[locale]/layout.tsx', 'utf8'), /<SWRDefaults>\{children\}<\/SWRDefaults>/)
  assert.match(readFileSync('components/workspace-app.tsx', 'utf8'), /\.\.\.swrDefaults, provider/)
})

for (const [name, source] of [
  ['SWR focus on', "useSWR(key, read, { revalidateOnFocus: true })"],
  ['SWR focus by condition', "useSWR(key, read, { revalidateOnFocus: !busy })"],
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
]) test(`allows ${name}`, () => assert.deepEqual(rules(source), [], source))

test('an allowlisted file may listen, but not turn SWR focus on', () => {
  const file = 'components/nav/bot-avatar.tsx'
  assert.deepEqual(rules("document.addEventListener('visibilitychange', resync)", file), [])
  assert.deepEqual(rules("useSWR(key, read, { revalidateOnFocus: true })", file), ['focus/swr-revalidate-on-focus'])
})
