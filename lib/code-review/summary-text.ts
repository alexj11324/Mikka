// The one summary line a coding task shows wherever it appears (R0, R0b, R6), as pure parts, so the default slot,
// the hosted layer and tests read the same words: 「PR #1471 · 3 个文件 +42 −7 · ⚠ 1 项检查失败」, or while the
// agent runs with no PR 「3 个文件 +42 −7 · 运行中」. The words are messages under `CodeReview.summary`.
import type { ReviewSummary } from './contract'

export type ReviewSummaryPart =
  | { kind: 'pr'; number: number }
  | { kind: 'files'; count: number; additions: number; deletions: number }
  | { kind: 'failed'; count: number }
  | { kind: 'running' }

/** The line's parts in order. While the agent runs, its checks are not settled, so 运行中 stands in their place. */
export function reviewSummaryParts(summary: Pick<ReviewSummary, 'pr' | 'files' | 'additions' | 'deletions' | 'checks' | 'running'>): ReviewSummaryPart[] {
  const parts: ReviewSummaryPart[] = []
  if (summary.pr) parts.push({ kind: 'pr', number: summary.pr.number })
  parts.push({ kind: 'files', count: summary.files, additions: summary.additions, deletions: summary.deletions })
  if (summary.running) parts.push({ kind: 'running' })
  else if (summary.checks.failed > 0) parts.push({ kind: 'failed', count: summary.checks.failed })
  return parts
}

/** A translator scoped to `CodeReview.summary` (next-intl's `useTranslations('CodeReview.summary')` fits). */
export type ReviewSummaryTranslate = (key: ReviewSummaryPart['kind'], values?: Record<string, number>) => string

export const REVIEW_SUMMARY_SEPARATOR = ' · '

export function formatReviewSummary(summary: Parameters<typeof reviewSummaryParts>[0], t: ReviewSummaryTranslate) {
  return reviewSummaryParts(summary).map(part => {
    const { kind, ...values } = part
    return t(kind, values)
  }).join(REVIEW_SUMMARY_SEPARATOR)
}
