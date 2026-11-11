// Review C1: a chat event reads as a line in Chinese with the thread's name, never the model's English text.
import assert from 'node:assert/strict'
import test from 'node:test'
import { eventText, questionCard } from '../lib/event-line.ts'

const runId = 'de300000-2b09-4c5e-8a10-1234567890ab'
const sources = { [runId]: { kind: 'run' as const, id: runId, name: '复现 Safari 白屏', status: 'waiting_input', issue: { id: 'i1', identifier: 'QN-12', number: 12, title: '登录页在 Safari 17 上白屏' } } } as never

test('an event names its thread and says what happened', () => {
  assert.equal(eventText({ kind: 'runQuestion', runId, issueId: null, status: null, title: null }, sources), '登录页在 Safari 17 上白屏 在等你回答')
  assert.equal(eventText({ kind: 'runFinished', runId, issueId: null, status: 'failed', title: null }, sources), '登录页在 Safari 17 上白屏 失败了')
  assert.equal(eventText({ kind: 'issueStatus', runId: null, issueId: 'x', status: 'review', title: 'Trim the bundle' }, {}), '「Trim the bundle」 改为评审中')
  assert.equal(eventText({ kind: 'runRetried', runId: 'unknown', issueId: null, status: null, title: null }, {}), '一个线程 换了一台机器继续')
})

test('an unknown event or an older server never shows the stored text', () => {
  assert.equal(eventText({ kind: 'other', runId: null, issueId: null, status: null, title: null }, {}), '有一条新动态')
  assert.equal(eventText(undefined, {}), '有一条新动态')
})

test('schedule results and task snapshots retain their useful status without protocol details', () => {
  const line = { kind: 'scheduleRan' as const, runId: null, issueId: null, status: 'succeeded', title: '每日报告' }
  assert.equal(eventText(line, {}), '定时任务「每日报告」 已执行')
  for (const [status, text] of Object.entries({ failed: '执行失败', skipped: '已跳过', cancelled: '已取消' })) {
    assert.equal(eventText({ ...line, status }, {}), `定时任务「每日报告」 ${text}`)
  }
  assert.equal(eventText({ ...line, kind: 'scheduleDue', status: null }, {}), '定时任务「每日报告」 到时间了')
  assert.equal(eventText({ ...line, kind: 'issueSnapshot', issueId: 'task-id', title: '准备报告', status: 'review' }, {}), '「准备报告」 状态为评审中')
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
