'use client'

/**
 * The 收件箱 page (the rail's 建议). The open-source UI draws the suggestion
 * feed; a UI layer may draw its own from the same data (docs/ui-overlay.md).
 */
import { SuggestionFeed } from '@/components/suggestions/suggestion-feed'
import type { InboxPageProps } from './inbox-contract'

export function InboxPage({ onOpenIssue, onConnect, onSent }: InboxPageProps) {
  return <SuggestionFeed onOpenIssue={onOpenIssue} onConnect={onConnect} onSent={onSent} />
}
