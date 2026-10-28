'use client'

import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { ArrowUpRight, ChevronRight, Ellipsis, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { APP_ICONS } from '@/components/plugins/app-icons'
import { SettingsSection } from '@/components/settings/primitives'
import { IconTile } from '@/components/reui/icon-tile'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { routing } from '@/i18n/routing'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { COMPOSIO_APP_IDS, composioConnectRedirect, type ComposioAppId, type ConnectedAccountView } from '@/lib/composio-accounts'
import { cn } from '@/lib/utils'

type IntegrationState = { configured: boolean; callbackVerifierConfigured: boolean; webhookConfigured: boolean; accounts: ConnectedAccountView[] }

const integrationPath = withBasePath('/api/integrations/composio')

/** Facts for 关于: who makes the app and where it lives. */
const APP_ABOUT: Record<ComposioAppId, { developer: string; website: string }> = {
  gmail: { developer: 'Google', website: 'https://mail.google.com' },
  googlecalendar: { developer: 'Google', website: 'https://calendar.google.com' },
  notion: { developer: 'Notion Labs', website: 'https://www.notion.com' },
  slack: { developer: 'Slack', website: 'https://slack.com' },
}

export function isComposioAppId(value: string | null): value is ComposioAppId {
  return value !== null && (COMPOSIO_APP_IDS as readonly string[]).includes(value)
}

/** The plugins page URL for one app (`/?section=plugins&app=gmail`), with locale and base path. */
export function usePluginHref() {
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  return (app: ComposioAppId | null) => withBasePath(`${prefix}/?section=plugins${app ? `&app=${app}` : ''}`)
}

/** Where the callback should bring the person back: this page, without the base path. */
function currentReturnPath() {
  const { pathname, search } = window.location
  const path = BASE_PATH && pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || '/' : pathname
  return `${path}${search}`
}

export function AppTile({ app, size = 'default', dim = false }: { app: ComposioAppId; size?: 'default' | 'xl'; dim?: boolean }) {
  const Icon = APP_ICONS[app]
  // An explicit size keeps a parent Button's svg sizing off the mark.
  return <IconTile size={size} variant="elevated" aria-hidden="true" className={cn(dim && 'opacity-50 grayscale')}><Icon className="size-(--icon-tile-icon-size)" /></IconTile>
}

/** The account's name as the page shows it: its alias, else its email, else "Gmail 账户". */
function useAccountName() {
  const t = useTranslations('Settings.integrations')
  return (account: ConnectedAccountView) => account.alias ?? account.email ?? t('accountFallback', { name: t(account.toolkit) })
}

/** The selected account becomes unavailable; do not predict another identity. */
function useTakeoverText() {
  const t = useTranslations('Settings.integrations')
  return (accounts: ConnectedAccountView[], leavingId: string) => {
    const leaving = accounts.find(account => account.id === leavingId)
    return leaving?.isDefault ? t('disconnectConsequence', { name: t(leaving.toolkit) }) : null
  }
}

/** An account Composio can no longer use until it is reconnected. */
const needsReconnect = (account: ConnectedAccountView) => account.status !== 'ACTIVE'

/** State and actions for the Composio apps, shared by the list and the detail page. */
export function useConnectedApps() {
  const t = useTranslations('Settings.integrations')
  const [state, setState] = useState<IntegrationState | null>(null)
  // The toolkit or account id an action is running for.
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<{ tone: 'status' | 'alert'; text: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(integrationPath, { cache: 'no-store' })
      if (!response.ok) throw new Error()
      setState(await response.json() as IntegrationState)
    } catch {
      setError(t('loadFailed'))
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const url = new URL(window.location.href)
    const result = url.searchParams.get('composio')
    if (!result) return
    if (result === 'connected') setNotice({ tone: 'status', text: t('connectionCompleted') })
    if (result === 'callback-failed') setNotice({ tone: 'alert', text: t('callbackVerificationFailed') })
    url.searchParams.delete('composio')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [t])

  async function startLink(key: string, body: { toolkit: ComposioAppId } | { accountId: string }) {
    setPending(key); setError('')
    try {
      const response = await fetch(integrationPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, returnTo: currentReturnPath() }) })
      const result = await response.json() as { redirectUrl?: unknown }
      const redirect = response.ok ? composioConnectRedirect(result.redirectUrl) : null
      if (!redirect) throw new Error()
      window.location.assign(redirect.href)
    } catch {
      setError(t('connectFailed'))
      setPending('')
    }
  }

  async function patch(body: { accountId: string; enabled: boolean } | { accountId: string; alias: string } | { accountId: string; default: true }) {
    return fetch(integrationPath, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }

  /** Turns the given accounts on or off; the switch moves at once and comes back if Composio refuses. */
  async function setEnabled(accountIds: string[], enabled: boolean) {
    if (!accountIds.length) return false
    setError('')
    setState(current => current && { ...current, accounts: current.accounts.map(account => accountIds.includes(account.id) ? { ...account, enabled } : account) })
    const results = await Promise.all(accountIds.map(accountId => patch({ accountId, enabled }).catch(() => null)))
    const ok = results.every(response => response?.ok)
    if (!ok) setError(t('updateFailed'))
    await refresh()
    return ok
  }

  async function makeDefault(accountId: string) {
    setPending(accountId); setError('')
    try {
      const response = await patch({ accountId, default: true }).catch(() => null)
      if (!response?.ok) setError(t('updateFailed'))
      await refresh()
      return Boolean(response?.ok)
    } finally {
      setPending('')
    }
  }

  /** Renames an account; the result tells the dialog what to say. */
  async function rename(accountId: string, alias: string): Promise<'ok' | 'taken' | 'failed'> {
    setPending(accountId)
    try {
      const response = await patch({ accountId, alias })
      if (response.status === 409) return 'taken'
      if (!response.ok) return 'failed'
      await refresh()
      return 'ok'
    } catch {
      return 'failed'
    } finally {
      setPending('')
    }
  }

  async function disconnect(accountId: string) {
    setPending(accountId)
    try {
      const response = await fetch(integrationPath, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }) })
      if (!response.ok) return false
      await refresh()
      return true
    } catch {
      return false
    } finally {
      setPending('')
    }
  }

  const canLink = Boolean(state?.configured && state.callbackVerifierConfigured)
  return {
    state, pending, error, notice, canLink,
    accountsFor: (app: ComposioAppId) => state?.accounts.filter(account => account.toolkit === app) ?? [],
    connect: (app: ComposioAppId) => startLink(app, { toolkit: app }),
    reconnect: (accountId: string) => startLink(accountId, { accountId }),
    setEnabled, makeDefault, rename, disconnect,
  }
}

