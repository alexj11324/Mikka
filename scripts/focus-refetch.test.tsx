import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { act, useState } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

const browser = new Window({ url: 'https://mikka.example/en' })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig']
let useSWR: typeof import('swr')['default']
let SWRDefaults: typeof import('../components/swr-defaults')['SWRDefaults']
let useCheckOnReturn: typeof import('../lib/hooks/use-check-on-return')['useCheckOnReturn']

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig, default: useSWR } = await import('swr'))
  ;({ SWRDefaults } = await import('../components/swr-defaults'))
  ;({ useCheckOnReturn } = await import('../lib/hooks/use-check-on-return'))
})
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => { root.unmount() }); container.remove() })
after(() => { browser.close() })

const wait = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }) }
const comeBack = async () => {
  await act(async () => {
    browser.dispatchEvent(new browser.Event('focus'))
    browser.document.dispatchEvent(new browser.Event('visibilitychange'))
  })
  await wait()
}

let reads = 0
const shown: string[] = []
let poke: () => Promise<unknown> = async () => undefined
function Reader({ options = {} }: { options?: Record<string, unknown> }) {
  const { data, isLoading, mutate } = useSWR('focus-reader', async () => { reads++; return `read ${reads}` }, { dedupingInterval: 0, ...options })
  poke = mutate
  const text = isLoading ? 'loading' : data ?? ''
  shown.push(text)
  return <p>{text}</p>
}
// Each render gets its own cache, so only the configuration differs.
const fresh = () => new Map()
const FRESH = 200
const sleep = async (ms: number) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }

test('plain SWR re-reads on every focus, which is why the site gates it', async () => {
  reads = 0
  await act(async () => { root.render(<SWRConfig value={{ provider: fresh }}><Reader options={{ focusThrottleInterval: 0 }} /></SWRConfig>) })
  await wait()
  assert.equal(reads, 1)
  await comeBack()
  assert.equal(reads, 2)
})

test('site defaults: focus within the freshness threshold sends no request', async () => {
  reads = 0
  await act(async () => { root.render(<SWRDefaults><SWRConfig value={{ provider: fresh, focusThrottleInterval: FRESH }}><Reader /></SWRConfig></SWRDefaults>) })
  await wait()
  for (let round = 0; round < 3; round++) {
    await comeBack()
    assert.equal(reads, 1)
    assert.equal(container.textContent, 'read 1')
  }
})

test('site defaults: past the threshold one focus revalidates once, silently', async () => {
  reads = 0; shown.length = 0
  await act(async () => { root.render(<SWRDefaults><SWRConfig value={{ provider: fresh, focusThrottleInterval: FRESH }}><Reader /></SWRConfig></SWRDefaults>) })
  await wait()
  await sleep(FRESH + 50)
  await comeBack()
  await comeBack()
  assert.equal(reads, 2)
  assert.equal(container.textContent, 'read 2')
  // Nothing but the two answers ever reached the screen after the first load.
  assert.deepEqual([...new Set(shown.slice(shown.indexOf('read 1')))], ['read 1', 'read 2'])
})

test('site defaults: a fresh answer from a poll or mutate counts, not just the mount', async () => {
  reads = 0
  await act(async () => { root.render(<SWRDefaults><SWRConfig value={{ provider: fresh, focusThrottleInterval: FRESH }}><Reader /></SWRConfig></SWRDefaults>) })
  await wait()
  await sleep(FRESH + 50)
  await act(async () => { await poke() })
  assert.equal(reads, 2)
  await comeBack()
  assert.equal(reads, 2)
})

test('site defaults: a hook that turns focus off is never revalidated on focus', async () => {
  reads = 0
  await act(async () => { root.render(<SWRDefaults><SWRConfig value={{ provider: fresh, focusThrottleInterval: FRESH }}><Reader options={{ revalidateOnFocus: false }} /></SWRConfig></SWRDefaults>) })
  await wait()
  await sleep(FRESH + 50)
  await comeBack()
  assert.equal(reads, 1)
})

let checks = 0
let arm: () => void = () => {}
function HandOff() {
  const [, rerender] = useState(0)
  arm = useCheckOnReturn(() => { checks++; rerender(count => count + 1) })
  return null
}

test('a return check runs once after a hand-off and never on plain focus', async () => {
  checks = 0
  await act(async () => { root.render(<HandOff />) })
  await comeBack()
  assert.equal(checks, 0)
  await act(async () => { arm() })
  await comeBack()
  assert.equal(checks, 1)
  await comeBack()
  assert.equal(checks, 1)
})

test('a return check armed twice still runs once and unmounting cancels it', async () => {
  checks = 0
  await act(async () => { root.render(<HandOff />) })
  await act(async () => { arm(); arm() })
  await comeBack()
  assert.equal(checks, 1)
  await act(async () => { arm() })
  await act(async () => { root.unmount() })
  root = createRoot(container)
  await comeBack()
  assert.equal(checks, 1)
})
