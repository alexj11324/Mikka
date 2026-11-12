import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { ViewStateProvider } from '../lib/hooks/view-state'
import type { LiveSocket } from '../lib/live/channel'

// Interactive checks: retry re-entry, focus after retry, and the 验收 pane's decision gate.
const zh = JSON.parse(readFileSync(new URL('../messages/zh-CN.json', import.meta.url), 'utf8'))
const lookup = (key: string, args?: Record<string, string>) => String(key.split('.').reduce((node, part) => node?.[part], zh) ?? key).replace(/\{(\w+)\}/g, (_, name) => args?.[name] ?? '')
const translators = new Map<string, typeof lookup>()
const translationsFor = (namespace = '') => {
  let translate = translators.get(namespace)
  if (!translate) {
    translate = (key, args) => lookup(namespace ? `${namespace}.${key}` : key, args)
    translators.set(namespace, translate)
  }
  return translate
}
type Swr = { data?: unknown; error?: unknown; isLoading: boolean; mutate: () => Promise<unknown> }
const cache = new Map()
let list: Swr
let ledger: unknown
let evidence: unknown
let detail: unknown
let publicFlow: unknown
let detailTaskId = 't1'
let detailReloads = 0
let ledgerReloads = 0
let listReloadKeys: string[] = []
let refreshFails = false
mock.module('swr', { defaultExport: (key: string | null) => {
  if (key === null) return { data: undefined }
  if (key === `/api/factory/tasks/${detailTaskId}`) return { data: detail, mutate: async () => { detailReloads++; if (refreshFails) throw new Error('detail unavailable'); return detail } }
  if (key === `/api/factory/tasks/${detailTaskId}/flow`) return { data: publicFlow, mutate: async () => publicFlow }
  if (key.includes('view=ledger')) return { data: ledger, mutate: async () => { ledgerReloads++; if (refreshFails) throw new Error('ledger unavailable'); return ledger } }
  if (key.includes('/approval')) return { data: evidence }
  return list
}, namedExports: { useSWRConfig: () => ({ cache, mutate: async (key: string) => {
  listReloadKeys.push(key)
  if (refreshFails) throw new Error('list unavailable')
  return list?.data
} }) } })
// The report's CI checks row reads the review summary (its own SWR and live keys); these tests cover the flow, not that row.
mock.module(new URL('../hooks/code-review/use-review-summary.ts', import.meta.url).href, { namedExports: { useReviewSummary: () => ({ data: undefined }) } })
mock.module('next-intl', { namedExports: { useTranslations: translationsFor, useFormatter: () => ({
  dateTime: (value: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...options }).format(value),
  relativeTime: () => '',
}), useNow: () => new Date('2026-11-05T01:00:00.000Z') } })
mock.module(new URL('../components/workspace/issue-thread-panel.tsx', import.meta.url).href, { namedExports: { IssueThreadPanel: () => null } })
// The report's diff rows use @pierre/diffs, which registers a web component on import; they draw only in a browser.
mock.module(new URL('../components/workspace/thread-changes.tsx', import.meta.url).href, { namedExports: {
  ThreadChangesPane: () => null, ThreadChangesView: () => null, ChangesTabLabel: () => null, Counts: () => null, FileSection: () => null,
  useDiffWrap: () => ['nowrap', () => {}],
} })
const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
mock.module(new URL('../components/ui/dialog.tsx', import.meta.url).href, { namedExports: { Dialog: Pass, DialogContent: Pass, DialogHeader: Pass, DialogTitle: Pass, DialogFooter: Pass } })
mock.module(new URL('../components/workspace/factory-reject-note.tsx', import.meta.url).href, { namedExports: { RejectNote: () => null } })

const browser = new Window({ url: 'https://mikka.example/zh-CN' })
const originalFrames = {
  requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'),
  cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'),
}
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let LiveProvider: typeof import('../hooks/use-live-key')['LiveProvider']
let FactoryAcceptance: typeof import('../components/workspace/factory-acceptance')['FactoryAcceptance']
let FactoryAcceptancePane: typeof import('../components/workspace/factory-acceptance-pane')['FactoryAcceptancePane']
let CandidateMachine: typeof import('../components/workspace/factory-acceptance-pane')['CandidateMachine']

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: browser.requestAnimationFrame.bind(browser) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: browser.cancelAnimationFrame.bind(browser) })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ LiveProvider } = await import('../hooks/use-live-key'))
  ;({ FactoryAcceptance } = await import('../components/workspace/factory-acceptance'))
  ;({ FactoryAcceptancePane, CandidateMachine } = await import('../components/workspace/factory-acceptance-pane'))
})
beforeEach(() => {
  cache.clear()
  detailTaskId = 't1'
  ledger = { binding: {}, approvals: [], publications: [], merges: [] }; evidence = undefined; detail = {}; publicFlow = undefined
  detailReloads = 0; ledgerReloads = 0; listReloadKeys = []; refreshFails = false
  container = document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container as unknown as Node)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); (container as unknown as { remove(): void }).remove() })
