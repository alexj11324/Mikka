// What the review-page slot receives (docs/ui-overlay.md): a coding task's one review page (decision 2026-11-08,
// R1–R12). The app shell mounts it while useReviewPage (hooks/code-review/use-review-page.ts) has a task open.
// Its reads and actions are the hooks in hooks/code-review/; Esc (outside a text field) and ✕ call onClose.

export type ReviewPageProps = {
  taskId: string
  onClose: () => void
}
