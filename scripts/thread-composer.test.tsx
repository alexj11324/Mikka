import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { State } from 'swr'
import { renderToStaticMarkup } from 'react-dom/server'
import { Window } from 'happy-dom'
import { IntlProvider } from 'next-intl'
import * as actualViewState from '../lib/hooks/view-state'
import * as actualAppBuild from '../lib/app-build'
import type { FactoryTask } from '../components/workspace/factory-acceptance-pane'

// R-10: every conversation ends in the shared composer. An open thread is one, so it keeps
// the composer after it finishes: an Artifact window, a task's thread and a thread opened
// from a chat all draw IssueThreadPanel. Only the legacy agent archive is read-only.

const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'))
const at = (path: string) => new URL(`../${path}`, import.meta.url).href
let thread: Record<string, unknown> | null
let draftText = ''
let pageChecks = 0
let buildGate: Promise<boolean> | undefined
let postReply = async (_request: { requestId: string; text: string }) => ({ sent: true })
let acceptance: FactoryTask | null = null
const browser = new Window({ url: 'https://mikka.example/en' })
for (const key of ['window', 'document', 'navigator', 'location', 'customElements', 'HTMLElement', 'Element', 'Node', 'CSS', 'MutationObserver', 'ResizeObserver'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id: number) => clearTimeout(id) })
const actualSWR = await import('swr')
let liveRead = false
let readFailure: unknown = null
let readHold: Promise<void> | null = null
let observeChanges = false
let changesReads = 0
let changesRead: { state: string; changes?: object } | null = null
let issueReads = 0
const notices = new Map<string, { action?: { onClick: (event: Event) => void } }>()
mock.module('sonner', { namedExports: { toast: {
  error: (_message: string, options: { id: string; action?: { onClick: (event: Event) => void } }) => { notices.set(options.id, options) },
  dismiss: (id: string) => { notices.delete(id) }, success: () => {},
} } })
mock.module('swr', {
  defaultExport: (key: unknown, fetcher: never, options: never) => liveRead && Array.isArray(key) && (key[0] === 'issue-thread' || observeChanges && key[0] === 'thread-changes')
    ? actualSWR.default(key, fetcher, options)
    : Array.isArray(key) && key[0] === 'issue-thread'
    ? { data: thread && { thread, chunks: [{ chunk: { type: 'text-delta', id: 'a', delta: 'Done.' }, at: new Date(0) }], messages: [] }, mutate: () => {} }
    // Where the thread runs is its own read (thread-run-place.tsx); none here.
    : Array.isArray(key) && key[0] === 'thread-machine' ? { data: null, mutate: () => {} }
    : Array.isArray(key) && key[0] === 'thread-changes' ? { data: changesRead, mutate: () => {} }
    : { data: [], mutate: () => {} },
  namedExports: { useSWRConfig: () => liveRead ? actualSWR.useSWRConfig() : ({ mutate: () => {}, cache: new Map() }), unstable_serialize: actualSWR.unstable_serialize },
})
mock.module('next/dynamic', { defaultExport: () => () => null })
mock.module(at('lib/hooks/view-state.tsx'), { namedExports: {
  ...actualViewState,
  useViewState: <T,>(key: string, initial: T) => actualViewState.useViewState(key, key.endsWith(':draft') ? draftText as T : initial),
} })
mock.module(at('lib/app-build.ts'), { namedExports: { ...actualAppBuild, checkPageBuildBeforeAction: async () => { pageChecks++; return buildGate ?? true } } })
mock.module(at('app/actions/agents.ts'), { namedExports: { retryQuotaPausedRun: async () => null, resumeQuotaPausedRunOnApiKey: async () => null, getThreadName: async () => null, getThreadContinuationModels: async () => null, listIssueThreads: async () => null, pollIssueThreads: async () => null, getIssueThread: async () => {
  issueReads++
  if (readHold) await readHold
  if (readFailure) throw readFailure
  return { thread, chunks: [{ chunk: { type: 'text-delta', id: 'a', delta: 'Done.' }, at: new Date(0) }], messages: [], chunksAppend: false }
}, getThreadChanges: async () => { changesReads++; return { state: 'none' } }, getThreadInstructions: async () => '', getThreadMachine: async () => null, sendIssueThreadMessage: async () => {}, sendIssueThreadReply: async (request: { requestId: string; text: string }) => { replyCalls++; return postReply(request) }, stopRun: async () => ({}) } })
mock.module(at('app/actions/artifacts.ts'), { namedExports: { listRunArtifacts: async () => [] } })
mock.module(at('components/workspace/factory-acceptance.tsx'), { namedExports: {
  useThreadAcceptance: (issueId: string | null, runId: string) =>
    acceptance?.issueId === issueId && acceptance.candidateRunId === runId ? acceptance : null,
  useAcceptanceTasks: () => ({ tasks: acceptance ? [acceptance] : [], allTasks: acceptance ? [acceptance] : [] }),
  AcceptanceStateBadge: () => null,
} })
mock.module(at('components/workspace/factory-acceptance-pane.tsx'), { namedExports: { FactoryAcceptancePane: () => <p data-private-pane="">Private acceptance notes</p> } })
mock.module(at('components/workspace/thread-changes.tsx'), { namedExports: { ThreadChangesPane: () => <p data-private-pane="">Private changes</p>, ChangesTabLabel: () => <>Changes</> } })
mock.module(at('components/workspace/self-improvement.tsx'), { namedExports: { ThreadFeedback: () => null } })
type ComposerProps = { label: string; value: string; submitDisabled?: boolean; onSubmit: () => void; onChange: (value: string) => void }
let composer: ComposerProps | null = null
let replyCalls = 0
mock.module(at('components/coordinator/chat-composer.tsx'), { namedExports: { ChatComposer: (props: ComposerProps) => {
  composer = props
  return <><textarea data-composer="" aria-label={props.label} value={props.value} onChange={event => props.onChange(event.currentTarget.value)} /><button data-composer-send="" disabled={props.submitDisabled}>Send</button></>
} } })

