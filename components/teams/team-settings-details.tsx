'use client'
import { useTranslations } from 'next-intl'

import { useId, useState, type ReactNode } from 'react'
import { SettingsLink as Link } from '@/components/settings/settings-link'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { useRouter } from 'next/navigation'
import { useSWRConfig } from 'swr'
import { ArrowUpRight, Bot, Box, ChartNoAxesCombined, CheckCircle2, ChevronLeft, ChevronRight, CircleDot, CircleHelp, CirclePlay, Globe2, Layers, MessageSquareMore, Repeat2, Settings, Tags, Users, type LucideIcon } from 'lucide-react'
import { changeTeamMember } from '@/app/actions/teams'
import { Button, buttonVariants } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import { useFeatureAvailability } from '@/hooks/use-feature-availability'
import { withBasePath } from '@/lib/base-path'

type Team = { id: string; workspaceId: string; name: string; identifier: string; description: string; memberCount: number; role: string | null }
function SlackIcon() { return <img src={withBasePath('/icons/slack.svg')} alt="" className="size-4" /> }
type SettingsRow = { title: string; icon?: LucideIcon | typeof SlackIcon; href?: string; label?: string; status?: ReactNode; action?: ReactNode; unavailable?: boolean; control?: 'switch' | 'button' | 'select'; controlLabel?: string }

// Titles and descriptions are keys in TeamSettings.rows (`<key>` and `<key>Description`).
const sections = [
  { title: 'issuesSection', rows: [
    { title: 'issueLabels', icon: Tags },
    { title: 'projectLabels', icon: Tags },
    { title: 'templates', icon: Layers },
    { title: 'recurringIssues', icon: Repeat2 },
  ] },
  { title: 'workflowSection', rows: [
    { title: 'issueStatuses', icon: CircleDot },
    { title: 'projectStatuses', icon: Box },
    { title: 'workflows', icon: CheckCircle2 },
    { title: 'triage', icon: CircleHelp, control: 'switch' },
    { title: 'cycles', icon: CirclePlay, control: 'switch' },
  ] },
  { title: 'agentsSection', rows: [
    { title: 'teamAgents', icon: Bot },
    { title: 'agentSkills', icon: Layers },
    { title: 'agentConnectors', icon: Globe2 },
    { title: 'projectUpdates', icon: ChartNoAxesCombined, control: 'switch' },
    { title: 'threadSummaries', icon: MessageSquareMore, control: 'switch' },
  ] },
] satisfies { title: string; rows: SettingsRow[] }[]

function SettingsRows({ rows }: { rows: SettingsRow[] }) {
  const rowText = useTranslations('TeamSettings.rows')
  const text = (key: string) => rowText(key as never)
  const describe = (key: string) => rowText.has(`${key}Description` as never) ? text(`${key}Description`) : undefined
  const release = useFeatureAvailability('teamSettings')
  const unavailableId = useId()
  return <ItemGroup className="gap-0 rounded-xl border bg-card px-4 sm:px-5"><span id={unavailableId} className="sr-only">{release.reason}</span>{rows.map(row => <div key={row.title} role="listitem">
    <Item render={row.href && (!row.unavailable || release.enabled) ? <Link href={row.href} aria-label={row.label} workspaceId={new URL(row.href, 'https://settings.invalid').searchParams.get('workspace') ?? undefined} /> : undefined} data-feature-flag={row.unavailable ? release.key : undefined} aria-disabled={row.unavailable && !release.enabled || undefined} title={row.unavailable ? release.reason : undefined} className="min-h-18 flex-nowrap gap-3 rounded-none px-0 py-4">
      {row.icon && <ItemMedia variant="icon" className="size-9 rounded-lg bg-muted text-muted-foreground"><row.icon aria-hidden="true" /></ItemMedia>}
      <ItemContent className="min-w-0"><ItemTitle>{text(row.title)}</ItemTitle>{describe(row.title) && <ItemDescription>{describe(row.title)}</ItemDescription>}</ItemContent>
      <ItemActions className="shrink-0">{row.action ?? (row.unavailable ? row.control === 'switch' ? <Switch checked={false} disabled aria-label={text(row.title)} aria-describedby={unavailableId} title={release.reason} data-feature-flag={release.key} /> : row.control === 'button' || row.control === 'select' ? <Button type="button" variant="outline" size="sm" disabled aria-label={text(row.title)} aria-describedby={unavailableId} title={release.reason} data-feature-flag="mikka-upcoming-team-settings" data-feature-implemented={false}><span>{row.controlLabel ? text(row.controlLabel) : `${text(row.title)}…`}</span>{row.control === 'select' && <ChevronRight data-icon="inline-end" />}</Button> : <ChevronRight className="shrink-0 text-muted-foreground" aria-hidden="true" /> : <>{row.status && <span className="text-right text-xs text-muted-foreground sm:text-sm">{row.status}</span>}{row.href && <ChevronRight className="shrink-0 text-muted-foreground" aria-hidden="true" />}</>)}</ItemActions>
    </Item>
  </div>)}</ItemGroup>
}

