'use client'

import { useRef, useState, type FormEvent } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { Ellipsis, EyeIcon, EyeOffIcon, LockIcon, Plus } from 'lucide-react'
import { deleteSavedLogin, listSavedLoginUsage, replaceSavedLoginPassword, saveSavedLogin, type listSavedLogins } from '@/app/actions/settings-activity'
import { settingsRead } from '@/lib/settings-read'
import type { SavedLogin, SavedLoginUse } from '@/lib/settings/saved-logins'
import { MikkaMarkSmall } from '@/components/brand/mikka-mark'
import { SiteIcon } from '@/components/credentials/site-icon'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { SettingRow, SettingsLoading, SettingsSection, settingsSectionAction } from '@/components/settings/primitives'
import { relativeTime } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'
import { usePresence } from '@/lib/use-presence'

type Editing = { kind: 'new' } | { kind: 'password'; login: SavedLogin }

/**
 * 密钥与登录 › 网站登录: the site logins the broker may fill. Added, re-passworded and
 * deleted here; a Bot can also save one from chat. Passwords never come back.
 */
export function SavedLoginsSettings() {
  const t = useTranslations('Settings.logins')
  const actionError = useActionError()
  const locale = useLocale()
  const { data, error, isLoading, mutate } = useSWR('account:saved-logins', () => settingsRead<Awaited<ReturnType<typeof listSavedLogins>>>('saved-logins'))
  const [editing, setEditing] = useState<Editing | null>(null)
  const sheet = usePresence(editing)
  const [removing, setRemoving] = useState<SavedLogin | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [usageOf, setUsageOf] = useState<SavedLogin | null>(null)

  const logins = data && !('error' in data) ? data.logins : []
  const add = () => setEditing({ kind: 'new' })

  async function remove(login: SavedLogin) {
    setDeleteError(null)
    try {
      const result = await deleteSavedLogin(login.id)
      if (result.error) { setDeleteError(actionError(result.error)); return }
      void mutate()
    } catch {
      setDeleteError(actionError())
    }
  }

  return <>
    <SettingsSection id="saved-logins-heading" title={t('heading')} action={logins.length > 0 ? <Button {...settingsSectionAction} onClick={add}>{t('add')}</Button> : undefined}>
      {isLoading && <SettingsLoading label={t('loading')} rows={3} bare />}
      {error && <FieldError className="px-5 py-3">{t('loadError')}</FieldError>}
      {!isLoading && !error && logins.length === 0 && <div className="flex flex-col items-start gap-3 px-5 py-6">
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
        <Button type="button" variant="secondary" size="sm" onClick={add}><Plus data-icon="inline-start" />{t('add')}</Button>
      </div>}
      {logins.length > 0 && <div role="list" className="divide-y divide-border">
        {logins.map(login => <div role="listitem" key={login.id}>
          <SettingRow icon={<SiteIcon origin={login.site} className="size-5" />} title={withoutScheme(login.site)} description={[login.account, login.lastUsedAt ? t('lastUsedBy', { when: relativeTime(login.lastUsedAt, locale), bot: login.lastUsedBy ?? t('unknownBot') }) : t('never')].join(' · ')}>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('actions', { site: withoutScheme(login.site) })} />}><Ellipsis data-icon="inline-start" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => setEditing({ kind: 'password', login })}>{t('changePassword')}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setUsageOf(login)}>{t('usage')}</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => { setDeleteError(null); setRemoving(login) }}>{t('delete')}</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingRow>
        </div>)}
      </div>}
      {deleteError && <FieldError className="px-5 py-3">{deleteError}</FieldError>}
    </SettingsSection>

    {sheet.value && <LoginSheet editing={sheet.value} open={sheet.open} onOpenChangeComplete={sheet.onOpenChangeComplete} onClose={saved => { setEditing(null); if (saved) void mutate() }} />}

    {/* Deleting cannot be undone: ask first, as 密钥与环境 does. */}
    <AlertDialog open={Boolean(removing)} onOpenChange={open => { if (!open) setRemoving(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('deleteTitle', { site: removing ? withoutScheme(removing.site) : '' })}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => { const login = removing; setRemoving(null); if (login) void remove(login) }}>{t('delete')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <Dialog open={Boolean(usageOf)} onOpenChange={open => { if (!open) setUsageOf(null) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('usageTitle', { site: usageOf ? withoutScheme(usageOf.site) : '' })}</DialogTitle>
        </DialogHeader>
        {usageOf && <UsageList id={usageOf.id} />}
      </DialogContent>
    </Dialog>
  </>
}

/** Add a login, or a new password for one. Site and account of a saved login are fixed. */
function LoginSheet({ editing, open, onOpenChangeComplete, onClose }: { editing: Editing; open: boolean; onOpenChangeComplete: (open: boolean) => void; onClose: (saved: boolean) => void }) {
  const t = useTranslations('Settings.logins')
  const card = useTranslations('CredentialLogin')
  const actionError = useActionError()
  const login = editing.kind === 'password' ? editing.login : null
  const [site, setSite] = useState(login?.site ?? '')
  const [account, setAccount] = useState(login?.account ?? '')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A new password starts on its own field; a new login starts on the site.
  const passwordField = useRef<HTMLInputElement>(null)
  const ready = Boolean(password) && (login !== null || (Boolean(site.trim()) && Boolean(account.trim())))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!ready || pending) return
    setPending(true)
    setError(null)
    try {
      const result = login ? await replaceSavedLoginPassword(login.id, password) : await saveSavedLogin({ site: site.trim(), account: account.trim(), password })
      if (result.error) { setError(actionError(result.error)); return }
      setPassword('')
      onClose(true)
    } catch {
      setError(actionError())
    } finally {
      setPending(false)
    }
  }

  return <Sheet open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(false) }}>
    <SheetContent side="right" className="gap-0" initialFocus={login ? passwordField : true}>
      <form onSubmit={submit} autoComplete="off" className="flex h-full flex-col">
        <SheetHeader className="pr-12"><SheetTitle>{login ? withoutScheme(login.site) : t('addTitle')}</SheetTitle></SheetHeader>
        <FieldGroup className="px-4">
          <Field>
            <FieldLabel htmlFor="saved-login-site">{t('site')}</FieldLabel>
            <Input id="saved-login-site" value={site} readOnly={login !== null} className={login ? 'text-muted-foreground' : undefined} autoComplete="off" spellCheck={false} inputMode="url" placeholder="https://" onChange={event => setSite(event.target.value)} disabled={pending} />
          </Field>
          <Field>
            <FieldLabel htmlFor="saved-login-account">{t('account')}</FieldLabel>
            <Input id="saved-login-account" value={account} readOnly={login !== null} className={login ? 'text-muted-foreground' : undefined} autoComplete="off" spellCheck={false} onChange={event => setAccount(event.target.value)} disabled={pending} />
          </Field>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="saved-login-password">{login ? t('newPassword') : t('password')}</FieldLabel>
            <InputGroup>
              <InputGroupInput ref={passwordField} id="saved-login-password" type={reveal ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} aria-invalid={error ? true : undefined} value={password} onChange={event => { setPassword(event.target.value); setError(null) }} disabled={pending} />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label={reveal ? card('hidePassword') : card('showPassword')} aria-pressed={reveal} onClick={() => setReveal(value => !value)}>{reveal ? <EyeOffIcon /> : <EyeIcon />}</InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {error && <FieldError>{error}</FieldError>}
          </Field>
        </FieldGroup>
        <SheetFooter className="flex-row items-center">
          <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground"><LockIcon className="size-3" />{card('securedBy')}<MikkaMarkSmall />Mikka</span>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onClose(false)}>{t('cancel')}</Button>
          <Button type="submit" disabled={pending || !ready}>{pending ? <Spinner data-icon="inline-start" /> : null}{t('save')}</Button>
        </SheetFooter>
      </form>
    </SheetContent>
  </Sheet>
}

function UsageList({ id }: { id: string }) {
  const t = useTranslations('Settings.logins')
  const locale = useLocale()
  const { data, error, isLoading } = useSWR(['account:saved-login-usage', id], () => listSavedLoginUsage(id))
  const uses: SavedLoginUse[] = data && !('error' in data) ? data.uses : []
  if (isLoading) return <SettingsLoading label={t('usageLoading')} rows={2} bare />
  if (error) return <FieldError>{t('usageError')}</FieldError>
  if (uses.length === 0) return <p className="text-sm text-muted-foreground">{t('usageEmpty')}</p>
  return <div className="flex max-h-80 flex-col divide-y divide-border overflow-auto">
    {uses.map(use => <div key={use.id} className="flex flex-col gap-0.5 py-2.5">
      <span className="text-sm">{use.botName ?? t('unknownBot')} · {t(`result.${use.result}`)}</span>
      <span className="text-xs text-muted-foreground">{relativeTime(use.at, locale)}</span>
    </div>)}
  </div>
}

function withoutScheme(site: string): string {
  return site.replace(/^https?:\/\//, '')
}