// The bare pane mounted below is the shared Artifact/Review transcript and composer.
const { ChatComposer } = await import('../components/coordinator/chat-composer')
mock.module(at('components/slots/thread.tsx'), { namedExports: {
  ThreadScreen: (props: import('../components/slots/thread-contract').ThreadScreenProps) =>
    <section data-required-thread-screen=""><ChatComposer {...props.composer} />{props.notices}</section>,
} })
let IssueThreadPanel: typeof import('../components/workspace/issue-thread-panel')['IssueThreadPanel']
let createRoot: typeof import('react-dom/client')['createRoot']
let root: Root | null = null
let container: HTMLDivElement
let refreshRead: () => Promise<unknown>
before(async () => { ({ createRoot } = await import('react-dom/client')); ({ IssueThreadPanel } = await import('../components/workspace/issue-thread-panel')) })
const base = { id: 'run-1', issueId: 'issue-1', status: 'succeeded', outcome: null, question: null, continuation: null, stopping: false, ownedByCurrentUser: true,
  createdAt: new Date(0), finishedAt: new Date(0), latestRunId: 'run-1', prompt: 'Fix it', stopRequestedAt: null, replyAvailable: true, retryAvailable: true, quota: null, feedbackEligible: false,
  detail: { name: 'ZHIX-2 Fix it', agentName: 'Claude Code', harness: 'claude_code', summary: null } }
beforeEach(() => { buildGate = undefined; postReply = async () => ({ sent: true }); thread = { ...base }; acceptance = null; composer = null; replyCalls = 0; draftText = ''; pageChecks = 0; liveRead = false; observeChanges = false; changesReads = 0; readFailure = null; readHold = null; changesRead = null; issueReads = 0; notices.clear(); browser.sessionStorage.clear() })
afterEach(async () => { if (root) { await act(async () => root!.unmount()); root = null; container.remove() } })
after(() => browser.close())
const render = (props: Partial<Parameters<typeof IssueThreadPanel>[0]> = {}) => renderToStaticMarkup(<IntlProvider locale="en" timeZone="UTC" messages={messages}>
  <IssueThreadPanel bare issueId="issue-1" runId="run-1" onClose={() => {}} {...props} />
</IntlProvider>)

