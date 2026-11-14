import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'))
const TASK = '11111111-1111-4111-8111-111111111111'
const ISSUE = '22222222-2222-4222-8222-222222222222'
const CANDIDATE = '33333333-3333-4333-8333-333333333333'
const RUN = '44444444-4444-4444-8444-444444444444'
const ATTEMPT = '55555555-5555-4555-8555-555555555555'
const ARTIFACT = '66666666-6666-4666-8666-666666666666'
const binding = { taskId: TASK, issueId: ISSUE, candidateId: CANDIDATE, attemptId: ATTEMPT, revision: 11 }
const task = { id: TASK, issueId: ISSUE, candidateId: CANDIDATE, candidateRunId: RUN, attemptId: ATTEMPT,
  revision: 11, stage: 'approval', status: 'pending', reason: 'Review needs judgment', isSkillCandidate: false }
let ledger: any
let detail: any
let evidence: any
let flow: any
let listed: any[]
let reloaded: string[]
let onRevalidate: ((key: string) => void) | undefined
let artifactDetail: any
const cache = new Map()
mock.module('swr', { defaultExport: (key: string | readonly unknown[] | null) => {
  if (key === null) return { data: undefined }
  if (Array.isArray(key)) return { data: key[0] === 'artifact' ? artifactDetail : key[0] === 'artifact-text' ? '# Acceptance document'
    : key[0] === 'issue-thread' ? { thread: { detail: { name: 'Producer' } } } : undefined, mutate: async () => {} }
  key = key as string | null
  const data = key === `/api/factory/tasks/${TASK}` ? detail : key === `/api/factory/tasks/${TASK}/flow` ? flow
    : key?.endsWith('view=ledger') ? ledger : key?.endsWith('/approval') ? evidence : { tasks: listed }
  return { data, mutate: async () => { if (key) { reloaded.push(key); onRevalidate?.(key) }; return data }, isLoading: false }
}, namedExports: { unstable_serialize: JSON.stringify, useSWRConfig: () => ({ cache, mutate: async (key: string) => { reloaded.push(key); onRevalidate?.(key) } }) } })
// The report's CI checks row reads the review summary (its own SWR and live keys); these tests cover the flow, not that row.
mock.module(new URL('../hooks/code-review/use-review-summary.ts', import.meta.url).href, { namedExports: { useReviewSummary: () => ({ data: undefined }) } })
mock.module('next-intl', { namedExports: {
  useTranslations: (namespace: string) => (key: string, args?: Record<string, string | number>) => {
    const value = `${namespace}.${key}`.split('.').reduce((node, part) => node?.[part], messages)
    assert.equal(typeof value, 'string', `missing copy ${namespace}.${key}`)
    return String(value).replace(/\{(\w+)\}/g, (_, name) => String(args?.[name] ?? ''))
  },
  useFormatter: () => ({ dateTime: () => '', relativeTime: () => '' }),
  useNow: () => new Date('2026-11-05T01:00:00.000Z'),
} })
const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
const Dialog = ({ children, open }: { children?: ReactNode; open?: boolean }) => open ? <div role="dialog">{children}</div> : null
mock.module(new URL('../components/ui/dialog.tsx', import.meta.url).href, { namedExports: { Dialog, DialogContent: Pass, DialogHeader: Pass, DialogTitle: Pass, DialogFooter: Pass } })
mock.module(new URL('../hooks/use-mobile.ts', import.meta.url).href, { namedExports: { useIsMobile: () => false } })
mock.module(new URL('../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKey: () => {} } })
mock.module(new URL('../components/workspace/issue-thread-panel.tsx', import.meta.url).href, { namedExports: { IssueThreadPanel: ({ runId }: { runId: string }) => <div data-producer={runId} /> } })
mock.module(new URL('../app/actions/agents.ts', import.meta.url).href, { namedExports: { getIssueThread: async () => undefined, getThreadMachine: async () => null, getThreadChanges: async () => ({ state: 'none' }) } })
// The report's diff rows use @pierre/diffs, which registers a web component on import; they draw only in a browser.
mock.module(new URL('../components/workspace/thread-changes.tsx', import.meta.url).href, { namedExports: {
  ThreadChangesPane: () => null, ThreadChangesView: () => null, ChangesTabLabel: () => null, Counts: () => null, FileSection: () => null,
  useDiffWrap: () => ['nowrap', () => {}],
} })
mock.module(new URL('../app/actions/artifacts.ts', import.meta.url).href, { namedExports: { getArtifact: async () => undefined, getArtifactText: async () => undefined, listRunArtifacts: async () => [] } })
mock.module(new URL('../app/actions/bots.ts', import.meta.url).href, { namedExports: { listBots: async () => [] } })
mock.module(new URL('../components/artifacts/artifact-share.tsx', import.meta.url).href, { namedExports: { ArtifactShare: () => null } })
mock.module(new URL('../components/coordinator/coordinator-chat.tsx', import.meta.url).href, { namedExports: { CoordinatorChat: () => null } })
mock.module('next/navigation', { namedExports: { useSearchParams: () => new URLSearchParams() } })
mock.module('next/dynamic', { defaultExport: () => (props: Parameters<typeof ArtifactViewer>[0]) => <ArtifactViewer {...props} /> })

const browser = new Window({ url: 'https://mikka.example/en' })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let FactoryAcceptancePane: typeof import('../components/workspace/factory-acceptance-pane')['FactoryAcceptancePane']
let FactoryArtifactAcceptance: typeof import('../components/workspace/factory-acceptance')['FactoryArtifactAcceptance']
let ArtifactViewer: typeof import('../components/artifacts/artifact-viewer')['ArtifactViewer']
let ArtifactWindow: typeof import('../components/artifacts/artifact-window')['ArtifactWindow']
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: browser.requestAnimationFrame.bind(browser) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: browser.cancelAnimationFrame.bind(browser) })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
    getComputedStyle: browser.getComputedStyle.bind(browser), ResizeObserver: browser.ResizeObserver })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ FactoryAcceptancePane } = await import('../components/workspace/factory-acceptance-pane'))
  ;({ FactoryArtifactAcceptance } = await import('../components/workspace/factory-acceptance'))
  ;({ ArtifactViewer } = await import('../components/artifacts/artifact-viewer'))
  ;({ ArtifactWindow } = await import('../components/artifacts/artifact-window'))
})
beforeEach(() => {
  ledger = { binding: { ...binding }, approvals: [], publications: [], merges: [], capabilities: { reject: true } }
  detail = { task: { ...task, route: { flowVersion: 2 } }, liveWorkspaceId: null }
  evidence = { binding: { ...binding }, manifest: { candidate: { kind: 'deliverable', sha: null, repository: '', environment: 'report', scope: 'report' }, artifacts: [] } }
  flow = { version: 2, id: TASK, issueId: ISSUE, revision: 11, stage: 'handoff', stages: ['implement', 'review', 'handoff'],
    needsYou: { kind: 'pr_review', since: '2026-11-05T00:00:00Z' },
    review: { verdict: 'needs_judgment', candidateId: CANDIDATE, currentCandidateReviewed: true },
    acceptance: { artifactId: ARTIFACT, version: 2, runId: RUN, candidateId: CANDIDATE, counts: {}, media: [] } }
  listed = [{ ...task }]; reloaded = []; onRevalidate = undefined; cache.clear()
  artifactDetail = { id: ARTIFACT, title: 'Acceptance', kind: 'markdown', latestVersion: 2, runId: RUN, issueId: ISSUE, acceptanceTaskId: TASK,
    live: { ownerId: 'owner', workspaceId: null }, versions: [1, 2].map(version => ({ version, authorName: 'Producer', authorHarness: 'claude-code', createdAt: '2026-11-05T00:00:00Z' })) }
  container = document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container as unknown as Node)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(async () => { await browser.happyDOM.close() })

const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name) as unknown as HTMLButtonElement | undefined
const artifact = async (version = 2, latestVersion = 2, artifactId = ARTIFACT) => {
  await act(async () => root.render(<FactoryArtifactAcceptance taskId={TASK} issueId={ISSUE} artifactId={artifactId} version={version} latestVersion={latestVersion} />))
}
async function editNote(note: string) {
  const input = document.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, note)
    input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
  })
}
async function withFetch(run: (sent: any[]) => Promise<void>, result = () => Response.json({ rejectionId: 'receipt', binding: { ...binding, revision: 13, candidateId: null } })) {
  const original = globalThis.fetch, sent: any[] = []
  globalThis.fetch = (async (url, options) => { sent.push({ url: String(url), ...JSON.parse(String(options?.body)) }); return result() }) as typeof fetch
  try { await run(sent) } finally { globalThis.fetch = original }
}