after(async () => {
  await browser.happyDOM.close()
  for (const key of ['requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const descriptor = originalFrames[key]
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

const task = (patch: Record<string, unknown> = {}) => ({ id: 't1', issueId: 'issue-1', stage: 'approval', status: 'pending', reason: '独立检查通过', candidateId: 'c1', candidateRunId: null, isSkillCandidate: false, ...patch })
const render = async () => { await act(async () => root.render(<FactoryAcceptance issueId="issue-1" />)) }
const pane = async (patch: Record<string, unknown> = {}) => { await act(async () => root.render(<FactoryAcceptancePane task={task(patch)} />)) }
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name) as unknown as HTMLButtonElement | undefined

test('v2 acceptance keeps the public handoff until a merged flow, with the existing candidate-bound merge action', async () => {
  const binding = { taskId: 't1', issueId: 'issue-1', attemptId: 'a1', candidateId: 'c1', revision: 8 }
  const candidate = { sha: 'a'.repeat(40), repository: 'o/r', environment: 'device:fixture', scope: 'repo' }
  ledger = { binding, approvals: [], publications: [], merges: [] }
  evidence = { binding, manifest: { candidate, artifacts: [] } }
  detail = { task: { ...task({ stage: 'publish', status: 'passed' }), route: { flowVersion: 2 }, revision: 8 }, checks: [],
    delivery: { candidateSha: candidate.sha, pullRequest: { url: 'https://github.com/o/r/pull/7', state: 'open' } } }
  const flow = { version: 2, id: 't1', issueId: 'issue-1', botId: 'bot', revision: 8, stage: 'handoff', stages: ['implement', 'review', 'handoff'],
    needsYou: { kind: 'pr_review', since: '2026-11-05T00:00:00Z' }, review: null, acceptance: null, pullRequest: { url: 'https://github.com/o/r/pull/7', state: 'open' } }
  publicFlow = flow
  await pane({ stage: 'publish', status: 'passed' })
  assert.match(container.textContent ?? '', /PR 待审/)
  assert.doesNotMatch(container.textContent ?? '', /已合并/)
  assert.ok(button('验收并合并'), 'the public handoff keeps normal acceptance reachable')
  publicFlow = { ...flow, stage: 'completed', needsYou: undefined, stages: [...flow.stages, 'completed'] }
  await pane({ stage: 'approval', status: 'pending' })
  assert.match(container.textContent ?? '', /已合并/)
  assert.equal(button('验收并合并'), undefined, 'a stale legacy pending row cannot reopen acceptance')
})

test('an accepted v2 report uses the same completed flow without reopening acceptance or claiming a GitHub merge', async () => {
  const binding = { taskId: 't1', issueId: 'issue-1', attemptId: 'a1', candidateId: 'c1', revision: 9 }
  detail = { task: { ...task({ stage: 'approval', status: 'passed' }), route: { flowVersion: 2 }, revision: 9 }, checks: [], delivery: { pullRequest: null } }
  ledger = { binding, approvals: [], publications: [], merges: [] }
  evidence = { binding, manifest: { candidate: { kind: 'report', sha: 'a'.repeat(40), repository: 'r', environment: 'device:local', scope: 'report' }, artifacts: [] } }
  publicFlow = { version: 2, id: 't1', issueId: 'issue-1', botId: null, revision: 9, stage: 'completed', completion: 'accepted',
    stages: ['implement', 'review', 'handoff', 'completed'], review: null, acceptance: null, pullRequest: null }
  await pane({ stage: 'approval', status: 'passed' })
  assert.match(container.textContent ?? '', /已验收/)
  assert.doesNotMatch(container.textContent ?? '', /已合并|PR 待审/)
  assert.equal(button('验收'), undefined)
  assert.equal(button('验收并合并'), undefined)
})

test('Factory list and duplicate task headers subscribe to their server scopes while another workspace is selected', async t => {
  const selected = '11111111-1111-4111-8111-111111111111'
  const personal = '22222222-2222-4222-8222-222222222222'
  const taskWorkspace = '33333333-3333-4333-8333-333333333333'
  const issueId = '44444444-4444-4444-8444-444444444444'
  detailTaskId = '55555555-5555-4555-8555-555555555555'
  const tickets: string[] = [], sockets: Socket[] = []
  class Socket implements LiveSocket {
    onopen: LiveSocket['onopen'] = null
    onmessage: LiveSocket['onmessage'] = null
    onclose: LiveSocket['onclose'] = null
    onerror: LiveSocket['onerror'] = null
    readyState: 0 | 1 | 2 | 3 = 0
    readonly url: string
    // The channel asks the Worker for revisions; the fixture addresses the socket by its channel path.
    constructor(url: string) { assert.equal(new URL(url).searchParams.get('revisions'), '1'); this.url = url.split('?')[0]; sockets.push(this) }
    open() { this.readyState = 1; if (this.onopen) Reflect.apply(this.onopen, this, [new Event('open')]) }
    message(value: unknown) { if (this.onmessage) Reflect.apply(this.onmessage, this, [{ data: JSON.stringify(value) }]) }
    send() {}
    close() { this.readyState = 3 }
  }
  const previousFetch = globalThis.fetch, previousSocket = globalThis.WebSocket
  const visibility = Object.getOwnPropertyDescriptor(browser.document, 'visibilityState')
  Object.defineProperty(browser.document, 'visibilityState', { configurable: true, value: 'visible' })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const workspace = new URL(String(input), 'https://mikka.example').searchParams.get('workspace')!
    tickets.push(workspace)
    return Response.json({ url: `wss://gateway.example/live/${workspace}`, protocol: 'fixture-ticket', expiresAt: Date.now() + 300_000 })
  }) as typeof fetch
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: Socket })
  t.after(() => {
    globalThis.fetch = previousFetch
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: previousSocket })
    if (visibility) Object.defineProperty(browser.document, 'visibilityState', visibility)
    else Reflect.deleteProperty(browser.document, 'visibilityState')
  })
  list = { data: { tasks: [], liveWorkspaceId: personal }, isLoading: false, mutate: async () => list.data }
  detail = { liveWorkspaceId: taskWorkspace, delivery: { machine: { name: 'Fixture', kind: 'cloud' } } }
  await act(async () => root.render(<LiveProvider ownerId="owner" workspaceId={selected}>
    <FactoryAcceptance issueId={issueId} />
    <CandidateMachine taskId={detailTaskId} /><CandidateMachine taskId={detailTaskId} />
  </LiveProvider>))
  assert.deepEqual(tickets.sort(), [personal, taskWorkspace].sort(), 'the navigation workspace must not select these channels')
  assert.equal(sockets.length, 2, 'duplicate task headers share their scope connection')
  await act(async () => { for (const socket of sockets) socket.open(); await new Promise(resolve => setTimeout(resolve, 120)) })
  listReloadKeys = []
  const taskSocket = sockets.find(socket => socket.url.endsWith(taskWorkspace))!
  const listSocket = sockets.find(socket => socket.url.endsWith(personal))!
  await act(async () => { taskSocket.message({ kind: 'factory_task', id: detailTaskId }); await new Promise(resolve => setTimeout(resolve, 120)) })
  assert.deepEqual(listReloadKeys, [`/api/factory/tasks/${detailTaskId}`])
  listReloadKeys = []
  await act(async () => {
    listSocket.message({ kind: 'factory_task', id: detailTaskId })
    listSocket.message({ kind: 'factory_issue', id: issueId })
    await new Promise(resolve => setTimeout(resolve, 120))
  })
  assert.deepEqual(listReloadKeys, [`/api/factory/tasks?issueId=${issueId}`], 'a task event on the issue scope cannot refresh another scope')
})

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