export function TeamSettingsDetails({ team }: { team: Team }) {
  const i18nText = useTranslations();
  const t = useTranslations('TeamSettings')
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
    } catch { setLeaveError(i18nText("Invite.signOutFailed")) }
    finally { setLeaving(false) }
  }
  return <section className="flex flex-col gap-8" aria-label={i18nText("FeatureCopy.c_08591229", { value0: (team.name) })}>
    <Link workspaceId={team.workspaceId} aria-label={i18nText("FeatureCopy.c_bd2c65c3")} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'self-start')} href={directoryHref}><ChevronLeft data-icon="inline-start" />{i18nText("Settings.sections.teams.title")}</Link>
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-12 pb-12 sm:pt-1">
      <header className="flex flex-wrap items-end justify-between gap-4 px-1 sm:px-4"><div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1><p className="text-sm text-muted-foreground">{t('accessibleToAll')}</p></div><Link aria-label={i18nText("FeatureCopy.c_65c36301")} className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={`/?team=${encodeURIComponent(team.id)}`}>{t('teamOverview')}<ChevronRight data-icon="inline-end" /></Link></header>
      <section aria-label={i18nText("FeatureCopy.c_a2a16471")}><SettingsRows rows={[
        { title: 'general', icon: Settings, href: `${href}&view=general`, label: i18nText("FeatureCopy.c_f4e5f570") },
        { title: 'members', icon: Users, href: `${href}&view=members`, label: i18nText("Invite.roles.member"), status: <span aria-label={i18nText("FeatureCopy.c_b7a7b168", { value0: (team.memberCount) })} >{t('memberCount', { count: team.memberCount })}</span> },
        { title: 'slack', icon: SlackIcon, unavailable: true },
      ]} /></section>
      {sections.map(section => <section key={section.title} className="flex flex-col gap-4" aria-label={t(`rows.${section.title}` as never)}><h2 className="px-1 text-base font-medium sm:px-4">{t(`rows.${section.title}` as never)}</h2><SettingsRows rows={section.rows.map(row => ({ ...row, unavailable: true }))} /></section>)}
      <section className="flex flex-col gap-4" aria-labelledby="team-hierarchy-heading"><div className="flex flex-col gap-2 px-1 sm:px-4"><h2 id="team-hierarchy-heading" className="text-base font-medium">{t('hierarchy')}</h2><p className="text-sm leading-relaxed text-muted-foreground">{t('hierarchyDescription')} <a className="inline-flex items-center gap-1 rounded-sm text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring" href="https://linear.app/docs/sub-teams" target="_blank" rel="noreferrer" aria-label={i18nText("FeatureCopy.c_37ee9ddc")}>{t('docs')}<ArrowUpRight className="size-3" aria-hidden="true" /></a></p></div><SettingsRows rows={[{ title: 'parentTeam', unavailable: true, control: 'select', controlLabel: 'none' }]} /></section>
      <section className="flex flex-col gap-4" aria-labelledby="team-danger-heading"><h2 id="team-danger-heading" className="px-1 text-base font-medium sm:px-4">{t('dangerZone')}</h2><SettingsRows rows={[
        { title: 'leaveTeam', action: <AlertDialog open={confirmLeave} onOpenChange={open => { if (!leaving) { setConfirmLeave(open); setLeaveError('') } }}><AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={!team.role} aria-label={i18nText("FeatureCopy.c_54bb9b75")} title={!team.role ? i18nText("FeatureCopy.c_8a85ff47") : undefined} />}>{t('leaveTeamEllipsis')}</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{i18nText("FeatureCopy.c_feecb1e6")} {team.name}？</AlertDialogTitle><AlertDialogDescription>{i18nText("FeatureCopy.c_42435748")}</AlertDialogDescription></AlertDialogHeader>{leaveError && <Alert variant="destructive"><AlertDescription>{leaveError}</AlertDescription></Alert>}<AlertDialogFooter><AlertDialogCancel disabled={leaving}>{i18nText("Editor.richText.cancel")}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={leaving} onClick={() => void leaveTeam()}>{leaving ? i18nText("Nav.signingOut") : i18nText("FeatureCopy.c_515ce419")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> },
        { title: 'retireTeam', unavailable: true, control: 'button' },
        { title: 'deleteTeam', unavailable: true, control: 'button' },
      ]} /></section>
    </div>
  </section>
}
