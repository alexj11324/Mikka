"use client"

import { ArrowUpRight, Check, ChevronDown, ChevronsUpDown, CircleHelp, Command, Cpu, ExternalLink, PanelLeftClose, Plus, Search, Settings2, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { views, type ModalKind, type ViewId } from "@/lib/workspace"
import { Button } from "@/components/ui/button"

export function WorkspaceSidebar({ view, navigate, open, onClose }: { view: ViewId; navigate: (view: ViewId) => void; open: (kind: ModalKind) => void; onClose?: () => void }) {
  return <aside className="workspace-sidebar flex h-full w-[224px] shrink-0 flex-col bg-sidebar px-3 pb-3 pt-5 text-[13px]">
    <div className="mb-5 flex items-center gap-2 px-2">
      <button onClick={() => open("workspace")} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="工作空间设置">
        <span className="brand-mark flex size-7 shrink-0 items-center justify-center rounded-lg"><Command className="size-4" strokeWidth={2.5} /></span>
        <span className="font-semibold tracking-tight">Orbit<span className="ml-1 font-normal text-muted-foreground">工作空间</span></span><ChevronsUpDown className="ml-auto size-3 text-muted-foreground" />
      </button>
      {onClose && <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="关闭导航"><PanelLeftClose /></Button>}
    </div>
    <button onClick={() => open("search")} className="mx-1 mb-5 flex h-8 items-center gap-2 rounded-md border bg-background/60 px-2.5 text-muted-foreground transition-colors hover:border-ring"><Search className="size-3.5" /><span>搜索工作空间</span><kbd className="ml-auto rounded border px-1 text-[10px]">⌘ K</kbd></button>
    <nav aria-label="主要导航" className="flex flex-col gap-0.5">
      {views.filter(item => item.group === "personal").map(item => <NavItem key={item.id} item={item} active={view === item.id} onClick={() => navigate(item.id)} />)}
      <div className="mb-1 mt-6 flex items-center justify-between px-2.5 text-[11px] font-medium text-muted-foreground"><span>工作空间</span><Button variant="ghost" size="icon-xs" aria-label="工作空间选项" onClick={() => open("workspace")}><ChevronDown /></Button></div>
      {views.filter(item => item.group === "workspace").map(item => <NavItem key={item.id} item={item} active={view === item.id} onClick={() => navigate(item.id)} />)}
    </nav>
    <div className="mb-2 mt-7 flex items-center justify-between px-2.5 text-[11px] font-medium text-muted-foreground"><span>你的团队</span><Button variant="ghost" size="icon-xs" aria-label="创建团队" onClick={() => open("workspace")}><Plus /></Button></div>
    <button onClick={() => open("workspace")} className="flex items-center gap-2 rounded-md px-2.5 py-2 text-muted-foreground hover:bg-sidebar-accent"><span className="flex size-5 items-center justify-center rounded border border-dashed"><Plus className="size-3" /></span>创建第一个团队</button>
    <div className="mt-auto flex flex-col gap-3 pt-10">
      <div className="rounded-lg border bg-background/55 p-3">
        <div className="mb-2 flex items-center gap-2 font-medium"><span className="flex size-5 items-center justify-center rounded bg-primary/10 text-primary"><Sparkles className="size-3" /></span>准备你的工作空间<span className="ml-auto text-[10px] text-muted-foreground">1/4</span></div>
        <div className="mb-2.5 flex gap-1" aria-label="设置进度：四分之一">{[0, 1, 2, 3].map(n => <span key={n} className={cn("h-1 flex-1 rounded-full", n === 0 ? "bg-primary" : "bg-border")} />)}</div>
        <button className="flex w-full items-center justify-between text-[11px] text-muted-foreground hover:text-foreground" onClick={() => open("setup")}>继续设置<ArrowUpRight className="size-3" /></button>
      </div>
      <button onClick={() => open("connection")} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent"><Cpu className="size-3.5" /><span>本机 daemon</span><span className="ml-auto flex items-center gap-1 text-[10px]"><span className="size-1.5 rounded-full bg-muted-foreground/45" />未连接</span></button>
      <div className="flex items-center gap-1 border-t pt-3">
        <button onClick={() => open("setup")} className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-sidebar-accent"><span className="flex size-6 items-center justify-center rounded-full border bg-background text-[10px] text-muted-foreground">访</span><span>访客模式</span></button>
        <Button variant="ghost" size="icon-sm" onClick={() => open("help")} aria-label="使用帮助"><CircleHelp /></Button><Button variant="ghost" size="icon-sm" onClick={() => open("setup")} aria-label="设置"><Settings2 /></Button>
      </div>
    </div>
  </aside>
}

function NavItem({ item, active, onClick }: { item: typeof views[number]; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} aria-current={active ? "page" : undefined} className={cn("flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left transition-colors", active ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground")}><item.icon className={cn("size-4", active && "text-primary")} strokeWidth={1.7} /><span>{item.label}</span>{item.id === "agents" && <span className="ml-auto rounded border border-primary/20 px-1 text-[9px] leading-4 text-primary">AI</span>}</button>
}