test('an exhausted completed run offers owner Retry with the exact host binding', async () => {
  const binding = { taskId: 't1', revision: 16 }
  detail = { completionRecovery: { binding }, checks: [] }
  await pane({ stage: 'execute', status: 'blocked', candidateId: null })
  const retry = button('重试')
  assert.ok(retry, 'the completed producer needs a normal owner recovery control')
  const sent: unknown[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url, options) => {
    assert.equal(String(url).endsWith('/api/factory/tasks/t1'), true)
    sent.push(JSON.parse(String(options?.body)))
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try { await act(async () => { retry.click(); retry.click() }) }
  finally { globalThis.fetch = original }
  assert.equal(sent.length, 1)
  const body = sent[0] as { action: string; binding: unknown; eventId: string }
  assert.equal(body.action, 'retry')
  assert.deepEqual(body.binding, binding)
  assert.ok(body.eventId)
})

test('a blocked label alone does not expose completion recovery', async () => {
  detail = { checks: [] }
  await pane({ stage: 'execute', status: 'blocked', candidateId: null })
  assert.equal(Boolean(button('重试')), false)
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

test('skill activation keeps one event across a lost response, remount, double click and an acknowledged result', async () => {
  const binding = { taskId: 't1', issueId: 'issue-1', attemptId: 'a1', candidateId: 'c1', revision: 8 }
  const candidate = { sha: 'a'.repeat(40), repository: 'o/r', environment: 'preview', scope: 'repo' }
  ledger = { binding, approvals: [], publications: [] }
  evidence = { binding, manifest: { candidate, artifacts: [] } }
  const scope = `skill-activation-${crypto.randomUUID()}`
  const open = async (key: string) => {
    await act(async () => root.render(<ViewStateProvider scope={scope}><FactoryAcceptancePane key={key} task={task({ isSkillCandidate: true })} /></ViewStateProvider>))
  }
  const sent: { operation: string; input: { eventId: string } }[] = []
  const original = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = (async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)))
    if (sent.length === 1) throw new TypeError('connection lost')
    await gate
    return new Response(JSON.stringify({ approvalId: 'approved-once', publicationId: 'p1' }), { status: 200 })
  }) as typeof fetch
  try {
    await open('first')
    await act(async () => { button('启用')!.click() })
    assert.equal(sent.length, 1)
    assert.ok(container.textContent?.includes(lookup('FactoryAcceptance.error')))
    await open('remounted')
    assert.equal(sent.length, 1)
    const enable = button('启用')!
    await act(async () => { enable.click(); enable.click() })
    assert.equal(enable.disabled, true)
    assert.deepEqual(sent.map(request => request.operation), ['approve', 'approve'])
    assert.deepEqual(sent[0], sent[1])
    assert.ok(sent[0].input.eventId)
    refreshFails = true
    await act(async () => { release() })
    assert.equal(sent.length, 2, 'the approval receipt already represents the publication')
    assert.ok(!container.textContent?.includes(lookup('FactoryAcceptance.error')), 'a refresh failure cannot turn an acknowledged mutation into an action error')
    assert.equal(ledgerReloads, 2)
  } finally { release(); globalThis.fetch = original }
})