function ReadControl() {
  const { mutate } = actualSWR.useSWRConfig()
  refreshRead = () => mutate(['issue-thread', 'issue-1', 'run-1'])
  return null
}
const readCaches = new Map<string, Map<string, State>>()
async function renderLive(scope = 'owner:workspace', props: Partial<Parameters<typeof IssueThreadPanel>[0]> = {}, shown = true) {
  liveRead = true
  if (!root) {
    container = browser.document.createElement('div') as unknown as HTMLDivElement
    document.body.append(container)
    root = createRoot(container)
    readCaches.clear()
  }
  if (!readCaches.has(scope)) readCaches.set(scope, new Map())
  const { SWRConfig } = actualSWR
  await act(async () => root!.render(<SWRConfig key={scope} value={{ provider: () => readCaches.get(scope)!, dedupingInterval: 0, shouldRetryOnError: false }}>
    <actualViewState.ViewStateProvider scope={scope}><IntlProvider locale="en" timeZone="UTC" messages={messages}>
      <ReadControl />{shown && <IssueThreadPanel issueId="issue-1" runId="run-1" bare {...props} />}
    </IntlProvider></actualViewState.ViewStateProvider>
  </SWRConfig>))
}
async function failRead(error: unknown) {
  readFailure = error
  await act(async () => { await refreshRead().catch(() => {}) })
}

test('an opened thread reads changes once alongside detail and refreshes when its status becomes known or changes', async () => {
  observeChanges = true
  let resolveDetail!: () => void
  readHold = new Promise(resolve => { resolveDetail = resolve })
  await renderLive('owner:workspace', { bare: false })
  assert.equal(changesReads, 1, 'start one diff read in parallel with a slow detail read')
  await act(async () => { resolveDetail(); await readHold })
  readHold = null
  assert.equal(changesReads, 2, 'the known status may include a checkpoint committed after the first read')
  thread = { ...base, status: 'running' }
  await act(async () => { await refreshRead() })
  assert.equal(changesReads, 3)
  await act(async () => { await refreshRead() })
  assert.equal(changesReads, 3, 'an unchanged status is already current')
})

test('a background thread read failure preserves transcript, scroll, composer focus and unsent draft', async () => {
  await renderLive()
  assert.equal(issueReads, 1)
  const history = container.querySelector('ol')!
  const scroll = history.parentElement!
  const input = container.querySelector('textarea')!
  assert.ok(history)
  await act(async () => composer!.onChange('Keep this unsent follow-up'))
  input.focus(); input.setSelectionRange(3, 9)
  scroll.scrollTop = 148
  scroll.dispatchEvent(new browser.Event('scroll') as unknown as Event)
  await failRead(new Error('network unavailable'))
  assert.ok(container.querySelector('ol') === history, 'a background failure must keep the conversation mounted')
  assert.ok(container.querySelector('textarea') === input, 'a background failure must not replace the composer')
  assert.equal(scroll.scrollTop, 148)
  assert.ok(document.activeElement === input)
  assert.equal(input.value, 'Keep this unsent follow-up')
  assert.deepEqual([input.selectionStart, input.selectionEnd], [3, 9])
  assert.ok(container.querySelector('[role="alert"]') === null)
  assert.equal(replyCalls, 0)
  const retry = notices.get('issue-thread-read-run-1')?.action
  assert.ok(retry, 'retry belongs to the existing background error notice')
  readFailure = null
  await act(async () => { retry.onClick(new Event('click', { cancelable: true })); await new Promise(resolve => setTimeout(resolve, 0)) })
  assert.equal(issueReads, 3)
  assert.equal(notices.size, 0)
  assert.ok(container.querySelector('ol') === history)
  assert.equal(input.value, 'Keep this unsent follow-up')
})

for (const [label, refusal] of [
  ['401', { status: 401 }], ['403', { status: 403 }], ['404', { status: 404 }],
  ['runNotFound over browser RPC', { status: 400, code: 'runNotFound' }],
  ['owner scope', { kind: 'owner' }], ['workspace scope', { kind: 'workspace' }],
  ['changed transport session', { status: 409, code: 'desktop_session_changed' }],
] as const) test(`a ${label} thread refusal hides private content until a new successful read`, async () => {
  await renderLive()
  assert.ok(container.querySelector('ol'))
  await act(async () => composer!.onChange('Private unsent follow-up'))
  await failRead(refusal)
  assert.ok(container.querySelector('ol') === null)
  assert.ok(container.querySelector('textarea') === null, 'the rejected thread must not keep its editable composer')
  assert.doesNotMatch(container.textContent ?? '', /Done\.|Fix it|Private unsent follow-up/)
  await failRead(new Error('network remains unavailable'))
  assert.ok(container.querySelector('ol') === null, 'a later ordinary failure cannot revive a denied read')
  assert.ok(container.querySelector('textarea') === null)
  readFailure = null
  await act(async () => { await refreshRead() })
  assert.ok(container.querySelector('ol'), 'a new authorized success can show the thread again')
  assert.equal(replyCalls, 0)
})

