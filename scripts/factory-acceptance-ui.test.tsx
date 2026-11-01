import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

// Interactive checks: retry re-entry, focus after retry, and the 验收 pane's decision gate.
const zh = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8')).FactoryAcceptance
const lookup = (key: string, args?: Record<string, string>) => String(key.split('.').reduce((node, part) => node?.[part], zh) ?? key).replace(/\{(\w+)\}/g, (_, name) => args?.[name] ?? '')
type Swr = { data?: unknown; error?: unknown; isLoading: boolean; mutate: () => Promise<unknown> }
let list: Swr
let ledger: unknown
let evidence: unknown
let detail: unknown
mock.module('swr', { defaultExport: (key: string | null) => {
  if (key === null) return { data: undefined }
  if (key === '/api/factory/tasks/t1') return { data: detail, mutate: async () => detail }
  if (key.includes('view=ledger')) return { data: ledger, mutate: async () => ledger }
  if (key.includes('/approval')) return { data: evidence }
  return list
} })
mock.module('next-intl', { namedExports: { useTranslations: () => lookup, useFormatter: () => ({ dateTime: () => '' }) } })
mock.module(new URL('../components/workspace/issue-thread-panel.tsx', import.meta.url).href, { namedExports: { IssueThreadPanel: () => null } })
const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
mock.module(new URL('../components/ui/dialog.tsx', import.meta.url).href, { namedExports: { Dialog: Pass, DialogContent: Pass, DialogHeader: Pass, DialogTitle: Pass, DialogFooter: Pass } })
mock.module(new URL('../components/workspace/factory-reject-note.tsx', import.meta.url).href, { namedExports: { RejectNote: () => null } })

const browser = new Window({ url: 'https://mikka.example/zh-CN' })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let FactoryAcceptance: typeof import('../components/workspace/factory-acceptance')['FactoryAcceptance']
let FactoryAcceptancePane: typeof import('../components/workspace/factory-acceptance-pane')['FactoryAcceptancePane']
let CandidateMachine: typeof import('../components/workspace/factory-acceptance-pane')['CandidateMachine']

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ FactoryAcceptance } = await import('../components/workspace/factory-acceptance'))
  ;({ FactoryAcceptancePane, CandidateMachine } = await import('../components/workspace/factory-acceptance-pane'))
})
beforeEach(() => {
  ledger = { binding: {}, approvals: [], publications: [], merges: [] }; evidence = undefined; detail = undefined
  container = document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container as unknown as Node)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); (container as unknown as { remove(): void }).remove() })
after(() => browser.happyDOM.close())

const task = (patch: Record<string, unknown> = {}) => ({ id: 't1', issueId: 'issue-1', stage: 'approval', status: 'pending', reason: '独立检查通过', candidateId: 'c1', candidateRunId: null, isSkillCandidate: false, ...patch })
const render = async () => { await act(async () => root.render(<FactoryAcceptance issueId="issue-1" />)) }
const pane = async (patch: Record<string, unknown> = {}) => { await act(async () => root.render(<FactoryAcceptancePane task={task(patch)} />)) }
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

test('the row opens acceptance for its task', async () => {
  const opened: unknown[] = []
  list = { data: { tasks: [task()] }, isLoading: false, mutate: async () => undefined }
  await act(async () => root.render(<FactoryAcceptance issueId="issue-1" onOpen={value => opened.push(value)} />))
  await act(async () => { (document.querySelector('[data-slot="item"] button') as unknown as HTMLButtonElement).click() })
  assert.deepEqual(opened, [task()])
})

