'use client'

import { useCallback, useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowUpRight, ChevronRight, Ellipsis, Plus } from 'lucide-react'

import { APP_ICONS } from '@/components/plugins/app-icons'
import { SettingsSection } from '@/components/settings/primitives'
import { IconTile } from '@/components/reui/icon-tile'
import { AlertDialog, AlertDialogCancel, AlertDialogAction, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'
import { COMPOSIO_APP_IDS, composioConnectRedirect, type ComposioAppId, type ConnectedAccountView } from '@/lib/composio-accounts'

type IntegrationState = { configured: boolean; callbackVerifierConfigured: boolean; webhookConfigured: boolean; accounts: ConnectedAccountView[] }

const integrationPath = withBasePath('/api/integrations/composio')

/** Facts for 关于: who makes the app and where it lives. */
const APP_ABOUT: Record<ComposioAppId, { developer: string; website: string }> = {
  gmail: { developer: 'Google', website: 'https://mail.google.com' },
  googlecalendar: { developer: 'Google', website: 'https://calendar.google.com' },
  notion: { developer: 'Notion Labs', website: 'https://www.notion.com' },
  slack: { developer: 'Slack', website: 'https://slack.com' },
}

export function AppTile({ app, size = 'default' }: { app: ComposioAppId; size?: 'default' | 'xl' }) {
  const Icon = APP_ICONS[app]
  // An explicit size keeps a parent Button's svg sizing off the mark.
  return <IconTile size={size} variant="elevated" aria-hidden="true"><Icon className="size-(--icon-tile-icon-size)" /></IconTile>
}

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
      const response = await fetch(integrationPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json() as { redirectUrl?: unknown }
      const redirect = response.ok ? composioConnectRedirect(result.redirectUrl) : null
      if (!redirect) throw new Error()
      window.location.assign(redirect.href)
    } catch {
      setError(t('connectFailed'))
      setPending('')
    }
  }

  async function patch(key: string, body: { accountId: string; enabled: boolean } | { accountId: string; alias: string }) {
    const response = await fetch(integrationPath, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(key)
  }

  /** Turns the given accounts on or off; the switch moves at once and comes back if Composio refuses. */
  async function setEnabled(accountIds: string[], enabled: boolean) {
    if (!accountIds.length) return
    setError('')
    setState(current => current && { ...current, accounts: current.accounts.map(account => accountIds.includes(account.id) ? { ...account, enabled } : account) })
    try {
      await Promise.all(accountIds.map(accountId => patch(accountId, { accountId, enabled })))
    } catch {
      setError(t('updateFailed'))
    }
    await refresh()
  }

  async function rename(accountId: string, alias: string) {
    setPending(accountId); setError('')
    try {
      await patch(accountId, { accountId, alias })
      await refresh()
      return true
    } catch {
      setError(t('renameFailed'))
      return false
    } finally {
      setPending('')
    }
  }

  async function disconnect(accountId: string) {
    setPending(accountId); setError('')
    try {
      const response = await fetch(integrationPath, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }) })
      if (!response.ok) throw new Error()
      await refresh()
      return true
    } catch {
      setError(t('disconnectFailed'))
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
    setEnabled, rename, disconnect,
  }
}

export type ConnectedApps = ReturnType<typeof useConnectedApps>

/** The plugins list: icon, name, one line, then 连接 or the on/off switch, and a way into the detail page. */
export function ConnectedAppsList({ apps, title, onOpen }: { apps: ConnectedApps; title: string; onOpen: (app: ComposioAppId) => void }) {
  const t = useTranslations('Settings.integrations')
  return <SettingsSection id="connected-apps-heading" title={title}>
    {COMPOSIO_APP_IDS.map(app => {
      const accounts = apps.accountsFor(app)
      const name = t(app)
      const enabled = accounts.some(account => account.enabled)
      const broken = accounts.length > 0 && accounts.every(account => account.status !== 'ACTIVE')
      return <div key={app} className="flex items-center gap-3 py-3 pr-3 pl-5">
        <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-3 p-0 text-left font-normal hover:bg-transparent active:not-aria-[haspopup]:translate-y-0" onClick={() => onOpen(app)}>
          <AppTile app={app} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{name}</span>
            <span className="truncate text-xs text-muted-foreground">{t(`${app}Description`)}</span>
          </span>
        </Button>
        {broken && <span className="shrink-0 text-xs text-destructive">{t('needsReconnect')}</span>}
        {accounts.length
          ? <Switch aria-label={t('enableApp', { name })} checked={enabled} onCheckedChange={checked => void apps.setEnabled(accounts.filter(account => account.enabled !== checked).map(account => account.id), checked)} />
          : <Button type="button" variant="secondary" size="sm" disabled={!apps.canLink || Boolean(apps.pending)} onClick={() => void apps.connect(app)}>{apps.pending === app ? t('working') : t('connect')}</Button>}
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t('openApp', { name })} onClick={() => onOpen(app)}><ChevronRight data-icon="inline-start" /></Button>
      </div>
    })}
  </SettingsSection>
}

