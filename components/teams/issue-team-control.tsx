'use client'
import { useTranslations } from 'next-intl'

import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { listTeams } from '@/app/actions/teams'
import { getIssueTeam, setIssueTeam } from '@/app/actions/team-relations'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Users } from 'lucide-react'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { PROPERTY_LABEL } from '@/components/workspace/issue-property-row'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTeamChoices } from './team-choices'

const NO_TEAMS: Awaited<ReturnType<typeof listTeams>> = []

export function IssueTeamControl({ issueId, disabled, onChosen }: { issueId: string; disabled: boolean; onChosen?: (issueId: string, teamId: string | null) => void }) {
  const i18nText = useTranslations();
  const { data: teams = NO_TEAMS, error: teamsError } = useSWR('teams', listTeams)
  const { data, error: readError, mutate } = useSWR(['issue-team', issueId], () => getIssueTeam(issueId))
  const { mutate: refresh } = useSWRConfig()
  const [next, setNext] = useState<string | undefined>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const selected = next ?? data ?? ''
  const noTeam = i18nText("FeatureCopy.c_2114e0a1")
  const choices = useTeamChoices(teams, noTeam)
  const currentLabel = choices.find(item => item.value === (selected || 'none'))?.label ?? noTeam
  async function save() {
    if (data === undefined || pending || disabled) return
    if (!window.confirm(selected ? i18nText("FeatureCopy.c_3b154930") : i18nText("FeatureCopy.c_81a1f593"))) return
    setPending(true); setError('')
    try {
      const result = await setIssueTeam({ issueId, teamId: selected || null, expectedTeamId: data })
      if (!result.ok) { setError(result.error); return }
      await mutate(result.data, { revalidate: false }); setNext(undefined); await refresh('issues')
      onChosen?.(issueId, result.data)
    } catch { setError(i18nText("FeatureCopy.c_95310b50")) }
    finally { setPending(false) }
  }
  return <FieldGroup className="gap-0"><Field orientation="horizontal" className="items-start gap-3">
    <FieldLabel htmlFor={`issue-team-${issueId}`} className={PROPERTY_LABEL}>{i18nText("FeatureCopy.c_53d4919c")}</FieldLabel>
    <FieldContent className="min-w-0 gap-2">
      <Select value={selected || 'none'} items={choices} disabled={disabled || pending || data === undefined || !!readError || !!teamsError} onValueChange={value => { if (value) { onChosen?.(issueId, null); setNext(value === 'none' ? '' : value) } }}><SelectTrigger id={`issue-team-${issueId}`} size="sm" className="-ml-1.5 h-7 max-w-full border-transparent bg-transparent pl-1.5 text-xs shadow-none hover:bg-muted dark:bg-transparent [&_svg:not([class*='size-'])]:size-3.5" title={currentLabel}><Users data-icon="inline-start" className="text-muted-foreground" /><SelectValue /></SelectTrigger><SelectContent align="start" className="min-w-56"><SelectGroup>{choices.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select>
      <FieldDescription className="text-xs">{data ? i18nText("FeatureCopy.c_f9821279") : i18nText("FeatureCopy.c_c5bc7195")}</FieldDescription>
      {selected !== (data ?? '') && <div><Button size="sm" variant="outline" disabled={disabled || pending} onClick={() => void save()}>{pending ? i18nText("FeatureCopy.c_6644f061") : i18nText("FeatureCopy.c_d1394c98")}</Button></div>}
      {(error || readError || teamsError) && <Alert variant="destructive"><AlertDescription>{error || i18nText("FeatureCopy.c_f4ae1a97")}</AlertDescription></Alert>}
    </FieldContent>
  </Field></FieldGroup>
}