test('验收并合并 needs the candidate PR, posts only the binding, and a refusal names GitHub\'s reason with 在 GitHub 打开', async () => {
  const pr = 'https://github.com/alexj11324/Mikka/pull/418'
  const delivery = (pullRequest: unknown) => ({ checks: [], delivery: { candidateSha: 'a'.repeat(40), pullRequest, repository: 'alexj11324/Mikka', environment: null, previewUrl: null, deploymentEnvironment: null } })
  list = { data: { tasks: [task()] }, isLoading: false, mutate: async () => undefined }
  evidence = { binding: {}, manifest: { candidate: { sha: 'a'.repeat(40), repository: 'alexj11324/Mikka', environment: 'preview', scope: 'x' }, artifacts: [] } }
  ledger = { binding: { taskId: 't1', revision: 3 }, approvals: [], publications: [], merges: [] }
  detail = delivery(null)
  await pane()
  assert.equal(Boolean(button('验收并合并')), false, 'no PR, nothing to merge')
  assert.doesNotMatch(document.body.textContent ?? '', /有效|批准/)
  detail = delivery({ url: pr, state: 'open' })
  await pane()
  const sent: unknown[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    sent.push(JSON.parse(init?.body ?? 'null'))
    return new Response(JSON.stringify({ error: 'githubMergeBlocked', pullRequestUrl: pr }), { status: 409 })
  }) as typeof fetch
  try {
    await act(async () => { button('验收并合并')!.click() })
  } finally { globalThis.fetch = realFetch }
  assert.equal(sent.length, 1)
  const [body] = sent as { operation: string; input: Record<string, unknown> }[]
  assert.equal(body.operation, 'accept')
  assert.deepEqual(Object.keys(body.input).sort(), ['binding', 'eventId'])
  assert.deepEqual(body.input.binding, { taskId: 't1', revision: 3 })
  assert.match(document.body.textContent ?? '', /无法合并/)
  assert.match(document.body.textContent ?? '', /检查或审批未通过/)
  const link = [...document.querySelectorAll('a')].find(a => a.textContent?.includes('在 GitHub 打开'))
  assert.equal(link?.getAttribute('href'), pr)
  assert.ok(button('验收并合并'), 'the task keeps waiting: accept again')
})

test('merging and merged read from the merge ledger; merged opens the PR', async () => {
  const pr = 'https://github.com/alexj11324/Mikka/pull/418'
  detail = { checks: [], delivery: { candidateSha: 'a'.repeat(40), pullRequest: { url: pr, state: 'open' }, repository: 'alexj11324/Mikka', environment: null, previewUrl: null, deploymentEnvironment: null } }
  evidence = { binding: {}, manifest: { candidate: { sha: 'a'.repeat(40), repository: 'alexj11324/Mikka', environment: 'preview', scope: 'x' }, artifacts: [] } }
  ledger = { binding: {}, approvals: [], publications: [], merges: [{ candidateId: 'c1', status: 'merging', code: null, pullRequestUrl: pr, createdAt: new Date().toISOString() }] }
  await pane()
  assert.match(document.body.textContent ?? '', /合并中/)
  assert.equal(Boolean(button('验收并合并')), false)
  ledger = { binding: {}, approvals: [], publications: [], merges: [{ candidateId: 'c1', status: 'merged', code: null, pullRequestUrl: pr, createdAt: new Date().toISOString() }] }
  await pane({ stage: 'publish', status: 'passed' })
  assert.match(document.body.textContent ?? '', /已合并/)
  assert.equal([...document.querySelectorAll('a')].find(a => a.textContent?.includes('在 GitHub 打开'))?.getAttribute('href'), pr)
})

test('a skill: the pane hides 发布 when the active approval has no publishable environment', async () => {
  list = { data: { tasks: [task({ stage: 'publish', status: 'running', isSkillCandidate: true })] }, isLoading: false, mutate: async () => undefined }
  const approval = { id: 'a1', candidateId: 'c1', candidate: { sha: 'a'.repeat(40), repository: 'r', environment: 'staging', scope: 'x' }, action: 'deploy', target: 't', targetEnvironment: 'staging', expiresAt: new Date(Date.now() + 3600000).toISOString(), revokedAt: null, createdAt: new Date().toISOString() }
  ledger = { binding: {}, approvals: [approval], publications: [] }
  await pane({ stage: 'publish', status: 'running', isSkillCandidate: true })
  assert.ok(button('撤销批准'))
  assert.equal(Boolean(button('发布')), false, '发布 is hidden')
  ledger = { binding: {}, approvals: [{ ...approval, candidate: { ...approval.candidate, environment: 'preview' }, targetEnvironment: 'preview' }], publications: [] }
  await pane({ stage: 'publish', status: 'running', isSkillCandidate: true })
  assert.ok(button('发布'))
})

