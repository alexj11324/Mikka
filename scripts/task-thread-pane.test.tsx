import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskConversationProps } from '../components/slots/task-conversation-contract'

// The single-run panel reads threads through server actions; only which panel opens, and with what, matters here.
const panels: { issueId: string | null; runId: string; initialTab?: string }[] = []
mock.module(new URL('../components/workspace/issue-thread-panel.tsx', import.meta.url).href, { namedExports: {
  IssueThreadPanel: (props: { issueId: string | null; runId: string; initialTab?: string }) => { panels.push(props); return <section data-panel={props.runId} /> },
} })

const { agentStretches } = await import('../lib/issue-threads')

const conversations: TaskConversationProps[] = []
const Conversation = (props: TaskConversationProps) => { conversations.push(props); return <section data-conversation={props.runId} /> }
mock.module(new URL('../components/slots/task-conversation.tsx', import.meta.url).href, { namedExports: { TaskConversation: Conversation } })
const { TaskThreadPane } = await import('../components/workspace/task-thread-pane')
const noop = () => {}

// One Agent stretch: Claude Code's run failed, its next run fixed it; then Codex took over.
const threads = [
  { id: 'failed', kind: 'implement', createdAt: new Date('2026-11-09T04:04:00Z'), detail: { harness: 'claude_code' }, status: 'failed' },
  { id: 'fixed', kind: 'implement', createdAt: new Date('2026-11-09T04:30:00Z'), detail: { harness: 'claude_code' }, status: 'succeeded' },
  { id: 'codex', kind: 'implement', createdAt: new Date('2026-11-09T05:10:00Z'), detail: { harness: 'codex' }, status: 'succeeded' },
]

test('an 活动 row opens the task\'s one conversation at its stretch\'s start, so failed → fixed read inline (2026-11-04-2200)', () => {
  const [stretch] = agentStretches(threads)
  assert.deepEqual(stretch.ids, ['failed', 'fixed'], 'the failed run and the run that fixed it are one stretch, one row')
  conversations.length = 0; panels.length = 0
  const html = renderToStaticMarkup(<TaskThreadPane issueId="task" runId={stretch.first.id} tab="chat" onOpenThread={noop} onBack={noop} />)
  assert.equal(panels.length, 0, 'not a single run\'s thread')
  assert.equal(conversations.length, 1)
  assert.equal(conversations[0].issueId, 'task', 'the task\'s joined conversation: every run of the task, oldest first')
  assert.equal(conversations[0].runId, 'failed', 'scrolled to the start of the stretch, so 已修复 follows it inline')
  assert.match(html, /data-conversation="failed"/)
})

test('验收 stays the chosen run’s own panel', () => {
  conversations.length = 0; panels.length = 0
  renderToStaticMarkup(<TaskThreadPane issueId="task" runId="fixed" tab="acceptance" onOpenThread={noop} onBack={noop} />)
  assert.equal(conversations.length, 0)
  assert.deepEqual(panels.map(panel => [panel.runId, panel.initialTab]), [['fixed', 'acceptance']])
})

test('Task entries import the required frame and joined conversation directly', () => {
  const files = [
    ['workspace/task-detail', 'TaskDetailFrame', 'task-detail'],
    ['workspace/task-thread-pane', 'TaskConversation', 'task-conversation'],
    ['workspace/thread-column', 'TaskConversation', 'task-conversation'],
    ['coordinator/conversation-panels', 'TaskConversation', 'task-conversation'],
  ]
  for (const [file, component, slot] of files) {
    const source = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), 'utf8')
    assert.match(source, new RegExp(`import [{] ${component} [}] from '@ui-slot/${slot}'`), file)
    assert.doesNotMatch(source, /(?:if\s*\(\s*(?:Frame|TaskDetailFrame|TaskConversation)\s*\)|(?:TaskDetailFrame|TaskConversation)\s*(?:&&|\?\?))/, file)
  }
})
