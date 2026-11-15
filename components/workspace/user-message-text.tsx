'use client'

import { LinkCitation, useLinkPreviews } from '@/components/workspace/agent-citations'
import { userMessageParts } from '@/lib/user-message-links'
import { splitChatFiles } from '@mikka/protocol/chat-attachments'
import type { ReactNode } from 'react'
import { ChatFileCards } from '@/components/chat/chat-file-cards'

/** A sent message's text with each web link shown as a source chip. */
export function UserMessageText({ text, renderText }: { text: string; renderText?: (value: string, index: number) => ReactNode }) {
  const parsed = splitChatFiles(text)
  const previews = useLinkPreviews([parsed.text])
  return <span data-slot="user-message-text"><ChatFileCards files={parsed.files} sent />{userMessageParts(parsed.text).map((part, index) => part.type === 'link'
    ? <LinkCitation key={index} url={part.url} label={part.label} preview={previews[part.url]} />
    : renderText ? renderText(part.text, index) : part.text)}</span>
}