test('a claimed skill publication offers reconciliation for the same reservation', async () => {
  const binding = { taskId: 't1', issueId: 'issue-1', attemptId: 'a1', candidateId: 'c1', revision: 8 }
  const approval = { id: 'ap', candidateId: 'c1', candidate: { sha: 'a'.repeat(40), repository: 'o/r', environment: 'preview', scope: 'repo' }, revokedAt: null, createdAt: new Date().toISOString() }
  for (const status of ['reserved', 'uncertain']) {
    const request = { binding, eventId: 'original-reservation' }
    ledger = { binding, approvals: [approval], publications: [{ id: 'pub', approvalId: 'ap', request, status }] }
    await pane({ stage: 'publish', status: 'running', isSkillCandidate: true })
    assert.equal(button('撤销批准'), undefined)
    assert.equal(button('发布'), undefined)
    const original = globalThis.fetch
    const sent: unknown[] = []
    globalThis.fetch = (async (_url, options) => {
      sent.push(JSON.parse(String(options?.body)))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      await act(async () => { button(lookup('FactoryAcceptance.reconcile'))!.click() })
      assert.deepEqual(sent, [{ operation: 'reconcile', input: { ...request, publicationId: 'pub' } }])
    } finally { globalThis.fetch = original }
  }
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

test('a device environment names the device category rather than an approval refusal', async () => {
  detail = { checks: [], delivery: { ...delivery, machine: null, machineName: null } }
  evidence = { binding: {}, manifest: { candidate: { sha: delivery.candidateSha, repository: 'r', environment: 'device:local-runner', scope: '' }, artifacts: [] } }
  await pane()
  const card = document.querySelector('section[aria-label="候选版本"]')
  assert.match(card?.textContent ?? '', /设备/)
  assert.doesNotMatch(card?.textContent ?? '', /不可批准/)
})

test('the pane reads an accepted report from the persisted task detail after accepting', async () => {
  detail = { task: task({ status: 'passed' }), checks: [], delivery }
  evidence = { binding: {}, manifest: { candidate: { kind: 'report', sha: delivery.candidateSha, repository: 'r', environment: 'device:local-runner', scope: '' }, artifacts: [] } }
  await pane()
  assert.match(document.body.textContent ?? '', /已验收/)
  assert.equal(Boolean(button('验收')), false)
})

function failedCandidate(stage: 'review' | 'verify' = 'review', revision = 24) {
  const current = { ...task(), stage, status: 'failed', revision, attemptId: `check-${revision}`, candidateRunId: 'producer' }
  ledger = { binding: { taskId: current.id, issueId: current.issueId, attemptId: current.attemptId, candidateId: current.candidateId, revision }, approvals: [], publications: [], merges: [] }
  detail = { task: current, checks: [{ stage, status: 'failed', attemptId: current.attemptId,
    candidateId: current.candidateId, candidateSha: 'a'.repeat(40), runId: 'check-run', criteria: [], verify: null }] }
  return current
}

function retryReceipt(current: ReturnType<typeof failedCandidate>) {
  const pending = { ...current, status: 'pending', revision: current.revision + 1, attemptId: `check-${current.revision + 1}` }
  return { contractVersion: 1, task: pending,
    attempts: [{ id: pending.attemptId, taskId: pending.id, candidateId: pending.candidateId, stage: pending.stage, status: pending.status }],
    candidates: [{ id: pending.candidateId, taskId: pending.id }] }
}

function checkFlow(current: ReturnType<typeof failedCandidate>, kind: 'failed' | 'blocked') {
  return { version: 2, id: current.id, issueId: current.issueId, botId: null, revision: current.revision,
    stage: current.stage === 'verify' ? 'implement' : 'review', stages: ['implement', 'review'],
    needsYou: { kind, since: '2026-11-05T00:00:00Z' }, review: null, acceptance: null, pullRequest: null }
}

test('single-review failure keeps its result without an impossible generic retry, while legacy and verify remain actionable', async () => {
  const current = failedCandidate()
  detail = { ...(detail as object), task: { ...current, route: { flowVersion: 2 } } }
  publicFlow = checkFlow(current, 'failed')
  await pane(current)
  assert.equal(Boolean(button('重新审阅')), false, 'the normal retry endpoint rejects a completed flow v2 review')
  assert.match(container.textContent ?? '', /需要修改/)
  assert.equal(Boolean(button('验收并合并')), false)
  for (const route of [undefined, { flowVersion: 1 }]) {
    const legacy = failedCandidate()
    detail = { ...(detail as object), task: { ...legacy, route } }
    await pane(legacy)
    assert.ok(button('重新审阅'))
  }
  const verify = failedCandidate('verify')
  detail = { ...(detail as object), task: { ...verify, route: { flowVersion: 2 } } }
  publicFlow = checkFlow(verify, 'failed')
  await pane(verify)
  assert.ok(button('重新验证'))
})

function blockedCandidate(stage: 'review' | 'verify' = 'review') {
  const current = { ...failedCandidate(stage), status: 'blocked', reason: 'Question recovery blocked: factoryQuestionRunMismatch' }
  detail = { task: current, completionRecovery: null, delivery: { ...delivery, candidateSha: 'a'.repeat(40), pullRequest: null },
    checks: [{ stage, status: 'blocked', attemptId: current.attemptId, candidateId: current.candidateId,
      candidateSha: 'a'.repeat(40), runId: 'blocked-check-run', criteria: [], verify: null }] }
  return current
}

test('blocked independent results are static and keep the fixed candidate', async () => {
  for (const stage of ['review', 'verify'] as const) {
    await pane(blockedCandidate(stage))
    const results = container.querySelector('section[aria-label="独立结果"]')
    assert.ok(results)
    assert.equal(Boolean(results.querySelector('[data-slot="spinner"]')), false, 'a blocked check is not running')
    assert.match(results.textContent ?? '', /受阻/)
    assert.doesNotMatch(results.textContent ?? '', /进行中|需要修改|未通过/)
    assert.ok(container.querySelector('section[aria-label="候选版本"] [data-sha="' + 'a'.repeat(40) + '"]'))
  }
})

test('blocked acceptance exposes the current factory reason in existing details without repeating the run failure', async () => {
  const current = blockedCandidate()
  await pane(current)
  const details = button('详情')
  assert.ok(details, 'the current Factory recovery failure must remain inspectable')
  assert.equal(details.getAttribute('aria-expanded'), 'false')
  await act(async () => { details.click() })
  assert.equal(details.getAttribute('aria-expanded'), 'true')
  assert.match(container.textContent ?? '', /Question recovery blocked: factoryQuestionRunMismatch/)
  assert.doesNotMatch(container.textContent ?? '', /ProfileUnavailable|agentProfileUnavailable/)
})

test('an unqualified blocked candidate offers only read access and never posts a retry or approval', async () => {
  const current = blockedCandidate()
  const opened: string[] = []
  const sent: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url, options) => {
    sent.push(`${options?.method ?? 'GET'} ${url}`)
    throw new Error('read-only blocked acceptance must not send an action')
  }) as typeof fetch
  try {
    await act(async () => root.render(<FactoryAcceptancePane task={current} onOpenThread={runId => opened.push(runId)} />))
    for (const label of ['重新审阅', '重新验证', '重试', '验收', '验收并合并', '批准并发布', '发布'])
      assert.equal(button(label), undefined, `blocked alone must not expose ${label}`)
    const open = button('独立审阅')
    assert.ok(open)
    await act(async () => { open.click() })
    assert.deepEqual(opened, ['blocked-check-run'])
    assert.equal(sent.length, 0, 'inspection does not restart model work')
  } finally { globalThis.fetch = original }
})

function qualifiedBlockedCandidate() {
  const current = blockedCandidate()
  detail = { ...(detail as object), checkStartRecovery: { binding: { taskId: current.id, revision: current.revision } } }
  return current
}

function startRecoveryReceipt(current: ReturnType<typeof qualifiedBlockedCandidate>) {
  const running = { ...current, status: 'running', revision: current.revision + 2, attemptId: `check-${current.revision + 2}` }
  return { contractVersion: 1, task: running,
    attempts: [{ id: running.attemptId, taskId: running.id, candidateId: running.candidateId,
      stage: running.stage, status: 'running', runId: 'new-check-run' }],
    candidates: [{ id: running.candidateId, taskId: running.id }] }
}

test('host-qualified blocked review retries once and adopts the bound running attempt', async () => {
  const current = qualifiedBlockedCandidate()
  await pane(current)
  const retry = button('重新审阅')
  assert.ok(retry)
  const sent: Record<string, unknown>[] = []
  let finish: (response: Response) => void = () => {}
  const original = globalThis.fetch
  globalThis.fetch = (async (url, options) => {
    assert.equal(String(url).endsWith('/api/factory/tasks/t1'), true)
    assert.equal(options?.method, 'POST')
    sent.push(JSON.parse(String(options?.body)))
    return new Promise<Response>(resolve => { finish = resolve })
  }) as typeof fetch
  try {
    await act(async () => { retry.click(); retry.click(); retry.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }) as unknown as Event) })
    assert.equal(sent.length, 1)
    assert.equal(retry.disabled, true)
    assert.equal(retry.getAttribute('aria-busy'), 'true')
    assert.deepEqual(Object.keys(sent[0]).sort(), ['action', 'binding', 'eventId', 'reason'])
    assert.deepEqual(sent[0].binding, { taskId: 't1', revision: 24 })
    assert.equal(sent[0].action, 'retry')
    const receipt = startRecoveryReceipt(current)
    detail = { task: receipt.task, checks: [{ stage: 'review', status: 'running', attemptId: receipt.task.attemptId,
      candidateId: 'c1', candidateSha: 'a'.repeat(40), runId: 'new-check-run', criteria: [], verify: null }] }
    await act(async () => { finish(new Response(JSON.stringify(receipt), { status: 200 })) })
    assert.equal(detailReloads, 1)
    assert.equal(ledgerReloads, 1)
    assert.deepEqual(listReloadKeys, ['/api/factory/tasks?issueId=issue-1'])
    assert.equal(button('重新审阅'), undefined)
    assert.equal(button('验收并合并'), undefined)
    assert.doesNotMatch(container.textContent ?? '', /重试未确认|发布失败|已验收/)
    assert.equal(sent.length, 1, 'refresh never dispatches another check')
  } finally { globalThis.fetch = original }
})

