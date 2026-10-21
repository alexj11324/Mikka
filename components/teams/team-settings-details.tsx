'use client'

import { useState, type ReactNode } from 'react'
import { SettingsLink as Link } from '@/components/settings/settings-link'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { useRouter } from 'next/navigation'
import { useSWRConfig } from 'swr'
import { ArrowUpRight, Bot, Box, ChartNoAxesCombined, CheckCircle2, ChevronLeft, ChevronRight, CircleDot, CircleHelp, CirclePlay, Globe2, Layers, MessageSquareMore, Repeat2, Settings, Tags, Users, type LucideIcon } from 'lucide-react'
import { changeTeamMember } from '@/app/actions/teams'
import { Button, buttonVariants } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { useFeatureAvailability } from '@/hooks/use-feature-availability'

type Team = { id: string; workspaceId: string; name: string; identifier: string; description: string; memberCount: number; role: string | null }
function SlackIcon() { return <img src="/icons/slack.svg" alt="" className="size-4" /> }
type SettingsRow = { title: string; description?: string; icon?: LucideIcon | typeof SlackIcon; href?: string; label?: string; status?: ReactNode; action?: ReactNode; unavailable?: boolean }

const sections = [
  { title: 'Issues, projects, and documents', rows: [
    { title: 'Issue labels', description: 'Labels available to this team’s issues', icon: Tags },
    { title: 'Project labels', description: 'Labels available to this team’s projects', icon: Tags },
    { title: 'Templates', description: 'Pre-filled templates for issues, documents, and projects', icon: Layers },
    { title: 'Recurring issues', description: 'Automatically create issues on a schedule', icon: Repeat2 },
  ] },
  { title: 'Workflow', rows: [
    { title: 'Issue statuses', description: 'Customize the statuses issues go through', icon: CircleDot },
    { title: 'Project statuses', description: 'Customize the statuses projects go through', icon: Box },
    { title: 'Workflows & automations', description: 'Manage issue automations, git workflows and other workflows', icon: CheckCircle2 },
    { title: 'Triage', description: 'Streamline how you handle requests from outside your team', icon: CircleHelp },
    { title: 'Cycles', description: 'Focus your team over short, time-boxed windows', icon: CirclePlay },
  ] },
  { title: 'AI & agents', rows: [
    { title: 'Team agents', description: 'Add guidance for how agents should operate within this team', icon: Bot },
    { title: 'Agent skills', description: 'Linear Agent skills shared with this team', icon: Layers },
    { title: 'Agent connectors', description: 'MCP connectors shared with this team', icon: Globe2 },
    { title: 'Project updates', description: 'Automatically generate updates using recent activity and defined rules', icon: ChartNoAxesCombined },
    { title: 'Resolved thread summaries', description: 'Automatically generate summaries for resolved threads', icon: MessageSquareMore },
  ] },
] satisfies { title: string; rows: SettingsRow[] }[]

function SettingsRows({ rows }: { rows: SettingsRow[] }) {
  const release = useFeatureAvailability('teamSettings')
  return <ItemGroup className="gap-0 rounded-xl border bg-card px-4 sm:px-5">{rows.map(row => <div key={row.title} role="listitem">
    <Item render={row.href && (!row.unavailable || release.enabled) ? <Link href={row.href} aria-label={row.label} workspaceId={new URL(row.href, 'https://settings.invalid').searchParams.get('workspace') ?? undefined} /> : undefined} data-feature-flag={row.unavailable ? release.key : undefined} aria-disabled={row.unavailable && !release.enabled || undefined} title={row.unavailable ? release.reason : undefined} className="min-h-18 flex-nowrap gap-3 rounded-none px-0 py-4">
      {row.icon && <ItemMedia variant="icon" className="size-9 rounded-lg bg-muted text-muted-foreground"><row.icon aria-hidden="true" /></ItemMedia>}
      <ItemContent className="min-w-0"><ItemTitle lang="en">{row.title}</ItemTitle>{row.description && <ItemDescription lang="en">{row.description}</ItemDescription>}</ItemContent>
      <ItemActions className="max-w-24 shrink-0 sm:max-w-none">{row.action ?? <>{(row.status || row.unavailable) && <span className="text-right text-xs text-muted-foreground sm:text-sm">{row.status ?? '暂未开放'}</span>}{row.href && <ChevronRight className="shrink-0 text-muted-foreground" aria-hidden="true" />}</>}</ItemActions>
    </Item>
  </div>)}</ItemGroup>
}

