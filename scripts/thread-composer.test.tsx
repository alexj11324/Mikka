import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, beforeEach, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
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
let acceptance: FactoryTask | null = null
mock.module('swr', {
  defaultExport: (key: unknown) => Array.isArray(key) && key[0] === 'issue-thread'
    ? { data: thread && { thread, chunks: [{ chunk: { type: 'text-delta', id: 'a', delta: 'Done.' }, at: new Date(0) }], messages: [] }, mutate: () => {} }
    // Where the thread runs is its own read (thread-run-place.tsx); none here.
    : Array.isArray(key) && key[0] === 'thread-machine' ? { data: null, mutate: () => {} }
    : { data: [], mutate: () => {} },
  namedExports: { useSWRConfig: () => ({ mutate: () => {}, cache: new Map() }), unstable_serialize: (key: unknown) => JSON.stringify(key) },
})
mock.module('next/dynamic', { defaultExport: () => () => null })
mock.module(at('lib/hooks/view-state.tsx'), { namedExports: {
  ...actualViewState,
  useViewState: <T,>(key: string, initial: T) => actualViewState.useViewState(key, key.endsWith(':draft') ? draftText as T : initial),
} })
mock.module(at('lib/app-build.ts'), { namedExports: { ...actualAppBuild, checkPageBuildBeforeAction: async () => { pageChecks++; return true } } })
mock.module(at('app/actions/agents.ts'), { namedExports: { retryQuotaPausedRun: async () => null, resumeQuotaPausedRunOnApiKey: async () => null, getThreadName: async () => null, listIssueThreads: async () => null, pollIssueThreads: async () => null, getIssueThread: async () => null, getThreadChanges: async () => ({ state: 'none' }), getThreadMachine: async () => null, sendIssueThreadMessage: async () => {}, sendIssueThreadReply: async () => { replyCalls++; return { sent: true } }, stopRun: async () => ({}) } })
mock.module(at('app/actions/artifacts.ts'), { namedExports: { listRunArtifacts: async () => [] } })
mock.module(at('components/workspace/factory-acceptance.tsx'), { namedExports: {
  useThreadAcceptance: (issueId: string | null, runId: string) =>
    acceptance?.issueId === issueId && acceptance.candidateRunId === runId ? acceptance : null,
  useAcceptanceTasks: () => ({ tasks: acceptance ? [acceptance] : [], allTasks: acceptance ? [acceptance] : [] }),
  AcceptanceStateBadge: () => null,
} })
mock.module(at('components/workspace/factory-acceptance-pane.tsx'), { namedExports: { FactoryAcceptancePane: () => null } })
mock.module(at('components/workspace/self-improvement.tsx'), { namedExports: { ThreadFeedback: () => null } })
let composer: { label: string; value: string; submitDisabled?: boolean; onSubmit: () => void } | null = null
let replyCalls = 0
mock.module(at('components/coordinator/chat-composer.tsx'), { namedExports: { ChatComposer: (props: { label: string; value: string; submitDisabled?: boolean; onSubmit: () => void }) => {
  composer = props
  return <><textarea data-composer="" aria-label={props.label} defaultValue={props.value} /><button data-composer-send="" disabled={props.submitDisabled}>Send</button></>
} } })

let IssueThreadPanel: typeof import('../components/workspace/issue-thread-panel')['IssueThreadPanel']
before(async () => { ({ IssueThreadPanel } = await import('../components/workspace/issue-thread-panel')) })
const base = { id: 'run-1', issueId: 'issue-1', status: 'succeeded', outcome: null, question: null, continuation: null, stopping: false, ownedByCurrentUser: true,
  createdAt: new Date(0), finishedAt: new Date(0), latestRunId: 'run-1', prompt: 'Fix it', stopRequestedAt: null, replyAvailable: true, retryAvailable: true, quota: null, feedbackEligible: false,
  detail: { name: 'ZHIX-2 Fix it', agentName: 'Claude Code', harness: 'claude_code', summary: null } }
beforeEach(() => { thread = { ...base }; acceptance = null; composer = null; replyCalls = 0; draftText = ''; pageChecks = 0 })
const render = (props: Partial<Parameters<typeof IssueThreadPanel>[0]> = {}) => renderToStaticMarkup(<IntlProvider locale="en" timeZone="UTC" messages={messages}>
  <IssueThreadPanel issueId="issue-1" runId="run-1" onClose={() => {}} {...props} />
</IntlProvider>)

test('an open thread ends in the composer whether it runs or has ended', () => {
  for (const status of ['running', 'waiting_input', 'succeeded', 'failed', 'stopped', 'cancelled']) {
    thread = { ...base, status }
    assert.match(render(), /data-slot="thread-composer"[\s\S]*data-composer=""/, `${status} thread has no composer`)
  }
})

test('the Artifact window and the thread column keep the composer', () => {
  assert.match(render({ bare: true }), /data-composer=""/, 'Artifact window (bare)')
  assert.match(render({ issueId: null, onOpenTask: undefined }), /data-composer=""/, 'thread column, a thread with no task')
})

test('a thread the viewer cannot read in full has no composer', () => {
  thread = { ...base, detail: null }
  assert.doesNotMatch(render(), /data-composer=""/)
})

test('every conversation container draws the shared composer, directly or through the thread panel', () => {
  const direct = ['components/coordinator/coordinator-chat.tsx', 'components/workspace/group-chat-view.tsx', 'components/workspace/issue-thread-panel.tsx']
  for (const file of direct) assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /<ChatComposer\b/, file)
  const threads = ['components/artifacts/artifact-window.tsx', 'components/workspace/task-detail.tsx', 'components/workspace/thread-column.tsx']
  for (const file of threads) assert.match(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /<IssueThreadPanel\b/, file)
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