test('unsubmitted review confirms its Owner response when list props omit the detailed route', async () => {
  const current = blockedCandidate()
  publicFlow = checkFlow(current, 'blocked')
  assert.equal('route' in current, false, 'the production task-list summary deliberately omits route')
  detail = { ...(detail as object), task: { ...current, route: { flowVersion: 2 } },
    checkSubmissionRecovery: { binding: { taskId: current.id, revision: current.revision } } }
  await pane(current)
  const retry = button('重新审阅')
  assert.ok(retry)
  // Keep the original summary/detail visible after the successful POST. This
  // exposes a false unconfirmed result instead of hiding it behind fresh props.
  refreshFails = true
  const sent: Record<string, unknown>[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url, options) => {
    assert.equal(String(url).endsWith('/api/factory/tasks/t1'), true)
    assert.equal(options?.method, 'POST')
    sent.push(JSON.parse(String(options?.body)))
    return Response.json(startRecoveryReceipt(current))
  }) as typeof fetch
  try {
    await act(async () => { retry.click(); retry.click() })
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0].binding, { taskId: current.id, revision: current.revision })
    assert.equal(sent[0].action, 'retry')
    assert.equal(detailReloads, 1); assert.equal(ledgerReloads, 1)
    assert.doesNotMatch(container.textContent ?? '', /重试未确认|重试未完成|已验收/)
  } finally { globalThis.fetch = original }
})