test('a new thread scope cannot show the previous scope conversation or draft while its read fails', async () => {
  await renderLive()
  await act(async () => composer!.onChange('Previous workspace draft'))
  readFailure = new Error('network unavailable in new scope')
  await renderLive('other-owner:other-workspace')
  assert.ok(container.querySelector('ol') === null)
  assert.ok(container.querySelector('textarea') === null)
  assert.doesNotMatch(container.textContent ?? '', /Done\.|Fix it|Previous workspace draft/)
  assert.ok(container.querySelector('[role="alert"]'))
})

for (const initialTab of ['changes', 'acceptance'] as const) test(`a thread refusal hides the cached ${initialTab} pane and its private header`, async () => {
  if (initialTab === 'changes') changesRead = { state: 'ready', changes: {} }
  else acceptance = acceptedTask()
  await renderLive('owner:workspace', { bare: false, initialTab, name: 'Private task name' })
  assert.ok(container.querySelector('[data-private-pane]'))
  await failRead({ status: 403 })
  assert.ok(container.querySelector('[data-private-pane]') === null, 'cached secondary panes must follow the thread refusal')
  assert.doesNotMatch(container.textContent ?? '', /Private task name|Private acceptance notes|Private changes/)
  assert.ok(container.querySelector('[data-slot="thread-artifact"]') === null, 'a refused thread cannot open its cached Artifact menu')
})

test('a retry started before the thread remounts restores the new panel from its shared successful read', async () => {
  await renderLive()
  await failRead({ status: 403 })
  readFailure = null
  let release!: () => void
  readHold = new Promise<void>(resolve => { release = resolve })
  let retry!: Promise<unknown>
  await act(async () => { retry = refreshRead() })
  await renderLive('owner:workspace', {}, false)
  await renderLive()
  assert.ok(container.querySelector('ol') === null)
  await act(async () => { release(); await retry })
  assert.ok(container.querySelector('ol'), 'the shared success must restore the remounted panel')
  assert.ok(container.querySelector('textarea'))
})

test('an open thread ends in the composer whether it runs or has ended', () => {
  for (const status of ['running', 'waiting_input', 'succeeded', 'failed', 'stopped', 'cancelled']) {
    thread = { ...base, status }
    assert.match(render(), /data-slot="thread-composer"[\s\S]*data-composer=""/, `${status} thread has no composer`)
  }
})

test('the Artifact window and the thread column keep the composer', () => {
  assert.match(render({ bare: true }), /data-composer=""/, 'Artifact window (bare)')
  assert.match(render({ bare: false, issueId: null, onOpenTask: undefined }), /data-required-thread-screen=""[\s\S]*data-composer=""/, 'the full thread column without a Task uses the required screen')
})

test('a thread the viewer cannot read in full has no composer', () => {
  thread = { ...base, detail: null }
  assert.doesNotMatch(render(), /data-composer=""/)
})

test('every conversation container draws the shared composer, directly or through the thread panel', () => {
  const direct = ['components/coordinator/coordinator-chat.tsx', 'components/workspace/group-chat-view.tsx', 'components/workspace/issue-thread-panel.tsx']
  for (const file of direct) assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /<ChatComposer\b/, file)
  const threads = ['components/artifacts/artifact-window.tsx', 'components/workspace/task-thread-pane.tsx', 'components/workspace/thread-column.tsx']
  for (const file of threads) assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /<IssueThreadPanel\b/, file)
  // The task page's thread is TaskThreadPane: the run panel, or the task-conversation slot built from it.
  assert.match(readFileSync(new URL('../components/workspace/task-detail.tsx', import.meta.url), 'utf8'), /<TaskThreadPane\b/, 'components/workspace/task-detail.tsx')
  // The panel's composer is not gated on the run being active again (#708 → this fix).
  const panel = readFileSync(new URL('../components/workspace/issue-thread-panel.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(panel, /\(active \|\| question\) && detail && <div/)
})

test('an open thread lets the agent’s words be quoted and every message be copied', () => {
  thread = { ...base, prompt: '> Done.\n\nWhy this way?' }
  const html = render()
  // The agent's reply is where 引用 picks words from; the person's own message is not.
  assert.match(html, /data-quote-source=""[^>]*>[\s\S]*Done\./)
  // The person's message shows the words it quotes above its own, not as `>` lines.
  assert.match(html, /data-slot="reply-quote"[^>]*aria-label="[^"]*Done\.[^"]*"/)
  assert.doesNotMatch(html, /&gt; Done\./)
  assert.equal(html.match(/data-copy-state="idle"/g)?.length, 2)
})

