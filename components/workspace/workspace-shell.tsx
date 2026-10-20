"use client"

import { useCallback, useEffect, useState } from "react"
import { ArrowUpRight, Bot, ChevronRight, CircleHelp, Command, Menu, Moon, PanelLeft, Plus, Settings2, Sun, Users } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { WorkspaceSidebar } from "@/components/workspace/workspace-sidebar"
import { Overview } from "@/components/workspace/overview"
import { WorkspaceViews } from "@/components/workspace/workspace-views"
import { WorkspaceDialogs } from "@/components/workspace/workspace-dialogs"
import { views, type ModalKind, type SetupStatus, type ViewId } from "@/lib/workspace"

export function WorkspaceShell({ setup }: { setup: SetupStatus }) {
  const [view, setView] = useState<ViewId>("overview")
  const [modal, setModal] = useState<ModalKind>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const { resolvedTheme, setTheme } = useTheme()
  const navigate = useCallback((next: ViewId) => { setView(next); setMobileNav(false); setModal(null) }, [])
  const open = useCallback((kind: ModalKind) => { setMobileNav(false); setModal(kind) }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229) return
      const target = event.target as HTMLElement
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setModal(current => current === "search" ? null : "search"); return }
      if (target.closest("input, textarea, select, [contenteditable], [role=dialog]") || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      if (event.key.toLowerCase() === "c") { event.preventDefault(); setModal("issue") }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  const current = views.find(item => item.id === view)!
  return <div className="flex h-svh min-h-0 overflow-hidden bg-sidebar text-foreground">
    <div className="hidden shrink-0 md:block"><WorkspaceSidebar view={view} navigate={navigate} open={open} /></div>
    <div className="flex min-w-0 flex-1 flex-col border-l bg-background">
      <header className="flex h-[57px] shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-7">
        <div className="flex min-w-0 items-center gap-3"><Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="打开导航" onClick={() => setMobileNav(true)}><PanelLeft /></Button><div className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex"><Command className="size-3.5" /><span>工作空间</span><ChevronRight className="size-3 opacity-50" /></div><span className="flex items-center gap-2 truncate text-xs font-medium"><current.icon className="size-3.5 text-muted-foreground" />{current.label}</span></div>
        <div className="flex shrink-0 items-center gap-1.5"><button onClick={() => open("setup")} className="mr-2 hidden items-center gap-1.5 text-[10px] text-muted-foreground lg:flex"><span className="size-1.5 rounded-full bg-success" />Neon 已连接</button><Button variant="ghost" size="icon-sm" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} aria-label="切换明暗主题"><Sun className="theme-sun" /><Moon className="theme-moon" /></Button><Button variant="outline" size="sm" onClick={() => open("invite")}><Users data-icon="inline-start" /><span className="hidden sm:inline">邀请成员</span></Button><Button size="sm" onClick={() => open("issue")}><Plus data-icon="inline-start" /><span className="hidden sm:inline">新建任务</span></Button></div>
      </header>
      <main id="workspace-content" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{view === "overview" ? <Overview open={open} navigate={navigate} setup={setup} /> : <WorkspaceViews key={view} view={view} open={open} />}</main>
    </div>
    <Dialog open={mobileNav} onOpenChange={setMobileNav}><DialogContent className="inset-y-0 left-0 h-svh max-w-[224px] translate-x-0 translate-y-0 rounded-none p-0 sm:max-w-[224px]" showCloseButton={false}><DialogTitle className="sr-only">工作空间导航</DialogTitle><WorkspaceSidebar view={view} navigate={navigate} open={open} onClose={() => setMobileNav(false)} /></DialogContent></Dialog>
    <WorkspaceDialogs modal={modal} setModal={setModal} navigate={navigate} setup={setup} />
    <Toaster position="bottom-right" />
  </div>
}
