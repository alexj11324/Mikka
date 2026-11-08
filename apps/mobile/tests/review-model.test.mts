import assert from 'node:assert/strict'
import test from 'node:test'
import { addComment, batchIsEmpty, batchLine, checksLine, editComment, EMPTY_BATCH, lineNumber, removeComment, sendBody, sourceLine, summaryLabel, summaryParts, toggleCheck, type ReviewSummary } from '../features/review/model/review.ts'

const summary = (extra: Partial<ReviewSummary> = {}): ReviewSummary => ({ pr: { number: 1471, state: 'open' }, files: 3, additions: 42, deletions: 7, checks: { failed: 1, passed: 5, pending: 0 }, running: false, ...extra })

test('the summary line: PR, files and lines, then the most urgent state (R0, R2a)', () => {
  assert.equal(summaryLabel(summary()), 'PR #1471，3 个文件 +42 −7，1 项检查失败')
  assert.equal(summaryLabel(summary({ pr: null, running: true, checks: { failed: 0, passed: 0, pending: 0 } })), '3 个文件 +42 −7，运行中')
  assert.equal(summaryParts(summary({ pr: { number: 1471, state: 'merged' } })).status, '已合并')
  assert.equal(summaryParts(summary({ pr: { number: 1471, state: 'merged' } })).failed, false)
  assert.equal(summaryParts(summary({ checks: { failed: 0, passed: 6, pending: 0 } })).status, '检查通过')
  // R2a's short form under the task title: no file count, 「1 项失败」; before a PR it keeps the files.
  assert.deepEqual([summaryParts(summary(), true).files, summaryParts(summary(), true).status], [null, '1 项失败'])
  assert.equal(summaryParts(summary({ pr: null, running: true }), true).files, '3 个文件')
})

test('the check row and the reclaimed-machine source line', () => {
  assert.equal(checksLine({ failed: 1, passed: 5, pending: 0 }), '1 项检查失败 · 5 项通过')
  assert.equal(checksLine({ failed: 0, passed: 0, pending: 0 }), '没有检查')
  assert.equal(sourceLine({ kind: 'machine', at: 'x', live: true }, () => 't'), null)
  assert.equal(sourceLine({ kind: 'checkpoint', at: 'x', live: false }, () => '昨天'), '机器已回收，显示的是最后一次检查点的改动 · 昨天')
})

test('the batch: add, edit and remove comments, attach a failing check, and the bar line', () => {
  const checks = [{ id: 'c1', name: 'ios-unit', conclusion: 'failure' as const }]
  let batch = addComment(EMPTY_BATCH, { id: 'a', path: 'cb.ts', line: 22, side: 'new', body: '用 config', quote: '+ const x' })
  batch = addComment(batch, { id: 'b', path: 'cb.ts', line: 25, side: 'new', body: '补测试', quote: '+ y' })
  batch = toggleCheck(batch, 'c1')
  assert.equal(batchLine(batch, checks), '2 条评论 · ios-unit 失败')
  batch = editComment(batch, 'a', '用 config 的 fallback')
  assert.equal(batch.comments[0]!.body, '用 config 的 fallback')
  batch = removeComment(toggleCheck(batch, 'c1'), 'b')
  assert.equal(batchLine(batch, checks), '1 条评论')
  assert.equal(batchIsEmpty(removeComment(batch, 'a')), true)
  assert.equal(batchIsEmpty({ ...EMPTY_BATCH, note: '整体再看一下' }), false)
})

test('发给 Agent sends trimmed comments, the note when there is one and the attached checks, with the batch key', () => {
  const batch = { comments: [{ id: 'a', path: 'cb.ts', line: 22, side: 'new' as const, body: ' 用 config ', quote: '' }, { id: 'b', path: 'cb.ts', line: 9, side: 'old' as const, body: '  ', quote: '' }], note: '', checks: ['c1'] }
  assert.deepEqual(sendBody(batch, 'k1'), { idempotencyKey: 'k1', comments: [{ path: 'cb.ts', line: 22, side: 'new', body: '用 config' }], checks: ['c1'] })
  assert.deepEqual(sendBody({ ...batch, note: ' 先跑测试 ' }, 'k1').note, '先跑测试')
})

test('a removed line is titled by its old number', () => {
  assert.equal(lineNumber({ kind: 'del', old: 22, text: 'x' }), 22)
  assert.equal(lineNumber({ kind: 'add', new: 23, text: 'x' }), 23)
})
