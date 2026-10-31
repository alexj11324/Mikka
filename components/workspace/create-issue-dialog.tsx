'use client'
import { useTranslations } from 'next-intl'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSONContent } from '@tiptap/react'
import { ChartNoAxesColumnIncreasing, ChevronRight, CircleDashed, LockKeyhole, Maximize2, Minimize2, SquareUserRound, X } from 'lucide-react'
import { saveIssue } from '@/app/actions/issues'
import useSWR from 'swr'
import { toast } from 'sonner'
import { listTeams } from '@/app/actions/teams'
import { setIssueTeam } from '@/app/actions/team-relations'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { cn } from '@/lib/utils'
import { IssueEditor } from './issue-editor'
import { IssuePropertyMenu } from './issue-property-menu'
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from './issue-properties'

const EMPTY: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

export function CreateIssueDialog({ open, onOpenChange, onCreated, author, initialTeamId = '', initialStatus = 'todo', initialTitle = '' }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
  author: string
  initialStatus?: string
  initialTeamId?: string
  initialTitle?: string
}) {
  const i18nText = useTranslations();
  const { data: teams = [], error: teamsError } = useSWR('teams', listTeams)
  const [teamId, setTeamId] = useState(initialTeamId)
  const [title, setTitle] = useState(initialTitle)
  const seenAhead = useRef(initialTitle)
  const [content, setContent] = useState<JSONContent>(EMPTY)
  const [status, setStatus] = useState(initialStatus)
  const [priority, setPriority] = useState('normal')
  const [createMore, setCreateMore] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editorKey, setEditorKey] = useState(0)
  const titleRef = useRef<HTMLInputElement>(null)
  const focusTitle = useCallback(() => {
    const field = titleRef.current
    if (!field) return null
    const end = field.value.length
    field.setSelectionRange(end, end)
    return field
  }, [])
  const submitting = useRef(false)
  const [defaults, setDefaults] = useState({ status: initialStatus, priority: 'normal' })
  const dirty = !!title.trim() || JSON.stringify(content) !== JSON.stringify(EMPTY) || status !== defaults.status || priority !== defaults.priority || teamId !== initialTeamId
  const [expanded, setExpanded] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)

  useEffect(() => {
    if (!initialTitle.startsWith(seenAhead.current)) return
    const extra = initialTitle.slice(seenAhead.current.length)
    seenAhead.current = initialTitle
    if (extra) setTitle(current => current + extra)
  }, [initialTitle])
  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    const place = () => {
      const field = titleRef.current
      if (!field) return
      field.focus()
      const end = field.value.length
      field.setSelectionRange(end, end)
    }
    place()
    // The dialog focus manager focuses again on the next frame. Place the caret
    // after that so characters typed ahead stay in front of the cursor.
    queueMicrotask(() => { frame = requestAnimationFrame(place) })
    return () => cancelAnimationFrame(frame)
  }, [open, editorKey, initialTitle])
  useEffect(() => { if (notice && !pending) titleRef.current?.focus() }, [notice, pending])
  useEffect(() => {
    if (!open || !dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [open, dirty])

  function close() {
    if (submitting.current) return
    if (dirty) { setDiscardOpen(true); return }
    onOpenChange(false)
  }
  function discard() {
    setDiscardOpen(false)
    onOpenChange(false)
  }

  async function create() {
    const currentTitle = titleRef.current?.value ?? title
    if (submitting.current || !currentTitle.trim()) return
    submitting.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      const result = await saveIssue({ title: currentTitle, content, status, priority })
      if (!('issue' in result) || !result.issue) {
        setError(result.error ?? i18nText("Issue.create.createFailed"))
        return
      }
      if (teamId) {
        try {
          const relation = await setIssueTeam({ issueId: result.issue.id, teamId, expectedTeamId: null })
          if (!relation.ok) toast.warning(i18nText("FeatureCopy.c_20f17d52", { value0: (relation.error) }))
        } catch { toast.warning(i18nText("FeatureCopy.c_6c08be2e")) }
      }
      onCreated(result.issue.id)
      if (createMore) {
        setDefaults({ status, priority })
        setTitle('')
        setContent(EMPTY)
        setEditorKey(value => value + 1)
        setNotice(i18nText("Issue.create.createdNotice"))
        titleRef.current?.focus()
      } else {
        onOpenChange(false)
      }
    } catch {
      setError(i18nText("Issue.create.createError"))
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return <><Dialog open={open} onOpenChange={value => { if (!value) close() }}>
    <DialogContent showCloseButton={false} initialFocus={focusTitle} className={cn('max-h-[calc(100svh-2rem)] gap-0 overflow-y-auto p-0 sm:top-[20svh] sm:max-h-[76svh] sm:max-w-3xl sm:translate-y-0', expanded && 'sm:max-w-5xl')}>
      <form onSubmit={event => { event.preventDefault(); void create() }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void create() }
        else if (event.key === 'Enter' && event.target === titleRef.current) event.preventDefault()
      }}>
        <header className="flex items-center justify-between gap-3 px-5 pt-4 sm:px-6">
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="outline" className="gap-1.5 rounded-full"><SquareUserRound />ORV</Badge><ChevronRight className="size-3 text-muted-foreground" />
            <DialogTitle className="sr-only">{i18nText("Projects.detail.newIssue")}</DialogTitle><span aria-hidden="true">{i18nText("Projects.detail.newIssue")}</span>
          </div>
          <div className="flex items-center gap-1"><Button type="button" variant="ghost" size="icon-sm" aria-label={expanded ? i18nText("Issue.create.collapse") : i18nText("Issue.create.expand")} aria-pressed={expanded} disabled={pending} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 data-icon="inline-start" /> : <Maximize2 data-icon="inline-start" />}</Button><Button type="button" variant="ghost" size="icon-sm" aria-label={i18nText("Issue.create.close")} disabled={pending} onClick={close}><X data-icon="inline-start" /></Button></div>
        </header>
        <DialogDescription className="sr-only">{i18nText("Issue.create.description")}</DialogDescription>
        <FieldSet disabled={pending} className={cn('flex min-w-0 flex-col gap-5 px-5 pt-5 pb-5 sm:px-6', expanded && 'min-h-96')}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-issue-title" className="sr-only">{i18nText("IssueDetail.dialog.taskTitleLabel")}</FieldLabel>
              <Input ref={titleRef} id="new-issue-title" autoFocus autoComplete="off" maxLength={200} placeholder={i18nText("IssueDetail.dialog.taskTitleLabel")} value={title} onChange={event => { setTitle(event.target.value); setError('') }} className="w-full border-none bg-transparent px-0 py-1 text-lg font-semibold shadow-none outline-none placeholder:text-muted-foreground/70 focus-visible:ring-0 dark:bg-transparent" />
            </Field>
            <Field>
              <FieldLabel className="sr-only">{i18nText("Editor.descriptionLabel")}</FieldLabel>
              <div inert={pending}><IssueEditor key={editorKey} compact content={content} author={author} onChange={setContent} /></div>
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap items-center gap-2">
            <IssuePropertyMenu pill label={i18nText("Issue.statusLabel")} value={status} options={ISSUE_STATUSES} icon={CircleDashed} disabled={pending} onChange={setStatus} />
            <IssuePropertyMenu pill label={i18nText("Issue.priorityLabel")} value={priority} options={ISSUE_PRIORITIES} icon={ChartNoAxesColumnIncreasing} disabled={pending} onChange={setPriority} />
            <Badge variant="outline" className="h-7 gap-1.5 rounded-full px-2.5"><LockKeyhole />{teamId ? i18nText("FeatureCopy.c_c30fccc5") : i18nText("Issue.create.private")}</Badge>
          </div>
          <FieldGroup><Field><FieldLabel htmlFor="new-issue-team">{i18nText("FeatureCopy.c_53d4919c")}</FieldLabel><NativeSelect id="new-issue-team" value={teamId} disabled={pending || !!teamsError} onChange={event => setTeamId(event.target.value)}><NativeSelectOption value="">{i18nText("FeatureCopy.c_a0860f69")}</NativeSelectOption>{teams.map(team => <NativeSelectOption key={team.id} value={team.id}>{team.identifier} · {team.name}</NativeSelectOption>)}</NativeSelect><p className="text-xs text-muted-foreground">{teamsError ? i18nText("FeatureCopy.c_d7d814ec") : teamId ? i18nText("FeatureCopy.c_f762eaaa") : i18nText("FeatureCopy.c_db09ed1f")}</p></Field></FieldGroup>
          {error && <FieldError className="text-xs">{error}</FieldError>}
          {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
        </FieldSet>
        <footer className="flex flex-wrap items-center justify-between gap-3 px-5 pt-1 pb-4 sm:px-6">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><ShortcutKeys keys={['mod', 'Enter']} />{i18nText("Projects.form.createAction")}</span>
          <div className="flex items-center gap-3">
            <FieldGroup className="contents"><Field orientation="horizontal"><Switch id="create-more" size="sm" checked={createMore} onCheckedChange={setCreateMore} disabled={pending} /><FieldLabel htmlFor="create-more">{i18nText("Issue.create.createMore")}</FieldLabel></Field></FieldGroup>
            <Button type="submit" size="sm" disabled={pending || !title.trim()}>{pending && <Spinner data-icon="inline-start" />}{pending ? i18nText("Invite.creating") : i18nText("Issue.create.submit")}</Button>
          </div>
        </footer>
      </form>
    </DialogContent>
  </Dialog>
  <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{i18nText("Issue.create.discardTitle")}</AlertDialogTitle>
        <AlertDialogDescription>{i18nText("Issue.create.discardDraft")}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{i18nText("Common.cancel")}</AlertDialogCancel>
        <AlertDialogAction onClick={discard}>{i18nText("Issue.create.discardAction")}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog></>
}
