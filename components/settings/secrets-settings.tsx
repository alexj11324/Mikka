'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Cloud, Ellipsis, EyeIcon, EyeOffIcon, FileUp, Plus } from 'lucide-react'
import { E2BKeyDialog, useE2BKeyStatus } from '@/components/settings/e2b-key-dialog'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import { SECRET_NOTE_MAX } from '@/lib/secrets/format'
import { secretActionAllowed, type WorkspaceRole } from '@/lib/secrets/permissions'
import type { WorkspaceSecretView } from '@/lib/secrets/store'
import { relativeTime } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'
import { usePresence, type PresenceProps } from '@/lib/use-presence'
import { SECRET_REPOSITORY as REPOSITORY, useDotenvFile, useDotenvPreview, useWorkspaceSecretEditor, useWorkspaceSecretImport, useWorkspaceSecrets, writableScopes, type SecretScope as Scope } from '@/hooks/settings/use-secrets'

type Filter = 'all' | 'workspace' | 'repository'
type Editing = { kind: 'new' } | { kind: 'edit'; secret: WorkspaceSecretView } | { kind: 'bulk' }
type Saved = { notice: string | null } | null

/**
 * 密钥与登录 › 工作区 (was 密钥与环境): workspace and repository secrets. Members see every row's
 * name, type, scope, note and who changed it; they write repository entries only. Values are
 * write-only (decision 2026-11-02-2120 item 7).
 */
export function SecretsSettings({ workspaceId, workspaceName }: { workspaceId: string; workspaceName?: string }) {
  const t = useTranslations('Settings.secrets')
  const common = useTranslations('Common')
  const locale = useLocale()
  const list = useWorkspaceSecrets(workspaceId)
  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState<Editing | null>(null)
  const sheet = usePresence(editing)
  const [notice, setNotice] = useState<string | null>(null)
  const { secrets, role } = list
  const shown = (secrets ?? []).filter(secret => filter === 'all' || secret.scopeType === filter)
  const open = (next: Editing) => { setNotice(null); setEditing(next) }

  return <>
    <SettingsSection id="secrets-heading" title={t('heading')} action={role && secrets?.length ? <>
      <Button {...settingsSectionAction} onClick={() => open({ kind: 'bulk' })}>{t('bulkAdd')}</Button>
      <Button {...settingsSectionAction} onClick={() => open({ kind: 'new' })}>{t('add')}</Button>
    </> : undefined}>
      {list.loading && <SettingsLoading label={t('loading')} rows={2} bare />}
      {list.error && <SettingsSaveError message={list.error} retryLabel={common('retry')} onRetry={list.reload} />}
      {/* Empty: the state as a title and Add as the one primary move; Bulk add stays beside it (UI audit settings2-05). */}
      {secrets?.length === 0 && role && <div className="flex flex-col items-start gap-3 px-5 py-6">
        <p className="text-sm font-medium">{t('empty')}</p>
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={() => open({ kind: 'new' })}><Plus data-icon="inline-start" />{t('add')}</Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => open({ kind: 'bulk' })}>{t('bulkAdd')}</Button>
        </div>
      </div>}
      {secrets && secrets.length > 0 && <div className="flex flex-col">
        <div className="px-5 pt-3">
          <ToggleGroup aria-label={t('filterLabel')} variant="segment" size="sm" spacing={0.5} value={[filter]} onValueChange={values => { const next = values[0] as Filter | undefined; if (next) setFilter(next) }}>
            {(['all', 'workspace', 'repository'] as const).map(value => <ToggleGroupItem key={value} value={value}>{t(`filters.${value}`)}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        <Table>
            <TableHeader><TableRow>
              <TableHead className="pl-5">{t('columns.name')}</TableHead>
              <TableHead>{t('columns.type')}</TableHead>
              <TableHead>{t('columns.scope')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('columns.note')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('columns.updatedBy')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('columns.updatedAt')}</TableHead>
              <TableHead className="w-12"><span className="sr-only">{t('columns.actions')}</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {shown.map(secret => {
                const editable = role !== null && secretActionAllowed(role, 'secret.replace', [secret])
                return <TableRow key={secret.id}>
                  <TableCell className="max-w-56 truncate pl-5 font-mono">{secret.name}</TableCell>
                  <TableCell><Badge variant="secondary">{t('kinds.secret')}</Badge>{secret.kind === 'env' && <span className="ml-1.5 text-xs text-muted-foreground">{t('notMasked')}</span>}</TableCell>
                  <TableCell className={cn('max-w-48 truncate', secret.scopeType === 'repository' && 'font-mono text-xs')}>{secret.scopeType === 'workspace' ? t('workspaceGroup') : secret.scopeRef}</TableCell>
                  <TableCell className="hidden max-w-56 truncate text-muted-foreground md:table-cell">{secret.note}</TableCell>
                  <TableCell className="hidden max-w-32 truncate lg:table-cell">{secret.updatedBy}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{relativeTime(secret.updatedAt, locale)}</TableCell>
                  <TableCell className="text-right">{editable && <DropdownMenu>
                    <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('actions', { name: secret.name })} />}><Ellipsis data-icon="inline-start" /></DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36"><DropdownMenuGroup>
                      <DropdownMenuItem onClick={() => open({ kind: 'edit', secret })}>{t('edit')}</DropdownMenuItem>
                    </DropdownMenuGroup></DropdownMenuContent>
                  </DropdownMenu>}</TableCell>
                </TableRow>
              })}
            </TableBody>
        </Table>
      </div>}
    </SettingsSection>
    {notice && <p role="status" className="px-1 text-sm text-muted-foreground">{notice}</p>}
    {sheet.value && role && (sheet.value.kind === 'bulk'
      ? <BulkSheet role={role} workspaceId={workspaceId} workspaceName={workspaceName} open={sheet.open} onOpenChangeComplete={sheet.onOpenChangeComplete} onClose={saved => { setEditing(null); if (saved) { setNotice(saved.notice); list.reload() } }} />
      : <SecretSheet role={role} workspaceId={workspaceId} workspaceName={workspaceName} secret={sheet.value.kind === 'edit' ? sheet.value.secret : null} open={sheet.open} onOpenChangeComplete={sheet.onOpenChangeComplete} onClose={saved => { setEditing(null); if (saved) { setNotice(saved.notice); list.reload() } }} />)}
  </>
}

