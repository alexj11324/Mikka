'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { CheckCircle2, Mail, Search, ShieldCheck, UserPlus, Users } from 'lucide-react'
import { inviteMember, listMembers, removeMember } from '@/app/actions/collaboration'
import { useActionError } from '@/lib/use-action-error'
import { Badge } from '@/components/reui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { UserAvatar } from '@/components/user-avatar'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { SearchInput } from '@/components/ui/search-input'

type Member = Awaited<ReturnType<typeof listMembers>>['owner']

export function IssueMembers({ id, onChanged }: { id: string; onChanged?: () => Promise<void> }) {
  const t = useTranslations('Members')
  const tCommon = useTranslations('Common')
  const actionError = useActionError()
  const { data, error, isValidating, mutate } = useSWR(['members', id], () => listMembers(id), { refreshInterval: 10000 })
  const [email, setEmail] = useState('')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const emailInput = useRef<HTMLInputElement>(null)
  const [inviteError, setInviteError] = useState('')
  const [removeError, setRemoveError] = useState('')
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<Member | null>(null)

  async function invite(event: FormEvent) {
    event.preventDefault()
    if (busy.current) return
    busy.current = true
    setPending(true); setInviteError(''); setMessage('')
    try {
      const result = await inviteMember(id, email)
      if (result.error) { setInviteError(actionError(result.error)); return }
      if (!result.member) { setInviteError(t('addFailed')); return }
      const member = result.member
      await mutate(current => current ? { ...current, members: [...current.members.filter(item => item.id !== member.id), member] } : current, { revalidate: false })
      setEmail(''); setQuery(''); setMessage(t('addedMessage'))
      void mutate().catch(() => {})
      await onChanged?.()
    } catch { setInviteError(t('addFailed')) }
    finally { busy.current = false; setPending(false) }
  }

  async function remove() {
    if (busy.current || !removing) return
    busy.current = true
    setPending(true); setRemoveError(''); setMessage('')
    try {
      const result = await removeMember(id, removing.id)
      if (result.error) { setRemoveError(actionError(result.error)); return }
      await mutate(current => current ? { ...current, members: current.members.filter(member => member.id !== removing.id) } : current, { revalidate: false })
      setMessage(t('removed', { name: removing.name || removing.email }))
      setRemoving(null)
      void mutate().catch(() => {})
      await onChanged?.()
    } catch { setRemoveError(t('removeFailed')) }
    finally { busy.current = false; setPending(false) }
  }

  const normalizedQuery = query.trim().toLowerCase()
  const visible = data ? [data.owner, ...data.members].filter(member => `${member.name} ${member.email}`.toLowerCase().includes(normalizedQuery)) : []

  return <>
    {/* The dialog is the only surface: sections and rows inside it carry no frame of their own. */}
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 text-sm font-medium">{t('accessTitle')}{data && <Badge variant="secondary">{t('membersCount', { count: data.members.length + 1 })}</Badge>}</div>
      {error && <Alert variant="destructive"><AlertTitle>{t('listUpdateFailed')}</AlertTitle><AlertDescription>{data ? t('keptPrevious') : t('readFailed')}<Button size="sm" variant="outline" disabled={isValidating} onClick={() => { void mutate().catch(() => {}) }}>{t('reload')}</Button></AlertDescription></Alert>}
      {!data && !error && <div role="status" aria-label={t('loading')}><Skeleton className="h-10 w-full" /><Skeleton className="mt-3 h-16 w-full" /></div>}
      {data?.isOwner && <form onSubmit={invite}>
          <FieldGroup>
            <Field data-invalid={!!inviteError}>
              <FieldLabel htmlFor="member-email">{t('addMember')}</FieldLabel>
              <InputGroup>
                <InputGroupInput ref={emailInput} id="member-email" type="email" autoComplete="email" value={email} onChange={event => { setEmail(event.target.value); setInviteError('') }} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault() }} placeholder={t('emailPlaceholder')} required maxLength={254} disabled={pending} aria-invalid={!!inviteError} aria-describedby={inviteError ? 'member-email-error' : undefined} />
                <InputGroupAddon><Mail /></InputGroupAddon>
              </InputGroup>
              {inviteError && <FieldError id="member-email-error">{inviteError}</FieldError>}
            </Field>
            <Button type="submit" disabled={pending || !email.trim()}>{pending && !removing ? <Spinner data-icon="inline-start" /> : <UserPlus data-icon="inline-start" />}{pending && !removing ? t('adding') : t('addMember')}</Button>
          </FieldGroup>
        </form>}
      {message && <Alert role="status"><CheckCircle2 /><AlertTitle>{t('successTitle')}</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>}
      {data && <div className="flex flex-col gap-4">
        <FieldGroup><Field><FieldLabel htmlFor="member-search" className="sr-only">{t('searchMembers')}</FieldLabel><SearchInput id="member-search" placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} /></Field></FieldGroup>
        <ItemGroup aria-label={t('memberList')}>
          {visible.map(member => <Item key={member.id} role="listitem" size="sm">
            <ItemMedia><UserAvatar user={member} /></ItemMedia>
            <ItemContent className="min-w-0"><ItemTitle>{member.name || member.email}{member.id === data.currentUserId && <Badge variant="outline">{t('you')}</Badge>}</ItemTitle><ItemDescription className="break-all">{member.email}</ItemDescription></ItemContent>
            <ItemActions>
              {member.id === data.owner.id ? <Badge variant="secondary"><ShieldCheck />{t('owner')}</Badge> : <Badge variant="outline">{t('collaborator')}</Badge>}
              {data.isOwner && member.id !== data.owner.id && <Button size="sm" variant="ghost" disabled={pending} aria-label={t('removeAria', { name: member.name || member.email })} onClick={() => { setRemoving(member); setRemoveError('') }}>{t('remove')}</Button>}
            </ItemActions>
          </Item>)}
        </ItemGroup>
        {visible.length === 0 ? <Empty><EmptyHeader><EmptyMedia variant="icon"><Search /></EmptyMedia><EmptyTitle>{t('noMatchTitle')}</EmptyTitle></EmptyHeader><EmptyContent><Button size="sm" variant="outline" onClick={() => setQuery('')}>{t('clearSearch')}</Button></EmptyContent></Empty> : data.members.length === 0 && !normalizedQuery && <Empty><EmptyHeader><EmptyMedia variant="icon"><Users /></EmptyMedia><EmptyTitle>{t('inviteTitle')}</EmptyTitle></EmptyHeader>{data.isOwner && <EmptyContent><Button size="sm" variant="outline" onClick={() => emailInput.current?.focus()}><UserPlus data-icon="inline-start" />{t('addFirst')}</Button></EmptyContent>}</Empty>}
      </div>}
    </div>
    <AlertDialog open={!!removing} onOpenChange={open => { if (!open && !busy.current) { setRemoving(null); setRemoveError('') } }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('removeDialogTitle')}</AlertDialogTitle><AlertDialogDescription>{t('removeDialogDescription', { name: removing?.name || removing?.email || '' })}</AlertDialogDescription></AlertDialogHeader>
        {removeError && <Alert variant="destructive"><AlertTitle>{t('removeFailedTitle')}</AlertTitle><AlertDescription>{removeError}</AlertDescription></Alert>}
        <AlertDialogFooter><AlertDialogCancel disabled={pending}>{tCommon('cancel')}</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending} onClick={() => { void remove() }}>{pending && <Spinner data-icon="inline-start" />}{pending ? t('removing') : t('confirmRemove')}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