test('the original thread shows the latest failed continuation and its existing Retry control', () => {
  thread = { ...base, status: 'stopped', latestRunId: 'run-2', error: 'Codex subscription execution failed',
    continuation: { id: 'run-2', status: 'failed', stopping: false } }
  const html = render()
  assert.match(html, /data-slot="thread-failure"[\s\S]*Codex subscription execution failed/)
  assert.match(html, /<button[^>]*>Retry<\/button>/)
  assert.match(html, /data-slot="thread-composer"/)
})

test('a historical failure does not offer Retry while the latest continuation works or has succeeded', () => {
  for (const status of ['running', 'succeeded']) {
    thread = { ...base, status: 'failed', latestRunId: 'run-2', error: 'Historical failure',
      continuation: { id: 'run-2', status, stopping: false } }
    assert.doesNotMatch(render(), /data-slot="thread-failure"/)
  }
})


test('an ended independent check hides generic Retry and preserves an editable composer with Send disabled', () => {
  draftText = 'Keep this unsent draft'
  thread = { ...base, status: 'failed', error: 'The selected Agent Profile changed or is no longer available.', replyAvailable: false, retryAvailable: false }
  const html = render()
  assert.match(html, /data-slot="thread-failure"/)
  assert.doesNotMatch(html, /<button[^>]*>Retry<\/button>/)
  assert.match(html, /data-composer-send="" disabled=""/)
  assert.match(html, /data-composer=""[^>]*aria-label="This independent check has ended\. Handle the result in Acceptance\."/)
  assert.doesNotMatch(html, /<textarea[^>]*(?:disabled|readOnly)/)
  assert.equal(composer?.submitDisabled, true)
  assert.equal(composer?.value, draftText, 'ending the check must not erase the draft')
  composer?.onSubmit()
  assert.equal(pageChecks, 0, 'the guarded callback must stop before its first network boundary')
  assert.equal(replyCalls, 0)
})

test('a strict question recovery on a check keeps Retry while ordinary Send remains disabled', () => {
  thread = { ...base, status: 'failed', error: 'Original task machine unavailable', replyAvailable: false, retryAvailable: true }
  const html = render()
  assert.match(html, /<button[^>]*>Retry<\/button>/)
  assert.match(html, /data-composer-send="" disabled=""/)
})

test('a historical failed root retains its diagnostic but cannot offer Retry or a composer', () => {
  thread = { ...base, status: 'failed', error: 'An earlier run failed', retryAvailable: true }
  const html = render({ transcriptOnly: true })
  assert.match(html, /An earlier run failed/)
  assert.doesNotMatch(html, /data-slot="thread-composer"|>Retry</)
  assert.match(render(), />Retry</)
})

test('a failed queued question wake retains its explicit Retry without reopening ordinary Send', () => {
  thread = { ...base, status: 'stopped', latestRunId: 'run-2', question: 'resuming', replyAvailable: true, retryAvailable: true,
    continuation: { id: 'run-2', status: 'queued', stopping: false }, questionWake: { generation: 'generation', error: 'Original task machine unavailable' } }
  const html = render()
  assert.match(html, /<button[^>]*>Retry<\/button>/)
  assert.match(html, /data-composer-send="" disabled=""/)
})

test('the ordinary producer and a current check question keep their composer controls', () => {
  for (const question of [null, 'waiting']) {
    thread = { ...base, status: question ? 'stopped' : 'failed', error: question ? null : 'Execution failed', question, replyAvailable: true, retryAvailable: !question }
    const html = render()
    assert.doesNotMatch(html, /data-composer-send="" disabled=""/)
    assert.match(html, /aria-label="Tell Claude Code what to do next…"/)
    if (!question) assert.match(html, /<button[^>]*>Retry<\/button>/)
  }
})

const acceptedTask = (patch: Partial<FactoryTask> = {}): FactoryTask => ({
  id: 'factory-task-1', issueId: 'issue-1', stage: 'approval', status: 'passed', reason: 'Accepted',
  candidateId: 'candidate-1', candidateRunId: 'run-1', isSkillCandidate: false, ...patch,
})
function expectStatusBadge(html: string, group: string, message?: string) {
  assert.match(html, new RegExp(`<span\\b(?=[^>]*data-slot="badge")(?=[^>]*data-group="${group}")[^>]*>`), message)
}

