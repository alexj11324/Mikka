import assert from 'node:assert/strict'
import test from 'node:test'
import { auditPolling, auditRepository, findPolling, pollingAllowlist, pollingMessage, staleAllowlistEntries } from './polling-policy.mjs'

const rules = source => findPolling('components/example.tsx', source).map(d => d.rule)

test('no polling outside the allowlist, and no allowlisted file polls more than it did', () => {
  assert.deepEqual(auditRepository().map(d => `${d.file}:${d.line}:${d.column} ${d.rule}`), [])
})

test('the allowlist has no stale entries: a replaced poller leaves the list', () => {
  assert.deepEqual(staleAllowlistEntries(), [])
})

test('every allowlist entry says why, and is a non-data timer, an external API or a tracked database poll', () => {
  for (const [file, entry] of Object.entries(pollingAllowlist)) {
    assert.ok(entry.reason?.length > 10, file)
    assert.ok(Number.isInteger(entry.hits) && entry.hits > 0, file)
    if (entry.tracking) {
      assert.equal(entry.tracking, '#1212', file)
      assert.equal(entry.kind, undefined, file)
      assert.match(entry.replaceWith, /^(?:hooks|lib)\//, file)
    } else assert.ok(['ui-timer', 'external', 'local', 'keepalive'].includes(entry.kind), file)
  }
})

test('a stale entry is reported: an allowlisted file with no polling fails', () => {
  const allowlist = { 'package.json': { kind: 'ui-timer', reason: 'this file has no polling', hits: 1 } }
  assert.deepEqual(staleAllowlistEntries(allowlist), ['package.json: no polling left; delete its pollingAllowlist entry'])
  assert.match(staleAllowlistEntries({ 'components/gone.tsx': { kind: 'ui-timer', reason: 'deleted file', hits: 1 } })[0], /no longer exists/)
})

test('an allowlisted file may keep its polls but not add one', () => {
  const allowlist = { 'components/example.tsx': { tracking: '#1212', replaceWith: 'hooks/use-live-key.tsx', reason: 'one tracked poll', hits: 1 } }
  const one = "useSWR(key, read, { refreshInterval: 5000 })"
  assert.deepEqual(auditPolling('components/example.tsx', one, allowlist), [])
  assert.equal(auditPolling('components/example.tsx', `${one}\nsetInterval(tick, 1000)`, allowlist).length, 2)
  assert.equal(auditPolling('components/other.tsx', one, allowlist)[0].message, pollingMessage)
})

test('the message points to live push and #1212', () => {
  assert.match(pollingMessage, /不要新增轮询/)
  assert.match(pollingMessage, /hooks\/use-live-key\.tsx/)
  assert.match(pollingMessage, /lib\/live\/\*/)
  assert.match(pollingMessage, /#1212/)
  assert.match(pollingMessage, /allowlist/)
})

for (const [name, source, rule] of [
  ['SWR refreshInterval', "useSWR(key, read, { refreshInterval: 5000 })", 'polling/refresh-interval'],
  ['SWR refreshInterval from a constant', "useSWR(key, read, { refreshInterval: LIST_MS })", 'polling/refresh-interval'],
  ['SWR refreshInterval as a function', "useSWR(key, read, { refreshInterval: data => data ? 2000 : 0 })", 'polling/refresh-interval'],
  ['SWR refreshInterval behind a condition', "useSWR(key, read, { refreshInterval: open ? 0 : 60_000 })", 'polling/refresh-interval'],
  ['SWR refreshInterval shorthand', "useSWR(key, read, { refreshInterval, dedupingInterval: 0 })", 'polling/refresh-interval'],
  ['SWRConfig refreshInterval prop', "<SWRConfig value={x} refreshInterval={5000} />", 'polling/refresh-interval'],
  ['React Query refetchInterval', "useQuery({ queryKey, queryFn, refetchInterval: 10_000 })", 'polling/refresh-interval'],
  ['setInterval', "const id = setInterval(load, 1000)", 'polling/set-interval'],
  ['window.setInterval', "window.setInterval(load, 1000)", 'polling/set-interval'],
  ['a _POLL_MS constant', "const STATUS_POLL_MS = 3000", 'polling/poll-constant'],
  ['a POLL_INTERVAL constant', "export const QUOTA_POLL_INTERVAL_MS = 60_000", 'polling/poll-constant'],
  ['an _EVERY_MS constant', "const SYNC_EVERY_MS = 30_000", 'polling/poll-constant'],
  ['while loop awaiting sleep', "while (!done) { await check(); await sleep(1000) }", 'polling/sleep-loop'],
  ['one-line while awaiting sleep', "while (!(await read()).done) await sleep('30s')", 'polling/sleep-loop'],
  ['for (;;) awaiting setTimeout', "for (;;) {\n  if (await ready()) return\n  await new Promise(resolve => setTimeout(resolve, 500))\n}", 'polling/sleep-loop'],
  ['long counted loop awaiting delay', "for (let step = 0; step < 1440; step++) { await tick(); await delay(30_000) }", 'polling/sleep-loop'],
  ['mobile useApi with an interval', "const page = useApi<Page>(`/api/x/${id}`, 15_000)", 'polling/helper'],
  ['mobile useApi with a numeric interval binding', "const interval = 15_000; const page = useApi<Page>(path, interval)", 'polling/helper'],
  ['pollUntil', "await pollUntil(() => read(), value => value.ok)", 'polling/helper'],
]) test(`rejects ${name}`, () => assert.ok(rules(source).includes(rule), `${source} -> ${rules(source)}`))

for (const [name, source] of [
  ['SWR polling off with 0', "useSWR(key, read, { refreshInterval: 0, revalidateOnFocus: false })"],
  ['SWR polling off with false', "useQuery({ queryKey, refetchInterval: false })"],
  ['SWR polling off on its own line', "useSWR(key, read, {\n  refreshInterval: 0\n})"],
  ['a type that mentions setInterval', "let timer: ReturnType<typeof setInterval> | null = null"],
  ['clearInterval', "clearInterval(timer)"],
  ['a one-off setTimeout', "setTimeout(() => setOpen(false), 300)"],
  ['a short bounded retry', "for (let attempt = 0; attempt < 3; attempt++) { try { return await send() } catch {} await delay(250) }"],
  ['for…of with a delay', "for (const step of steps) { await wait(100); show(step) }"],
  ['a loop with no delay', "while (queue.length) await handle(queue.shift())"],
  ['mobile useApi without an interval', "const page = useApi<Page>(`/api/x/${id}`)"],
  ['mobile useApi with a read decoder', "const page = useApi<Page>(ready ? filePath(id, path, ref) : null, readFilePath)"],
  ['mobile useApi with an inline read decoder', "const page = useApi<Page>(path, async path => decode(await api(path)))"],
  ['useApi definition', "export function useApi<T>(path: string | null, every = 0) {}"],
  ['a non-polling constant', "const FRESH_FOR_MS = 60_000"],
]) test(`allows ${name}`, () => assert.deepEqual(rules(source), [], source))
