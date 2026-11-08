'use client'

// The default review-summary slot (docs/ui-overlay.md): none. The open-source build has no review page, so a
// coding task shows no summary line and reads nothing; a layer with the review page draws the line here.
import type { ReviewSummaryLineProps } from './review-summary-contract'

/** Optional export: true when the layer has the review page, which turns on ⌘⇧B and ⌘K 「审阅 #N」. */
export const REVIEW_ENABLED = false

export function ReviewSummaryLine(_props: ReviewSummaryLineProps): null {
  return null
}
