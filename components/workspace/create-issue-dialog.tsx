'use client'

import { useEffect, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/react'
import { ChartNoAxesColumnIncreasing, ChevronRight, CircleDashed, LockKeyhole, Maximize2, Minimize2, SquareUserRound, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { saveIssue } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useActionError } from '@/lib/use-action-error'
import { IssueEditor } from './issue-editor'
import { IssuePropertyMenu } from './issue-property-menu'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, WORKSPACE_NAME } from './issue-properties'

const EMPTY: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

export function CreateIssueDialog({ open, onOpenChange, onCreated, author, initialStatus = 'todo' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
  author: string
  initialStatus?: string
}) {
  const t = useTranslations('Issue.create')
  const issueT = useTranslations('Issue')
  const statusT = useTranslations('Issue.status')
  const priorityT = useTranslations('Issue.priority')
  const statusLabel = (value: string) => statusT.has(value as never) ? statusT(value as never) : value
  const priorityLabel = (value: string) => priorityT.has(value as never) ? priorityT(value as never) : value
  const translateError = useActionError()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState<JSONContent>(EMPTY)
  const [status, setStatus] = useState(initialStatus)
  const [priority, setPriority] = useState('normal')
  const [createMore, setCreateMore] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editorKey, setEditorKey] = useState(0)
  const titleRef = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)
  const [defaults, setDefaults] = useState({ status: initialStatus, priority: 'normal' })
  const dirty = !!title.trim() || JSON.stringify(content) !== JSON.stringify(EMPTY) || status !== defaults.status || priority !== defaults.priority
  const [expanded, setExpanded] = useState(false)

  useEffect(() => { if (notice && !pending) titleRef.current?.focus() }, [notice, pending])
  useEffect(() => {
    if (!open || !dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [open, dirty])

  function close() {
    if (submitting.current) return
    if (dirty && !window.confirm(t('discardDraft'))) return
    onOpenChange(false)
  }

  async function create() {
    if (submitting.current || !title.trim()) return
    submitting.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      const result = await saveIssue({ title, content, status, priority })
      if ('error' in result) {
        setError(translateError(result.error))
        return
      }
      onCreated(result.issue.id)
      if (createMore) {
        setDefaults({ status, priority })
        setTitle('')
        setContent(EMPTY)
        setEditorKey(value => value + 1)
        setNotice(t('createdNotice'))
        titleRef.current?.focus()
      } else {
        onOpenChange(false)
      }
    } catch {
      setError(t('createError'))
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return <Dialog open={open} onOpenChange={value => { if (!value) close() }}>
    <DialogContent showCloseButton={false} initialFocus={titleRef} className={cn('max-h-[calc(100svh-2rem)] gap-0 overflow-y-auto p-0 sm:top-[20svh] sm:max-h-[76svh] sm:max-w-3xl sm:translate-y-0', expanded && 'sm:max-w-5xl')}>
      <form onSubmit={event => { event.preventDefault(); void create() }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void create() }
        else if (event.key === 'Enter' && event.target === titleRef.current) event.preventDefault()
      }}>
        <header className="flex items-center justify-between gap-3 px-5 pt-4 sm:px-6">
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="outline" className="gap-1.5 rounded-full"><SquareUserRound />ORV</Badge><ChevronRight className="size-3 text-muted-foreground" />
            <DialogTitle className="sr-only">{t('title')}</DialogTitle><span aria-hidden="true">{t('title')}</span>
          </div>
          <div className="flex items-center gap-1"><Button type="button" variant="ghost" size="icon-sm" aria-label={expanded ? t('collapse') : t('expand')} aria-pressed={expanded} disabled={pending} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 data-icon="inline-start" /> : <Maximize2 data-icon="inline-start" />}</Button><Button type="button" variant="ghost" size="icon-sm" aria-label={t('close')} disabled={pending} onClick={close}><X data-icon="inline-start" /></Button></div>
        </header>
        <DialogDescription className="sr-only">{t('description')}</DialogDescription>
        <FieldSet disabled={pending} className={cn('flex min-w-0 flex-col gap-5 px-5 pt-5 pb-5 sm:px-6', expanded && 'min-h-96')}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-issue-title" className="sr-only">{t('titleLabel')}</FieldLabel>
              <Input ref={titleRef} id="new-issue-title" autoComplete="off" maxLength={200} placeholder={t('titleLabel')} value={title} onChange={event => { setTitle(event.target.value); setError('') }} className="w-full border-none bg-transparent py-1 text-lg font-semibold shadow-none outline-none placeholder:text-muted-foreground/70 focus-visible:ring-0 dark:bg-transparent" />
            </Field>
            <Field>
              <FieldLabel className="sr-only">{t('descriptionLabel')}</FieldLabel>
              <div inert={pending}><IssueEditor key={editorKey} compact content={content} author={author} onChange={setContent} /></div>
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap items-center gap-2">
            <IssuePropertyMenu pill label={issueT('statusLabel')} value={status} options={ISSUE_STATUSES} getLabel={statusLabel} icon={CircleDashed} disabled={pending} onChange={setStatus} />
            <IssuePropertyMenu pill label={issueT('priorityLabel')} value={priority} options={ISSUE_PRIORITIES} getLabel={priorityLabel} icon={ChartNoAxesColumnIncreasing} disabled={pending} onChange={setPriority} />
            <Badge variant="outline" className="h-7 gap-1.5 rounded-full px-2.5"><SquareUserRound />{WORKSPACE_NAME}</Badge>
            <Badge variant="outline" className="h-7 gap-1.5 rounded-full px-2.5"><LockKeyhole />{t('private')}</Badge>
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
        </FieldSet>
        <footer className="flex flex-wrap items-center justify-between gap-3 px-5 pt-1 pb-4 sm:px-6">
          <span className="text-xs text-muted-foreground">{t('shortcutCreate')}</span>
          <div className="flex items-center gap-3">
            <FieldGroup className="contents"><Field orientation="horizontal"><Switch id="create-more" size="sm" checked={createMore} onCheckedChange={setCreateMore} disabled={pending} /><FieldLabel htmlFor="create-more">{t('createMore')}</FieldLabel></Field></FieldGroup>
            <Button type="submit" size="sm" disabled={pending || !title.trim()}>{pending && <Spinner data-icon="inline-start" />}{pending ? t('creating') : t('submit')}</Button>
          </div>
        </footer>
      </form>
    </DialogContent>
  </Dialog>
}
