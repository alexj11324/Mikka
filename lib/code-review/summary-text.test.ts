import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { formatReviewSummary, reviewSummaryParts, type ReviewSummaryTranslate } from './summary-text'

// The zh-CN words, with {name} filled in: what next-intl does for these messages.
const messages = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')).CodeReview.summary as Record<string, string>
const t: ReviewSummaryTranslate = (key, values = {}) => messages[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]))

const base = { files: 3, additions: 42, deletions: 7, checks: { failed: 1, passed: 5, pending: 0 } }
const pr = { number: 1471, state: 'open' as const, url: 'https://github.com/acme/app/pull/1471' }

test('a PR with a failing check reads as R0 shows it', () => {
  assert.equal(formatReviewSummary({ ...base, pr, running: false }, t), 'PR #1471 · 3 个文件 +42 −7 · ⚠ 1 项检查失败')
})

test('running with no PR reads 运行中 and no PR number (R6)', () => {
  assert.equal(formatReviewSummary({ ...base, pr: null, running: true }, t), '3 个文件 +42 −7 · 运行中')
})

test('passing checks add nothing; running stands in for unsettled checks', () => {
  assert.deepEqual(reviewSummaryParts({ ...base, checks: { failed: 0, passed: 5, pending: 0 }, pr, running: false }).map(part => part.kind), ['pr', 'files'])
  assert.deepEqual(reviewSummaryParts({ ...base, pr, running: true }).map(part => part.kind), ['pr', 'files', 'running'])
})

test('partial review data shows only observed counts and never invents checks', () => {
  const summary = { pr, files: 3, additions: null, deletions: null, checks: null, running: false }
  assert.deepEqual(reviewSummaryParts(summary), [{ kind: 'pr', number: 1471 }, { kind: 'fileCount', count: 3 }])
  assert.deepEqual(reviewSummaryParts({ ...summary, files: null }), [{ kind: 'pr', number: 1471 }])
})