test('an unknown start recovery preserves its event across remounts and waits for an explicit retry', async () => {
  const current = qualifiedBlockedCandidate()
  const scope = `check-start-retry-${crypto.randomUUID()}`
  const open = async (key: string) => {
    await act(async () => root.render(<ViewStateProvider scope={scope}><FactoryAcceptancePane key={key} task={current} /></ViewStateProvider>))
  }
  await open('first')
  const sent: Record<string, unknown>[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)))
    if (sent.length === 1) throw new TypeError('connection lost')
    return new Response(JSON.stringify(startRecoveryReceipt(current)), { status: 200 })
  }) as typeof fetch
  try {
    await act(async () => { button('重新审阅')!.click() })
    assert.match(container.textContent ?? '', /重试未确认/)
    assert.equal(sent.length, 1)
    await open('remounted')
    assert.equal(sent.length, 1, 'rendering and refresh cannot replay the unknown recovery')
    await act(async () => { button('重新审阅')!.click() })
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[1], sent[0])
    assert.deepEqual(sent[0].binding, { taskId: 't1', revision: 24 })
    assert.ok(sent[0].eventId)
    assert.doesNotMatch(container.textContent ?? '', /重试未确认|发布失败|已验收/)
  } finally { globalThis.fetch = original }
})

test('same-candidate review retry posts once while busy and refreshes to the new pending attempt', async () => {
  const current = failedCandidate()
  await pane(current)
  const retry = button('重新审阅')
  assert.ok(retry)
  const sent: Record<string, unknown>[] = []
  let finish: (response: Response) => void = () => {}
  const original = globalThis.fetch
  globalThis.fetch = (async (url, options) => {
    assert.equal(String(url).endsWith('/api/factory/tasks/t1'), true)
    assert.equal(options?.method, 'POST')
    sent.push(JSON.parse(String(options?.body)))
    return new Promise<Response>(resolve => { finish = resolve })
  }) as typeof fetch
  try {
    await act(async () => { retry.click(); retry.click(); retry.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }) as unknown as Event) })
    assert.equal(sent.length, 1)
    assert.equal(retry.disabled, true)
    assert.equal(retry.getAttribute('aria-busy'), 'true')
    assert.deepEqual(Object.keys(sent[0]).sort(), ['action', 'binding', 'eventId', 'reason'])
    assert.deepEqual(sent[0].binding, { taskId: 't1', revision: 24 })
    assert.equal(sent[0].action, 'retry')
    const receipt = retryReceipt(current)
    const pending = receipt.task
    detail = { task: pending, checks: [{ stage: 'review', status: 'pending', attemptId: 'check-25',
      candidateId: 'c1', candidateSha: 'a'.repeat(40), runId: null, criteria: [], verify: null }] }
    await act(async () => { finish(new Response(JSON.stringify(receipt), { status: 200 })) })
    assert.equal(detailReloads, 1)
    assert.equal(ledgerReloads, 1)
    assert.deepEqual(listReloadKeys, ['/api/factory/tasks?issueId=issue-1'])
    assert.equal(button('重新审阅'), undefined)
    assert.equal(button('验收并合并'), undefined)
    assert.doesNotMatch(container.textContent ?? '', /发布失败/)
    assert.equal(sent.length, 1, 'refresh never dispatches another action')
  } finally { globalThis.fetch = original }
})