test('acceptance resolves the current producer badge without rewriting its outcome or disabling its ordinary composer', () => {
  draftText = 'Keep this producer follow-up draft'
  thread = { ...base, outcome: 'needs_input' }
  acceptance = acceptedTask({ status: 'pending' })
  expectStatusBadge(render(), 'waiting')
  acceptance = acceptedTask()
  const html = render()
  expectStatusBadge(html, 'resolved')
  assert.match(html, /Resolved<\/span>/)
  assert.equal(thread.outcome, 'needs_input', 'acceptance is a display fact, not a rewrite of the stored run outcome')
  assert.equal(composer?.value, draftText)
  assert.equal(composer?.submitDisabled, false, 'an accepted producer keeps its existing Send permission')
  assert.doesNotMatch(html, /data-composer-send="" disabled=""/)
  assert.equal(pageChecks, 0, 'rendering acceptance must not issue a reply')
  assert.equal(replyCalls, 0)
})

test('an acceptance display cannot grant Send when the server has withheld ordinary continuation', () => {
  draftText = 'Preserve a guarded draft'
  thread = { ...base, outcome: 'needs_input', replyAvailable: false, retryAvailable: false }
  acceptance = acceptedTask()
  const html = render()
  expectStatusBadge(html, 'resolved')
  assert.equal(composer?.submitDisabled, true)
  assert.equal(composer?.value, draftText)
  composer?.onSubmit()
  assert.equal(pageChecks, 0)
  assert.equal(replyCalls, 0)
})

test('the root panel resolves its accepted latest continuation without changing the root acceptance pane route', () => {
  draftText = 'Keep the current continuation draft'
  thread = { ...base, outcome: 'needs_input', latestRunId: 'run-2',
    continuation: { id: 'run-2', status: 'succeeded', outcome: 'needs_input', stopping: false } }
  acceptance = acceptedTask({ candidateRunId: 'run-2' })
  // Opening a list row still addresses run-1. Its acceptance tab must not be
  // silently redirected to run-2 just to obtain the current status badge.
  const html = render({ initialTab: 'acceptance' })
  expectStatusBadge(html, 'resolved')
  assert.equal(composer?.value, draftText, 'the existing root conversation remains mounted')
  assert.equal(composer?.submitDisabled, false, 'display acceptance preserves the host Send permission')
  assert.equal(thread.outcome, 'needs_input')
  assert.equal(pageChecks, 0)
  assert.equal(replyCalls, 0)
})

const retainedPanelStates: { name: string; task?: Partial<FactoryTask>; run?: Record<string, unknown>; group: string; stopping?: boolean }[] = [
  { name: 'another issue', task: { issueId: 'other-issue' }, group: 'waiting' },
  { name: 'an earlier candidate producer', task: { candidateRunId: 'older-run' }, group: 'waiting' },
  { name: 'a missing current candidate', task: { candidateId: null }, group: 'waiting' },
  { name: 'a skill candidate', task: { isSkillCandidate: true }, group: 'waiting' },
  { name: 'approval not yet accepted', task: { status: 'pending' }, group: 'waiting' },
  { name: 'a passed check before approval', task: { stage: 'review' }, group: 'waiting' },
  { name: 'a failed producer', run: { status: 'failed', outcome: 'blocked' }, group: 'blocked' },
  { name: 'a historical failed review', task: { candidateRunId: 'producer-run' }, run: { status: 'failed', outcome: 'blocked' }, group: 'blocked' },
  { name: 'a later successful continuation', run: { latestRunId: 'run-2', continuation: { id: 'run-2', status: 'succeeded', outcome: 'needs_input', stopping: false } }, group: 'waiting' },
  { name: 'an active run', run: { status: 'running' }, group: 'running' },
  { name: 'a waiting input run', run: { status: 'waiting_input' }, group: 'waiting' },
  { name: 'an unanswered question', run: { question: 'waiting' }, group: 'waiting' },
  { name: 'a resuming question', run: { question: 'resuming', latestRunId: 'run-2', continuation: { id: 'run-2', status: 'queued', stopping: false } }, group: 'running' },
  { name: 'a failed question wake', run: { question: 'resuming', latestRunId: 'run-2', continuation: { id: 'run-2', status: 'queued', stopping: false }, questionWake: { generation: 'wake-1', error: 'Original task machine unavailable' } }, group: 'blocked' },
  { name: 'a quota-paused run', run: { status: 'paused' }, group: 'blocked' },
  { name: 'a requested stop', run: { status: 'running', stopping: true }, group: 'running', stopping: true },
]
for (const scenario of retainedPanelStates) {
  test(`accepted candidate metadata does not replace the panel state of ${scenario.name}`, () => {
    thread = { ...base, outcome: 'needs_input', ...scenario.run }
    acceptance = acceptedTask(scenario.task)
    const html = render()
    assert.doesNotMatch(html, /data-group="resolved"/)
    if (scenario.stopping) assert.match(html, /Stopping[^<]*<\/span>/)
    else expectStatusBadge(html, scenario.group, scenario.name)
    assert.equal(pageChecks, 0)
    assert.equal(replyCalls, 0)
  })
}