/** One app: header, its connected accounts with their actions, and 关于. */
export function ConnectedAppDetail({ apps, app, rootLabel, onBack }: { apps: ConnectedApps; app: ComposioAppId; rootLabel: string; onBack: () => void }) {
  const t = useTranslations('Settings.integrations')
  const common = useTranslations('Common')
  const format = useFormatter()
  const [renaming, setRenaming] = useState<ConnectedAccountView | null>(null)
  const [alias, setAlias] = useState('')
  const [confirming, setConfirming] = useState<ConnectedAccountView | null>(null)
  const accounts = apps.accountsFor(app)
  const name = t(app)
  const about = APP_ABOUT[app]
  const busy = Boolean(apps.pending)
  const accountName = (account: ConnectedAccountView) => account.alias ?? t('accountFallback', { name })
  const statusLabel = (account: ConnectedAccountView) => !account.enabled ? t('statusDisabled')
    : account.status === 'EXPIRED' ? t('statusExpired')
        : account.status === 'FAILED' ? t('statusFailed') : t('statusInactive')

  return <div className="flex flex-col gap-8">
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem><BreadcrumbLink render={<Button type="button" variant="link" className="h-auto p-0 font-normal text-muted-foreground hover:text-foreground hover:no-underline" onClick={onBack} />}>{rootLabel}</BreadcrumbLink></BreadcrumbItem>
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
      {accounts.map(account => <div key={account.id} className="flex items-center gap-3 py-3 pr-3 pl-5">
        <AppTile app={app} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{accountName(account)}</span>
          <span className="truncate text-xs text-muted-foreground">
            {(!account.enabled || account.status !== 'ACTIVE') && <><span className={cn(account.enabled && 'text-destructive')}>{statusLabel(account)}</span>{' · '}</>}
            {t('connectedOn', { date: format.dateTime(new Date(account.createdAt), { year: 'numeric', month: 'short', day: 'numeric' }) })}
          </span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t('accountActions', { name: accountName(account) })} disabled={busy} />}><Ellipsis data-icon="inline-start" /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => { setAlias(account.alias ?? ''); setRenaming(account) }}>{t('rename')}</DropdownMenuItem>
              <DropdownMenuItem disabled={!apps.canLink} onClick={() => void apps.reconnect(account.id)}>{t('reconnect')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void apps.setEnabled([account.id], !account.enabled)}>{account.enabled ? t('turnOff') : t('turnOn')}</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setConfirming(account)}>{t('disconnect')}</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>)}
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

    <Dialog open={Boolean(renaming)} onOpenChange={open => { if (!open && !busy) setRenaming(null) }}>
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={event => {
          event.preventDefault()
          if (!renaming || !alias.trim()) return
          void apps.rename(renaming.id, alias.trim()).then(saved => { if (saved) setRenaming(null) })
        }}>
          <DialogHeader><DialogTitle>{t('rename')}</DialogTitle></DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-alias" className="sr-only">{t('accountName')}</FieldLabel>
              <Input id="account-alias" autoFocus maxLength={60} value={alias} placeholder={renaming ? accountName(renaming) : undefined} onChange={event => setAlias(event.target.value)} className="border-transparent bg-muted" />
            </Field>
          </FieldGroup>
          {apps.error && <p role="alert" className="text-xs text-destructive">{apps.error}</p>}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setRenaming(null)}>{common('cancel')}</Button>
            <Button type="submit" disabled={busy || !alias.trim()}>{busy ? common('saving') : common('save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <AlertDialog open={Boolean(confirming)} onOpenChange={open => { if (!open && !busy) setConfirming(null) }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader><AlertDialogTitle>{t('disconnectTitle', { name: confirming ? accountName(confirming) : name })}</AlertDialogTitle></AlertDialogHeader>
        {apps.error && <p role="alert" className="text-xs text-destructive">{apps.error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel variant="secondary" disabled={busy}>{common('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => {
            if (!confirming) return
            void apps.disconnect(confirming.id).then(done => { if (done) setConfirming(null) })
          }}>{busy ? t('working') : t('disconnect')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}
