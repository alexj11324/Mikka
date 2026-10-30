'use client'

import { AgentCitationsContext, CitationSources, type AgentCitations } from '@/components/workspace/agent-citations'
import { AgentGenerativeUI } from '@/components/workspace/agent-generative-ui'
import { ReplyBubbles } from '@/components/workspace/agent-text-bubble'

/**
 * A Coordinator reply, drawn by the same OpenUI renderer as the Agent page:
 * its text in grey bubbles, cards and charts on their own, no byline (the
 * title pill already says who this is).
 * Cited issues, runs and web pages show as source chips in the text, then an
 * "N sources" toggle lists them all. A citation it cannot show stays as written.
 */
export function CoordinatorReply({ text, citations }: { text: string; citations: AgentCitations }) {
  return <AgentCitationsContext value={citations}>
    <div className="flex w-full min-w-0 flex-col gap-2 break-words">
      <ReplyBubbles value><AgentGenerativeUI response={text} isStreaming={false} onAction={() => {}} showErrors={false} /></ReplyBubbles>
      {/* A choice card already shows its task chip; no "N sources" footnote under it. */}
      {!/\bBeQuestions\(/.test(text) && <CitationSources text={text} />}
    </div>
  </AgentCitationsContext>
}
