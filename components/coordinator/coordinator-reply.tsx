'use client'

import { memo, use, useMemo } from 'react'
import { AgentCitationsContext, coveredIssues, type AgentCitations } from '@/components/workspace/agent-citations'
import { AgentGenerativeUI } from '@/components/workspace/agent-generative-ui'
import { ReplyBubbles } from '@/components/workspace/agent-text-bubble'
import { withoutPartialCitation } from '@/lib/coordinator/citations'

const ignoreAction = () => {}

/**
 * A Coordinator reply, drawn by the same OpenUI renderer as the Agent page:
 * its text in grey bubbles, cards and charts on their own, no byline (the
 * title pill already says who this is). A message frame that draws reply text
 * plain (the hosted thread) sets ReplyBubbles off around it, and that wins:
 * otherwise Markdown and OpenUI text in one reply would disagree.
 * Cited issues, runs and web pages show as source chips in the text; a task whose thread it also cites is its title.
 * Web pages it cites are listed under it on hover (R-15). A citation it cannot show stays as written.
 * While it streams, a citation still arriving is left out until its chip can show.
 * Memoised: a token for the reply that is streaming does not redraw the replies already finished.
 */
export const CoordinatorReply = memo(function CoordinatorReply({ text, citations, isStreaming = false, carded = '' }: { text: string; citations: AgentCitations; isStreaming?: boolean
  /** Comma-joined ids of the threads whose card sits under this reply; a string, so the memo keeps holding. */
  carded?: string }) {
  const bubbles = use(ReplyBubbles) ?? true
  const shown = isStreaming ? withoutPartialCitation(text) : text
  // A task whose thread this reply also cites is its title, not a second chip (R-15).
  const value = useMemo(() => ({ ...citations, covered: coveredIssues(shown, citations.sources), carded: new Set(carded ? carded.split(',') : []) }), [citations, shown, carded])
  return <AgentCitationsContext value={value}>
    <div data-quote-source="" className="flex w-full min-w-0 flex-col gap-2 break-words">
      <ReplyBubbles value={bubbles}><AgentGenerativeUI response={shown} isStreaming={isStreaming} onAction={ignoreAction} showErrors={false} /></ReplyBubbles>
    </div>
  </AgentCitationsContext>
})
