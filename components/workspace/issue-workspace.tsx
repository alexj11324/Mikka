'use client'

import { useCallback, useState } from 'react'
import useSWR from 'swr'
import { useRouter } from 'next/navigation'
import { Command, LogOut, Moon, Plus, Search, Sun, CircleDashed } from 'lucide-react'
import { useTheme } from 'next-themes'
import { listIssues } from '@/app/actions/issues'
import { authClient } from '@/lib/auth-client'
import { TaskDetail } from './task-detail'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const STATUS: Record<string, string> = { todo: '待处理', doing: '进行中', review: '待审阅', done: '已完成' }
export function IssueWorkspace({ user, initialIssues }: { user: { name: string; email: string }; initialIssues: Awaited<ReturnType<typeof listIssues>> }) {
  const { data: tasks = [], mutate, error } = useSWR('issues', listIssues, { fallbackData: initialIssues })
  const [selected, setSelected] = useState<string | null>(null)
  const [draftKey, setDraftKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  const [accountError, setAccountError] = useState('')
  const { resolvedTheme, setTheme } = useTheme()
  const router = useRouter()
  const onDirty = useCallback((value: boolean) => setDirty(value), [])
  function open(id: string | null) {
    if (dirty && !window.confirm('有未保存的修改，确定放弃这些修改？')) return
    setDirty(false); setSelected(id); setDraftKey(value => value + 1)
  }
  function saved(id: string) { setSelected(id); void mutate() }
  async function signOut() {
    if (dirty && !window.confirm('有未保存的修改，确定退出？')) return
    setSigningOut(true); setAccountError('')
    try {
      const result = await authClient.signOut()
      if (result.error) throw new Error('sign out failed')
      await mutate([], { revalidate: false }); router.replace('/sign-in'); router.refresh()
    } catch { setAccountError('退出失败，请稍后重试。'); setSigningOut(false) }
  }
  const filtered = tasks.filter(task => task.title.toLowerCase().includes(query.toLowerCase()))
  return <div className="min-h-svh bg-background text-foreground">
    <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6"><div className="flex items-center gap-3 text-xs"><Command className="size-4" /><span className="font-semibold">Orbit</span><span className="text-muted-foreground">/</span><span className="text-muted-foreground">个人工作台</span><Badge variant="secondary">MVP</Badge></div><div className="flex items-center gap-2"><span className="max-w-32 truncate text-xs text-muted-foreground" title={user.email}>{user.name}</span><Button variant="ghost" size="icon-sm" aria-label="切换明暗主题" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>{resolvedTheme === 'dark' ? <Sun /> : <Moon />}</Button><Button variant="ghost" size="sm" onClick={signOut} disabled={signingOut}><LogOut data-icon="inline-start" />退出</Button></div></header>
    {accountError && <p role="alert" className="px-6 py-2 text-sm text-destructive">{accountError}</p>}
    <div className="mx-auto flex max-w-[1500px] flex-col md:min-h-[calc(100svh-57px)] md:flex-row">
      <aside aria-label="任务列表" className="flex w-full shrink-0 flex-col gap-4 border-b bg-muted/15 p-4 md:w-64 md:border-r md:border-b-0"><div className="flex items-center justify-between"><h2 className="text-xs font-medium text-muted-foreground">我的任务 <span className="ml-1">{tasks.length}</span></h2><Button variant="ghost" size="icon-sm" aria-label="新建任务" onClick={() => open(null)}><Plus /></Button></div><div className="flex items-center gap-2"><Search className="size-4 shrink-0 text-muted-foreground" /><Input aria-label="搜索任务" placeholder="搜索任务…" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <nav className="flex max-h-56 flex-col gap-1 overflow-y-auto md:max-h-[calc(100svh-260px)]">{error && <p role="alert" className="text-xs text-destructive">列表更新失败，已保留上次结果。</p>}{filtered.map(task => <button key={task.id} type="button" aria-current={selected === task.id ? 'page' : undefined} onClick={() => open(task.id)} className={cn('flex flex-col gap-2 rounded-md px-3 py-3 text-left transition-colors hover:bg-accent', selected === task.id && 'bg-accent')}><span className="truncate text-xs font-medium">{task.title}</span><span className="flex items-center gap-2 text-[10px] text-muted-foreground"><CircleDashed className="size-3" />{STATUS[task.status]}<span className="ml-auto">v{task.revision}</span></span></button>)}{!filtered.length && <p className="px-2 py-6 text-xs leading-6 text-muted-foreground">{query ? '没有找到匹配的任务。' : '还没有任务。创建第一个任务，开始记录工作。'}</p>}</nav><p className="mt-auto pt-4 text-[10px] leading-5 text-muted-foreground">Neon 持久化 · 账号数据隔离<br />实时协作与本机执行待接入</p></aside>
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8"><TaskDetail key={draftKey} id={selected} onSaved={saved} onDirty={onDirty} /></main>
    </div>
  </div>
}
