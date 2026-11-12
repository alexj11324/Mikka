'use client'

import { useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { GroupMessagesRequestError, leaveGroupConversation, type GroupSummary } from '@/lib/group-messages'
import { botKeys } from '@/lib/swr/keys'
import type { GroupChatRequest } from './group-chat-view'
import { forgetGroupReads } from './group-membership-cache'

export function GroupLeaveAction({ group, userId, onLeft }: {
  group: GroupChatRequest; userId: string; onLeft: () => void
}) {
  const t = useTranslations('GroupChat')
  const common = useTranslations('Common')
  const { mutate } = useSWRConfig()
  const sending = useRef(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      await leaveGroupConversation(group.id, userId)
    } catch (cause) {
      const status = cause instanceof GroupMessagesRequestError ? cause.status : undefined
      // Retrying a committed departure also removes local access.
      if (status !== 404) {
        setError(t(status === 401 ? 'authRequired' : status === 403 || status === 422 ? 'leaveDenied' : 'leaveError'))
        sending.current = false
        setBusy(false)
        return
      }
    }
    // Invalidate in-flight reads and older pages as well as the visible transcript.
    // No fetch is necessary to remove a membership the server has already ended.
    await Promise.all([
      forgetGroupReads(mutate, group.id),
      mutate<GroupSummary[]>(botKeys.groups(userId, group.workspaceId), rows => rows?.filter(row => row.id !== group.id), { revalidate: false }),
    ])
    onLeft()
  }

  return <AlertDialog open={open} onOpenChange={next => { if (!sending.current) { setOpen(next); setError('') } }}>
    <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>{t('leave')}</AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{t('leaveConfirm', { name: group.title || t('untitled') })}</AlertDialogTitle>
        <AlertDialogDescription>{t('reinvite')}</AlertDialogDescription>
      </AlertDialogHeader>
      {error && <p role="alert" className="text-sm text-destructive-foreground">{error}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>{common('cancel')}</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={busy} onClick={() => { void confirm() }}>{t('leave')}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
