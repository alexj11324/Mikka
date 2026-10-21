'use client'

import { useState, type ReactNode } from 'react'
import { Clock3, MessageSquarePlus, PanelLeft, Search } from 'lucide-react'
import { ChatApp, ChatAppFooter, ChatAppHeader } from '@/components/agents/chat-app'
import { AISidebar } from '@/components/agents/ai-sidebar'
import { AnimatedSidebar, AnimatedSidebarContent, AnimatedSidebarGroup, AnimatedSidebarGroupContent, AnimatedSidebarGroupLabel, AnimatedSidebarInset, AnimatedSidebarMenu, AnimatedSidebarMenuButton, AnimatedSidebarMenuItem, AnimatedSidebarRail, AnimatedSidebarTrigger, useAnimatedSidebar } from '@/components/motion/animated-sidebar'
import { Input } from '@/components/motion/input'
import { AgentConversation, type AgentTurn } from './agent-conversation'

export function AgentChat({ turns, composer, streaming, onReset }: {
  turns: AgentTurn[]
  composer: ReactNode
  streaming: boolean
  onReset: () => void
}) {
  return <section id="orvilo-agent" aria-label="Agent 对话工作区" className="h-[calc(100svh-4rem)] min-h-0 w-full p-2 sm:p-4">
    <ChatApp sidebarWidth="17rem" className="h-full">
      <AgentChatSidebar turns={turns} streaming={streaming} onReset={onReset} />
      <AnimatedSidebarInset className="min-h-0 bg-background">
        <ChatAppHeader>
          <div className="flex min-w-0 items-center gap-2.5">
            <AnimatedSidebarTrigger aria-label="切换对话侧栏" className="text-muted-foreground hover:bg-muted hover:text-foreground"><PanelLeft className="size-4" /></AnimatedSidebarTrigger>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-medium">{turns.at(-1)?.question || '新任务'}</h1>
              <p className="truncate text-xs text-muted-foreground">Agent 工作区 · GLM-5.3-Flash</p>
            </div>
          </div>
          <span role="status" className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{streaming ? '正在生成' : '临时会话'}</span>
        </ChatAppHeader>
        <AgentConversation turns={turns} streaming={streaming} />
        <ChatAppFooter>
          <div className="mx-auto max-w-3xl">{composer}</div>
        </ChatAppFooter>
      </AnimatedSidebarInset>
    </ChatApp>
  </section>
}

function AgentChatSidebar({ turns, streaming, onReset }: { turns: AgentTurn[]; streaming: boolean; onReset: () => void }) {
  const [view, setView] = useState<'conversation' | 'search' | 'runs'>('conversation')
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const { isMobile, setOpenMobile } = useAnimatedSidebar()
  const items = turns.filter(turn => view !== 'search' || turn.question.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(turn => ({ id: String(turn.id), label: turn.question, kind: 'file' as const }))

  function navigate(id: string) {
    setActiveId(id)
    document.getElementById(`agent-turn-${id}`)?.scrollIntoView({ block: 'start', behavior: 'instant' })
    if (isMobile) setOpenMobile(false)
  }

  return <AnimatedSidebar ariaLabel="对话导航" collapsible="offcanvas" className="min-h-0" panelClassName="h-full bg-background">
    <AnimatedSidebarContent className="gap-4 overflow-hidden px-2 py-4">
      <AnimatedSidebarGroup className="shrink-0 px-1 py-0">
        <AnimatedSidebarGroupContent>
          <AnimatedSidebarMenu className="gap-1">
            <AnimatedSidebarMenuItem><AnimatedSidebarMenuButton icon={<MessageSquarePlus className="size-4" />} onSelect={onReset} disabled={streaming} className="font-normal">新任务</AnimatedSidebarMenuButton></AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuItem><AnimatedSidebarMenuButton icon={<Search className="size-4" />} onSelect={() => setView(view === 'search' ? 'conversation' : 'search')} isActive={view === 'search'} closeOnSelect={false} className="font-normal">搜索</AnimatedSidebarMenuButton></AnimatedSidebarMenuItem>
            <AnimatedSidebarMenuItem><AnimatedSidebarMenuButton icon={<Clock3 className="size-4" />} onSelect={() => setView(view === 'runs' ? 'conversation' : 'runs')} isActive={view === 'runs'} closeOnSelect={false} className="font-normal">运行记录</AnimatedSidebarMenuButton></AnimatedSidebarMenuItem>
          </AnimatedSidebarMenu>
        </AnimatedSidebarGroupContent>
      </AnimatedSidebarGroup>
      <AnimatedSidebarGroup className="min-h-0 flex-1 px-1 py-0">
        <AnimatedSidebarGroupLabel className="mb-1 h-8 px-2 text-xs font-medium normal-case tracking-normal">{view === 'runs' ? '本轮请求' : '当前会话'}</AnimatedSidebarGroupLabel>
        <AnimatedSidebarGroupContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {view === 'search' && <Input label="搜索本轮问题" type="search" value={query} onChange={setQuery} placeholder="输入关键词…" />}
          {view === 'runs' && <p role="status" className="px-2 text-xs text-muted-foreground">{streaming ? '正在生成当前回复，可在输入栏停止。' : turns.length ? `本轮已发起 ${turns.length} 次请求。` : '尚未发起请求。'}</p>}
          {items.length ? <AISidebar items={items} activeId={activeId} onActiveChange={navigate} ariaLabel="本轮问题" renderMenu={() => null} /> : <p className="px-2 text-xs text-muted-foreground">{query && view === 'search' ? '没有匹配的问题。' : '发送消息后，在这里查看本轮问题。'}</p>}
          <p id="agent-service-note" className="px-2 text-xs leading-relaxed text-muted-foreground">OpenCode Go · 不持久保存对话，不读取或修改工作区；确认和回答直接继续，其他建议按钮仅填入提问。</p>
        </AnimatedSidebarGroupContent>
      </AnimatedSidebarGroup>
    </AnimatedSidebarContent>
    <AnimatedSidebarRail />
  </AnimatedSidebar>
}
