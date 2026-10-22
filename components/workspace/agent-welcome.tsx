'use client'

import { useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { agentStarters } from './agent-starters'
import type { AgentChatSession } from './agent-chat'

export function AgentWelcome({ composer, sessions, onSelect, onSuggestion }: {
  composer: ReactNode
  sessions: AgentChatSession[]
  onSelect: (id: string) => void
  onSuggestion: (prompt: string) => void
}) {
  const [showSuggestions, setShowSuggestions] = useState(true)

  return <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-8">
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center py-12">
      <div className="flex flex-col gap-5">
        {composer}
        {showSuggestions && <section aria-label="推荐建议" className="flex flex-col gap-3">
          <div className="flex items-center justify-between pl-2">
            <h2 className="text-sm text-muted-foreground">试试从这些事情开始</h2>
            <Button variant="ghost" size="icon-sm" aria-label="隐藏推荐建议" onClick={() => setShowSuggestions(false)}><X aria-hidden="true" data-icon="inline-start" /></Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {agentStarters.slice(0, 3).map(starter => <Button key={starter.title} variant="outline" className="h-auto min-h-32 flex-col items-start justify-between gap-7 whitespace-normal p-4 text-left" onClick={() => onSuggestion(starter.prompt)}>
              <starter.icon aria-hidden="true" data-icon="inline-start" />
              <span className="flex flex-col gap-1"><span>{starter.title}</span><span className="text-sm font-normal text-muted-foreground">{starter.description}</span></span>
            </Button>)}
          </div>
        </section>}
        {sessions.length > 0 && <section aria-label="最近对话" className="flex flex-col gap-1">
          {sessions.slice(0, 5).map(session => <Button key={session.id} variant="ghost" className="w-full justify-between gap-4" onClick={() => onSelect(session.id)}>
            <span className="truncate">{session.title}</span>
            <time className="shrink-0 text-xs text-muted-foreground" dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</time>
          </Button>)}
        </section>}
      </div>
    </div>
  </div>
}
