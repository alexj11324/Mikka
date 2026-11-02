'use client'
import { useTranslations } from 'next-intl'

import { useState, type ReactNode } from 'react'
import { SettingsLink as Link } from '@/components/settings/settings-link'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { useRouter } from 'next/navigation'
import { useSWRConfig } from 'swr'
import { ChevronLeft, ChevronRight, Settings, Users, type LucideIcon } from 'lucide-react'
import { changeTeamMember } from '@/app/actions/teams'
import { Button, buttonVariants } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'

type Team = { id: string; workspaceId: string; name: string; identifier: string; description: string; memberCount: number; role: string | null }
type SettingsRow = { title: string; icon?: LucideIcon; href?: string; label?: string; status?: ReactNode; action?: ReactNode }

// Rows for features that are not built are not shown (decisions/2026-11-02-0303, R-40).
function SettingsRows({ rows }: { rows: SettingsRow[] }) {
  const rowText = useTranslations('TeamSettings.rows')
  const text = (key: string) => rowText(key as never)
  return <ItemGroup className="gap-0 overflow-hidden rounded-xl border bg-card">{rows.map(row => <div key={row.title} role="listitem">
    <Item render={row.href ? <Link href={row.href} aria-label={row.label} workspaceId={new URL(row.href, 'https://settings.invalid').searchParams.get('workspace') ?? undefined} /> : undefined} className="min-h-18 flex-nowrap gap-3 rounded-none px-4 py-4 sm:px-5">
      {row.icon && <ItemMedia variant="icon" className="size-9 rounded-lg bg-muted text-muted-foreground"><row.icon aria-hidden="true" /></ItemMedia>}
      <ItemContent className="min-w-0"><ItemTitle>{text(row.title)}</ItemTitle></ItemContent>
      <ItemActions className="shrink-0">{row.action ?? <>{row.status && <span className="text-right text-xs text-muted-foreground sm:text-sm">{row.status}</span>}{row.href && <ChevronRight className="shrink-0 text-muted-foreground" aria-hidden="true" />}</>}</ItemActions>
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
      <header className="flex flex-wrap items-end justify-between gap-4 px-1 sm:px-4"><div className="flex flex-col gap-2"><h1 className="text-xl font-semibold">{team.name}</h1><p className="text-sm text-muted-foreground">{t('accessibleToAll')}</p></div><Link aria-label={i18nText("FeatureCopy.c_65c36301")} className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={workspaceLink({ section: 'team-home', team: team.id })}>{t('teamOverview')}<ChevronRight data-icon="inline-end" /></Link></header>
      <section aria-label={i18nText("FeatureCopy.c_a2a16471")}><SettingsRows rows={[
        { title: 'general', icon: Settings, href: `${href}&view=general`, label: i18nText("FeatureCopy.c_f4e5f570") },
        { title: 'members', icon: Users, href: `${href}&view=members`, label: i18nText("Invite.roles.member"), status: <span aria-label={i18nText("FeatureCopy.c_b7a7b168", { value0: (team.memberCount) })} >{t('memberCount', { count: team.memberCount })}</span> },
      ]} /></section>
      <section className="flex flex-col gap-4" aria-labelledby="team-danger-heading"><h2 id="team-danger-heading" className="px-1 text-base font-medium sm:px-4">{t('dangerZone')}</h2><SettingsRows rows={[
        { title: 'leaveTeam', action: <AlertDialog open={confirmLeave} onOpenChange={open => { if (!leaving) { setConfirmLeave(open); setLeaveError('') } }}><AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={!team.role} aria-label={i18nText("FeatureCopy.c_54bb9b75")} title={!team.role ? i18nText("FeatureCopy.c_8a85ff47") : undefined} />}>{t('leaveTeamEllipsis')}</AlertDialogTrigger><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{i18nText("FeatureCopy.c_feecb1e6")} {team.name}？</AlertDialogTitle><AlertDialogDescription>{i18nText("FeatureCopy.c_42435748")}</AlertDialogDescription></AlertDialogHeader>{leaveError && <Alert variant="destructive"><AlertDescription>{leaveError}</AlertDescription></Alert>}<AlertDialogFooter><AlertDialogCancel disabled={leaving}>{i18nText("Editor.richText.cancel")}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={leaving} onClick={() => void leaveTeam()}>{leaving ? i18nText("Nav.signingOut") : i18nText("FeatureCopy.c_515ce419")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog> },
      ]} /></section>
    </div>
  </section>
}