test('the existing Send back action includes the exact required candidate binding', async () => {
  await act(async () => root.render(<FactoryAcceptancePane task={task} />))
  assert.ok(button('Request changes'))
  await act(async () => { button('Request changes')!.click() })
  await editNote('Correct the acceptance document')
  await withFetch(async sent => {
    await act(async () => { button('Send back')!.click() })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].operation, 'reject')
    assert.deepEqual(sent[0].input.binding, binding)
    assert.equal(sent[0].input.candidateId, CANDIDATE)
    assert.equal(sent[0].input.note, 'Correct the acceptance document')
  })
})

test('the current v2 report offers Owner accept despite needs_judgment and POSTs its bound revision once', async () => {
  await artifact()
  assert.ok(button('Request changes'))
  assert.ok(button('Accept'))
  assert.equal(document.querySelector('section[aria-label="Candidate"]'), null, 'the report keeps its own content; only the decision bar is embedded')
  await withFetch(async sent => {
    await act(async () => { button('Accept')!.click(); button('Accept')!.click() })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].operation, 'accept')
    assert.deepEqual(sent[0].input.binding, binding)
    assert.match(sent[0].input.eventId, /^[0-9a-f-]{36}$/)
    assert.equal(flow.review.verdict, 'needs_judgment', 'the UI never rewrites the independent verdict')
  }, () => Response.json({ accepted: true, binding: { ...binding, revision: 12 } }))
  for (const key of [`/api/factory/tasks/${TASK}/approval?view=ledger`, `/api/factory/tasks/${TASK}`, `/api/factory/tasks/${TASK}/flow`, `/api/factory/tasks?issueId=${ISSUE}`])
    assert.ok(reloaded.includes(key), key)
})

