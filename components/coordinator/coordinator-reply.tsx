'use client'

import { memo } from 'react'
import { AgentCitationsContext, CitationSources, type AgentCitations } from '@/components/workspace/agent-citations'
import { AgentGenerativeUI } from '@/components/workspace/agent-generative-ui'
import { ReplyBubbles } from '@/components/workspace/agent-text-bubble'
import { withoutPartialCitation } from '@/lib/coordinator/citations'

const ignoreAction = () => {}

/**
 * A Coordinator reply, drawn by the same OpenUI renderer as the Agent page:
 * its text in grey bubbles, cards and charts on their own, no byline (the
 * title pill already says who this is).
 * Cited issues, runs and web pages show as source chips in the text, then an
 * "N sources" toggle lists them all. A citation it cannot show stays as written.
 * While it streams, a citation still arriving is left out until its chip can show.
 * Memoised: a token for the reply that is streaming does not redraw the replies already finished.
 */
export const CoordinatorReply = memo(function CoordinatorReply({ text, citations, isStreaming = false }: { text: string; citations: AgentCitations; isStreaming?: boolean }) {
  const shown = isStreaming ? withoutPartialCitation(text) : text
  return <AgentCitationsContext value={citations}>
    <div data-quote-source="" className="flex w-full min-w-0 flex-col gap-2 break-words">
      <ReplyBubbles value><AgentGenerativeUI response={shown} isStreaming={isStreaming} onAction={ignoreAction} showErrors={false} /></ReplyBubbles>
      {/* A choice card already shows its task chip; no "N sources" footnote under it. */}
      {!/\bBeQuestions\(/.test(shown) && <CitationSources text={shown} />}
    </div>
  </AgentCitationsContext>
})
