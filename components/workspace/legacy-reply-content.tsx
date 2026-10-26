'use client'

import { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { legacyChatContent } from '@/lib/legacy-chat-content'

/** Accessible static archive text; no live card renderer, callbacks, controls or remote images. */
export function LegacyReplyContent({ response }: { response: string }) {
  const content = useMemo(() => legacyChatContent(response), [response])
  if (content.format === 'source') return <pre className="whitespace-pre-wrap break-words">{content.text}</pre>
  return <div className="agent-markdown whitespace-pre-wrap break-words">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
      a: ({ children, href }) => <span>{children}{href ? ` (${href})` : ''}</span>,
      img: ({ alt, src }) => <span>{alt || (typeof src === 'string' ? src : '')}</span>,
    }}>{content.text}</Markdown>
  </div>
}