test('request changes in the report submits the note for that candidate and never accepts it', async () => {
  await artifact()
  await act(async () => { button('Request changes')!.click() })
  await editNote('Replace the incorrect command in the document')
  await withFetch(async sent => {
    await act(async () => { button('Send back')!.click(); button('Send back')?.click() })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].operation, 'reject')
    assert.equal(sent[0].input.candidateId, CANDIDATE)
    assert.deepEqual(sent[0].input.binding, binding)
    assert.equal(sent[0].input.note, 'Replace the incorrect command in the document')
  })
  listed = [{ ...task, stage: 'execute', status: 'pending', candidateId: null, candidateRunId: null, revision: 13 }]
  flow = { ...flow, stage: 'implement', revision: 13, acceptance: null }
  await artifact()
  assert.equal(button('Accept'), undefined)
  assert.equal(button('Request changes'), undefined)
})

test('a human-accepted no-PR report shows completed acceptance with no repeated actions or rewritten verdict', async () => {
  await artifact()
  assert.ok(button('Accept'))
  const revision = 12
  // Each read still has its pre-click cached value until explicitly refreshed.
  // No live event is delivered during this accept response.
  onRevalidate = key => {
    if (key === `/api/factory/tasks?issueId=${ISSUE}`) listed = [{ ...task, status: 'passed', revision }]
    if (key === `/api/factory/tasks/${TASK}`) detail.task = { ...detail.task, status: 'passed', revision }
    if (key.endsWith('view=ledger')) ledger.binding = { ...binding, revision }
    if (key.endsWith('/approval')) evidence.binding = { ...binding, revision }
    if (key.endsWith('/flow')) flow = { ...flow, revision, stage: 'completed', completion: 'accepted', needsYou: undefined, stages: [...flow.stages, 'completed'] }
  }
  await withFetch(async sent => {
    await act(async () => { button('Accept')!.click() })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].operation, 'accept')
    await artifact()
  }, () => Response.json({ status: 'accepted', acceptanceId: 'receipt', binding: { ...binding, revision } }))
  assert.equal(button('Accept'), undefined)
  assert.equal(button('Request changes'), undefined)
  assert.match(document.body.textContent ?? '', /Accepted/)
  assert.equal(flow.review.verdict, 'needs_judgment')
})

test('old versions, ordinary artifacts, and a mismatched current run have no approval controls', async () => {
  await artifact(1, 2)
  assert.equal(button('Accept'), undefined)
  await artifact(2, 3)
  assert.equal(button('Accept'), undefined, 'even a stale flow response cannot approve while viewing an older version')
  await artifact(2, 2, '77777777-7777-4777-8777-777777777777')
  assert.equal(button('Accept'), undefined)
  flow.acceptance.runId = '77777777-7777-4777-8777-777777777777'
  await artifact()
  assert.equal(button('Accept'), undefined)
  assert.equal(button('Request changes'), undefined)
})

