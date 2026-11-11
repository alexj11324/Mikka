import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useSyncExternalStore } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { EnvironmentsView } from '../../app/actions/environments'
import type { saveEnvironment } from '../../app/actions/project-resources'

type SaveInput = Parameters<typeof saveEnvironment>[0]
const workspaceId = '11111111-1111-4111-8111-111111111111'
const environmentId = '22222222-2222-4222-8222-222222222222'
const projectId = '33333333-3333-4333-8333-333333333333'
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8'))
const lookup = (path: string) => path.split('.').reduce((node, part) => node?.[part], zh)
const translator = (namespace: string) => Object.assign((key: string, values?: Record<string, unknown>) => {
  const value = lookup(`${namespace}.${key}`)
  assert.equal(typeof value, 'string', `missing ${namespace}.${key}`)
  return (value as string).replace(/\{(\w+)\}/g, (match, name: string) => values?.[name] === undefined ? match : String(values[name]))
}, { has: (key: string) => typeof lookup(`${namespace}.${key}`) === 'string' })
mock.module('next-intl', { namedExports: { useTranslations: translator } })

let state: { data?: EnvironmentsView; error?: Error }
let server: EnvironmentsView
let read: () => Promise<EnvironmentsView>
let outcome: 'success' | 'business-denied' | 401 | 403
const writes: SaveInput[] = [], defaultWrites: unknown[] = []
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const publish = () => { for (const listener of listeners) listener() }
const snapshot = () => state
const mutate = async (...args: [EnvironmentsView?, { revalidate?: boolean }?]) => {
  // Model SWR's explicit erase separately from a parameterless revalidation.
  if (args.length && args[1]?.revalidate === false) state = { data: args[0] }
  else state = { data: await read() }
  publish()
  return state.data
}
mock.module('swr', { defaultExport: (_key: unknown, fetcher: typeof read) => {
  read = fetcher
  const current = useSyncExternalStore(subscribe, snapshot)
  return { ...current, mutate }
}, namedExports: { unstable_serialize: (key: unknown) => JSON.stringify(key) } })
mock.module(new URL('../../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKey: () => undefined } })
mock.module(new URL('../../app/actions/project-resources.ts', import.meta.url).href, { namedExports: {
  saveEnvironment: async (input: SaveInput) => {
    writes.push(structuredClone(input))
    if (outcome === 'business-denied') return { error: 'workspaceAccessDenied' }
    if (outcome !== 'success') throw Object.assign(new Error('synthetic transport refusal'), { status: outcome })
    return { id: input.id ?? environmentId, revision: (input.revision ?? 0) + 1 }
  },
  setProjectDefaultEnvironment: async (input: unknown) => { defaultWrites.push(input); return { revision: 2 } },
} })

const browser = new Window({ url: 'https://fixture.example/mikka/settings?section=environments' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let EnvironmentsSettings: typeof import('./environments-settings')['EnvironmentsSettings']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['HTMLElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ EnvironmentsSettings } = await import('./environments-settings'))
})
beforeEach(() => {
  const data: EnvironmentsView = { canManage: true, projects: [], environments: [{
    id: environmentId, name: 'Private environment fixture', revision: 7, archived: false,
    configuration: { runtime: 'local', harness: 'any', variables: {}, secretIds: [], repositoryKeys: [],
      setup: { command: 'node --version', copyFiles: ['fixture.local'], approved: false } },
  }] }
  state = { data }; server = structuredClone(data)
  outcome = 'success'; writes.length = 0; defaultWrites.length = 0
  mock.method(globalThis, 'fetch', async () => Response.json(server))
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); mock.restoreAll() })
after(() => browser.close())
const render = async () => { await act(async () => root.render(<EnvironmentsSettings workspaceId={workspaceId} />)) }
const edit = async () => {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${translator('Settings.environments')('editNamed', { name: state.data!.environments[0].name })}"]`)
  assert.ok(trigger)
  await act(async () => trigger.click())
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  assert.ok(dialog)
  return dialog
}
const submit = async (dialog: HTMLElement) => {
  const form = dialog.querySelector('form')
  assert.ok(form)
  await act(async () => { form.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event) })
}

test('renaming an existing unapproved setup keeps its approval and copied files', async () => {
  await render()
  const dialog = await edit()
  const input = dialog.querySelector<HTMLInputElement>('#environment-name')
  assert.ok(input)
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Renamed environment')
    input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
  })
  await submit(dialog)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].name, 'Renamed environment')
  assert.equal(writes[0].configuration.setup?.approved, false)
  assert.deepEqual(writes[0].configuration.setup?.copyFiles, ['fixture.local'])
  assert.equal(writes[0].configuration.setup?.command, 'node --version')
})

for (const failure of ['business-denied', 401, 403] as const) {
  test(`write refusal ${failure} closes the editor and erases its current read snapshot`, async () => {
    await render()
    const dialog = await edit()
    assert.equal(dialog.querySelector<HTMLTextAreaElement>('#environment-setup')?.value, 'node --version')
    outcome = failure
    await submit(dialog)
    assert.equal(writes.length, 1)
    assert.equal(state.data, undefined, 'the old authorized read must not remain available to this view')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(container.textContent?.includes('Private environment fixture'), false)
    assert.equal(document.querySelector('#environment-setup'), null)
  })
}

test('restoring an archived environment sends archived false without editing Project defaults', async () => {
  state.data!.environments[0].archived = true
  state.data!.projects = [{ id: projectId, name: 'Personal Project fixture', revision: 3, environmentId }]
  server = { ...structuredClone(state.data!), environments: [{ ...structuredClone(state.data!.environments[0]), archived: false, revision: 8 }] }
  await render()
  const restore = [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === zh.Settings.environments.restore)
  assert.ok(restore)
  await act(async () => restore.click())
  assert.equal(writes.length, 1)
  assert.equal(writes[0].archived, false)
  assert.equal(writes[0].id, environmentId)
  assert.equal(writes[0].revision, 7)
  assert.deepEqual(writes[0].configuration.setup, { command: 'node --version', copyFiles: ['fixture.local'], approved: false })
  assert.deepEqual(defaultWrites, [], 'restoration never rewrites a Project default')
  assert.equal(state.data?.projects[0].environmentId, environmentId)
  assert.equal(state.data?.environments[0].archived, false)
})
