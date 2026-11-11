import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskConversationProps } from '../components/slots/task-conversation-contract'

// The single-run panel reads threads through server actions; only which panel opens, and with what, matters here.
const panels: { issueId: string | null; runId: string; initialTab?: string }[] = []
mock.module(new URL('../components/workspace/issue-thread-panel.tsx', import.meta.url).href, { namedExports: {
  IssueThreadPanel: (props: { issueId: string | null; runId: string; initialTab?: string }) => { panels.push(props); return <section data-panel={props.runId} /> },
} })

const { TaskThreadPane } = await import('../components/workspace/task-thread-pane')
const { agentStretches } = await import('../lib/issue-threads')

const conversations: TaskConversationProps[] = []
const Conversation = (props: TaskConversationProps) => { conversations.push(props); return <section data-conversation={props.runId} /> }
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
  const html = renderToStaticMarkup(<TaskThreadPane issueId="task" runId={stretch.first.id} tab="chat" onOpenThread={noop} onBack={noop} conversation={Conversation} />)
  assert.equal(panels.length, 0, 'not a single run\'s thread')
  assert.equal(conversations.length, 1)
  assert.equal(conversations[0].issueId, 'task', 'the task\'s joined conversation: every run of the task, oldest first')
  assert.equal(conversations[0].runId, 'failed', 'scrolled to the start of the stretch, so 已修复 follows it inline')
  assert.match(html, /data-conversation="failed"/)
})

test('验收 stays the run\'s own panel, and so does every thread in the build without a layer', () => {
  conversations.length = 0; panels.length = 0
  renderToStaticMarkup(<TaskThreadPane issueId="task" runId="fixed" tab="acceptance" onOpenThread={noop} onBack={noop} conversation={Conversation} />)
  renderToStaticMarkup(<TaskThreadPane issueId="task" runId="failed" tab="chat" onOpenThread={noop} onBack={noop} conversation={null} />)
  assert.equal(conversations.length, 0)
  assert.deepEqual(panels.map(panel => [panel.runId, panel.initialTab]), [['fixed', 'acceptance'], ['failed', 'chat']])
})

test('the default slot has no conversation, so the public build keeps the run panel', async () => {
  const slot = await import('../components/slots/task-conversation')
  assert.equal(slot.TaskConversation, null)
  panels.length = 0
  renderToStaticMarkup(<TaskThreadPane issueId="task" runId="failed" tab="chat" onOpenThread={noop} onBack={noop} />)
  assert.deepEqual(panels.map(panel => panel.runId), ['failed'])
})
