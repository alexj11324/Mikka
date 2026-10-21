'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import { Building2, Monitor, Moon, SlidersHorizontal, SquareUserRound, Sun, UserRound, Users } from 'lucide-react'
import { AppShellContent } from '@/components/app-shell'
import { SettingsSidebar } from './settings-sidebar'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { WorkspaceSettings } from '@/components/settings/workspace-settings'

const sections = [
  { id: 'preferences', title: '偏好设置', group: '个人', icon: SlidersHorizontal, description: '让 Orvilo 更符合你的工作习惯。' },
  { id: 'profile', title: '个人资料', group: '个人', icon: UserRound, description: '查看你在工作区中的账户信息。' },
  { id: 'workspace', title: '工作区', group: '管理', icon: Building2, description: '当前工作区的基本信息。' },
  { id: 'teams', title: '团队', group: '管理', icon: SquareUserRound, description: '组织团队与共同负责的工作。' },
  { id: 'members', title: '成员', group: '管理', icon: Users, description: '管理工作区成员、角色与邀请。' },
] as const

export type SettingsSection = (typeof sections)[number]['id']

function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-col gap-1"><div className="text-sm font-medium">{title}</div>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div><div className="shrink-0 text-sm">{children}</div></div>
}

export function SettingsView({ user, onBack, onSignOut, signingOut, accountError, activeSection, workspaceId, selectedTeamId, children }: { user: { name: string; email: string; image?: string | null }; onBack: () => void; onSignOut: () => void; signingOut: boolean; accountError: string; activeSection?: SettingsSection; workspaceId?: string; selectedTeamId?: string; children?: ReactNode }) {
  const [localSection, setSection] = useState<SettingsSection>('preferences')
  const section = activeSection ?? localSection
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const current = sections.find(item => item.id === section)!
  return <>
    <SettingsSidebar user={user} section={section} activeSection={activeSection} selectedTeamId={selectedTeamId} workspaceId={workspaceId} onSectionChange={setSection} onBack={onBack} onSignOut={onSignOut} signingOut={signingOut} />
    <AppShellContent parent="设置" title={current.title} variant="settings">
      {accountError && <p role="alert" className="px-6 py-2 text-sm text-destructive">{accountError}</p>}
      {section === 'members' || section === 'teams' ? children : <div className="mx-auto flex w-full max-w-3xl flex-col gap-9 px-6 py-10 sm:px-10 sm:py-16">
        <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">{current.title}</h1><p className="text-sm text-muted-foreground">{current.description}</p></div>
        {section === 'preferences' && <section className="flex flex-col gap-3" aria-labelledby="appearance-heading"><h2 id="appearance-heading" className="text-sm font-medium">外观</h2><div className="rounded-xl border bg-muted/30 px-5"><SettingRow title="界面主题" description="选择浅色、深色或跟随系统。"><ToggleGroup aria-label="界面主题" variant="outline" spacing={0} disabled={!mounted} value={mounted && theme ? [theme] : []} onValueChange={values => { if (values[0]) setTheme(values[0]) }}><ToggleGroupItem value="light" aria-label="浅色"><Sun />浅色</ToggleGroupItem><ToggleGroupItem value="dark" aria-label="深色"><Moon />深色</ToggleGroupItem><ToggleGroupItem value="system" aria-label="跟随系统"><Monitor />系统</ToggleGroupItem></ToggleGroup></SettingRow><SettingRow title="界面语言" description="当前版本的显示语言。"><span className="text-muted-foreground">简体中文</span></SettingRow></div></section>}
        {section === 'profile' && <section className="flex flex-col gap-3" aria-labelledby="profile-heading"><h2 id="profile-heading" className="text-sm font-medium">账户信息</h2><div className="rounded-xl border bg-muted/30 px-5"><SettingRow title="头像" description="根据账户名称自动生成。"><Avatar className="size-10"><AvatarFallback>{(user.name || user.email).slice(0, 2).toUpperCase()}</AvatarFallback></Avatar></SettingRow><SettingRow title="名称"><span>{user.name || '未设置'}</span></SettingRow><SettingRow title="电子邮箱"><span className="break-all">{user.email}</span></SettingRow></div><p className="text-xs text-muted-foreground">账户信息为只读，当前版本暂不支持在此修改。</p></section>}
        {section === 'workspace' && <WorkspaceSettings />}
      </div>}
    </AppShellContent>
  </>
}
