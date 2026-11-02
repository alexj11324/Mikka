'use client'

import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { Ellipsis, EyeIcon, EyeOffIcon, FileUp, Plus } from 'lucide-react'
import { createMySecret, deleteMySecret, importMySecrets, listMySecrets, replaceMySecret } from '@/app/actions/user-secrets'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { SettingsLoading, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import { DOTENV_MAX_BYTES, parseDotenv } from '@/lib/secrets/dotenv'
import { isReservedEnvName, SECRET_NOTE_MAX } from '@/lib/secrets/format'
import type { UserSecretView } from '@/lib/secrets/user-store'
import { relativeTime } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'
import { usePresence, type PresenceProps } from '@/lib/use-presence'
import { cn } from '@/lib/utils'

type Editing = { kind: 'new' } | { kind: 'edit'; secret: UserSecretView } | { kind: 'bulk' }
type Saved = { notice: string | null } | null

/**
 * 密钥与登录 › 我的 › 我的密钥: the person's own secrets. They reach only this person's runs, in
 * every workspace, and win over a workspace secret of the same name (decision 2026-11-02-2120).
 * Write-only like every secret.
 */
export function PersonalSecretsSettings({ workspaceId, workspaceName }: { workspaceId: string; workspaceName?: string }) {
  const t = useTranslations('Settings.secrets')
  const actionError = useActionError()
  const locale = useLocale()
  const list = useSWR(['account:my-secrets', workspaceId], () => listMySecrets(workspaceId))
  const [editing, setEditing] = useState<Editing | null>(null)
  const sheet = usePresence(editing)
  const [notice, setNotice] = useState<string | null>(null)
  const secrets = list.data && !list.data.error ? list.data.secrets : null
  const open = (next: Editing) => { setNotice(null); setEditing(next) }
  const close = (saved: Saved) => { setEditing(null); if (saved) { setNotice(saved.notice); void list.mutate() } }

  return <>
    <SettingsSection id="my-secrets-heading" title={t('mineHeading')} action={secrets?.length ? <>
      <Button {...settingsSectionAction} onClick={() => open({ kind: 'bulk' })}>{t('bulkAdd')}</Button>
      <Button {...settingsSectionAction} onClick={() => open({ kind: 'new' })}>{t('add')}</Button>
    </> : undefined}>
      {!list.data && !list.error && <SettingsLoading label={t('loading')} rows={2} bare />}
      {(list.error || list.data?.error) && <FieldError className="px-5 py-4">{actionError(list.data?.error)}</FieldError>}
      {secrets?.length === 0 && <div className="flex flex-col items-start gap-3 px-5 py-6">
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => open({ kind: 'new' })}><Plus data-icon="inline-start" />{t('add')}</Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => open({ kind: 'bulk' })}>{t('bulkAdd')}</Button>
        </div>
      </div>}
      {secrets && secrets.length > 0 && <Table>
        <TableHeader><TableRow>
          <TableHead className="pl-5">{t('columns.name')}</TableHead>
          <TableHead>{t('columns.type')}</TableHead>
          <TableHead className="hidden md:table-cell">{t('columns.note')}</TableHead>
          <TableHead className="hidden lg:table-cell">{t('columns.updatedAt')}</TableHead>
          <TableHead className="w-12"><span className="sr-only">{t('columns.actions')}</span></TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {secrets.map(secret => <TableRow key={secret.id}>
            <TableCell className="max-w-56 truncate pl-5 font-mono">{secret.name}</TableCell>
            <TableCell><Badge variant="secondary">{t('kinds.secret')}</Badge>{secret.kind === 'env' && <span className="ml-1.5 text-xs text-muted-foreground">{t('notMasked')}</span>}</TableCell>
            <TableCell className="hidden max-w-64 truncate text-muted-foreground md:table-cell">{secret.note}</TableCell>
            <TableCell className="hidden text-muted-foreground lg:table-cell">{relativeTime(secret.updatedAt, locale)}</TableCell>
            <TableCell className="text-right"><DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('actions', { name: secret.name })} />}><Ellipsis data-icon="inline-start" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36"><DropdownMenuGroup>
                <DropdownMenuItem onClick={() => open({ kind: 'edit', secret })}>{t('edit')}</DropdownMenuItem>
              </DropdownMenuGroup></DropdownMenuContent>
            </DropdownMenu></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>}
    </SettingsSection>
    {notice && <p role="status" className="px-1 text-sm text-muted-foreground">{notice}</p>}
    {sheet.value && (sheet.value.kind === 'bulk'
      ? <MyBulkSheet workspaceId={workspaceId} workspaceName={workspaceName} open={sheet.open} onOpenChangeComplete={sheet.onOpenChangeComplete} onClose={close} />
      : <MySecretSheet workspaceId={workspaceId} workspaceName={workspaceName} secret={sheet.value.kind === 'edit' ? sheet.value.secret : null} open={sheet.open} onOpenChangeComplete={sheet.onOpenChangeComplete} onClose={close} />)}
  </>
}

