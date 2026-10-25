'use client'

import { useEffect, useRef, useState, useId } from 'react'
import { useTranslations } from 'next-intl'
import useSWR, { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { ChevronRight, Laptop, Paperclip } from 'lucide-react'
import { listDevices } from '@/app/actions/agents'
import { sendCoordinatorMessage } from '@/app/actions/coordinator'
import { useActionError } from '@/lib/use-action-error'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

const MAX_LENGTH = 8000

/**
 * 新建任务 the Comma way: say what needs doing in a sentence, on which machine,
 * and the Coordinator turns it into the task (title, status, assignee…). The
 * request goes into the Coordinator conversation, where its reply shows up.
 */
export function NewTaskDialog({ open, onOpenChange, onSent, project, initialText = '' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSent?: () => void
  /** Project page the request came from. */
  project?: string | null
  /** Keys typed before the dialog finished opening. */
  initialText?: string
}) {
  const t = useTranslations('Shell.newTaskDialog')
  const tShell = useTranslations('Shell')
  const tCommon = useTranslations('Common')
  const actionError = useActionError()
  const { mutate } = useSWRConfig()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const fileId = useId()

  const { data: devices = [] } = useSWR(open ? 'devices' : null, listDevices)
  const [picked, setPicked] = useState<string | null>(null)
  const device = devices.find(item => item.id === picked) ?? devices.find(item => item.online && item.enabled) ?? devices[0]
  useEffect(() => { if (open && initialText) setDraft(current => current || initialText) }, [open, initialText])

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
      const context = [device && t('contextDevice', { device: device.name }), project && t('contextProject', { project })].filter(Boolean).join(t('contextSeparator'))
      const result = await sendCoordinatorMessage(context ? t('promptWithContext', { context, text }) : t('prompt', { text }))
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
        {device
          ? <Select value={device.id} onValueChange={value => setPicked(value)} items={devices.map(item => ({ value: item.id, label: item.name }))}>
            <SelectTrigger size="sm" className="h-7 gap-1.5 rounded-full px-2.5" aria-label={t('device')}><Laptop aria-hidden="true" className="text-muted-foreground" /><SelectValue /></SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false} className="w-auto min-w-48"><SelectGroup>
              {devices.map(item => <SelectItem key={item.id} value={item.id}><Laptop aria-hidden="true" />{item.name}{!item.online && <span className="ml-auto pl-3 text-xs text-muted-foreground">{t('offline')}</span>}</SelectItem>)}
            </SelectGroup></SelectContent>
          </Select>
          : <span className="flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-muted-foreground"><Laptop aria-hidden="true" className="size-3.5" />{t('noDevice')}</span>}
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <DialogTitle className="text-sm font-medium">{t('title')}</DialogTitle>
        {project && <span className="flex h-6 max-w-40 items-center rounded-full border px-2 text-xs text-muted-foreground"><span className="truncate">{project}</span></span>}
      </div>
      <DialogDescription className="sr-only">{t('description')}</DialogDescription>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="new-issue-title" className="sr-only">{t('label')}</FieldLabel>
          <Textarea id="new-issue-title" autoFocus value={draft} maxLength={MAX_LENGTH} disabled={sending} placeholder={t('placeholder')} className="min-h-24 resize-none border-0 px-0 text-base shadow-none focus-visible:ring-0 dark:bg-transparent" onChange={event => setDraft(event.target.value)} onKeyDown={event => {
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
