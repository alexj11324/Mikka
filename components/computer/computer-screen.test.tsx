import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ComponentProps } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { ComputerState } from '@/lib/computer/types'

let state: ComputerState = { machine: 'sleeping', control: 'idle' }
let requests = 0
let finishWake: (value: null) => void
let failWake: (error: Error) => void
const failures: string[] = []
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key } })
mock.module('sonner', { namedExports: { toast: { error: (message: string) => failures.push(message) } } })
mock.module(new URL('../../hooks/use-computer.ts', import.meta.url).href, { namedExports: {
  useComputer: () => ({ data: state, mutate: async () => state }),
  useViewerGrant: () => ({}),
} })
mock.module(new URL('../../lib/computer/client.ts', import.meta.url).href, { namedExports: { computerApi: {
  wake: () => { requests++; return new Promise<null>((resolve, reject) => { finishWake = resolve; failWake = reject }) },
} } })
mock.module(new URL('../ui/button.tsx', import.meta.url).href, { namedExports: { Button: ({ size: _size, variant: _variant, ...props }: ComponentProps<'button'> & { size?: string; variant?: string }) => <button {...props} /> } })
mock.module(new URL('../ui/progress.tsx', import.meta.url).href, { namedExports: { Progress: (props: { 'aria-label': string }) => <div role="progressbar" aria-label={props['aria-label']} /> } })

const browser = new Window()
let root: Root
let container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let ComputerScreen: typeof import('./computer-screen')['ComputerScreen']
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ComputerScreen } = await import('./computer-screen'))
})
beforeEach(() => {
  state = { machine: 'sleeping', control: 'idle' }; requests = 0; failures.length = 0
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())
const render = async () => { await act(async () => root.render(<ComputerScreen botId="fixture-bot" name="Fixture" />)) }

test('rapid wake clicks send one request and show progress while a sleeping poll is stale', async () => {
  await render()
  const button = container.querySelector('button')!
  await act(async () => { button.click(); button.click() })
  assert.equal(requests, 1)
  assert.ok(container.querySelector('[role="progressbar"][aria-label="waking"]'))
  assert.equal(container.querySelector('button'), null)
  state = { machine: 'waking', control: 'idle' }
  await act(async () => finishWake(null))
  assert.deepEqual(failures, [])
  assert.ok(container.querySelector('[aria-label="waking"]'))
})

test('a real wake failure is visible and releases the button for an explicit retry', async () => {
  await render()
  await act(async () => container.querySelector('button')!.click())
  await act(async () => failWake(new Error('provider unavailable')))
  assert.deepEqual(failures, ['wakeFailed'])
  assert.equal(container.querySelector('button')?.textContent, 'wake')
  await act(async () => container.querySelector('button')!.click())
  assert.equal(requests, 2)
  state = { machine: 'waking', control: 'idle' }
  await act(async () => finishWake(null))
})
