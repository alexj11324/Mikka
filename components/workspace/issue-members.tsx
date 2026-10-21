'use client'

import { useState, type FormEvent } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { inviteMember, listMembers, removeMember } from '@/app/actions/collaboration'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { useActionError } from '@/lib/use-action-error'

export function IssueMembers({ id }: { id: string }) {
  const t = useTranslations('Workspace.members')
  const translateError = useActionError()
  const { data, error, mutate } = useSWR(['members', id], () => listMembers(id), { refreshInterval: 10000 })
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  async function invite(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true); setMessage('')
    try {
      const result = await inviteMember(id, email)
      if ('error' in result) { setMessage(translateError(result.error)); return }
      setEmail(''); setMessage(t('added')); await mutate()
    } catch { setMessage(t('addFailed')) }
    finally { setPending(false) }
  }
  async function remove(memberId: string) {
    if (pending || !window.confirm(t('removeConfirm'))) return
    setPending(true); setMessage('')
    try {
      const result = await removeMember(id, memberId)
      if ('error' in result) { setMessage(translateError(result.error)); return }
      await mutate()
    }
    catch { setMessage(t('removeFailed')) }
    finally { setPending(false) }
  }
  return <Collapsible render={<div className="rounded-lg border p-4" />}><CollapsibleTrigger className="cursor-pointer"><span className="text-xs font-medium">{t('title')} {data ? `· ${data.members.length + 1}` : ''}</span></CollapsibleTrigger><CollapsibleContent><div className="mt-4 flex flex-col gap-4">
    <p className="text-xs leading-6 text-muted-foreground">{t('description')}</p>
    {error && <p role="alert" className="text-xs text-destructive">{t('readFailed')}</p>}
    {data?.members.map(member => <div key={member.id} className="flex items-center justify-between gap-3 text-xs"><div className="min-w-0"><p className="truncate font-medium">{member.name}</p><p className="truncate text-muted-foreground">{member.email}</p></div>{data.isOwner && <Button size="sm" variant="ghost" disabled={pending} onClick={() => remove(member.id)}>{t('remove')}<span className="sr-only">{member.name}</span></Button>}</div>)}
    {data?.isOwner && <form onSubmit={invite} className="flex flex-col gap-3 sm:flex-row sm:items-end"><FieldGroup><Field><FieldLabel htmlFor="member-email">{t('addLabel')}</FieldLabel><Input id="member-email" type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder={t('emailPlaceholder')} required maxLength={254} disabled={pending} /></Field></FieldGroup><Button size="sm" variant="outline" type="submit" disabled={pending}>{t('add')}</Button></form>}
    {message && <p role="status" className="text-xs leading-6">{message}</p>}
  </div></CollapsibleContent></Collapsible>
}
