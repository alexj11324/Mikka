'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Ellipsis, EyeIcon, EyeOffIcon, FileUp, Plus } from 'lucide-react'
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
import { SettingsLoading, SettingsSaveError, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import { SECRET_NOTE_MAX } from '@/lib/secrets/format'
import type { UserSecretView } from '@/lib/secrets/user-store'
import { relativeTime } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'
import { usePresence, type PresenceProps } from '@/lib/use-presence'
import { useDotenvFile, useDotenvPreview, useMySecretEditor, useMySecretImport, useMySecrets } from '@/hooks/settings/use-secrets'
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
  const common = useTranslations('Common')
  const locale = useLocale()
  const list = useMySecrets(workspaceId)
  const [editing, setEditing] = useState<Editing | null>(null)
  const sheet = usePresence(editing)
  const [notice, setNotice] = useState<string | null>(null)
  const secrets = list.secrets
  const open = (next: Editing) => { setNotice(null); setEditing(next) }
  const close = (saved: Saved) => { setEditing(null); if (saved) { setNotice(saved.notice); list.reload() } }

  return <>
    <SettingsSection id="my-secrets-heading" title={t('mineHeading')} action={secrets?.length ? <>
      <Button {...settingsSectionAction} onClick={() => open({ kind: 'bulk' })}>{t('bulkAdd')}</Button>
      <Button {...settingsSectionAction} onClick={() => open({ kind: 'new' })}>{t('add')}</Button>
    </> : undefined}>
      {list.loading && <SettingsLoading label={t('loading')} rows={2} bare />}
      {list.error && <SettingsSaveError message={list.error} retryLabel={common('retry')} onRetry={list.reload} />}
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
  const [name, setName] = useState(secret?.name ?? '')
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [note, setNote] = useState(secret?.note ?? '')
  const [masked, setMasked] = useState(secret ? secret.kind === 'secret' : true)
  const editor = useMySecretEditor(workspaceId, secret, secretName => t('shortValueNotMasked', { name: secretName }))
  const { pending, error, setError } = editor
  const [deleting, setDeleting] = useState(false)
  // Deleting asks first; a name the workspace already has asks too (the editor says so).
  const confirm = deleting ? 'delete' : editor.shadow ? 'shadow' : null
  const closeConfirm = () => { setDeleting(false); editor.cancelShadow() }
  const changed = secret === null || Boolean(value) || note.trim() !== secret.note
  const ready = changed && (secret !== null || (Boolean(name.trim()) && Boolean(value)))

  async function save(overrideWorkspace = false) {
    closeConfirm()
    const saved = await editor.save({ name, value, note, masked }, overrideWorkspace)
    if (saved) onClose(saved)
  }

  async function remove() {
    closeConfirm()
    if (await editor.remove()) onClose({ notice: null })
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
          {secret && <Button type="button" variant="destructive" className="mr-auto" disabled={pending !== null} onClick={() => setDeleting(true)}>{pending === 'delete' ? t('deleting') : commonT('delete')}</Button>}
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => onClose(null)}>{commonT('cancel')}</Button>
          <Button type="submit" disabled={pending !== null || !ready}>{pending === 'save' ? <Spinner data-icon="inline-start" /> : null}{pending === 'save' ? commonT('saving') : commonT('save')}</Button>
        </SheetFooter>
      </form>
    </SheetContent>
    <AlertDialog open={confirm !== null} onOpenChange={next => { if (!next) closeConfirm() }}>
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
  const importer = useMySecretImport(workspaceId)
  const { pending, error, setError, shadowed, done } = importer
  const { preview: previewed, count } = useDotenvPreview(text)
  const preview = previewed && 'tooLarge' in previewed ? 'tooLarge' as const : previewed
  const readFile = useDotenvFile(setText)

  const fileInput = useRef<HTMLInputElement>(null)
  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    setError(readFile(file))
  }

  async function save(overrideWorkspace = false) {
    const total = await importer.run({ text, masked, replace }, overrideWorkspace)
    if (!total) return
    setText('')
    onClose({ notice: t('importDone', total) })
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
                {preview.errors.map(problem => <li key={`e${problem.line}`} className="text-xs text-destructive-foreground">{t(`lineError.${problem.reason}`, { line: problem.line, name: 'name' in problem ? problem.name ?? '' : '' })}</li>)}
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
    <AlertDialog open={shadowed !== null} onOpenChange={next => { if (!next) importer.cancelShadow() }}>
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
