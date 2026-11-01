'use client'
import { useTranslations } from 'next-intl'

import { useRef, useState } from 'react'
import { SettingsLink as Link } from '@/components/settings/settings-link'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWR, { useSWRConfig } from 'swr'
import { ArrowDown, ArrowUp, ChevronLeft, SquareUserRound } from 'lucide-react'
import { changeTeamMember, loadTeamDirectory } from '@/app/actions/teams'
import { fetchTeamDirectory, isSettingsAccessError, settingsReadOptions, teamDirectoryKey } from '@/lib/settings-data'
import { SettingsDataState } from '@/components/settings/settings-data-state'
import { SettingsContent } from '@/components/ui/settings-layout'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { memberCsv } from '@/lib/invitation-csv'
import { TeamDirectoryMenu } from './team-directory-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { SearchInput } from '@/components/ui/search-input'
import { TeamForm } from './team-form'
import { TeamMembersSettings } from './team-members-settings'
import { TeamSettingsDetails } from './team-settings-details'

type Directory = Awaited<ReturnType<typeof loadTeamDirectory>>
export function TeamDirectory({ workspaceId }: { workspaceId?: string }) {
  const i18nText = useTranslations();
  const t = useTranslations('TeamSettings')
  const router = useRouter()
  const params = useSearchParams()
  const initialTeamId = params.get('team') ?? undefined
  const createInitially = params.get('create') === '1'
  const initialView = params.get('view')
  const { mutate: refresh } = useSWRConfig()
  const { data, error: readError, mutate } = useSWR<Directory>(teamDirectoryKey(workspaceId), fetchTeamDirectory, settingsReadOptions)
  function navigate(href: string) { if (!pushSettingsHistory(href, workspaceId)) router.push(href) }
  const [query, setQuery] = useState('')
  const [view, setView] = useState('all')
  const [sortAscending, setSortAscending] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const downloadRef = useRef<HTMLAnchorElement>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>()
  function updated() { void mutate(); void refresh('teams') }
  if (!data || isSettingsAccessError(readError)) return <SettingsDataState title={i18nText("Settings.sections.teams.title")} error={readError} onRetry={() => void mutate()} />
  const directoryHref = `/settings/teams?workspace=${encodeURIComponent(data.workspace.id)}`
  function teamHref(teamId: string, page?: 'general' | 'members') { return `${directoryHref}&team=${encodeURIComponent(teamId)}${page ? `&view=${page}` : ''}` }
  function createTeam() { navigate(`${directoryHref}&create=1`) }
  async function saved(teamId: string) {
    try {
      const directory = await loadTeamDirectory(workspaceId)
      await mutate(directory, { revalidate: false })
      void refresh('teams')
      navigate(teamHref(teamId))
    } catch { setError(i18nText("FeatureCopy.c_9ae338b8")) }
  }
  async function membership(teamId: string, joined: boolean) {
    if (pending) return
    setPending(true); setError('')
    try { const result = await changeTeamMember({ teamId, action: joined ? 'leave' : 'join' }); if (!result.ok) setError(result.error); else updated() }
    catch { setError(i18nText("IssueDetail.operationFailed")) }
    finally { setPending(false) }
  }
  const filtered = data.teams.filter(team => (view === 'all' || !!team.role) && `${team.name} ${team.identifier} ${team.description}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (sortAscending ? 1 : -1) * a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  function exportTeams() {
    if (!downloadRef.current) return
    const csv = memberCsv([[i18nText("Settings.workspaceForm.name"), i18nText("FeatureCopy.c_f60daeb5"), i18nText("FeatureCopy.c_5ea2e0cd"), i18nText("FeatureCopy.c_747b74ce"), i18nText("Invite.roles.member"), i18nText("FeatureCopy.c_243d2318")], ...filtered.map(team => [team.name, team.identifier, team.description, i18nText("Settings.groups.workspace"), String(team.memberCount), team.role === 'owner' ? i18nText("Projects.fields.lead") : team.role === 'member' ? i18nText("Invite.roles.member") : i18nText("FeatureCopy.c_8dabc5fb")])])
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    setDownloadUrl(url)
    downloadRef.current.href = url
    downloadRef.current.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const selectedTeam = data.teams.find(team => team.id === initialTeamId)
  if (createInitially) return <TeamForm workspaceId={data.workspace.id} existingIdentifiers={data.teams.map(team => team.identifier)} onClose={() => navigate(directoryHref)} onSaved={saved} />
  if (initialTeamId && selectedTeam && initialView === 'general') return <TeamForm key={selectedTeam.id} workspaceId={data.workspace.id} team={selectedTeam} editable={selectedTeam.role === 'owner' || data.role === 'admin'} onClose={() => navigate(teamHref(selectedTeam.id))} onSaved={saved} />
  if (initialTeamId && selectedTeam) return <SettingsContent className="gap-6">
    {initialView === 'members' ? <section className="flex flex-col gap-8"><Button variant="ghost" size="sm" className="self-start" nativeButton={false} role="link" render={<Link workspaceId={data.workspace.id} href={teamHref(selectedTeam.id)} />}><ChevronLeft data-icon="inline-start" />{i18nText("FeatureCopy.c_212cf650")}</Button><div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-12 sm:pt-4"><header className="flex flex-col gap-2"><h1 className="text-xl font-semibold">{i18nText("FeatureCopy.c_7de0251f")}</h1><p className="text-sm text-muted-foreground">{selectedTeam.name} · {selectedTeam.memberCount}  {i18nText("FeatureCopy.c_b8d0b7f3")}</p></header><TeamMembersSettings key={selectedTeam.id} team={selectedTeam} onUpdated={updated} /></div></section> : <TeamSettingsDetails key={selectedTeam.id} team={selectedTeam} />}
  </SettingsContent>
  return <SettingsContent data-settings-state={readError ? 'error' : 'ready'} className="gap-6">
    {initialTeamId ? <Empty><EmptyHeader><EmptyTitle>{i18nText("FeatureCopy.c_19b23b31")}</EmptyTitle></EmptyHeader><Button variant="outline" onClick={() => navigate(directoryHref)}>{i18nText("FeatureCopy.c_30108106")}</Button></Empty> : <section aria-label={i18nText("FeatureCopy.c_efbc2a6b")} className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{i18nText("Settings.sections.teams.title")}</h1>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="min-w-0 flex-1 sm:w-80"><SearchInput aria-label={t('searchTeams')} placeholder={t('filterPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} /></div>
          <Select value={view} items={[{ value: 'all', label: t('active') }, { value: 'mine', label: t('joined') }]} onValueChange={value => { if (value) setView(value) }}><SelectTrigger aria-label={i18nText("FeatureCopy.c_ab3ddf8b")}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">{t('active')}</SelectItem><SelectItem value="mine">{t('joined')}</SelectItem></SelectGroup></SelectContent></Select>
        </div>
        <div className="ml-auto flex items-center gap-2"><Button type="button" variant="outline" className="rounded-full" aria-label={i18nText("FeatureCopy.c_3aea5cc4")} onClick={exportTeams}>{t('exportCsv')}</Button><Button type="button" className="rounded-full" aria-label={i18nText("FeatureCopy.c_929d5670")} onClick={createTeam}>{t('createTeam')}</Button></div>
      </div>
      {(error || readError) && <Alert variant="destructive"><AlertDescription>{error || i18nText("FeatureCopy.c_1526ac93")}{readError && <Button variant="ghost" size="sm" onClick={() => void mutate()}>{i18nText("Common.retry")}</Button>}</AlertDescription></Alert>}
      {filtered.length ? <Table>
        <TableHeader><TableRow className="border-0 hover:bg-transparent"><TableHead aria-sort={sortAscending ? 'ascending' : 'descending'} className="w-1/3"><Button type="button" variant="ghost" size="sm" aria-label={i18nText("FeatureCopy.c_74329ce8")} onClick={() => setSortAscending(value => !value)}>{t('columns.name')}{sortAscending ? <ArrowDown data-icon="inline-end" /> : <ArrowUp data-icon="inline-end" />}</Button></TableHead><TableHead className="w-1/3">{t('columns.description')}</TableHead><TableHead>{t('columns.visibility')}</TableHead><TableHead>{t('columns.members')}</TableHead><TableHead className="w-12"><span className="sr-only">{i18nText("Members.table.actions")}</span></TableHead></TableRow></TableHeader>
        <TableBody>
          <TableRow className="border-0 bg-muted/60 hover:bg-muted/60"><TableCell colSpan={5} className="rounded-lg px-4 py-2 text-muted-foreground"><span>{view === 'mine' ? t('joined') : t('active')}</span><span className="ml-2 tabular-nums">{filtered.length}</span></TableCell></TableRow>
          {filtered.map(team => <TableRow key={team.id} className="group border-0">
            <TableCell className="min-w-56 py-3"><div className="flex items-center gap-3"><SquareUserRound className="size-4 shrink-0 text-primary" aria-hidden="true" /><Link workspaceId={data.workspace.id} href={teamHref(team.id)} className="rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring">{team.name}</Link><span className="text-muted-foreground">{team.identifier}</span></div></TableCell>
            <TableCell><p className="max-w-80 truncate text-muted-foreground">{team.description}</p></TableCell>
            <TableCell className="text-muted-foreground" title={i18nText("FeatureCopy.c_63434fea")}>{t('visibilityWorkspace')}</TableCell>
            <TableCell className="tabular-nums text-muted-foreground">{team.memberCount}</TableCell>
            <TableCell><TeamDirectoryMenu team={team} pending={pending} navigate={navigate} teamHref={teamHref} onMembership={membership} /></TableCell>
          </TableRow>)}
        </TableBody>
      </Table> : <Empty className="min-h-72"><EmptyHeader><EmptyTitle>{query ? i18nText("FeatureCopy.c_24997695") : view === 'mine' ? i18nText("FeatureCopy.c_d82a1158") : i18nText("FeatureCopy.c_e5305647")}</EmptyTitle></EmptyHeader><Button onClick={createTeam}>{i18nText("FeatureCopy.c_929d5670")}</Button></Empty>}
    </section>}
    <a ref={downloadRef} href={downloadUrl} download="teams.csv" className="hidden" tabIndex={-1} aria-hidden="true">{i18nText("FeatureCopy.c_80dbcaf6")}</a>
  </SettingsContent>
}
