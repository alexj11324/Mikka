'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import type { ReactNode } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { AgentWelcome } from './agent-welcome'
import { Button } from '@/components/ui/button'
import { ConversationPill } from '@/components/nav/conversation-pill'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { AgentConversation, type AgentTurn } from './agent-conversation'
import type { SavedAgentSession } from '@/lib/agent-history'

export type AgentChatSession = SavedAgentSession & { running?: boolean }

type AgentChatNavigation = {
  sessions: AgentChatSession[]
  sessionId: string | null
  onSelect: (id: string) => void
  onReset: () => void
  onDemo?: () => void
}

/** `bot` is who the chat is with; its header is the bot's name, not the chat's first question. */
export function AgentChat({ turns, composer, streaming, sessions, sessionId, onSelect, onReset, onDemo, onSuggestion, bot }: AgentChatNavigation & {
  bot?: { id: string; name: string; color: string; shape: string }
  turns: AgentTurn[]
  composer: ReactNode
  streaming: boolean
  onSuggestion: (prompt: string) => void
}) {
  const agentCopy = useAgentCopy()

  const title = bot?.name || sessions.find(session => session.id === sessionId)?.title || turns[0]?.question || agentCopy.newConversation

  return <section aria-label={agentCopy.agentConversationWorkspace} className="orvilo-agent relative flex size-full min-h-0 flex-col">
    <AgentChatHeader title={title} bot={bot} streaming={streaming} sessions={sessions} sessionId={sessionId} onSelect={onSelect} onReset={onReset} onDemo={onDemo} />
    <div aria-hidden="true" className="hidden h-14 shrink-0 md:block" />
    {turns.length === 0 ? <AgentWelcome composer={composer} sessions={bot ? [] : sessions} onSelect={onSelect} onSuggestion={onSuggestion} /> : <>
      <AgentConversation turns={turns} streaming={streaming} />
      <footer className="shrink-0 px-4 pb-4 pt-2 sm:px-8 sm:pb-6">
        <div className="mx-auto w-full max-w-3xl">{composer}</div>
      </footer>
    </>}
  </section>
}

function AgentChatHeader({ title, bot, streaming, onReset, onDemo }: AgentChatNavigation & { title: string; bot?: { id: string; name: string; color: string; shape: string }; streaming: boolean }) {
  const agentCopy = useAgentCopy()

  // Desktop shows the conversation as the centered pill (MIK-40) and switches conversations in the left list or ⌘K.
  return <>
    <ConversationPill name={title} avatar={bot ? <BotAvatar color={bot.color} shape={bot.shape} size="pill" /> : undefined} />
    {streaming && <span role="status" className="sr-only">{agentCopy.responding}</span>}
    <header className="flex h-12 shrink-0 items-center gap-2 px-4 md:hidden">
      <SidebarTrigger aria-label={agentCopy.toggleSidebar} />
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
      {onDemo && <Button variant="ghost" size="sm" onClick={onDemo}>{agentCopy.componentDemo}</Button>}
      <Button variant="ghost" size="icon" aria-label={agentCopy.newTask} title={agentCopy.newTask} onClick={onReset}><MessageSquarePlus aria-hidden="true" data-icon="inline-start" /></Button>
    </header>
  </>
}
