'use client'

import { useState, type ReactNode } from 'react'
import { FileText, LoaderCircle, MessageSquarePlus, PanelLeft, Search } from 'lucide-react'
import { ChatApp, ChatAppFooter, ChatAppHeader } from '@/components/agents/chat-app'
import { AISidebar } from '@/components/agents/ai-sidebar'
import { AnimatedSidebar, AnimatedSidebarContent, AnimatedSidebarGroup, AnimatedSidebarGroupContent, AnimatedSidebarGroupLabel, AnimatedSidebarInset, AnimatedSidebarMenu, AnimatedSidebarMenuButton, AnimatedSidebarMenuItem, AnimatedSidebarRail, AnimatedSidebarTrigger, useAnimatedSidebar } from '@/components/motion/animated-sidebar'
import { Input } from '@/components/motion/input'
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
  return <section aria-label="Agent 对话工作区" className="orvilo-agent h-[calc(100svh-4rem)] min-h-0 w-full p-2 sm:p-4">
    <ChatApp sidebarWidth="17rem" className="h-full">
      <AgentChatSidebar sessions={sessions} sessionId={sessionId} onSelect={onSelect} onReset={onReset} />
      <AnimatedSidebarInset className="min-h-0 bg-background">
        <ChatAppHeader>
          <div className="flex min-w-0 items-center gap-2.5">
            <AnimatedSidebarTrigger aria-label="切换对话侧栏" className="text-muted-foreground hover:bg-muted hover:text-foreground"><PanelLeft className="size-4" /></AnimatedSidebarTrigger>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-medium">{turns.at(-1)?.question || '新任务'}</h1>
              <p className="truncate text-xs text-muted-foreground">Agent 工作区 · DS 4.1 Flash</p>
            </div>
          </div>
          {streaming && <span role="status" className="shrink-0 text-xs text-muted-foreground">正在回复</span>}
        </ChatAppHeader>
        <AgentConversation turns={turns} streaming={streaming} />
        <ChatAppFooter>
          <div className="mx-auto max-w-3xl">{composer}</div>
        </ChatAppFooter>
      </AnimatedSidebarInset>
    </ChatApp>
  </section>
}

function AgentChatSidebar({ sessions, sessionId, onSelect, onReset }: AgentChatNavigation) {
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const { isMobile, setOpenMobile } = useAnimatedSidebar()
  const items = sessions.filter(session => !searching || session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .map(session => ({ id: session.id, label: session.title, kind: 'file' as const }))

  function navigate(id: string) {
    onSelect(id)
    if (isMobile) setOpenMobile(false)
  }

  return <AnimatedSidebar ariaLabel="对话导航" collapsible="offcanvas" className="min-h-0" panelClassName="h-full bg-background">
    <AnimatedSidebarContent className="gap-4 overflow-hidden px-2 py-4">
      <AnimatedSidebarGroup className="shrink-0 px-1 py-0">
        <AnimatedSidebarGroupContent>
          <AnimatedSidebarMenu className="gap-1">
            <AnimatedSidebarMenuItem><AnimatedSidebarMenuButton icon={<MessageSquarePlus className="size-4" />} onSelect={onReset} className="font-normal">新任务</AnimatedSidebarMenuButton></AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuItem><AnimatedSidebarMenuButton icon={<Search className="size-4" />} onSelect={() => setSearching(value => !value)} isActive={searching} closeOnSelect={false} className="font-normal">搜索</AnimatedSidebarMenuButton></AnimatedSidebarMenuItem>
          </AnimatedSidebarMenu>
        </AnimatedSidebarGroupContent>
      </AnimatedSidebarGroup>
      <AnimatedSidebarGroup className="min-h-0 flex-1 px-1 py-0">
        <AnimatedSidebarGroupLabel className="mb-1 h-8 px-2 text-xs font-medium normal-case tracking-normal">历史会话</AnimatedSidebarGroupLabel>
        <AnimatedSidebarGroupContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {searching && <Input label="搜索历史会话" type="search" value={query} onChange={setQuery} placeholder="输入关键词…" />}
          {items.length ? <AISidebar items={items} activeId={sessionId} onActiveChange={navigate} ariaLabel="历史会话" renderIcon={item => sessions.find(session => session.id === item.id)?.running
            ? <LoaderCircle aria-label="正在回复" className="size-4 animate-spin" /> : <FileText aria-hidden="true" className="size-4" />} renderMenu={() => null} /> : <p className="px-2 text-xs text-muted-foreground">{query && searching ? '未找到相关会话' : '暂无历史会话'}</p>}
        </AnimatedSidebarGroupContent>
      </AnimatedSidebarGroup>
    </AnimatedSidebarContent>
    <AnimatedSidebarRail />
  </AnimatedSidebar>
}