export function TeamSettingsDetails({ team }: { team: Team }) {
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState('')
  const directoryHref = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}`
  const href = `${directoryHref}&team=${encodeURIComponent(team.id)}`
  async function leaveTeam() {
    if (leaving) return
    setLeaving(true)
    setLeaveError('')
    try {
      const result = await changeTeamMember({ teamId: team.id, action: 'leave' })
      if (!result.ok) { setLeaveError(result.error); return }
      setConfirmLeave(false)
      await Promise.allSettled([mutate('teams'), mutate(['team-directory', team.workspaceId])])
      if (!pushSettingsHistory(directoryHref, team.workspaceId)) router.push(directoryHref)
    } catch { setLeaveError('退出失败，请重试。') }
    finally { setLeaving(false) }
  }
  return <section className="flex flex-col gap-8" aria-label={`${team.name} 团队设置`}>
    <Link workspaceId={team.workspaceId} aria-label="全部团队" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'self-start')} href={directoryHref}><ChevronLeft data-icon="inline-start" /><span lang="en">Teams</span></Link>
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-12 pb-12 sm:pt-1">
      <header className="flex flex-wrap items-end justify-between gap-4 px-1 sm:px-4"><div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1><p className="text-sm text-muted-foreground" lang="en">Accessible to all workspace members</p></div><Link aria-label="团队概览" className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={`/?team=${encodeURIComponent(team.id)}`}><span lang="en">Team overview</span><ChevronRight data-icon="inline-end" /></Link></header>
      <section aria-label="团队设置选项"><SettingsRows rows={[
        { title: 'General', description: 'Name, identifier, timezone, estimates, and broader settings', icon: Settings, href: `${href}&view=general`, label: '常规设置' },
        { title: 'Members', description: 'Manage team members', icon: Users, href: `${href}&view=members`, label: '成员', status: <span aria-label={`${team.memberCount} 位成员`} lang="en">{team.memberCount} {team.memberCount === 1 ? 'member' : 'members'}</span> },
        { title: 'Slack notifications', description: 'Broadcast notifications to Slack', icon: SlackIcon, unavailable: true },
      ]} /></section>
      {sections.map(section => <section key={section.title} className="flex flex-col gap-4" aria-label={section.title}><h2 className="px-1 text-base font-medium sm:px-4" lang="en">{section.title}</h2><SettingsRows rows={section.rows.map(row => ({ ...row, unavailable: true }))} /></section>)}
      <section className="flex flex-col gap-4" aria-labelledby="team-hierarchy-heading"><div className="flex flex-col gap-2 px-1 sm:px-4"><h2 id="team-hierarchy-heading" className="text-base font-medium" lang="en">Team hierarchy</h2><p className="text-sm leading-relaxed text-muted-foreground" lang="en">Teams can be nested to reflect your team structure and to share workflows and settings. <a className="inline-flex items-center gap-1 rounded-sm text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring" href="https://linear.app/docs/sub-teams" target="_blank" rel="noreferrer" aria-label="查看团队层级文档（新窗口）">Docs<ArrowUpRight className="size-3" aria-hidden="true" /></a></p></div><SettingsRows rows={[{ title: 'Parent team', unavailable: true }]} /></section>
      <section className="flex flex-col gap-4" aria-labelledby="team-danger-heading"><h2 id="team-danger-heading" className="px-1 text-base font-medium sm:px-4" lang="en">Danger zone</h2><SettingsRows rows={[
        { title: 'Leave team', description: 'Remove yourself as a member of this team', action: <AlertDialog open={confirmLeave} onOpenChange={open => { if (!leaving) { setConfirmLeave(open); setLeaveError('') } }}><AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={!team.role} aria-label="退出团队" title={!team.role ? '你尚未加入此团队' : undefined} />}><span lang="en">Leave team…</span></AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>退出 {team.name}？</AlertDialogTitle><AlertDialogDescription>退出后，此团队将从“Your teams”中移除。团队必须保留至少一位启用中的负责人。</AlertDialogDescription></AlertDialogHeader>{leaveError && <Alert variant="destructive"><AlertDescription>{leaveError}</AlertDescription></Alert>}<AlertDialogFooter><AlertDialogCancel disabled={leaving}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={leaving} onClick={() => void leaveTeam()}>{leaving ? '正在退出…' : '确认退出'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> },
        { title: 'Retire team', description: 'Prevent creating and updating issues in this team while preserving all historical data', unavailable: true, action: <Button variant="ghost" size="sm" disabled title="暂未开放：团队停用功能尚未实现。"><span lang="en">Retire…</span></Button> },
        { title: 'Delete team', description: 'Permanently delete this team and all its data', unavailable: true, action: <Button variant="ghost" size="sm" disabled title="暂未开放：团队删除功能尚未实现。"><span lang="en">Delete…</span></Button> },
      ]} /></section>
    </div>
  </section>
}
