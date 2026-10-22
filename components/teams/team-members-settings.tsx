'use client'
import { useTranslations } from 'next-intl'

import { useState } from 'react'
import useSWR from 'swr'
import { changeTeamMember, type loadTeamDirectory } from '@/app/actions/teams'
import { fetchTeamMembers, settingsReadOptions, teamMembersKey } from '@/lib/settings-data'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'

type Directory = Awaited<ReturnType<typeof loadTeamDirectory>>
export function TeamMembersSettings({ team, onUpdated }: { team: Directory['teams'][number]; onUpdated: () => void }) {
  const i18nText = useTranslations();
  const { data, error: readError, mutate } = useSWR(teamMembersKey(team.id), fetchTeamMembers, settingsReadOptions)
  const [adding, setAdding] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function change(userId: string, action: 'add' | 'remove' | 'owner' | 'member') {
    if (pending || (action === 'remove' && !window.confirm(i18nText("FeatureCopy.c_7a80514b")))) return
    setPending(true); setError('')
    try {
      const result = await changeTeamMember({ teamId: team.id, userId, action })
      if (!result.ok) { setError(result.error); return }
      setAdding(''); await mutate(); onUpdated()
    } catch { setError(i18nText("IssueDetail.operationFailed")) }
    finally { setPending(false) }
  }
  const memberIds = new Set(data?.members.map(member => member.userId))
  const available = data?.workspaceMembers.filter(member => !memberIds.has(member.userId)) ?? []
  return <section className="flex min-w-0 flex-col gap-6" aria-label={i18nText("FeatureCopy.c_42dd21b0", { value0: (team.name) })}><p className="text-sm leading-relaxed text-muted-foreground">{i18nText("FeatureCopy.c_0e7db50f")}</p>
    {readError ? <Alert variant="destructive"><AlertDescription>{i18nText("FeatureCopy.c_cdbd68cd")}<Button variant="ghost" size="sm" onClick={() => void mutate()}>{i18nText("Common.retry")}</Button></AlertDescription></Alert> : !data ? <Skeleton className="h-28 w-full" /> : <>
      {data.canManage && <FieldGroup><Field><FieldLabel htmlFor="add-team-member">{i18nText("FeatureCopy.c_f939c47b")}</FieldLabel><div className="flex flex-wrap gap-2"><NativeSelect id="add-team-member" value={adding} onChange={event => setAdding(event.target.value)} disabled={pending}><NativeSelectOption value="">{i18nText("FeatureCopy.c_dfe0c748")}</NativeSelectOption>{available.map(member => <NativeSelectOption key={member.userId} value={member.userId}>{member.name} · {member.email}</NativeSelectOption>)}</NativeSelect><Button size="sm" disabled={!adding || pending} onClick={() => void change(adding, 'add')}>{i18nText("Members.addMember")}</Button></div></Field></FieldGroup>}
      <Table><TableHeader><TableRow><TableHead>{i18nText("Invite.roles.member")}</TableHead><TableHead>{i18nText("Members.csv.role")}</TableHead>{data.canManage && <TableHead className="text-right">{i18nText("Members.table.actions")}</TableHead>}</TableRow></TableHeader><TableBody>{data.members.map(member => <TableRow key={member.userId}><TableCell><p className="text-sm">{member.name}</p><p className="text-xs text-muted-foreground">{member.email}</p>{member.status === 'suspended' && <Badge variant="outline">{i18nText("FeatureCopy.c_856486d2")}</Badge>}</TableCell><TableCell>{member.role === 'owner' ? i18nText("Projects.fields.lead") : i18nText("Invite.roles.member")}</TableCell>{data.canManage && <TableCell><div className="flex flex-wrap justify-end gap-1"><Button size="sm" variant="ghost" disabled={pending || member.status !== 'active'} aria-label={`${member.role === 'owner' ? i18nText("Members.menu.makeMember") : i18nText("FeatureCopy.c_cde9c3ab")}：${member.email}`} onClick={() => void change(member.userId, member.role === 'owner' ? 'member' : 'owner')}>{member.role === 'owner' ? i18nText("Members.menu.makeMember") : i18nText("FeatureCopy.c_cde9c3ab")}</Button><Button size="sm" variant="ghost" disabled={pending} aria-label={i18nText("FeatureCopy.c_352987c4", { value0: (member.email) })} onClick={() => void change(member.userId, 'remove')}>{i18nText("FeatureCopy.c_0d01c5a3")}</Button></div></TableCell>}</TableRow>)}</TableBody></Table>
    </>}{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </section>
}
