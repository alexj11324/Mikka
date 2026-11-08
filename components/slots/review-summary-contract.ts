// What the review-summary slot receives (docs/ui-overlay.md): a coding task's one summary line and 「审阅」
// (decision 2026-11-08, R0, R0b, R6). Data comes from useReviewSummary (hooks/code-review/use-review-summary.ts);
// the words from formatReviewSummary (lib/code-review/summary-text.ts).

export type ReviewSummaryPlacement =
  /** Under a task's card in the chat (R0). */
  | 'card'
  /** A row in the window bar's 等待你 list (R0). */
  | 'waiting'
  /** The first row under the task panel's title, the whole line a button (R0b). */
  | 'panel'

export type ReviewSummaryLineProps = {
  taskId: string
  placement: ReviewSummaryPlacement
  /** Opens the task's review page (openReview in hooks/code-review/use-review-page.ts). */
  onOpenReview: (taskId: string) => void
}
