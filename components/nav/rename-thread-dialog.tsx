'use client'

import { useRef, useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup } from '@/components/ui/field'

/** 重命名 a thread from its sidebar row; the caller saves through renameConversation and closes when it has finished. */
export function RenameThreadDialog({ title, onSave, onClose }: { title: string; onSave: (title: string) => Promise<boolean>; onClose: () => void }) {
  const t = useTranslations('Nav.botMenu')
  const common = useTranslations('Common')
  const [value, setValue] = useState(title)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const save = async () => {
    const next = value.trim()
    if (!next || busy.current) return
    if (next === title) { onClose(); return }
    busy.current = true
    setPending(true)
    const done = await onSave(next)
    busy.current = false
    setPending(false)
    if (done) onClose()
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy.current) onClose() }}>
    <DialogContent>
      <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save() }}>
        <DialogHeader><DialogTitle>{t('renameTitle')}</DialogTitle></DialogHeader>
        <FieldGroup><Field>
          <Input id="rename-thread-title" aria-label={t('renameTitle')} value={value} maxLength={400} autoFocus disabled={pending} onChange={event => setValue(event.target.value)} />
        </Field></FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{common('cancel')}</Button>
          <Button type="submit" disabled={pending || !value.trim()}>{common('save')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
