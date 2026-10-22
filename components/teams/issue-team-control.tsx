'use client'
import { useTranslations } from 'next-intl'

import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { listTeams } from '@/app/actions/teams'
import { getIssueTeam, setIssueTeam } from '@/app/actions/team-relations'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
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
  return <div className="flex flex-col gap-3 px-2"><FieldGroup><Field><FieldLabel htmlFor={`issue-team-${issueId}`}>{i18nText("FeatureCopy.c_53d4919c")}</FieldLabel><NativeSelect id={`issue-team-${issueId}`} value={selected} disabled={disabled || pending || data === undefined || !!readError || !!teamsError} onChange={event => setNext(event.target.value)}><NativeSelectOption value="">{i18nText("FeatureCopy.c_2114e0a1")}</NativeSelectOption>{teams.map(team => <NativeSelectOption key={team.id} value={team.id}>{team.identifier} · {team.name}</NativeSelectOption>)}</NativeSelect></Field></FieldGroup><p className="text-xs leading-relaxed text-muted-foreground">{data ? i18nText("FeatureCopy.c_f9821279") : i18nText("FeatureCopy.c_c5bc7195")}</p>{selected !== (data ?? '') && <Button size="sm" variant="outline" disabled={disabled || pending} onClick={() => void save()}>{pending ? i18nText("FeatureCopy.c_6644f061") : i18nText("FeatureCopy.c_d1394c98")}</Button>}{(error || readError || teamsError) && <Alert variant="destructive"><AlertDescription>{error || i18nText("FeatureCopy.c_f4ae1a97")}</AlertDescription></Alert>}</div>
}
