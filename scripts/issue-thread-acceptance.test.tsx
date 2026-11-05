import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, beforeEach, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { IntlProvider } from 'next-intl'
import type { IssueThread } from '../lib/issue-threads'
import type { FactoryTask } from '../components/workspace/factory-acceptance-pane'

// Render the actual row and status components. The accepted ledger refreshes
// independently of the run read; this must change presentation, never run data.
const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'))
const at = (path: string) => new URL(`../${path}`, import.meta.url).href
let threads: IssueThread[] = []
let tasks: FactoryTask[] = []
mock.module('swr', {
  defaultExport: (key: unknown) => Array.isArray(key) && key[0] === 'issue-threads'
    ? { data: { threads, live: { workspaceId: 'workspace-1' } }, mutate: () => {} }
    : { data: undefined, mutate: () => {} },
  namedExports: { unstable_serialize: (key: unknown) => JSON.stringify(key) },
})
mock.module(at('app/actions/agents.ts'), { namedExports: { pollIssueThreads: async () => null } })
mock.module(at('hooks/use-live-key.tsx'), { namedExports: { useLiveKey: () => {} } })
// The old component need not consume this hook to mount. Its positive cases
// fail on the rendered Waiting badge, not on an absent future helper import.
mock.module(at('components/workspace/factory-acceptance.tsx'), { namedExports: {
  useAcceptanceTasks: () => ({ tasks, allTasks: tasks }),
  useThreadAcceptance: () => null,
  AcceptanceStateBadge: () => null,
} })

let IssueThreads: typeof import('../components/workspace/issue-threads')['IssueThreads']
before(async () => { ({ IssueThreads } = await import('../components/workspace/issue-threads')) })
const producer = (patch: Partial<IssueThread> = {}): IssueThread => ({
  id: 'producer-1', rootRunId: 'producer-1', latestRunId: 'producer-1', status: 'succeeded', outcome: 'needs_input',
  stopping: false, question: null, continuation: null, ownedByCurrentUser: true, ownerName: null,
  createdAt: new Date(0), finishedAt: new Date(1),
  detail: { name: 'Current producer', agentName: 'Claude Code', harness: 'claude_code', summary: null },
  attempts: [{ runId: 'producer-1', attempt: 1, status: 'succeeded', outcome: 'needs_input', stopping: false, createdAt: new Date(0), finishedAt: new Date(1) }],
  ...patch,
})
const accepted = (patch: Partial<FactoryTask> = {}): FactoryTask => ({
  id: 'factory-task-1', issueId: 'issue-1', stage: 'approval', status: 'passed', reason: 'Accepted',
  candidateId: 'candidate-1', candidateRunId: 'producer-1', isSkillCandidate: false, ...patch,
})
beforeEach(() => { threads = [producer()]; tasks = [accepted()] })
const render = () => renderToStaticMarkup(<IntlProvider locale="en" timeZone="UTC" now={new Date(2)} messages={messages}>
  <IssueThreads issueId="issue-1" openId={null} onOpen={() => {}} />
</IntlProvider>)
function expectRowGroup(html: string, group: string) {
  assert.match(html, new RegExp(`<span\\b(?=[^>]*role="img")(?=[^>]*data-group="${group}")[^>]*>`), 'the row icon must agree with its status badge')
  assert.match(html, new RegExp(`<span\\b(?=[^>]*data-slot="badge")(?=[^>]*data-group="${group}")[^>]*>`), 'the visible status badge must use acceptance for this exact producer')
}

test('a committed acceptance resolves the current producer row while its stored run outcome stays needs_input', () => {
  tasks = [accepted({ status: 'pending' })]
  expectRowGroup(render(), 'waiting')
  tasks = [accepted()]
  const html = render()
  expectRowGroup(html, 'resolved')
  assert.match(html, /Resolved<\/span>/)
  assert.equal(threads[0].outcome, 'needs_input')
  assert.equal(threads[0].status, 'succeeded')
})

test('accepting the producer preserves the independent review result and the historical blocked attempt', () => {
  threads = [producer(), producer({ id: 'review-current', rootRunId: 'review-current', latestRunId: 'review-current', outcome: 'done' }),
    producer({ id: 'review-old', rootRunId: 'review-old', latestRunId: 'review-old', status: 'failed', outcome: 'blocked' })]
  const rows = [...render().matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(match => match[1])
  assert.equal(rows.length, 3)
  expectRowGroup(rows[0], 'resolved')
  expectRowGroup(rows[1], 'resolved')
  expectRowGroup(rows[2], 'blocked')
  assert.equal(threads[2].outcome, 'blocked')
})

const retainedRowStates: { name: string; task?: Partial<FactoryTask>; run?: Partial<IssueThread>; group: string; stopping?: boolean }[] = [
  { name: 'another issue', task: { issueId: 'other-issue' }, group: 'waiting' },
  { name: 'an earlier candidate', task: { candidateRunId: 'older-producer' }, group: 'waiting' },
  { name: 'a candidate without its producer', task: { candidateRunId: null }, group: 'waiting' },
  { name: 'no current candidate', task: { candidateId: null }, group: 'waiting' },
  { name: 'a skill candidate', task: { isSkillCandidate: true }, group: 'waiting' },
  { name: 'pending approval', task: { status: 'pending' }, group: 'waiting' },
  { name: 'a review passed before acceptance', task: { stage: 'review' }, group: 'waiting' },
  { name: 'a failed current producer', run: { status: 'failed', outcome: 'blocked' }, group: 'blocked' },
  { name: 'a newer successful continuation', run: { latestRunId: 'continuation-1', continuation: { id: 'continuation-1', status: 'succeeded', outcome: 'needs_input', stopping: false } }, group: 'waiting' },
  { name: 'a newer failed continuation', run: { latestRunId: 'continuation-1', continuation: { id: 'continuation-1', status: 'failed', outcome: 'blocked', stopping: false } }, group: 'blocked' },
  { name: 'an active run', run: { status: 'running' }, group: 'running' },
  { name: 'an input-waiting run', run: { status: 'waiting_input' }, group: 'waiting' },
  { name: 'an unanswered question', run: { question: 'waiting' }, group: 'waiting' },
  { name: 'a resuming question', run: { question: 'resuming', latestRunId: 'continuation-1', continuation: { id: 'continuation-1', status: 'queued', stopping: false } }, group: 'running' },
  { name: 'a failed question wake', run: { question: 'resuming', latestRunId: 'continuation-1', continuation: { id: 'continuation-1', status: 'queued', stopping: false }, questionWake: { generation: 'wake-1', error: 'Original task machine unavailable' } }, group: 'blocked' },
  { name: 'a quota-paused run', run: { status: 'paused' }, group: 'blocked' },
  { name: 'a requested stop', run: { status: 'running', stopping: true }, group: 'running', stopping: true },
]
for (const scenario of retainedRowStates) {
  test(`accepted metadata preserves the row state for ${scenario.name}`, () => {
    threads = [producer(scenario.run)]
    tasks = [accepted(scenario.task)]
    const html = render()
    assert.doesNotMatch(html, /data-group="resolved"/)
    if (scenario.stopping) assert.match(html, /Stopping[^<]*<\/span>/)
    else expectRowGroup(html, scenario.group)
  })
}
