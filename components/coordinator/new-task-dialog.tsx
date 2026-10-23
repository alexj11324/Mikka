'use client'

import { useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { ChevronRight, Paperclip } from 'lucide-react'
import { sendCoordinatorMessage } from '@/app/actions/coordinator'
import { useActionError } from '@/lib/use-action-error'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

const MAX_LENGTH = 8000

/**
 * 新建任务 the Comma way: say what needs doing in a sentence and the
 * Coordinator turns it into the task (title, status, assignee…). The request
 * goes into the Coordinator conversation, where its reply shows up.
 */
export function NewTaskDialog({ open, onOpenChange, onSent }: { open: boolean; onOpenChange: (open: boolean) => void; onSent?: () => void }) {
  const t = useTranslations('Shell.newTaskDialog')
  const tNav = useTranslations('Nav')
  const tShell = useTranslations('Shell')
  const tCommon = useTranslations('Common')
  const actionError = useActionError()
  const { mutate } = useSWRConfig()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const fileId = useId()

  async function attach(files: File[]) {
    let next = draft
    for (const file of files) {
      const block = await textAttachment(file, MAX_LENGTH - next.length - 2)
      if (!block) { toast.error(tShell('attachUnsupported', { max: MAX_LENGTH })); continue }
      next = next.trim() ? `${next.trimEnd()}\n\n${block}` : block
    }
    setDraft(next)
  }

  async function submit() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const result = await sendCoordinatorMessage(t('prompt', { text }))
      if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
      setDraft('')
      onOpenChange(false)
      onSent?.()
      void mutate('coordinator-chat')
    } catch {
      toast.error(t('failed'))
    } finally {
      setSending(false)
    }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="gap-3 p-4 sm:max-w-xl" closeLabel={tCommon('close')}>
      <div className="flex items-center gap-2 pr-8 text-sm">
        <span className="flex h-7 items-center gap-1.5 rounded-full border pr-3 pl-1"><LetterAvatar name="Coordinator" tone="coordinator" size="pill" />{tNav('coordinator')}</span>
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <DialogTitle className="text-sm font-medium">{t('title')}</DialogTitle>
      </div>
      <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={fieldId} className="sr-only">{t('label')}</FieldLabel>
          <Textarea id={fieldId} autoFocus value={draft} maxLength={MAX_LENGTH} disabled={sending} placeholder={t('placeholder')} className="min-h-24 resize-none border-0 px-0 text-base shadow-none focus-visible:ring-0 dark:bg-transparent" onChange={event => setDraft(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
          }} />
        </Field>
      </FieldGroup>
      <FieldGroup className="sr-only"><Field><FieldLabel htmlFor={fileId}>{tShell('attach')}</FieldLabel><Input ref={fileRef} id={fileId} type="file" accept={TEXT_ATTACHMENT_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = '' }} /></Field></FieldGroup>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon-sm" className="rounded-full" aria-label={tShell('attach')} disabled={sending} onClick={() => fileRef.current?.click()}><Paperclip data-icon="inline-start" /></Button>
        <Button size="sm" className="ml-auto bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" disabled={!draft.trim() || sending} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => { void submit() }}>{sending ? t('sending') : t('create')}</Button>
      </div>
    </DialogContent>
  </Dialog>
}