test('a skill: a failed publication shows 发布失败，批准仍保留 with 撤销批准 and 发布', async () => {
  list = { data: { tasks: [task({ stage: 'publish', status: 'running', isSkillCandidate: true })] }, isLoading: false, mutate: async () => undefined }
  const approval = { id: 'a1', candidateId: 'c1', candidate: { sha: 'a'.repeat(40), repository: 'r', environment: 'preview', scope: 'x' }, action: 'deploy', target: 't', targetEnvironment: 'preview', expiresAt: new Date(Date.now() + 3600000).toISOString(), revokedAt: null, createdAt: new Date().toISOString() }
  ledger = { binding: {}, approvals: [approval], publications: [{ id: 'p1', approvalId: 'a1', status: 'failed', request: {} }] }
  await pane({ stage: 'publish', status: 'running', isSkillCandidate: true })
  assert.match(document.body.textContent ?? '', /发布失败，批准仍保留/)
  assert.ok(button('撤销批准'))
  assert.ok(button('发布'))
})

// #541 fixture: the task detail fields the backend adds for frame 06.
const delivery = { candidateSha: 'a3f9c2e'.padEnd(40, 'b'), pullRequest: { url: 'https://github.com/alexj11324/Mikka/pull/418', state: 'open', title: 'perf(home): 首屏图片懒加载与字体子集' }, repository: 'alexj11324/Mikka', previewUrl: null, previewDatabaseBranch: 'preview/mik-48', machine: { name: 'Alex 的 MacBook', kind: 'device' } }

test('the candidate card shows the PR title and the preview database branch (#541)', async () => {
  detail = { checks: [], delivery }
  evidence = { binding: {}, manifest: { candidate: { sha: delivery.candidateSha, repository: 'alexj11324/Mikka', environment: 'preview', scope: '' }, artifacts: [] } }
  await pane()
  const card = document.querySelector('section[aria-label="候选版本"]')
  assert.ok(card?.textContent?.includes('#418perf(home): 首屏图片懒加载与字体子集'))
  assert.ok(card?.textContent?.includes('Preview · Neon preview/mik-48'))
  assert.ok(!card?.textContent?.includes('alexj11324/Mikka'), 'the title replaces the repository')
})

test('without the #541 fields the card falls back to the repository and the bare environment', async () => {
  detail = { checks: [], delivery: { ...delivery, pullRequest: { url: delivery.pullRequest.url, state: 'open' }, previewDatabaseBranch: undefined, machine: undefined } }
  evidence = { binding: {}, manifest: { candidate: { sha: delivery.candidateSha, repository: 'alexj11324/Mikka', environment: 'preview', scope: '' }, artifacts: [] } }
  await pane()
  const card = document.querySelector('section[aria-label="候选版本"]')
  assert.ok(card?.textContent?.includes('alexj11324/Mikka'))
  assert.ok(!card?.textContent?.includes('Neon'))
})

test('the header names the machine that produced the candidate, and nothing when unknown', async () => {
  detail = { checks: [], delivery }
  await act(async () => root.render(<CandidateMachine taskId="t1" />))
  assert.equal(container.textContent, 'Alex 的 MacBook')
  detail = { checks: [], delivery: { ...delivery, machine: null } }
  await act(async () => root.render(<CandidateMachine taskId="t1" />))
  assert.equal(container.textContent, '')
})