test('an unknown verification retry keeps its complete request across pane remounts', async () => {
  const current = failedCandidate('verify')
  const scope = `candidate-retry-${crypto.randomUUID()}`
  const open = async (key: string) => {
    await act(async () => root.render(<ViewStateProvider scope={scope}><FactoryAcceptancePane key={key} task={current} /></ViewStateProvider>))
  }
  await open('first')
  const sent: Record<string, unknown>[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)))
    if (sent.length === 1) throw new TypeError('connection lost')
    return new Response(JSON.stringify(retryReceipt(current)), { status: 200 })
  }) as typeof fetch
  try {
    await act(async () => { button('重新验证')!.click() })
    assert.match(container.textContent ?? '', /重试未确认/)
    assert.equal(sent.length, 1)
    await open('remounted')
    assert.equal(sent.length, 1, 'remount does not replay an unknown request')
    await act(async () => { button('重新验证')!.click() })
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[1], sent[0])
    assert.equal(sent[0].action, 'retry')
    assert.deepEqual(sent[0].binding, { taskId: 't1', revision: 24 })
    assert.ok(sent[0].eventId)
    assert.equal(detailReloads, 2)
    assert.equal(ledgerReloads, 2)
    assert.deepEqual(listReloadKeys, Array(2).fill('/api/factory/tasks?issueId=issue-1'))
    assert.doesNotMatch(container.textContent ?? '', /重试未确认|发布失败|已验收/)
  } finally { globalThis.fetch = original }
})

test('malformed successful retry responses stay unconfirmed when all refreshes fail', async () => {
  const current = failedCandidate('verify')
  await pane(current)
  refreshFails = true
  const sent: unknown[] = []
  const bodies = ['{}', '<html>unavailable</html>']
  const original = globalThis.fetch
  globalThis.fetch = (async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)))
    return new Response(bodies[sent.length - 1], { status: 200 })
  }) as typeof fetch
  try {
    for (let index = 0; index < bodies.length; index++) {
      await act(async () => { button('重新验证')!.click() })
      assert.match(container.textContent ?? '', /重试未确认/)
      assert.equal(button('重新验证')?.disabled, false)
      assert.equal(sent.length, index + 1)
    }
    assert.deepEqual(sent[1], sent[0], 'an explicit replay keeps the full request after an invalid 200')
    assert.equal(detailReloads, 2)
    assert.equal(ledgerReloads, 2)
    assert.deepEqual(listReloadKeys, Array(2).fill('/api/factory/tasks?issueId=issue-1'))
    assert.doesNotMatch(container.textContent ?? '', /发布失败|已验收/)
  } finally { globalThis.fetch = original }
})

test('a retry conflict refreshes list, detail and ledger without dispatching again', async () => {
  await pane(failedCandidate())
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify({ error: 'factoryStale' }), { status: 409 })
  }) as typeof fetch
  try {
    await act(async () => { button('重新审阅')!.click() })
    assert.equal(calls, 1)
    assert.equal(detailReloads, 1)
    assert.equal(ledgerReloads, 1)
    assert.deepEqual(listReloadKeys, ['/api/factory/tasks?issueId=issue-1'])
    assert.match(container.textContent ?? '', /重试未完成/)
    assert.doesNotMatch(container.textContent ?? '', /重试未确认|发布失败|已验收/)
  } finally { globalThis.fetch = original }
})

test('a later failed revision needs a new explicit click and never inherits an unknown retry', async () => {
  const old = failedCandidate()
  await pane(old)
  const sent: { eventId: string; binding: { revision: number } }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url, options) => {
    sent.push(JSON.parse(String(options?.body)))
    throw new TypeError('connection lost')
  }) as typeof fetch
  try {
    await act(async () => { button('重新审阅')!.click() })
    const current = failedCandidate('review', 26)
    await pane(old)
    assert.equal(button('重新审阅'), undefined, 'old props cannot act on a new detail/ledger revision')
    await pane(current)
    assert.equal(sent.length, 1)
    assert.doesNotMatch(container.textContent ?? '', /重试未确认/, 'the previous attempt error cannot label this attempt')
    await act(async () => { button('重新审阅')!.click() })
    assert.equal(sent.length, 2)
    assert.equal(sent[1].binding.revision, 26)
    assert.notEqual(sent[1].eventId, sent[0].eventId)
  } finally { globalThis.fetch = original }
})

test('pending/running checks and a stale ledger expose no same-candidate retry control', async () => {
  for (const stage of ['review', 'verify'] as const) {
    for (const status of ['pending', 'running']) {
      const current = { ...failedCandidate(stage), status }
      detail = { task: current, checks: [] }
      await pane(current)
      assert.equal(button('重新审阅'), undefined)
      assert.equal(button('重新验证'), undefined)
      assert.equal(button('验收并合并'), undefined)
    }
  }
  const current = failedCandidate()
  ledger = { binding: { taskId: 't1', issueId: 'issue-1', attemptId: 'older-check', revision: 24, candidateId: 'c1' }, approvals: [], publications: [] }
  await pane(current)
  assert.equal(button('重新审阅'), undefined)
})

