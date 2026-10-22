'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import type { AgentCopy } from '@/lib/agent-copy'
import { useLocale } from 'next-intl'
import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, FileText, LoaderCircle, MessageSquarePlus, Search } from 'lucide-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { AgentWelcome } from './agent-welcome'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
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

export function AgentChat({ turns, composer, streaming, sessions, sessionId, onSelect, onReset, onDemo, onSuggestion }: AgentChatNavigation & {
  turns: AgentTurn[]
  composer: ReactNode
  streaming: boolean
  onSuggestion: (prompt: string) => void
}) {
  const agentCopy = useAgentCopy()

  const title = sessions.find(session => session.id === sessionId)?.title || turns[0]?.question || agentCopy.newConversation

  return <section aria-label={agentCopy.agentConversationWorkspace} className="orvilo-agent flex size-full min-h-0 flex-col">
    <AgentChatHeader title={title} streaming={streaming} sessions={sessions} sessionId={sessionId} onSelect={onSelect} onReset={onReset} onDemo={onDemo} />
    {turns.length === 0 ? <AgentWelcome composer={composer} sessions={sessions} onSelect={onSelect} onSuggestion={onSuggestion} /> : <>
      <AgentConversation turns={turns} streaming={streaming} />
      <footer className="shrink-0 px-4 pb-4 pt-2 sm:px-8 sm:pb-6">
        <div className="mx-auto w-full max-w-3xl">{composer}</div>
      </footer>
    </>}
  </section>
}

function AgentChatHeader({ title, streaming, sessions, sessionId, onSelect, onReset, onDemo }: AgentChatNavigation & { title: string; streaming: boolean }) {
  const agentCopy = useAgentCopy()

  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const today = new Date().setHours(0, 0, 0, 0)
  const groups = [
    { label: agentCopy.today, sessions: sessions.filter(session => Date.parse(session.updatedAt) >= today) },
    { label: agentCopy.last7Days, sessions: sessions.filter(session => Date.parse(session.updatedAt) < today && Date.parse(session.updatedAt) >= today - 6 * 86400000) },
    { label: agentCopy.earlier, sessions: sessions.filter(session => Date.parse(session.updatedAt) < today - 6 * 86400000) },
  ]

  function navigate(id: string) {
    setOpen(false)
    setSearching(false)
    onSelect(id)
  }

  return <header className="flex h-12 shrink-0 items-center gap-2 px-4">
    <SidebarTrigger aria-label={agentCopy.toggleSidebar} />
    <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setSearching(false) }}>
      <h1 className="min-w-0">
        <PopoverTrigger render={<Button variant="ghost" className="max-w-full justify-start" aria-label={(agentCopy.switchConversation + (title))} />}>
          <span className="truncate">{title}</span>
          <ChevronDown aria-hidden="true" data-icon="inline-end" />
        </PopoverTrigger>
      </h1>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0" aria-label={searching ? agentCopy.searchConversations : agentCopy.switchConversation2} initialFocus={searching ? searchRef : undefined}>
        <Command label={searching ? agentCopy.searchConversations : agentCopy.conversationHistory} shouldFilter={searching} tabIndex={0}>
          {searching && <CommandInput ref={searchRef} aria-label={agentCopy.searchConversations} placeholder={agentCopy.searchConversations2} />}
          <CommandList label={agentCopy.conversationHistory} className="max-h-80">
            <CommandEmpty>{sessions.length ? agentCopy.noMatchingConversations : agentCopy.noConversationsYet}</CommandEmpty>
            {groups.filter(group => group.sessions.length > 0).map(group => <CommandGroup key={group.label} heading={group.label}>
              {group.sessions.map(session => <CommandItem key={session.id} value={session.id} keywords={[session.title]} data-checked={session.id === sessionId} onSelect={() => navigate(session.id)} className="gap-2 py-2">
                {session.running ? <LoaderCircle aria-label={agentCopy.responding} className="animate-spin" /> : <FileText aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <time dateTime={session.updatedAt} title={new Date(session.updatedAt).toLocaleString(locale)} className="shrink-0 text-xs text-muted-foreground">{relativeDate(session.updatedAt, locale, agentCopy)}</time>
              </CommandItem>)}
            </CommandGroup>)}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {streaming && <span role="status" className="sr-only">{agentCopy.responding}</span>}
      {onDemo && <Button variant="ghost" size="sm" onClick={onDemo}>{agentCopy.componentDemo}</Button>}
      <Button variant="ghost" size="icon" aria-label={agentCopy.newTask} title={agentCopy.newTask} onClick={onReset}><MessageSquarePlus aria-hidden="true" data-icon="inline-start" /></Button>
      <Button variant="ghost" size="icon" aria-label={agentCopy.search} title={agentCopy.searchConversations} onClick={() => { setSearching(true); setOpen(true) }}><Search aria-hidden="true" data-icon="inline-start" /></Button>
    </div>
  </header>
}

function relativeDate(date: string, locale: string, agentCopy: AgentCopy) {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 86400000))
  if (days === 0) return agentCopy.today
  if (days < 7) return ((days) + agentCopy.daysAgo)
  if (days < 30) return ((Math.floor(days / 7)) + agentCopy.weeksAgo)
  return new Date(date).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })
}
