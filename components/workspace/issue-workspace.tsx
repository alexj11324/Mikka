'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useRouter } from 'next/navigation'
import { Columns3, List, Search } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { IssueBoard } from './issue-board'
import { AppSidebar } from '@/components/app-sidebar'
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { CreateIssueDialog } from './create-issue-dialog'
import { IssueList } from './issue-list'
import { IssueSearch } from './issue-search'
import { ISSUE_STATUSES, WORKSPACE_NAME, issueIdentifier, type IssueStatus, type IssueView } from './issue-properties'
import { listIssues } from '@/app/actions/issues'
import { authClient } from '@/lib/auth-client'
import { TaskDetail } from './task-detail'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

function WorkspaceSidebarTrigger() {
  const { isMobile, openMobile, open } = useSidebar()
  return <SidebarTrigger className="-ml-1" aria-label="展开或收起侧栏" aria-expanded={isMobile ? openMobile : open} />
}

export function IssueWorkspace({ user, initialIssues }: { user: { id: string; name: string; email: string; image?: string | null }; initialIssues: Awaited<ReturnType<typeof listIssues>> }) {
  const [boardBusy, setBoardBusy] = useState(false)
  const { data: tasks = [], mutate, error } = useSWR('issues', listIssues, { fallbackData: initialIssues, refreshInterval: boardBusy ? 0 : 10000, revalidateOnFocus: !boardBusy, revalidateOnReconnect: !boardBusy })
  const [layout, setLayout] = useState<'board' | 'list'>('board')
  const [createStatus, setCreateStatus] = useState<IssueStatus>('todo')
  const [selected, setSelected] = useState<string | null>(null)
  const [draftKey, setDraftKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const flushDetail = useRef<(() => Promise<boolean>) | null>(null)
  const leaving = useRef(false)
  const registerFlush = useCallback((flush: (() => Promise<boolean>) | null) => { flushDetail.current = flush }, [])
  const [query, setQuery] = useState('')
  const [view, setView] = useState<IssueView>('all')
  const [creating, setCreating] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || boardBusy) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (document.querySelector('[role="dialog"][data-open]') && !searchOpen) return
        event.preventDefault(); setSearchOpen(value => !value)
      } else if (event.key.toLowerCase() === 'c' && !event.metaKey && !event.ctrlKey && !event.altKey && !creating && !searchOpen && !(event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]'))) {
        event.preventDefault(); setCreateStatus(ISSUE_STATUSES.some(status => status.value === view) ? view as IssueStatus : 'todo'); setCreating(true)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [creating, searchOpen, view, boardBusy])
  const [signingOut, setSigningOut] = useState(false)
  const [accountError, setAccountError] = useState('')
  const router = useRouter()
  const onDirty = useCallback((value: boolean) => setDirty(value), [])
  async function leave(action: () => void | Promise<void>) {
    leaving.current = true
    try {
      if (flushDetail.current) {
        if (!await flushDetail.current()) return
      } else if (dirty) return
      setDirty(false)
      await action()
    } finally { leaving.current = false }
  }
  function open(id: string | null) {
    if (boardBusy || leaving.current) return false
    void leave(() => { setSelected(id); setDraftKey(value => value + 1) })
    return true
  }
  const saved = useCallback((id: string) => { setSelected(id); void mutate() }, [mutate])
  function create(status: IssueStatus = ISSUE_STATUSES.some(item => item.value === view) ? view as IssueStatus : 'todo') { if (boardBusy) return; setCreateStatus(status); setCreating(true) }
  function signOut() {
    if (boardBusy || leaving.current) return
    void leave(async () => {
      setSigningOut(true); setAccountError('')
      try {
        const result = await authClient.signOut()
        if (result.error) throw new Error('sign out failed')
        await mutate([], { revalidate: false }); router.replace('/sign-in'); router.refresh()
      } catch { setAccountError('退出失败，请稍后重试。'); setSigningOut(false) }
    })
  }
  function navigate(next: IssueView) {
    if (boardBusy || leaving.current) return false
    void leave(() => { setSelected(null); setView(next); setQuery(''); setDraftKey(value => value + 1) })
    return true
  }
  const filtered = tasks.filter(task => (view === 'all' || (view === 'mine' ? task.ownerId === user.id : view === 'shared' ? task.ownerId !== user.id : task.status === view)) && `${issueIdentifier(task.id)} ${task.title}`.toLowerCase().includes(query.trim().toLowerCase()))
  const counts: Record<IssueView, number> = { all: tasks.length, mine: 0, shared: 0, backlog: 0, todo: 0, doing: 0, review: 0, done: 0, canceled: 0, duplicate: 0 }
  for (const task of tasks) {
    if (ISSUE_STATUSES.some(status => status.value === task.status)) counts[task.status as IssueStatus]++
    counts[task.ownerId === user.id ? 'mine' : 'shared']++
  }
  const viewTitle = view === 'all' ? '全部任务' : view === 'mine' ? '我创建的' : view === 'shared' ? '协作任务' : ISSUE_STATUSES.find(status => status.value === view)?.label ?? '全部任务'
  return <TooltipProvider><SidebarProvider>
    <AppSidebar user={user} view={view} counts={counts} recentIssues={tasks} selected={selected} onNavigate={navigate} onOpen={open} onSearch={() => { if (!boardBusy) setSearchOpen(true) }} onCreate={() => create()} onSignOut={signOut} signingOut={signingOut} />
    <SidebarInset className="min-w-0">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <WorkspaceSidebarTrigger />
          <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
          <Breadcrumb aria-label="当前位置"><BreadcrumbList><BreadcrumbItem className="hidden sm:inline-flex"><span>{WORKSPACE_NAME}</span></BreadcrumbItem><BreadcrumbSeparator className="hidden sm:block" /><BreadcrumbItem><BreadcrumbPage>{selected ? issueIdentifier(selected) : viewTitle}</BreadcrumbPage></BreadcrumbItem></BreadcrumbList></Breadcrumb>
        </div>
        <div className="flex shrink-0 items-center gap-2"><Button variant="ghost" size="icon-sm" aria-label="打开全局搜索" disabled={boardBusy} onClick={() => setSearchOpen(true)}><Search data-icon="inline-start" /></Button></div>
      </header>
      {accountError && <p role="alert" className="px-6 py-2 text-sm text-destructive">{accountError}</p>}
      {error && <p role="alert" className="px-6 py-2 text-xs text-destructive">列表更新失败，已保留上次结果。</p>}
      {selected ? <TaskDetail key={draftKey} id={selected} user={user} onSaved={saved} onDirty={onDirty} onRegisterFlush={registerFlush} onClose={() => open(null)} /> : <>
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div className="flex items-center gap-2"><h1 className="text-sm font-semibold">{viewTitle}</h1><Badge variant="secondary">{filtered.length}</Badge></div>
          <div className="flex w-full min-w-0 items-center justify-between gap-3 sm:w-auto"><div className="flex min-w-0 items-center gap-2 sm:w-48"><span className="inline-flex shrink-0 text-muted-foreground"><Search className="size-3.5" aria-hidden="true" /></span><Input aria-label="搜索任务" placeholder="搜索任务…" value={query} onChange={event => setQuery(event.target.value)} disabled={boardBusy} /></div><ToggleGroup aria-label="任务视图" size="sm" variant="outline" spacing={0} disabled={boardBusy} value={[layout]} onValueChange={values => { const next = values[0]; if (next === 'board' || next === 'list') setLayout(next) }}><ToggleGroupItem value="list" aria-label="列表视图"><List /></ToggleGroupItem><ToggleGroupItem value="board" aria-label="看板视图"><Columns3 /></ToggleGroupItem></ToggleGroup></div>
        </div>
        {layout === 'board' ? <IssueBoard issues={filtered} onOpen={open} onCreate={create} onUpdated={() => mutate()} onBusyChange={setBoardBusy} /> : <IssueList issues={filtered} searching={!!query || view !== 'all'} onOpen={open} onCreate={() => create()} />}
      </>}
    </SidebarInset>
    {creating && <CreateIssueDialog initialStatus={createStatus} open={creating} onOpenChange={setCreating} onCreated={() => { void mutate() }} author={user.name || user.email} />}
    {searchOpen && <IssueSearch open={searchOpen} onOpenChange={setSearchOpen} issues={tasks} onOpen={open} onCreate={() => create()} />}
  </SidebarProvider></TooltipProvider>
}