test('new candidate, revision, and evidence reads must agree before the report can offer a decision', async () => {
  for (const field of ['candidateId', 'taskId', 'issueId', 'revision', 'attemptId']) {
    ledger.binding = { ...binding, [field]: field === 'revision' ? 10 : '77777777-7777-4777-8777-777777777777' }
    await artifact()
    assert.equal(button('Accept'), undefined, `stale ledger ${field}`)
    ledger.binding = { ...binding }
    evidence.binding = { ...binding, [field]: field === 'revision' ? 10 : '77777777-7777-4777-8777-777777777777' }
    await artifact()
    assert.equal(button('Accept'), undefined, `stale evidence ${field}`)
    evidence.binding = { ...binding }
  }
  detail.task = { ...detail.task, candidateId: '77777777-7777-4777-8777-777777777777', revision: 12 }
  await artifact()
  assert.equal(button('Accept'), undefined, 'a newer detail already superseded the cached list, flow and ledger')
  listed = []
  await artifact()
  assert.equal(button('Accept'), undefined, 'a no-longer-readable task cannot gain controls from the artifact hint')
})

test('a repaired report uses its new producer and candidate, even though its Artifact was created by an earlier run', async () => {
  const candidateId = '88888888-8888-4888-8888-888888888888', runId = '99999999-9999-4999-8999-999999999999'
  const next = { ...task, candidateId, candidateRunId: runId, revision: 18 }
  listed = [next]; detail.task = { ...next, route: { flowVersion: 2 } }
  flow = { ...flow, revision: 18, acceptance: { ...flow.acceptance, candidateId, runId, version: 3 } }
  ledger.binding = { ...binding, candidateId, revision: 18 }; evidence.binding = { ...ledger.binding }
  await artifact(2, 3)
  assert.equal(button('Accept'), undefined)
  await artifact(3, 3)
  assert.ok(button('Accept'))
  await withFetch(async sent => {
    await act(async () => { button('Accept')!.click() })
    assert.deepEqual(sent[0].input.binding, ledger.binding)
  })
})

test('reject stays unavailable when the server does not offer that capability', async () => {
  ledger.capabilities.reject = false
  await artifact()
  assert.equal(button('Request changes'), undefined)
  assert.ok(button('Accept'))
})

// P1 (decision 2026-11-06-1615): in the window the decision is the header's 要求修改 and 批准并合并.
test('the actual Artifact window puts the decision above its report and original producer thread', async () => {
  await act(async () => root.render(<ArtifactWindow artifactId={ARTIFACT} />))
  assert.ok(button(messages.ArtifactReview.approveAndMerge))
  assert.ok(button(messages.ArtifactReview.changeRequestLabel))
  const decision = button(messages.ArtifactReview.approveAndMerge)!, report = document.querySelector('main')!, producer = document.querySelector('[data-producer]')!
  assert.equal(producer.getAttribute('data-producer'), RUN)
  assert.ok(decision.compareDocumentPosition(report) & browser.Node.DOCUMENT_POSITION_FOLLOWING)
  assert.ok(decision.compareDocumentPosition(producer) & browser.Node.DOCUMENT_POSITION_FOLLOWING)
  await act(async () => { (document.querySelector('button[aria-label="Versions"]') as unknown as HTMLButtonElement)!.click() })
  const older = [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent?.startsWith('v1'))
  assert.ok(older, 'the real version picker exposes the older report')
  await act(async () => { (older as unknown as HTMLButtonElement).click() })
  assert.equal(button(messages.ArtifactReview.approveAndMerge), undefined)
  assert.equal(button(messages.ArtifactReview.changeRequestLabel), undefined)
  assert.match(document.body.textContent ?? '', /Viewing v1/)
})

test('ordinary Artifact windows have no acceptance actions even when made by a candidate run', async () => {
  artifactDetail.acceptanceTaskId = null
  await act(async () => root.render(<ArtifactWindow artifactId={ARTIFACT} />))
  assert.ok(document.querySelector('[data-producer]'))
  assert.equal(button('Accept'), undefined)
  assert.equal(button('Request changes'), undefined)
})