/** BYO E2B: the person's own E2B API key for cloud computers (keys are personal; shown under 账号 › 模型与订阅). Write-only; the row shows its state only. */
export function E2BKeySettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.secrets.e2b')
  const actionError = useActionError()
  const status = useE2BKeyStatus(workspaceId)
  const [open, setOpen] = useState(false)
  const keyDialog = usePresence(open)
  const data = status.data && !status.data.error ? status.data : null
  const state = !data ? null : !data.configured ? 'missing' : data.lastErrorCode ? `errors.${data.lastErrorCode}` : 'configured'

  return <>
    <SettingsSection id="e2b-heading" title={t('heading')}>
      {!status.data && !status.error && <SettingsLoading label={t('loading')} rows={1} />}
      {(status.error || status.data?.error) && <FieldError className="px-5 py-4">{actionError(status.data?.error)}</FieldError>}
      {data && state && <SettingRow title="E2B API Key" icon={<Cloud aria-hidden="true" className="size-4 text-muted-foreground" />}>
        <div className="flex items-center gap-3">
          <span role="status" className={cn(data.lastErrorCode ? 'text-destructive-foreground' : 'text-muted-foreground')}>{t(state as 'missing')}</span>
          {data.canEdit && <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>{data.configured ? t('replace') : t('set')}</Button>}
        </div>
      </SettingRow>}
    </SettingsSection>
    {keyDialog.value && data && <E2BKeyDialog workspaceId={workspaceId} open={keyDialog.open} onOpenChangeComplete={keyDialog.onOpenChangeComplete} configured={data.configured} onClose={changed => { setOpen(false); if (changed) void status.mutate() }} />}
  </>
}

