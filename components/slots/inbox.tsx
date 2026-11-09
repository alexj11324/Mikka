'use client'

/**
 * The 收件箱 page (the rail's 建议). The open-source UI draws the suggestion
 * feed; a UI layer may draw its own from the same data (docs/ui-overlay.md).
 */
import { SuggestionFeed } from '@/components/suggestions/suggestion-feed'
import type { InboxPageProps } from './inbox-contract'

/** The page's title, e.g. in the phone header (inbox-contract.ts): the open-source page is 建议. */
export const INBOX_TITLE = 'Nav.suggestions'
/** Whether the page keeps the phone header (title, refresh, search) above its body: the open-source feed does. */
export const INBOX_PHONE_HEADER = true

export function InboxPage({ onOpenIssue, onConnect, onSent }: InboxPageProps) {
  return <SuggestionFeed onOpenIssue={onOpenIssue} onConnect={onConnect} onSent={onSent} />
}