test('host completion recovery keeps its existing control ahead of same-candidate retry', async () => {
  const current = failedCandidate()
  detail = { ...(detail as object), completionRecovery: { binding: { taskId: 't1', revision: 24 } } }
  await pane(current)
  assert.ok(button('重试'))
  assert.equal(button('重新审阅'), undefined)
  assert.equal(button('重新验证'), undefined)
})

test('a cited pre-question command source shows its localized time and opens that source thread without changing the result', async () => {
  const current = failedCandidate()
  const source = { runId: 'pre-question-run', sessionId: 'native-session-kept-in-data', status: 'stopped',
    recoveryEventId: 'answer-receipt', observedAt: '2026-11-04T09:12:34.000Z' }
  const sourceCheck = { stage: 'review', status: 'failed', attemptId: current.attemptId, candidateId: current.candidateId,
    candidateSha: 'a'.repeat(40), runId: 'review-run', criteria: [], verify: null, commandSources: [source] }
  detail = { task: current, checks: [sourceCheck] }
  const opened: string[] = []
  await act(async () => root.render(<FactoryAcceptancePane task={current} onOpenThread={runId => opened.push(runId)} />))
  assert.match(container.textContent ?? '', /来自提问前的执行/)
  assert.match(container.textContent ?? '', /需要修改/)
  const time = container.querySelector('time')
  assert.equal(time?.getAttribute('datetime'), source.observedAt)
  assert.equal(time?.textContent, new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(source.observedAt)))
  assert.doesNotMatch(container.textContent ?? '', /native-session-kept-in-data|answer-receipt/)
  await act(async () => { button('查看执行')!.click() })
  await act(async () => { button('独立审阅')!.click() })
  assert.deepEqual(opened, ['pre-question-run', 'review-run'])
  assert.ok(button('重新审阅'), 'source provenance does not turn a failed check into a pass')

  for (const commandSources of [undefined, []]) {
    detail = { task: current, checks: [{ ...sourceCheck, commandSources }] }
    await pane(current)
    assert.doesNotMatch(container.textContent ?? '', /来自提问前的执行|查看执行/)
    assert.equal(container.querySelector('time'), null)
    assert.match(container.textContent ?? '', /需要修改/)
  }
})

test('a host-qualified no-Run dispatch block retries once without claiming a review was performed', async () => {
  const current = { ...failedCandidate(), status: 'blocked',
    reason: 'Independent check could not select an Agent Profile. Check the available profiles and retry the check.' }
  publicFlow = checkFlow(current, 'blocked')
  const checkDispatchRecovery = { binding: { taskId: current.id, revision: current.revision } }
  detail = { task: { ...current, route: { flowVersion: 2 } }, checkDispatchRecovery,
    checks: [{ stage: 'review', status: 'blocked', attemptId: current.attemptId,
      candidateId: current.candidateId, candidateSha: 'a'.repeat(40), runId: null, criteria: [], verify: null }] }
  await pane(current)
  const retry = button('重新审阅')
  assert.ok(retry)
  assert.match(container.textContent ?? '', /阻塞/)
  assert.equal(container.querySelector('section[aria-label="独立结果"]'), null, 'an unstarted attempt is not an independent result')
  assert.doesNotMatch(container.textContent ?? '', /需要修改|审阅中|发布失败/)
  assert.equal(container.querySelector('[data-slot="spinner"]'), null)
  assert.equal(button('验收并合并'), undefined)
  const sent: Record<string, unknown>[] = []
  let finish: (response: Response) => void = () => {}
  const original = globalThis.fetch
  globalThis.fetch = (async (url, options) => {
    assert.equal(String(url).endsWith('/api/factory/tasks/t1'), true)
    assert.equal(options?.method, 'POST')
    sent.push(JSON.parse(String(options?.body)))
    return new Promise<Response>(resolve => { finish = resolve })
  }) as typeof fetch
  try {
    assert.equal(sent.length, 0, 'rendering a blocked task never retries it')
    await act(async () => { retry.click(); retry.click() })
    assert.equal(sent.length, 1)
    assert.equal(retry.disabled, true)
    assert.deepEqual(Object.keys(sent[0]).sort(), ['action', 'binding', 'eventId', 'reason'])
    assert.deepEqual(sent[0].binding, checkDispatchRecovery.binding)
    assert.equal(sent[0].action, 'retry')
    const receipt = retryReceipt(current)
    const attempt = { ...receipt.attempts[0], runId: null }
    detail = { task: receipt.task, checks: [{ stage: 'review', status: 'pending', attemptId: receipt.task.attemptId,
      candidateId: current.candidateId, candidateSha: 'a'.repeat(40), runId: null, criteria: [], verify: null }] }
    await act(async () => { finish(Response.json({ ...receipt, attempts: [attempt] })) })
    assert.equal(detailReloads, 1)
    assert.equal(ledgerReloads, 1)
    assert.deepEqual(listReloadKeys, ['/api/factory/tasks?issueId=issue-1'])
    assert.equal(button('重新审阅'), undefined)
    assert.equal(button('验收并合并'), undefined)
    assert.doesNotMatch(container.textContent ?? '', /重试未确认|需要修改|发布失败|已验收/)
    assert.equal(sent.length, 1, 'the pending transition and refresh cannot dispatch another check')
  } finally { globalThis.fetch = original }
})
