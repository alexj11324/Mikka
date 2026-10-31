'use client'

import { LinkCitation, useLinkPreviews } from '@/components/workspace/agent-citations'
import { userMessageParts } from '@/lib/user-message-links'

/** A sent message's text with each web link shown as a source chip. */
export function UserMessageText({ text }: { text: string }) {
  const previews = useLinkPreviews([text])
  return <span data-slot="user-message-text">{userMessageParts(text).map((part, index) => part.type === 'link'
    ? <LinkCitation key={index} url={part.url} label={part.label} preview={previews[part.url]} />
    : part.text)}</span>
}