test('Thread releases the draft before version preflight and retries an unknown ACK using the same immutable command', async () => {
  const runId = crypto.randomUUID()
  thread = { ...base, id: runId, latestRunId: runId }
  let release!: (value: boolean) => void
  buildGate = new Promise(resolve => { release = resolve })
  const writes: { requestId: string; text: string }[] = []
  postReply = async request => {
    writes.push(request)
    if (writes.length === 1) throw new TypeError('connection closed after write')
    return { sent: true }
  }
  await renderLive('owner:workspace', { runId })
  await act(async () => composer!.onChange('same words'))
  await act(async () => { composer!.onSubmit(); composer!.onSubmit() })
  assert.equal(composer!.value, '')
  assert.equal(container.querySelectorAll('[data-delivery-phase="sending"]').length, 1)
  assert.equal(replyCalls, 0)
  await act(async () => composer!.onChange('next draft'))
  await act(async () => release(true))
  const failed = container.querySelector<HTMLElement>('[data-delivery-phase="failed"]')
  assert.match(failed?.textContent ?? '', /same words/)
  const retry = [...failed!.querySelectorAll('button')].find(button => button.textContent === 'Retry')
  assert.ok(retry, 'the retry belongs to this failed message')
  await act(async () => retry.click())
  assert.equal(writes.length, 2)
  assert.equal(writes[0].requestId, writes[1].requestId)
  assert.equal(writes[1].text, 'same words')
  assert.equal(composer!.value, 'next draft')
  assert.equal(container.querySelectorAll('[data-delivery-phase="accepted"]').length, 1)
})

test('Review retries the original candidate and event in place after the approval response is lost', async t => {
  const runId = crypto.randomUUID()
  thread = { ...base, id: runId, latestRunId: runId }
  const binding = { taskId: crypto.randomUUID(), issueId: crypto.randomUUID(), attemptId: crypto.randomUUID(), candidateId: crypto.randomUUID(), revision: 3 }
  const calls: { url: string; operation: string; input: { eventId: string; note: string; binding: typeof binding } }[] = []
  const originalFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, options?: RequestInit) => {
    if (!String(url).endsWith('/api/factory/tasks/' + binding.taskId + '/approval')) return originalFetch(url, options)
    const body = JSON.parse(String(options?.body))
    calls.push({ url: String(url), ...body })
    if (calls.length === 1) throw new TypeError('response lost after the ledger committed')
    return Response.json({ replayed: true })
  })
  let release!: (ok: boolean) => void
  let canceled = 0
  buildGate = new Promise(resolve => { release = resolve })
  await renderLive('owner:workspace', { runId, changeRequest: { binding, label: 'Request changes', onCancel: () => { canceled++ } } })
  await act(async () => composer!.onChange('Fix the original candidate'))
  await act(async () => { composer!.onSubmit(); composer!.onSubmit() })
  assert.equal(composer!.value, '')
  assert.equal(canceled, 1)
  assert.equal(calls.length, 0)
  assert.equal(container.querySelectorAll('[data-delivery-phase="sending"]').length, 1)
  await act(async () => release(true))
  await renderLive('owner:workspace', { runId })
  await act(async () => composer!.onChange('Separate next draft'))
  const failed = container.querySelector('[data-delivery-phase="failed"]')
  assert.match(failed?.textContent ?? '', /Fix the original candidate/)
  const retry = [...failed!.querySelectorAll('button')].find(button => button.textContent === 'Retry')
  assert.ok(retry)
  await act(async () => retry.click())
  assert.equal(replyCalls, 0, 'a Review command must reach its candidate ledger')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], calls[1])
  assert.equal(calls[1].operation, 'reject')
  assert.equal(calls[1].url.endsWith('/api/factory/tasks/' + binding.taskId + '/approval'), true)
  assert.match(calls[1].input.eventId, /^[\da-f-]{36}$/i)
  assert.deepEqual(calls[1].input.binding, binding)
  assert.equal(calls[1].input.note, 'Fix the original candidate')
  assert.equal(composer!.value, 'Separate next draft')
  assert.equal(container.querySelectorAll('[data-delivery-phase="accepted"]').length, 1)
})

