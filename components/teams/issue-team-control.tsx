'use client'
import { useTranslations } from 'next-intl'

import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { listTeams } from '@/app/actions/teams'
import { getIssueTeam, setIssueTeam } from '@/app/actions/team-relations'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

export function IssueTeamControl({ issueId, disabled }: { issueId: string; disabled: boolean }) {
  const i18nText = useTranslations();
  const { data: teams = [], error: teamsError } = useSWR('teams', listTeams)
  const { data, error: readError, mutate } = useSWR(['issue-team', issueId], () => getIssueTeam(issueId))
  const { mutate: refresh } = useSWRConfig()
  const [next, setNext] = useState<string | undefined>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const selected = next ?? data ?? ''
  const noTeam = i18nText("FeatureCopy.c_2114e0a1")
  const choices = [{ value: 'none', label: noTeam }, ...teams.map(team => ({ value: team.id, label: `${team.identifier} · ${team.name}` }))]
  const currentLabel = choices.find(item => item.value === (selected || 'none'))?.label ?? noTeam
  async function save() {
    if (data === undefined || pending || disabled) return
    if (!window.confirm(selected ? i18nText("FeatureCopy.c_3b154930") : i18nText("FeatureCopy.c_81a1f593"))) return
    setPending(true); setError('')
    try {
      const result = await setIssueTeam({ issueId, teamId: selected || null, expectedTeamId: data })
      if (!result.ok) { setError(result.error); return }
      await mutate(result.data, { revalidate: false }); setNext(undefined); await refresh('issues')
    } catch { setError(i18nText("FeatureCopy.c_95310b50")) }
    finally { setPending(false) }
  }
  return <div className="flex flex-col gap-3"><FieldGroup className="gap-2"><Field><FieldLabel htmlFor={`issue-team-${issueId}`}>{i18nText("FeatureCopy.c_53d4919c")}</FieldLabel><Select value={selected || 'none'} items={choices} disabled={disabled || pending || data === undefined || !!readError || !!teamsError} onValueChange={value => { if (value) setNext(value === 'none' ? '' : value) }}><SelectTrigger id={`issue-team-${issueId}`} className="w-full max-w-full" title={currentLabel}><SelectValue /></SelectTrigger><SelectContent align="start" className="min-w-56"><SelectGroup>{choices.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select><FieldDescription>{data ? i18nText("FeatureCopy.c_f9821279") : i18nText("FeatureCopy.c_c5bc7195")}</FieldDescription></Field></FieldGroup>{selected !== (data ?? '') && <Button size="sm" variant="outline" disabled={disabled || pending} onClick={() => void save()}>{pending ? i18nText("FeatureCopy.c_6644f061") : i18nText("FeatureCopy.c_d1394c98")}</Button>}{(error || readError || teamsError) && <Alert variant="destructive"><AlertDescription>{error || i18nText("FeatureCopy.c_f4ae1a97")}</AlertDescription></Alert>}</div>
}