function ScopeField({ role, scope, onScope, repository, onRepository, disabled, workspaceName }: { role: WorkspaceRole; scope: Scope; onScope: (scope: Scope) => void; repository: string; onRepository: (value: string) => void; disabled: boolean; workspaceName?: string }) {
  const t = useTranslations('Settings.secrets')
  const scopes = writableScopes(role)
  return <FieldGroup>
    {scopes.length > 1 && <Field>
      <FieldLabel id="secret-scope-label">{t('scope')}</FieldLabel>
      <ToggleGroup aria-labelledby="secret-scope-label" variant="segment" size="sm" spacing={0.5} value={[scope]} disabled={disabled} onValueChange={values => { const next = values[0] as Scope | undefined; if (next) onScope(next) }}>
        {scopes.map(value => <ToggleGroupItem key={value} value={value}>{value === 'workspace' ? workspaceName ?? t('workspaceGroup') : t('repository')}</ToggleGroupItem>)}
      </ToggleGroup>
    </Field>}
    {scope === 'repository' && <Field>
      <FieldLabel htmlFor="secret-repository">{t('repository')}</FieldLabel>
      <Input id="secret-repository" value={repository} placeholder="owner/repo" autoComplete="off" spellCheck={false} className="font-mono" disabled={disabled} onChange={event => onRepository(event.target.value)} />
    </Field>}
  </FieldGroup>
}


