import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// Interactive checks: retry re-entry, focus after retry, and the window's decision gate.
const zh = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8')).FactoryAcceptance
const lookup = (key: string, args?: Record<string, string>) => String(key.split('.').reduce((node, part) => node?.[part], zh) ?? key).replace(/\{(\w+)\}/g, (_, name) => args?.[name] ?? '')
type Swr = { data?: unknown; error?: unknown; isLoading: boolean; mutate: () => Promise<unknown> }
let list: Swr
let ledger: unknown
let evidence: unknown
mock.module('swr', { defaultExport: (key: string | null) => {
  if (key === null) return { data: undefined }
  if (key.includes('view=ledger')) return { data: ledger, mutate: async () => ledger }
  if (key.includes('/approval')) return { data: evidence }
  return list
} })
mock.module('next-intl', { namedExports: { useTranslations: () => lookup, useFormatter: () => ({ dateTime: () => '' }) } })
mock.module(new URL('../components/workspace/issue-thread-panel.tsx', import.meta.url).href, { namedExports: { IssueThreadPanel: () => null } })
const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
mock.module(new URL('../components/ui/dialog.tsx', import.meta.url).href, { namedExports: { Dialog: Pass, DialogContent: Pass, DialogTitle: Pass } })

const browser = new Window({ url: 'https://mikka.example/zh-CN' })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let FactoryAcceptance: typeof import('../components/workspace/factory-acceptance')['FactoryAcceptance']

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ FactoryAcceptance } = await import('../components/workspace/factory-acceptance'))
})
beforeEach(() => {
  ledger = { binding: {}, approvals: [], publications: [] }; evidence = undefined
  container = document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container as unknown as Node)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); (container as unknown as { remove(): void }).remove() })
after(() => browser.happyDOM.close())

const task = (patch: Record<string, unknown> = {}) => ({ id: 't1', issueId: 'issue-1', stage: 'approval', status: 'pending', reason: '独立检查通过', candidateId: 'c1', candidateRunId: null, isSkillCandidate: false, ...patch })
const render = async () => { await act(async () => root.render(<FactoryAcceptance issueId="issue-1" />)) }
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name) as unknown as HTMLButtonElement | undefined

test('retry fires once while a refetch is in flight', async () => {
  let calls = 0
  let finish: (value: unknown) => void = () => {}
  list = { error: new Error('down'), isLoading: false, mutate: () => { calls++; return new Promise(resolve => { finish = resolve }) } }
  await render()
  const retry = button('重试')!
  await act(async () => { retry.click(); retry.click(); retry.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }) as unknown as Event) })
  assert.equal(calls, 1)
  await act(async () => { finish(undefined) })
})

test('a successful retry moves focus to the list heading', async () => {
  const data = { tasks: [task()] }
  list = { error: new Error('down'), isLoading: false, mutate: async () => { list = { data, isLoading: false, mutate: async () => data }; return data } }
  await render()
  await act(async () => { button('重试')!.click() })
  await render()
  const heading = document.querySelector('h3')
  assert.ok(heading)
  assert.ok(document.activeElement === heading, `focus is on ${document.activeElement?.tagName}`)
})

test('the window hides 批准发布 when the candidate has no publishable environment', async () => {
  list = { data: { tasks: [task()] }, isLoading: false, mutate: async () => undefined }
  evidence = { binding: {}, evidenceReadId: 'r1', evidenceDigest: 'd', manifest: { candidate: { sha: 'a'.repeat(40), repository: 'alexj11324/Mikka', environment: 'staging', scope: 'x' }, artifacts: [] } }
  await render()
  await act(async () => { (document.querySelector('[data-slot="item"] button') as unknown as HTMLButtonElement).click() })
  assert.match(document.body.textContent ?? '', /待你确认/)
  assert.equal(Boolean(button('批准发布')), false, '批准发布 is hidden')
  evidence = { ...(evidence as object), manifest: { ...(evidence as { manifest: object }).manifest, candidate: { sha: 'a'.repeat(40), repository: 'alexj11324/Mikka', environment: 'preview', scope: 'x' } } }
  await render()
  assert.ok(button('批准发布'), 'a complete candidate shows 批准')
})

test('the window hides 发布 when the active approval has no publishable environment', async () => {
  list = { data: { tasks: [task({ stage: 'publish', status: 'running' })] }, isLoading: false, mutate: async () => undefined }
  const approval = { id: 'a1', candidateId: 'c1', candidate: { sha: 'a'.repeat(40), repository: 'r', environment: 'staging', scope: 'x' }, action: 'deploy', target: 't', targetEnvironment: 'staging', expiresAt: new Date(Date.now() + 3600000).toISOString(), revokedAt: null, createdAt: new Date().toISOString() }
  ledger = { binding: {}, approvals: [approval], publications: [] }
  await render()
  await act(async () => { (document.querySelector('[data-slot="item"] button') as unknown as HTMLButtonElement).click() })
  assert.ok(button('撤销批准'))
  assert.equal(Boolean(button('发布')), false, '发布 is hidden')
  ledger = { binding: {}, approvals: [{ ...approval, candidate: { ...approval.candidate, environment: 'preview' }, targetEnvironment: 'preview' }], publications: [] }
  await render()
  assert.ok(button('发布'))
})
