import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, beforeEach, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { IntlProvider } from 'next-intl'

// R-10: every conversation ends in the shared composer. An open thread is one, so it keeps
// the composer after it finishes: an Artifact window, a task's thread and a thread opened
// from a chat all draw IssueThreadPanel. Only the legacy agent archive is read-only.

const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'))
const at = (path: string) => new URL(`../${path}`, import.meta.url).href
let thread: Record<string, unknown> | null
mock.module('swr', {
  defaultExport: (key: unknown) => Array.isArray(key) && key[0] === 'issue-thread'
    ? { data: thread && { thread, chunks: [{ chunk: { type: 'text-delta', id: 'a', delta: 'Done.' }, at: new Date(0) }], messages: [] }, mutate: () => {} }
    : { data: [], mutate: () => {} },
  namedExports: { useSWRConfig: () => ({ mutate: () => {}, cache: new Map() }), unstable_serialize: (key: unknown) => JSON.stringify(key) },
})
mock.module('next/dynamic', { defaultExport: () => () => null })
mock.module(at('app/actions/agents.ts'), { namedExports: { retryQuotaPausedRun: async () => null, resumeQuotaPausedRunOnApiKey: async () => null, getThreadName: async () => null, listIssueThreads: async () => null, getIssueThread: async () => null, getThreadChanges: async () => ({ state: 'none' }), sendIssueThreadMessage: async () => {}, sendIssueThreadReply: async () => ({ sent: true }), stopRun: async () => ({}) } })
mock.module(at('app/actions/artifacts.ts'), { namedExports: { listRunArtifacts: async () => [] } })
mock.module(at('components/workspace/factory-acceptance.tsx'), { namedExports: { useThreadAcceptance: () => null, AcceptanceStateBadge: () => null } })
mock.module(at('components/workspace/factory-acceptance-pane.tsx'), { namedExports: { FactoryAcceptancePane: () => null } })
mock.module(at('components/workspace/self-improvement.tsx'), { namedExports: { ThreadFeedback: () => null } })
mock.module(at('components/coordinator/chat-composer.tsx'), { namedExports: { ChatComposer: ({ label }: { label: string }) => <textarea data-composer="" aria-label={label} /> } })

let IssueThreadPanel: typeof import('../components/workspace/issue-thread-panel')['IssueThreadPanel']
before(async () => { ({ IssueThreadPanel } = await import('../components/workspace/issue-thread-panel')) })
const base = { id: 'run-1', issueId: 'issue-1', status: 'succeeded', outcome: null, question: null, continuation: null, stopping: false, ownedByCurrentUser: true,
  createdAt: new Date(0), finishedAt: new Date(0), latestRunId: 'run-1', prompt: 'Fix it', stopRequestedAt: null, quota: null, feedbackEligible: false,
  detail: { name: 'ZHIX-2 Fix it', agentName: 'Claude Code', harness: 'claude_code', summary: null } }
beforeEach(() => { thread = { ...base } })
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