/** Add one secret, or edit one: a new value, note or scope. Name and masking are fixed once saved. */
function SecretSheet({ workspaceId, workspaceName, role, secret, onClose, open = true, onOpenChangeComplete }: { workspaceId: string; workspaceName?: string; role: WorkspaceRole; secret: WorkspaceSecretView | null; onClose: (saved: Saved) => void } & PresenceProps) {
  const t = useTranslations('Settings.secrets')
  const commonT = useTranslations('Common')
  const card = useTranslations('CredentialLogin')
  const [name, setName] = useState(secret?.name ?? '')
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [note, setNote] = useState(secret?.note ?? '')
  const [masked, setMasked] = useState(secret ? secret.kind === 'secret' : true)
  const [scope, setScope] = useState<Scope>(secret?.scopeType ?? writableScopes(role)[0])
  const [repository, setRepository] = useState(secret?.scopeRef ?? '')
  const editor = useWorkspaceSecretEditor(workspaceId, secret, secretName => t('shortValueNotMasked', { name: secretName }))
  const { pending, error, setError } = editor
  const [confirm, setConfirm] = useState<'workspace' | 'delete' | null>(null)
  const moved = secret !== null && (scope !== secret.scopeType || (scope === 'repository' && repository.trim().toLowerCase() !== secret.scopeRef))
  const changed = secret === null || Boolean(value) || note.trim() !== secret.note || moved
  // Moving re-seals the value under the new scope, so a move needs the value again.
  const ready = changed && (secret !== null || (Boolean(name.trim()) && Boolean(value))) && (!moved || Boolean(value)) && (scope === 'workspace' || REPOSITORY.test(repository.trim()))

  async function save() {
    setConfirm(null)
    const saved = await editor.save({ name, value, note, masked, scope, repository, moved })
    if (saved) onClose(saved)
  }

  async function remove() {
    setConfirm(null)
    if (await editor.remove()) onClose({ notice: null })
  }

  // Everyone in the workspace can use a workspace secret: say so once before saving one (Devin's safer default).
  const submit = () => { if (!ready || pending) return; if (scope === 'workspace' && (!secret || moved)) setConfirm('workspace'); else void save() }

  return <Sheet open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(null) }}>
    <SheetContent side="right" className="gap-0">
      <form onSubmit={event => { event.preventDefault(); submit() }} autoComplete="off" className="flex h-full flex-col overflow-y-auto">
        <SheetHeader className="pr-12"><SheetTitle className={cn(secret && 'font-mono')}>{secret ? secret.name : t('addTitle')}</SheetTitle></SheetHeader>
        <FieldGroup className="px-4">
          <ScopeField role={role} scope={scope} onScope={setScope} repository={repository} onRepository={setRepository} disabled={pending !== null} workspaceName={workspaceName} />
          {!secret && <Field>
            <FieldLabel htmlFor="secret-name">{t('name')}</FieldLabel>
            <Input id="secret-name" value={name} className="font-mono" maxLength={128} autoComplete="off" spellCheck={false} placeholder="VERCEL_TOKEN" disabled={pending !== null} onChange={event => setName(event.target.value)} />
          </Field>}
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="secret-value">{secret ? t('newValue') : t('value')}</FieldLabel>
            <InputGroup>
              <InputGroupInput id="secret-value" type={reveal ? 'text' : 'password'} value={value} autoComplete="new-password" spellCheck={false} aria-invalid={error ? true : undefined} disabled={pending !== null} onChange={event => { setValue(event.target.value); setError(null) }} />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label={reveal ? card('hidePassword') : card('showPassword')} aria-pressed={reveal} onClick={() => setReveal(on => !on)}>{reveal ? <EyeOffIcon /> : <EyeIcon />}</InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="secret-note">{t('note')}</FieldLabel>
            <Textarea id="secret-note" value={note} maxLength={SECRET_NOTE_MAX} rows={3} disabled={pending !== null} onChange={event => setNote(event.target.value)} />
          </Field>
          <Field orientation="horizontal" className="justify-between border-t pt-4">
            <FieldLabel htmlFor="secret-masked">{t('masked')}</FieldLabel>
            <Switch id="secret-masked" checked={masked} disabled={secret !== null || pending !== null} onCheckedChange={setMasked} />
          </Field>
        </FieldGroup>
        <SheetFooter className="flex-row items-center">
          {secret && secretActionAllowed(role, 'secret.delete') && <Button type="button" variant="destructive" className="mr-auto" disabled={pending !== null} onClick={() => setConfirm('delete')}>{pending === 'delete' ? t('deleting') : commonT('delete')}</Button>}
          <Button type="button" variant="outline" className={cn(!secret && 'ml-auto')} disabled={pending !== null} onClick={() => onClose(null)}>{commonT('cancel')}</Button>
          <Button type="submit" disabled={pending !== null || !ready}>{pending === 'save' ? <Spinner data-icon="inline-start" /> : null}{pending === 'save' ? commonT('saving') : commonT('save')}</Button>
        </SheetFooter>
      </form>
    </SheetContent>
    <AlertDialog open={confirm !== null} onOpenChange={next => { if (!next) setConfirm(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{confirm === 'delete' ? t('removeTitle', { name: secret?.name ?? '' }) : t('confirmWorkspace', { workspace: workspaceName ?? t('workspaceGroup'), name: secret?.name ?? name.trim() })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{commonT('cancel')}</AlertDialogCancel>
          {confirm === 'delete'
            ? <AlertDialogAction variant="destructive" onClick={() => void remove()}>{commonT('delete')}</AlertDialogAction>
            : <AlertDialogAction onClick={() => void save()}>{commonT('save')}</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Sheet>
}


/** Bulk add: paste a .env or pick one (≤ 2 MB); each line previewed by name, values shown as dots only. */
function BulkSheet({ workspaceId, workspaceName, role, onClose, open = true, onOpenChangeComplete }: { workspaceId: string; workspaceName?: string; role: WorkspaceRole; onClose: (saved: Saved) => void } & PresenceProps) {
  const t = useTranslations('Settings.secrets')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const [text, setText] = useState('')
  const [masked, setMasked] = useState(true)
  const [replace, setReplace] = useState(true)
  const [scope, setScope] = useState<Scope>(writableScopes(role)[0])
  const [repository, setRepository] = useState('')
  const importer = useWorkspaceSecretImport(workspaceId)
  const { pending, error, setError } = importer
  const [confirm, setConfirm] = useState(false)
  const { preview, count } = useDotenvPreview(text)
  const ready = count > 0 && (scope === 'workspace' || REPOSITORY.test(repository.trim()))
  const readFile = useDotenvFile(setText)

  const fileInput = useRef<HTMLInputElement>(null)
  function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    setError(readFile(file))
  }

  async function save() {
    setConfirm(false)
    const total = await importer.run({ text, masked, replace, scope, repository })
    if (!total) return
    setText('')
    onClose({ notice: t('importDone', total) })
  }

  return <Sheet open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(null) }}>
    <SheetContent side="right" className="gap-0">
      <form onSubmit={event => { event.preventDefault(); if (ready && !pending) { if (scope === 'workspace') setConfirm(true); else void save() } }} autoComplete="off" className="flex h-full flex-col overflow-y-auto">
        <SheetHeader className="pr-12"><SheetTitle>{t('bulkTitle')}</SheetTitle></SheetHeader>
        <FieldGroup className="px-4">
          <ScopeField role={role} scope={scope} onScope={setScope} repository={repository} onRepository={setRepository} disabled={pending} workspaceName={workspaceName} />
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="secret-dotenv">{t('paste')}</FieldLabel>
            {/* The pasted text holds values: it is never echoed back, only its names below. */}
            <Textarea id="secret-dotenv" value={text} rows={8} spellCheck={false} autoComplete="off" className="font-mono text-xs [-webkit-text-security:disc]" placeholder="KEY=value # note" aria-invalid={error ? true : undefined} disabled={pending} onChange={event => { setText(event.target.value); setError(null) }} />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <Field>
            {/* The browser's own file button is in the browser's language; this one follows the page. */}
            <Input ref={fileInput} type="file" accept=".env,text/plain" className="hidden" tabIndex={-1} aria-hidden="true" disabled={pending} onChange={pick} />
            <div><Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => fileInput.current?.click()}><FileUp data-icon="inline-start" />{t('pickFile')}</Button></div>
            <FieldDescription>{t('pickFileLimit')}</FieldDescription>
          </Field>
          {preview && ('tooLarge' in preview
            ? <FieldError>{actionError('secretImportTooLarge')}</FieldError>
            : <div role="status" className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('willAdd', { count })}</span>
              <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
                {preview.entries.map(entry => <li key={entry.line} className="truncate font-mono text-xs">{entry.name}</li>)}
                {preview.errors.map(problem => <li key={`e${problem.line}`} className="text-xs text-destructive-foreground">{t(`lineError.${problem.reason}`, { line: problem.line, name: 'name' in problem ? problem.name ?? '' : '' })}</li>)}
              </ul>
            </div>)}
          <Field orientation="horizontal" className="justify-between border-t pt-4">
            <FieldLabel htmlFor="secret-bulk-masked">{t('masked')}</FieldLabel>
            <Switch id="secret-bulk-masked" checked={masked} disabled={pending} onCheckedChange={setMasked} />
          </Field>
          <Field orientation="horizontal" className="justify-between">
            <FieldLabel htmlFor="secret-bulk-replace">{t('replaceExisting')}</FieldLabel>
            <Switch id="secret-bulk-replace" checked={replace} disabled={pending} onCheckedChange={setReplace} />
          </Field>
        </FieldGroup>
        <SheetFooter className="flex-row items-center justify-end">
          <Button type="button" variant="outline" disabled={pending} onClick={() => onClose(null)}>{commonT('cancel')}</Button>
          <Button type="submit" disabled={pending || !ready}>{pending ? <Spinner data-icon="inline-start" /> : null}{t('addCount', { count })}</Button>
        </SheetFooter>
      </form>
    </SheetContent>
    <AlertDialog open={confirm} onOpenChange={next => { if (!next) setConfirm(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('confirmWorkspaceMany', { workspace: workspaceName ?? t('workspaceGroup'), count })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{commonT('cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={() => void save()}>{t('addCount', { count })}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Sheet>
}
