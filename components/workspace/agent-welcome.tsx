'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { AgentChatSession } from './agent-chat'

export function AgentWelcome({ composer, sessions, onSelect }: {
  composer: ReactNode
  sessions: AgentChatSession[]
  onSelect: (id: string) => void
}) {
  const agentCopy = useAgentCopy()

  return <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-8">
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center py-12">
      <div className="flex flex-col gap-5">
        {composer}
        {sessions.length > 0 && <section aria-label={agentCopy.recentConversations} className="flex flex-col gap-1">
          {sessions.slice(0, 5).map(session => <Button key={session.id} variant="ghost" className="w-full justify-between gap-4" onClick={() => onSelect(session.id)}>
            <span className="truncate">{session.title}</span>
            <time className="shrink-0 text-xs text-muted-foreground" dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</time>
          </Button>)}
        </section>}
      </div>
    </div>
  </div>
}