test('Inbox waiting replies keep the original thread, viewer, workspace and request ID across an unknown result and remount', async () => {
  const { useInboxThreadReply } = await import('../lib/hooks/chat-delivery')
  const issueId = crypto.randomUUID(), runId = crypto.randomUUID(), laterRunId = crypto.randomUUID()
  const viewer = { ownerId: crypto.randomUUID(), workspaceId: crypto.randomUUID() }
  let submit!: ReturnType<typeof useInboxThreadReply>
  function InboxReply({ current }: { current: typeof viewer | null }) {
    submit = useInboxThreadReply(current)
    return null
  }
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  root = createRoot(container)
  const renderInbox = (current: typeof viewer | null, visible = true) => act(async () => root!.render(
    <actualViewState.ViewStateProvider scope={current ? current.ownerId + ':' + current.workspaceId : 'no-scope'}>
      <IntlProvider locale="en" timeZone="UTC" messages={messages}>{visible && <InboxReply current={current} />}</IntlProvider>
    </actualViewState.ViewStateProvider>,
  ))
  const calls: unknown[] = []
  postReply = async request => {
    calls.push(request)
    if (calls.length === 1) throw new TypeError('lost response')
    return { sent: true }
  }
  await renderInbox(null)
  assert.equal((await submit(issueId, runId, 'Original answer')).status, 'unavailable')
  buildGate = Promise.resolve(false)
  thread = { ...base, id: runId, latestRunId: runId }
  await renderLive(viewer.ownerId + ':' + viewer.workspaceId, { issueId, runId })
  await act(async () => composer!.onChange('Draft on an old build'))
  await act(async () => { composer!.onSubmit() })
  const reason = container.querySelector('[data-delivery-phase="failed"] [role="alert"]')?.firstChild?.textContent
  assert.equal(reason, messages.Coordinator.sendUpdateRequired)
  await renderInbox(viewer)
  await act(async () => { assert.deepEqual(await submit(issueId, runId, 'Draft on an old build'), { status: 'failed', error: reason }) })
  assert.equal(calls.length, 0)
  buildGate = undefined
  await act(async () => { assert.equal((await submit(issueId, runId, 'Original answer')).status, 'uncertain') })
  await act(async () => { assert.equal((await submit(issueId, runId, 'Independent answer')).status, 'accepted') })
  await renderInbox(viewer, false)
  await renderInbox(viewer)
  await act(async () => { assert.equal((await submit(issueId, laterRunId, 'Original answer')).status, 'accepted') })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], calls[2])
  assert.notEqual((calls[1] as { requestId: string }).requestId, (calls[0] as { requestId: string }).requestId)
  const original = calls[2] as { requestId: string }
  assert.match(original.requestId, /^[\da-f-]{36}$/i)
  assert.deepEqual(original, { issueId, runId, text: 'Original answer', requestId: original.requestId,
    expectedOwnerId: viewer.ownerId, expectedWorkspaceId: viewer.workspaceId })
  await act(async () => { assert.equal((await submit(issueId, laterRunId, 'Original answer')).status, 'accepted') })
  assert.notEqual((calls[3] as { requestId: string }).requestId, original.requestId, 'an acknowledged answer must not consume a later independent answer')
  const { DesktopTransportError } = await import('../apps/desktop/src/renderer/read-batch')
  for (const [status, expected] of [[401, messages.Errors.authRequired], [403, messages.Coordinator.sendAccessDenied],
    [426, messages.Coordinator.sendUpdateRequired], [429, messages.Coordinator.sendRateLimited]] as const) {
    postReply = async () => { throw new DesktopTransportError('desktop_rpc_request_rejected', { status }) }
    await act(async () => { assert.deepEqual(await submit(issueId, runId, 'Denied ' + status), { status: 'failed', error: expected }) })
  }
})
