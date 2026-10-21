'use client'

import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { listTeams } from '@/app/actions/teams'
import { getIssueTeam, setIssueTeam } from '@/app/actions/team-relations'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'

export function IssueTeamControl({ issueId, disabled }: { issueId: string; disabled: boolean }) {
  const { data: teams = [], error: teamsError } = useSWR('teams', listTeams)
  const { data, error: readError, mutate } = useSWR(['issue-team', issueId], () => getIssueTeam(issueId))
  const { mutate: refresh } = useSWRConfig()
  const [next, setNext] = useState<string | undefined>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const selected = next ?? data ?? ''
  async function save() {
    if (data === undefined || pending || disabled) return
    if (!window.confirm(selected ? '设为公开团队任务后，本工作区所有启用成员均可查看和编辑，是否继续？' : '移出团队后，仅创建者及显式授权的协作成员可以访问，是否继续？')) return
    setPending(true); setError('')
    try {
      const result = await setIssueTeam({ issueId, teamId: selected || null, expectedTeamId: data })
      if (!result.ok) { setError(result.error); return }
      await mutate(result.data, { revalidate: false }); setNext(undefined); await refresh('issues')
    } catch { setError('归属保存失败，请刷新重试。') }
    finally { setPending(false) }
  }
  return <div className="flex flex-col gap-3 px-2"><FieldGroup><Field><FieldLabel htmlFor={`issue-team-${issueId}`}>归属团队</FieldLabel><NativeSelect id={`issue-team-${issueId}`} value={selected} disabled={disabled || pending || data === undefined || !!readError || !!teamsError} onChange={event => setNext(event.target.value)}><NativeSelectOption value="">无团队 · 私有/显式协作</NativeSelectOption>{teams.map(team => <NativeSelectOption key={team.id} value={team.id}>{team.identifier} · {team.name}</NativeSelectOption>)}</NativeSelect></Field></FieldGroup><p className="text-xs leading-relaxed text-muted-foreground">{data ? '对该工作区启用成员公开，可协作编辑。' : '未加入团队，仅创建者和授权协作成员可访问。'}</p>{selected !== (data ?? '') && <Button size="sm" variant="outline" disabled={disabled || pending} onClick={() => void save()}>{pending ? '保存中…' : '保存团队归属'}</Button>}{(error || readError || teamsError) && <Alert variant="destructive"><AlertDescription>{error || '团队读取失败，请刷新后重试。'}</AlertDescription></Alert>}</div>
}
