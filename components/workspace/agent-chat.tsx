'use client'

import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, FileText, LoaderCircle, MessageSquarePlus, Search } from 'lucide-react'
import { ChatApp, ChatAppFooter, ChatAppHeader } from '@/components/agents/chat-app'
import { AnimatedSidebarInset } from '@/components/motion/animated-sidebar'
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
}

export function AgentChat({ turns, composer, streaming, sessions, sessionId, onSelect, onReset }: AgentChatNavigation & {
  turns: AgentTurn[]
  composer: ReactNode
  streaming: boolean
}) {
  const title = sessions.find(session => session.id === sessionId)?.title || turns[0]?.question || '新任务'

  return <section aria-label="Agent 对话工作区" className="orvilo-agent h-[calc(100svh-4rem)] min-h-0 w-full p-2 sm:p-4">
    <ChatApp open={false} className="h-full">
      <AnimatedSidebarInset className="min-h-0 bg-background">
        <AgentChatHeader title={title} streaming={streaming} sessions={sessions} sessionId={sessionId} onSelect={onSelect} onReset={onReset} />
        <AgentConversation turns={turns} streaming={streaming} />
        <ChatAppFooter>
          <div className="mx-auto max-w-3xl">{composer}</div>
        </ChatAppFooter>
      </AnimatedSidebarInset>
    </ChatApp>
  </section>
}

function AgentChatHeader({ title, streaming, sessions, sessionId, onSelect, onReset }: AgentChatNavigation & { title: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const today = new Date().setHours(0, 0, 0, 0)
  const groups = [
    { label: '今天', sessions: sessions.filter(session => Date.parse(session.updatedAt) >= today) },
    { label: '最近 7 天', sessions: sessions.filter(session => Date.parse(session.updatedAt) < today && Date.parse(session.updatedAt) >= today - 6 * 86400000) },
    { label: '更早', sessions: sessions.filter(session => Date.parse(session.updatedAt) < today - 6 * 86400000) },
  ]

  function navigate(id: string) {
    setOpen(false)
    setSearching(false)
    onSelect(id)
  }

  return <ChatAppHeader className="gap-2 px-3">
    <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setSearching(false) }}>
      <h1 className="min-w-0">
        <PopoverTrigger render={<Button variant="ghost" className="max-w-full justify-start" aria-label={`切换会话：${title}`} />}>
          <span className="truncate">{title}</span>
          <ChevronDown aria-hidden="true" data-icon="inline-end" />
        </PopoverTrigger>
      </h1>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0" aria-label={searching ? '搜索历史会话' : '切换历史会话'} initialFocus={searching ? searchRef : undefined}>
        <Command label={searching ? '搜索历史会话' : '历史会话'} shouldFilter={searching} tabIndex={0}>
          {searching && <CommandInput ref={searchRef} aria-label="搜索历史会话" placeholder="搜索历史会话…" />}
          <CommandList label="历史会话" className="max-h-80">
            <CommandEmpty>{sessions.length ? '未找到相关会话' : '暂无历史会话'}</CommandEmpty>
            {groups.filter(group => group.sessions.length > 0).map(group => <CommandGroup key={group.label} heading={group.label}>
              {group.sessions.map(session => <CommandItem key={session.id} value={session.id} keywords={[session.title]} data-checked={session.id === sessionId} onSelect={() => navigate(session.id)} className="gap-2 py-2">
                {session.running ? <LoaderCircle aria-label="正在回复" className="animate-spin" /> : <FileText aria-hidden="true" />}
                <span className="min-w-0 flex-1 truncate">{session.title}</span>
                <time dateTime={session.updatedAt} title={new Date(session.updatedAt).toLocaleString('zh-CN')} className="shrink-0 text-xs text-muted-foreground">{relativeDate(session.updatedAt)}</time>
              </CommandItem>)}
            </CommandGroup>)}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {streaming && <span role="status" className="sr-only">正在回复</span>}
      <Button variant="ghost" size="icon" aria-label="新任务" title="新任务" onClick={onReset}><MessageSquarePlus aria-hidden="true" data-icon="inline-start" /></Button>
      <Button variant="ghost" size="icon" aria-label="搜索" title="搜索历史会话" onClick={() => { setSearching(true); setOpen(true) }}><Search aria-hidden="true" data-icon="inline-start" /></Button>
    </div>
  </ChatAppHeader>
}

function relativeDate(date: string) {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 86400000))
  if (days === 0) return '今天'
  if (days < 7) return `${days}天前`
  if (days < 30) return `${Math.floor(days / 7)}周前`
  return new Date(date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
