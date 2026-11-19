// Review C1: a chat event reads as a line in Chinese with the thread's name, never the model's English text.
import assert from 'node:assert/strict'
import test from 'node:test'
import { eventText, questionCard } from '../lib/event-line.ts'
// The line's words are catalog entries now (R-42), so the assertions read them back instead of
// repeating the Chinese: this suite runs under whatever the device locale is.
import { mobileMessages } from '../lib/messages.ts'

const zh = mobileMessages.MobileCore.event
const zhStatus = mobileMessages.Issue.status
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')

const runId = 'de300000-2b09-4c5e-8a10-1234567890ab'
const sources = { [runId]: { kind: 'run' as const, id: runId, name: '复现 Safari 白屏', status: 'waiting_input', issue: { id: 'i1', identifier: 'QN-12', number: 12, title: '登录页在 Safari 17 上白屏' } } } as never

test('an event names its thread and says what happened', () => {
  const task = '登录页在 Safari 17 上白屏'
  assert.equal(eventText({ kind: 'runQuestion', runId, issueId: null, status: null, title: null }, sources), `${task} ${zh.runQuestion}`)
  assert.equal(eventText({ kind: 'runFinished', runId, issueId: null, status: 'failed', title: null }, sources), `${task} ${zh.runFailed}`)
  assert.equal(eventText({ kind: 'issueStatus', runId: null, issueId: 'x', status: 'review', title: 'Trim the bundle' }, {}), fill(zh.taskNowStatus, { task: fill(zh.quotedTitle, { title: 'Trim the bundle' }), status: zhStatus.review }))
  assert.equal(eventText({ kind: 'runRetried', runId: 'unknown', issueId: null, status: null, title: null }, {}), `${zh.someThread} ${zh.runRetried}`)
})

test('an unknown event or an older server never shows the stored text', () => {
  assert.equal(eventText({ kind: 'other', runId: null, issueId: null, status: null, title: null }, {}), zh.newEvent)
  assert.equal(eventText(undefined, {}), zh.newEvent)
})

test('schedule results and task snapshots retain their useful status without protocol details', () => {
  const line = { kind: 'scheduleRan' as const, runId: null, issueId: null, status: 'succeeded', title: '每日报告' }
  assert.equal(eventText(line, {}), `${fill(zh.scheduledTitle, { title: '每日报告' })} ${zh.scheduleRan}`)
  for (const [status, text] of Object.entries({ failed: zh.scheduleFailed, skipped: zh.scheduleSkipped, cancelled: zh.runCancelled })) {
    assert.equal(eventText({ ...line, status }, {}), `${fill(zh.scheduledTitle, { title: '每日报告' })} ${text}`)
  }
  assert.equal(eventText({ ...line, kind: 'scheduleDue', status: null }, {}), fill(zh.scheduleDue, { schedule: fill(zh.scheduledTitle, { title: '每日报告' }) }))
  assert.equal(eventText({ ...line, kind: 'issueSnapshot', issueId: 'task-id', title: '准备报告', status: 'review' }, {}), fill(zh.taskIsStatus, { task: fill(zh.quotedTitle, { title: '准备报告' }), status: zhStatus.review }))
})

test('a thread still waiting for an answer is a card named without its task key (#1386)', () => {
  const line = { kind: 'runQuestion' as const, runId, issueId: null, status: null, title: null }
  assert.deepEqual(questionCard(line, sources), { runId, title: '登录页在 Safari 17 上白屏' })
  const waiting = { [runId]: { ...(sources as Record<string, object>)[runId], group: 'waiting' } } as never
  assert.deepEqual(questionCard(line, waiting), { runId, title: '登录页在 Safari 17 上白屏' })
  const answered = { [runId]: { ...(sources as Record<string, object>)[runId], group: 'running' } } as never
  assert.equal(questionCard(line, answered), null)
  assert.equal(questionCard({ ...line, kind: 'runReport' }, sources), null)
  assert.equal(questionCard(line, {}), null)
})
