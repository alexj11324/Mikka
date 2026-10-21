'use client'

import { useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import { ArrowLeft, Building2, Monitor, Moon, Search, SlidersHorizontal, Sun, UserRound } from 'lucide-react'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { NavUser } from '@/components/nav-user'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { WORKSPACE_NAME } from '@/components/workspace/issue-properties'

const sections = [
  { id: 'preferences', title: '偏好设置', group: '个人', icon: SlidersHorizontal, description: '让 Orvilo 更符合你的工作习惯。' },
  { id: 'profile', title: '个人资料', group: '个人', icon: UserRound, description: '查看你在工作区中的账户信息。' },
  { id: 'workspace', title: '工作区', group: '工作区', icon: Building2, description: '当前工作区的基本信息。' },
] as const

function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-col gap-1"><div className="text-sm font-medium">{title}</div>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div><div className="shrink-0 text-sm">{children}</div></div>
}

export function SettingsView({ user, onBack, onSignOut, signingOut, accountError }: { user: { name: string; email: string }; onBack: () => void; onSignOut: () => void; signingOut: boolean; accountError: string }) {
  const [section, setSection] = useState<(typeof sections)[number]['id']>('preferences')
  const [query, setQuery] = useState('')
  const { theme, setTheme } = useTheme()
  const { setOpenMobile } = useSidebar()
  const current = sections.find(item => item.id === section)!
  const filtered = sections.filter(item => `${item.title} ${item.group}`.includes(query.trim()))
  return <>
    <Sidebar variant="inset">
      <SidebarHeader>
        <SidebarMenu><SidebarMenuItem><SidebarMenuButton onClick={() => { setOpenMobile(false); onBack() }}><ArrowLeft /><span>返回应用</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
        <div className="relative my-2"><Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden="true" /><SidebarInput className="pl-8" aria-label="搜索设置" placeholder="搜索设置…" value={query} onChange={event => setQuery(event.target.value)} /></div>
      </SidebarHeader>
      <SidebarContent>
        {['个人', '工作区'].map(group => {
          const items = filtered.filter(item => item.group === group)
          return items.length > 0 && <SidebarGroup key={group}><SidebarGroupLabel>{group}</SidebarGroupLabel><SidebarMenu>{items.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={section === item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => { setSection(item.id); setOpenMobile(false) }}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>
        })}
        {filtered.length === 0 && <p className="px-4 py-2 text-sm text-muted-foreground" role="status">没有匹配的设置</p>}
      </SidebarContent>
      <SidebarFooter><NavUser user={user} onSignOut={onSignOut} signingOut={signingOut} /></SidebarFooter>
      <SidebarRail />
    </Sidebar>
    <SidebarInset className="min-w-0">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4"><SidebarTrigger aria-label="展开或收起侧栏" /><Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-auto" /><span className="text-sm text-muted-foreground">设置</span><span className="text-sm">/</span><span className="text-sm">{current.title}</span></header>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-9 px-6 py-10 sm:px-10 sm:py-16">
        <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">{current.title}</h1><p className="text-sm text-muted-foreground">{current.description}</p></div>
        {accountError && <p role="alert" className="text-sm text-destructive">{accountError}</p>}
        {section === 'preferences' && <section className="flex flex-col gap-3" aria-labelledby="appearance-heading"><h2 id="appearance-heading" className="text-sm font-medium">外观</h2><div className="rounded-xl border bg-muted/30 px-5"><SettingRow title="界面主题" description="选择浅色、深色或跟随系统。"><ToggleGroup aria-label="界面主题" variant="outline" spacing={0} value={theme ? [theme] : []} onValueChange={values => { if (values[0]) setTheme(values[0]) }}><ToggleGroupItem value="light" aria-label="浅色"><Sun />浅色</ToggleGroupItem><ToggleGroupItem value="dark" aria-label="深色"><Moon />深色</ToggleGroupItem><ToggleGroupItem value="system" aria-label="跟随系统"><Monitor />系统</ToggleGroupItem></ToggleGroup></SettingRow><Separator /><SettingRow title="界面语言" description="当前版本的显示语言。"><span className="text-muted-foreground">简体中文</span></SettingRow></div></section>}
        {section === 'profile' && <section className="flex flex-col gap-3" aria-labelledby="profile-heading"><h2 id="profile-heading" className="text-sm font-medium">账户信息</h2><div className="rounded-xl border bg-muted/30 px-5"><SettingRow title="头像" description="根据账户名称自动生成。"><Avatar className="size-10"><AvatarFallback>{(user.name || user.email).slice(0, 2).toUpperCase()}</AvatarFallback></Avatar></SettingRow><Separator /><SettingRow title="名称"><span>{user.name || '未设置'}</span></SettingRow><Separator /><SettingRow title="电子邮箱"><span className="break-all">{user.email}</span></SettingRow></div><p className="text-xs text-muted-foreground">账户信息为只读，当前版本暂不支持在此修改。</p></section>}
        {section === 'workspace' && <section className="flex flex-col gap-3" aria-labelledby="workspace-heading"><h2 id="workspace-heading" className="text-sm font-medium">基本信息</h2><div className="rounded-xl border bg-muted/30 px-5"><SettingRow title="工作区名称"><span>{WORKSPACE_NAME}</span></SettingRow><Separator /><SettingRow title="用途"><span className="text-muted-foreground">任务与文档</span></SettingRow></div><p className="text-xs text-muted-foreground">工作区信息由应用统一配置，当前为只读。</p></section>}
      </div>
    </SidebarInset>
  </>
}