export type ConnectedApps = ReturnType<typeof useConnectedApps>

/** Loading, setup and result lines under the list or the detail page. */
export function ConnectedAppsStatus({ apps }: { apps: ConnectedApps }) {
  const t = useTranslations('Settings.integrations')
  const { state, error, notice } = apps
  return <>
    {!state && !error && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
    {state && !state.configured && <p role="status" className="text-sm text-muted-foreground">{t('composioNotConfigured')}</p>}
    {state?.configured && !state.callbackVerifierConfigured && <p role="status" className="text-sm text-muted-foreground">{t('callbackVerifierNotConfigured')}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role={notice.tone} className={cn('text-sm', notice.tone === 'alert' ? 'text-destructive' : 'text-muted-foreground')}>{notice.text}</p>}
  </>
}

/** The app's overall state from its accounts. */
function appState(accounts: ConnectedAccountView[]) {
  const usable = accounts.filter(account => !needsReconnect(account))
  const expired = accounts.length > 0 && usable.length === 0
  const on = usable.some(account => account.enabled)
  return { usable, expired, on, off: accounts.length > 0 && !expired && !on }
}

/**
 * The plugins list: icon, name, one line, then 连接 or the on/off switch and a
 * way into the app's page. `onOpen` handles a plain click in place; the row is
 * still a real link (`appHref`) for a new tab or another page.
 */
export function ConnectedAppsList({ apps, title, appHref, onOpen, action }: { apps: ConnectedApps; title: string; appHref: (app: ComposioAppId) => string; onOpen?: (app: ComposioAppId) => void; action?: ReactNode }) {
  const t = useTranslations('Settings.integrations')
  // A plain click opens the page in place; a modified click keeps the link's own behaviour.
  function openInPlace(event: MouseEvent<HTMLAnchorElement>, app: ComposioAppId) {
    if (!onOpen || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
    event.preventDefault()
    onOpen(app)
  }
  return <SettingsSection id="connected-apps-heading" title={title} action={action}>
    {COMPOSIO_APP_IDS.map(app => {
      const accounts = apps.accountsFor(app)
      const name = t(app)
      const { usable, expired, on, off } = appState(accounts)
      return <div key={app} className="flex items-center gap-3 py-3 pr-3 pl-5">
        <Button variant="ghost" nativeButton={false} role="link" render={<a href={appHref(app)} onClick={event => openInPlace(event, app)} />} className="h-auto min-w-0 flex-1 justify-start gap-3 p-0 text-left font-normal whitespace-normal hover:bg-transparent active:not-aria-[haspopup]:translate-y-0">
          <AppTile app={app} dim={off || expired} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={cn('text-sm font-medium', (off || expired) && 'text-muted-foreground')}>{name}</span>
              {off && <Badge variant="secondary">{t('statusDisabled')}</Badge>}
              {/* On a phone the 重新连接 button beside the row says it. */}
              {expired && <Badge tone="destructive" className="hidden sm:inline-flex">{t('needsReconnect')}</Badge>}
            </span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{t(`${app}Description`)}</span>
          </span>
        </Button>
        {/* One account to reconnect: right here. Several: the app's page, where each has its own. */}
        {expired && (accounts.length === 1
          ? <Button type="button" variant="secondary" size="sm" disabled={!apps.canLink || Boolean(apps.pending)} onClick={() => void apps.reconnect(accounts[0].id)}>{apps.pending === accounts[0].id ? t('working') : t('reconnect')}</Button>
          : <Button variant="secondary" size="sm" nativeButton={false} role="link" render={<a href={appHref(app)} onClick={event => openInPlace(event, app)} />}>{t('reconnect')}</Button>)}
        {accounts.length
          ? <Switch aria-label={t('enableApp', { name })} checked={on} disabled={expired} onCheckedChange={checked => {
            void apps.setEnabled(usable.filter(account => account.enabled !== checked).map(account => account.id), checked).then(ok => {
              if (ok && !checked) toast.success(t('turnedOff', { name }), { description: t('takeoverNone', { name }) })
            })
          }} />
          : <Button type="button" variant="secondary" size="sm" disabled={!apps.canLink || Boolean(apps.pending)} onClick={() => void apps.connect(app)}>{apps.pending === app ? t('working') : t('connect')}</Button>}
        <Button variant="ghost" size="icon-sm" nativeButton={false} role="link" aria-label={t('openApp', { name })} render={<a href={appHref(app)} onClick={event => openInPlace(event, app)} />}><ChevronRight data-icon="inline-start" /></Button>
      </div>
    })}
  </SettingsSection>
}

/** One app: header, its connected accounts with their actions, and 关于. */
export function ConnectedAppDetail({ apps, app, rootLabel, rootHref, onBack }: { apps: ConnectedApps; app: ComposioAppId; rootLabel: string; rootHref: string; onBack: () => void }) {
  const t = useTranslations('Settings.integrations')
  const common = useTranslations('Common')
  const format = useFormatter()
  const [renaming, setRenaming] = useState<ConnectedAccountView | null>(null)
  const [alias, setAlias] = useState('')
  const [confirming, setConfirming] = useState<ConnectedAccountView | null>(null)
  // Errors from a dialog stay in that dialog and go when it closes.
  const [dialogError, setDialogError] = useState('')
  const accounts = apps.accountsFor(app)
  const several = accounts.length > 1
  const name = t(app)
  const about = APP_ABOUT[app]
  const busy = Boolean(apps.pending)
  const accountName = useAccountName()
  const takeoverText = useTakeoverText()
  const statusLabel = (account: ConnectedAccountView) => account.status === 'EXPIRED' ? t('statusExpired')
    : account.status === 'FAILED' ? t('statusFailed') : account.status !== 'ACTIVE' ? t('statusInactive') : null
  const closeRename = () => { setRenaming(null); setDialogError('') }
  const closeConfirm = () => { setConfirming(null); setDialogError('') }

  return <div className="flex flex-col gap-8">
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem><BreadcrumbLink href={rootHref} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); onBack() }}>{rootLabel}</BreadcrumbLink></BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem><BreadcrumbPage>{name}</BreadcrumbPage></BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>

    <header className="flex flex-wrap items-center gap-4">
      <AppTile app={app} size="xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-xl font-semibold">{name}</h2>
        <p className="text-sm text-muted-foreground">{t(`${app}Description`)}</p>
      </div>
      {!accounts.length && <Button type="button" disabled={!apps.canLink || busy} onClick={() => void apps.connect(app)}>{apps.pending === app ? t('working') : t('connect')}</Button>}
    </header>

    {accounts.length > 0 && <SettingsSection id="connected-accounts-heading" title={t('accountsHeading')}>
      {accounts.map(account => {
        const broken = needsReconnect(account)
        const off = !account.enabled && !broken
        const status = statusLabel(account)
        const title = accountName(account)
        // The email under the name, unless the name is the email; otherwise when it was connected.
        // The default says the bots use it, in words, so it reads on touch too.
        const defaultRow = several && account.isDefault
        const email = account.email && account.email !== title ? account.email : null
        const detail = email ?? t('connectedOn', { date: format.dateTime(new Date(account.createdAt), { year: 'numeric', month: 'short', day: 'numeric' }) })
        return <div key={account.id} className="flex items-center gap-3 py-3 pr-3 pl-5">
          <AppTile app={app} dim={off || broken} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className={cn('min-w-0 truncate text-sm font-medium', (off || broken) && 'text-muted-foreground')}>{title}</span>
              {defaultRow && <Badge variant="secondary">{t('default')}</Badge>}
              {off && <Badge variant="secondary">{t('statusDisabled')}</Badge>}
              {status && <Badge tone="destructive">{status}</Badge>}
            </span>
            <span className="truncate text-xs text-muted-foreground">{detail}</span>
            {defaultRow && <span className="text-xs text-muted-foreground">{t('botsUseThis')}</span>}
          </div>
          {broken && <Button type="button" variant="secondary" size="sm" disabled={!apps.canLink || busy} onClick={() => void apps.reconnect(account.id)}>{apps.pending === account.id ? t('working') : t('reconnect')}</Button>}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('accountActions', { name: title })} disabled={busy} />}><Ellipsis data-icon="inline-start" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuGroup>
                {several && !account.isDefault && !broken && account.enabled && <DropdownMenuItem onClick={() => {
                  void apps.makeDefault(account.id).then(ok => { if (ok) toast.success(t('madeDefault', { account: title })) })
                }}>{t('makeDefault')}</DropdownMenuItem>}
                <DropdownMenuItem onClick={() => { setAlias(account.alias ?? account.email ?? ''); setDialogError(''); setRenaming(account) }}>{t('rename')}</DropdownMenuItem>
                <DropdownMenuItem disabled={!apps.canLink} onClick={() => void apps.reconnect(account.id)}>{t('reconnect')}</DropdownMenuItem>
                {!broken && <DropdownMenuItem onClick={() => {
                  const turningOff = account.enabled
                  // Worked out before the switch moves: who the bots use once this one is off.
                  const takeover = turningOff ? takeoverText(accounts, account.id) : null
                  void apps.setEnabled([account.id], !turningOff).then(ok => {
                    if (ok && turningOff) toast.success(t('turnedOff', { name: title }), takeover ? { description: takeover } : undefined)
                  })
                }}>{account.enabled ? t('turnOff') : t('turnOn')}</DropdownMenuItem>}
                <DropdownMenuItem variant="destructive" onClick={() => { setDialogError(''); setConfirming(account) }}>{t('disconnect')}</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      })}
      <Button type="button" variant="ghost" disabled={!apps.canLink || busy} onClick={() => void apps.connect(app)} className="h-auto w-full justify-start gap-3 rounded-none py-2 pr-3 pl-5 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground">
        <span className="flex size-10 items-center justify-center"><Plus data-icon="inline-start" aria-hidden="true" /></span>
        {apps.pending === app ? t('working') : t('connectAnotherAccount')}
      </Button>
    </SettingsSection>}

    <SettingsSection id="app-about-heading" title={t('about')}>
      <div className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
        <span className="text-muted-foreground">{t('developer')}</span>
        <span>{about.developer}</span>
      </div>
      <div className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
        <span className="text-muted-foreground">{t('website')}</span>
        <a href={about.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">{new URL(about.website).hostname}<ArrowUpRight className="size-3.5" aria-hidden="true" /></a>
      </div>
    </SettingsSection>

    <Dialog open={Boolean(renaming)} onOpenChange={open => { if (!open && !busy) closeRename() }}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={event => {
          event.preventDefault()
          const next = alias.trim()
          if (!renaming || !next) return
          setDialogError('')
          void apps.rename(renaming.id, next).then(result => {
            if (result === 'ok') closeRename()
            else setDialogError(result === 'taken' ? t('aliasTaken') : t('renameFailed'))
          })
        }}>
          <DialogHeader><DialogTitle>{t('rename')}</DialogTitle></DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(dialogError)}>
              <FieldLabel htmlFor="account-alias" className="sr-only">{t('accountName')}</FieldLabel>
              {/* Grey fill, no stroke (R-31); a local override until the shared Input changes. */}
              <Input id="account-alias" autoFocus maxLength={60} value={alias} aria-invalid={Boolean(dialogError)} aria-describedby={dialogError ? 'account-alias-error' : undefined} placeholder={renaming ? accountName(renaming) : undefined} onChange={event => { setAlias(event.target.value); setDialogError('') }} className="border-transparent bg-muted" />
              {dialogError && <p id="account-alias-error" role="alert" className="text-xs text-destructive">{dialogError}</p>}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={busy} onClick={closeRename}>{common('cancel')}</Button>
            <Button type="submit" disabled={busy || !alias.trim()}>{busy ? common('saving') : common('save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <AlertDialog open={Boolean(confirming)} onOpenChange={open => { if (!open && !busy) closeConfirm() }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('disconnectTitle', { name: confirming ? accountName(confirming) : name })}</AlertDialogTitle>
          <AlertDialogDescription>{(confirming && takeoverText(accounts, confirming.id)) ?? t('disconnectConsequence', { name })}</AlertDialogDescription>
        </AlertDialogHeader>
        {dialogError && <p role="alert" className="text-xs text-destructive">{dialogError}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel variant="secondary" disabled={busy}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => {
            if (!confirming) return
            const label = accountName(confirming)
            const takeover = takeoverText(accounts, confirming.id)
            void apps.disconnect(confirming.id).then(done => {
              if (!done) { setDialogError(t('disconnectFailed')); return }
              closeConfirm()
              toast.success(t('disconnected', { name: label }), takeover ? { description: takeover } : undefined)
            })
          }}>{busy ? t('working') : t('disconnect')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
