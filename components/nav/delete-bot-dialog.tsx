'use client'

import { useRef, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

/**
 * 删除 Bot, asked as Capy asks before deleting a Captain: what goes, what stays, and 改为归档 beside 删除.
 * The caller runs the delete or the archive (lib/bot-lifecycle.ts) and closes the dialog when it has finished.
 */
export function DeleteBotDialog({ name, onDelete, onArchive, onClose }: {
  name: string
  onDelete: () => Promise<boolean>
  onArchive: () => Promise<boolean>
  onClose: () => void
}) {
  const t = useTranslations('Nav.botMenu')
  const common = useTranslations('Common')
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const run = async (action: () => Promise<boolean>) => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    const done = await action()
    busy.current = false
    setPending(false)
    if (done) onClose()
  }
  return <AlertDialog open onOpenChange={open => { if (!open && !busy.current) onClose() }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{t('deleteTitle', { name })}</AlertDialogTitle>
        <AlertDialogDescription>{t('deletePermanent')} {t('deleteKeeps')}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>{common('cancel')}</AlertDialogCancel>
        <Button variant="outline" disabled={pending} onClick={() => { void run(onArchive) }}>{t('archiveInstead')}</Button>
        <AlertDialogAction variant="destructive" disabled={pending} onClick={event => { event.preventDefault(); void run(onDelete) }}>{t('delete')}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
}