function MySecretSheet({ workspaceId, workspaceName, secret, onClose, open = true, onOpenChangeComplete }: { workspaceId: string; workspaceName?: string; secret: UserSecretView | null; onClose: (saved: Saved) => void } & PresenceProps) {
  const t = useTranslations('Settings.secrets')
  const commonT = useTranslations('Common')
  const card = useTranslations('CredentialLogin')
  const actionError = useActionError()
  const [name, setName] = useState(secret?.name ?? '')
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [note, setNote] = useState(secret?.note ?? '')
  const [masked, setMasked] = useState(secret ? secret.kind === 'secret' : true)
  const [pending, setPending] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'shadow' | 'delete' | null>(null)
  const changed = secret === null || Boolean(value) || note.trim() !== secret.note
  const ready = changed && (secret !== null || (Boolean(name.trim()) && Boolean(value)))

  async function save(overrideWorkspace = false) {
    setConfirm(null)
    setPending('save')
    setError(null)
    try {
      const result = secret
        ? await replaceMySecret({ id: secret.id, ...(value ? { value } : {}), ...(note.trim() !== secret.note ? { note: note.trim() } : {}) }, workspaceId)
        : await createMySecret({ name: name.trim(), kind: masked ? 'secret' : 'env', value, note: note.trim(), overrideWorkspace }, workspaceId)
      // A name the workspace already has: ask once, then the personal value wins in this person's runs.
      if (result.error === 'secretNameShadowsWorkspace') { setConfirm('shadow'); return }
      if (result.error) { setError(actionError(result.error)); return }
      onClose({ notice: result.warning === 'shortValueNotMasked' ? t('shortValueNotMasked', { name: result.name }) : null })
    } catch {
      setError(actionError())
    } finally {
      setPending(null)
    }
  }

  async function remove() {
    if (!secret) return
    setConfirm(null)
    setPending('delete')
    setError(null)
    try {
      const result = await deleteMySecret({ id: secret.id }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return }
      onClose({ notice: null })
    } catch {
      setError(actionError())
    } finally {
      setPending(null)
    }
  }

  return <Sheet open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(null) }}>
    <SheetContent side="right" className="gap-0">
      <form onSubmit={event => { event.preventDefault(); if (ready && !pending) void save() }} autoComplete="off" className="flex h-full flex-col overflow-y-auto">
        <SheetHeader className="pr-12"><SheetTitle className={cn(secret && 'font-mono')}>{secret ? secret.name : t('addMineTitle')}</SheetTitle></SheetHeader>
        <FieldGroup className="px-4">
          {!secret && <Field>
            <FieldLabel htmlFor="my-secret-name">{t('name')}</FieldLabel>
            <Input id="my-secret-name" value={name} className="font-mono" maxLength={128} autoComplete="off" spellCheck={false} placeholder="OPENROUTER_API_KEY" disabled={pending !== null} onChange={event => setName(event.target.value)} />
          </Field>}
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="my-secret-value">{secret ? t('newValue') : t('value')}</FieldLabel>
            <InputGroup>
              <InputGroupInput id="my-secret-value" type={reveal ? 'text' : 'password'} value={value} autoComplete="new-password" spellCheck={false} aria-invalid={error ? true : undefined} disabled={pending !== null} onChange={event => { setValue(event.target.value); setError(null) }} />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label={reveal ? card('hidePassword') : card('showPassword')} aria-pressed={reveal} onClick={() => setReveal(on => !on)}>{reveal ? <EyeOffIcon /> : <EyeIcon />}</InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="my-secret-note">{t('note')}</FieldLabel>
            <Textarea id="my-secret-note" value={note} maxLength={SECRET_NOTE_MAX} rows={3} disabled={pending !== null} onChange={event => setNote(event.target.value)} />
          </Field>
          <Field orientation="horizontal" className="justify-between border-t pt-4">
            <FieldLabel htmlFor="my-secret-masked">{t('masked')}</FieldLabel>
            <Switch id="my-secret-masked" checked={masked} disabled={secret !== null || pending !== null} onCheckedChange={setMasked} />
          </Field>
        </FieldGroup>
        <SheetFooter className="flex-row items-center justify-end">
          {secret && <Button type="button" variant="destructive" className="mr-auto" disabled={pending !== null} onClick={() => setConfirm('delete')}>{pending === 'delete' ? t('deleting') : commonT('delete')}</Button>}
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => onClose(null)}>{commonT('cancel')}</Button>
          <Button type="submit" disabled={pending !== null || !ready}>{pending === 'save' ? <Spinner data-icon="inline-start" /> : null}{pending === 'save' ? commonT('saving') : commonT('save')}</Button>
        </SheetFooter>
      </form>
    </SheetContent>
    <AlertDialog open={confirm !== null} onOpenChange={next => { if (!next) setConfirm(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{confirm === 'delete' ? t('removeTitle', { name: secret?.name ?? '' }) : t('shadowConfirm', { workspace: workspaceName ?? t('workspaceGroup'), name: name.trim() })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{commonT('cancel')}</AlertDialogCancel>
          {confirm === 'delete'
            ? <AlertDialogAction variant="destructive" onClick={() => void remove()}>{commonT('delete')}</AlertDialogAction>
            : <AlertDialogAction onClick={() => void save(true)}>{t('useMine')}</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Sheet>
}

function MyBulkSheet({ workspaceId, workspaceName, onClose, open = true, onOpenChangeComplete }: { workspaceId: string; workspaceName?: string; onClose: (saved: Saved) => void } & PresenceProps) {
  const t = useTranslations('Settings.secrets')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const [text, setText] = useState('')
  const [masked, setMasked] = useState(true)
  const [replace, setReplace] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shadowed, setShadowed] = useState<string[] | null>(null)
  const [done, setDone] = useState({ created: 0, replaced: 0, kept: 0 })
  const preview = useMemo(() => {
    if (!text.trim()) return null
    try {
      const parsed = parseDotenv(text)
      const reserved = parsed.entries.filter(entry => isReservedEnvName(entry.name)).map(entry => ({ line: entry.line, name: entry.name, reason: 'reserved' as const }))
      return { entries: parsed.entries.filter(entry => !isReservedEnvName(entry.name)), errors: [...parsed.errors, ...reserved].sort((a, b) => a.line - b.line) }
    } catch { return 'tooLarge' as const }
  }, [text])
  const count = preview && preview !== 'tooLarge' ? preview.entries.length : 0

  const fileInput = useRef<HTMLInputElement>(null)
  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > DOTENV_MAX_BYTES) { setError(actionError('secretImportTooLarge')); return }
    setError(null)
    void file.text().then(setText)
  }

  async function save(overrideWorkspace = false) {
    setShadowed(null)
    setPending(true)
    setError(null)
    try {
      // The confirmed second pass only adds the shadowed names: everything else was written by the first.
      const result = await importMySecrets({ text, masked, onConflict: overrideWorkspace || !replace ? 'skip' : 'replace', overrideWorkspace }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return }
      const total = overrideWorkspace
        ? { created: done.created + result.created.length, replaced: done.replaced, kept: done.kept }
        : { created: result.created.length, replaced: result.replaced.length, kept: result.kept.length + result.errors.filter(problem => problem.reason !== 'shadowsWorkspace').length }
      const shadows = result.errors.filter(problem => problem.reason === 'shadowsWorkspace').map(problem => problem.name ?? '')
      // Names the workspace already has: ask once, then add them with the personal value.
      if (shadows.length) { setDone(total); setShadowed(shadows); return }
      setText('')
      onClose({ notice: t('importDone', total) })
    } catch {
      setError(actionError())
    } finally {
      setPending(false)
    }
  }

  return <Sheet open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(done.created || done.replaced ? { notice: t('importDone', done) } : null) }}>
    <SheetContent side="right" className="gap-0">
      <form onSubmit={event => { event.preventDefault(); if (count > 0 && !pending) void save() }} autoComplete="off" className="flex h-full flex-col overflow-y-auto">
        <SheetHeader className="pr-12"><SheetTitle>{t('bulkTitle')}</SheetTitle></SheetHeader>
        <FieldGroup className="px-4">
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="my-secret-dotenv">{t('paste')}</FieldLabel>
            {/* The pasted text holds values: it is never echoed back, only its names below. */}
            <Textarea id="my-secret-dotenv" value={text} rows={8} spellCheck={false} autoComplete="off" className="font-mono text-xs [-webkit-text-security:disc]" placeholder="KEY=value # note" aria-invalid={error ? true : undefined} disabled={pending} onChange={event => { setText(event.target.value); setError(null) }} />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <Field>
            <Input ref={fileInput} type="file" accept=".env,text/plain" className="hidden" tabIndex={-1} aria-hidden="true" disabled={pending} onChange={pick} />
            <div><Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => fileInput.current?.click()}><FileUp data-icon="inline-start" />{t('pickFile')}</Button></div>
            <FieldDescription>{t('pickFileLimit')}</FieldDescription>
          </Field>
          {preview && (preview === 'tooLarge'
            ? <FieldError>{actionError('secretImportTooLarge')}</FieldError>
            : <div role="status" className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('willAdd', { count })}</span>
              <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
                {preview.entries.map(entry => <li key={entry.line} className="truncate font-mono text-xs">{entry.name}</li>)}
                {preview.errors.map(problem => <li key={`e${problem.line}`} className="text-xs text-destructive">{t(`lineError.${problem.reason}`, { line: problem.line, name: 'name' in problem ? problem.name ?? '' : '' })}</li>)}
              </ul>
            </div>)}
          <Field orientation="horizontal" className="justify-between border-t pt-4">
            <FieldLabel htmlFor="my-secret-bulk-masked">{t('masked')}</FieldLabel>
            <Switch id="my-secret-bulk-masked" checked={masked} disabled={pending} onCheckedChange={setMasked} />
          </Field>
          <Field orientation="horizontal" className="justify-between">
            <FieldLabel htmlFor="my-secret-bulk-replace">{t('replaceExisting')}</FieldLabel>
            <Switch id="my-secret-bulk-replace" checked={replace} disabled={pending} onCheckedChange={setReplace} />
          </Field>
        </FieldGroup>
        <SheetFooter className="flex-row items-center justify-end">
          <Button type="button" variant="outline" disabled={pending} onClick={() => onClose(done.created || done.replaced ? { notice: t('importDone', done) } : null)}>{commonT('cancel')}</Button>
          <Button type="submit" disabled={pending || count === 0}>{pending ? <Spinner data-icon="inline-start" /> : null}{t('addCount', { count })}</Button>
        </SheetFooter>
      </form>
    </SheetContent>
    <AlertDialog open={shadowed !== null} onOpenChange={next => { if (!next) setShadowed(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('shadowConfirmMany', { workspace: workspaceName ?? t('workspaceGroup'), names: (shadowed ?? []).join('、') })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{commonT('cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void save(true)}>{t('useMine')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Sheet>
}
