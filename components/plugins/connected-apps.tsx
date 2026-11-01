'use client'

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowUpRight, Blocks, ChevronDown, ChevronRight, Ellipsis, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { APP_ICONS } from '@/components/plugins/app-icons'
import { SettingsSection } from '@/components/settings/primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { COMPOSIO_APP_IDS, composioConnectRedirect, type ComposioAppId, type ConnectedAccountView as AccountView } from '@/lib/composio-accounts'
import type { StoreApp, StoreCatalog } from '@/lib/plugins/catalog'
import type { AppDetail, AppTool } from '@/lib/plugins/app-detail'
import { openCurrentPageInBrowser } from '@/lib/platform/open-settings'
import { useCheckOnReturn } from '@/lib/hooks/use-check-on-return'
import { cn } from '@/lib/utils'

/** Any store toolkit's account (lib/composio-accounts). */
type ConnectedAccountView = AccountView<string>
type IntegrationState = { configured: boolean; callbackVerifierConfigured: boolean; webhookConfigured: boolean; accounts: ConnectedAccountView[] }
export type StoreCatalogView = { configured: boolean } & StoreCatalog

/** The SWR key of the 插件 store (lib/plugins/catalog.ts). */
export const storeCatalogKey = withBasePath('/api/integrations/composio/catalog')

export async function readStoreCatalog(): Promise<StoreCatalogView> {
  const response = await fetch(storeCatalogKey)
  if (!response.ok) throw new Error(String(response.status))
  return await response.json() as StoreCatalogView
}

/** The store, cached across visits like the accounts. */
export function useStoreCatalog(enabled = true) {
  return useSWR(enabled ? storeCatalogKey : null, readStoreCatalog, { revalidateOnFocus: false })
}

/** One store app's page data (lib/plugins/app-detail.ts), cached like the store. */
export function useAppDetail(app: string | null) {
  return useSWR(app ? `${storeCatalogKey}/${encodeURIComponent(app)}` : null, async (key: string) => {
    const response = await fetch(key)
    if (!response.ok) throw new Error(String(response.status))
    return await response.json() as AppDetail
  }, { revalidateOnFocus: false, shouldRetryOnError: false })
}

/** Mikka's own integrations, not Composio's. */
export const OWN_APPS = ['github', 'linear', 'telegram'] as const
export type OwnAppId = typeof OWN_APPS[number]
export const isOwnApp = (value: string | null): value is OwnAppId => value !== null && (OWN_APPS as readonly string[]).includes(value)

/**
 * An app's name and icon anywhere on the page: ours and the first four apps
 * from messages, every other store app from Composio's catalog.
 */
export function useAppInfo() {
  const t = useTranslations('Settings.integrations')
  const tLinear = useTranslations('Settings.linear')
  const tTelegram = useTranslations('Settings.telegram')
  const { data } = useStoreCatalog()
  const byId = new Map<string, StoreApp>((data?.apps ?? []).map(app => [app.id, app]))
  return (id: string) => {
    const store = byId.get(id)
    const name = id === 'linear' ? tLinear('title') : id === 'telegram' ? tTelegram('title') : id === 'github' || isComposioAppId(id) ? t(id) : store?.name ?? id
    return { name, iconUrl: store?.iconUrl ?? null, description: isOwnApp(id) ? '' : store?.description ?? '' }
  }
}

const integrationPath = withBasePath('/api/integrations/composio')

/** The SWR key of the Composio apps' state; 建议 reads the same key. */
export const connectedAppsKey = integrationPath

export async function readConnectedApps(): Promise<IntegrationState> {
  const response = await fetch(integrationPath, { cache: 'no-store' })
  if (!response.ok) throw new Error(String(response.status))
  return await response.json() as IntegrationState
}

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


/** Where the callback should bring the person back: this page, without the base path. */
function currentReturnPath() {
  const { pathname, search } = window.location
  const path = BASE_PATH && pathname.startsWith(BASE_PATH) ? pathname.slice(BASE_PATH.length) || '/' : pathname
  return `${path}${search}`
}

export function AppTile({ app, iconUrl = null, size = 'default', dim = false }: { app: string; iconUrl?: string | null; size?: 'default' | 'xl'; dim?: boolean }) {
  const Icon = Object.hasOwn(APP_ICONS, app) ? APP_ICONS[app as keyof typeof APP_ICONS] : null
  const glyph = cn(size === 'xl' ? 'size-7' : 'size-4.5')
  // The brand mark on its own (R-74): no tile behind it, in the same slot and size as before so rows stay aligned.
  // Store apps use Composio's logo; an app without one gets a plain glyph.
  return <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center', size === 'xl' ? 'size-14' : 'size-10', dim && 'opacity-50 grayscale')}>
    {Icon ? <Icon className={glyph} /> : iconUrl ? <img src={iconUrl} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className={cn(glyph, 'object-contain')} /> : <Blocks className={cn(glyph, 'text-muted-foreground')} />}
  </span>
}

/** The account's name as the page shows it: its alias, else its email, else "Gmail 账户". */
function useAccountName() {
  const t = useTranslations('Settings.integrations')
  const info = useAppInfo()
  return (account: ConnectedAccountView) => account.alias ?? account.email ?? t('accountFallback', { name: info(account.toolkit).name })
}

/** The selected account becomes unavailable; do not predict another identity. */
function useTakeoverText() {
  const t = useTranslations('Settings.integrations')
  const info = useAppInfo()
  return (accounts: ConnectedAccountView[], leavingId: string) => {
    const leaving = accounts.find(account => account.id === leavingId)
    return leaving?.isDefault ? t('disconnectConsequence', { name: info(leaving.toolkit).name }) : null
  }
}

/** An account Composio can no longer use until it is reconnected. */
const needsReconnect = (account: ConnectedAccountView) => account.status !== 'ACTIVE'

/** State and actions for the Composio apps, shared by the list and the detail page. */
export function useConnectedApps(enabled = true) {
  const t = useTranslations('Settings.integrations')
  // Cached across visits: a revisit shows the last state at once and re-reads it behind.
  const { data, error: loadError, mutate } = useSWR(enabled ? connectedAppsKey : null, readConnectedApps, { revalidateOnFocus: false })
  const state = data ?? null
  // The toolkit or account id an action is running for.
  const [pending, setPending] = useState('')
  const [actionError, setError] = useState('')
  const [notice, setNotice] = useState<{ tone: 'status' | 'alert'; text: string } | null>(null)
  const error = actionError || (loadError ? t('loadFailed') : '')

  const refresh = async () => { if (enabled) await mutate() }

  // A connect that finished in the system browser: read once on the way back, never on plain focus.
  const checkOnReturn = useCheckOnReturn(() => { void refresh() })

  useEffect(() => {
    if (!enabled) return
    const url = new URL(window.location.href)
    const result = url.searchParams.get('composio')
    if (!result) return
    if (result === 'connected') setNotice({ tone: 'status', text: t('connectionCompleted') })
    if (result === 'callback-failed') setNotice({ tone: 'alert', text: t('callbackVerificationFailed') })
    url.searchParams.delete('composio')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [t, enabled])

  async function startLink(key: string, body: { toolkit: string } | { accountId: string }) {
    setPending(key); setError('')
    try {
      // A reconnect keeps the account it replaces in a cookie the callback must
      // read, so on the desktop it still starts in the browser (#601).
      if ('accountId' in body) {
        const handoff = await openCurrentPageInBrowser()
        if (handoff === 'desktop') { checkOnReturn(); return }
        if (handoff === 'unsupported') { setError(t('browserUpdateRequired')); return }
      }
      const response = await fetch(integrationPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, returnTo: currentReturnPath() }) })
      const result = await response.json() as { redirectUrl?: unknown }
      const redirect = response.ok ? composioConnectRedirect(result.redirectUrl) : null
      if (!redirect) throw new Error()
      // The desktop shell sends any off-origin navigation to the system browser
      // and stays here; the list reads once when the person comes back. On the web
      // this page navigates away and the callback lands on a fresh mount.
      checkOnReturn()
      window.location.assign(redirect.href)
    } catch {
      setError(t('connectFailed'))
    } finally {
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
    await mutate(current => current && { ...current, accounts: current.accounts.map(account => accountIds.includes(account.id) ? { ...account, enabled } : account) }, { revalidate: false })
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

  const canLink = enabled && Boolean(state?.configured && state.callbackVerifierConfigured)
  // Shown on the disabled 连接 buttons, so they say why instead of doing nothing.
  const unavailable = state && !canLink ? t('connectUnavailable') : undefined
  return {
    state, pending, error, notice, canLink, unavailable,
    // Nothing read yet: rows hold their place without guessing 连接 or the switch.
    loading: enabled && !state && !loadError,
    accountsFor: (app: string) => state?.accounts.filter(account => account.toolkit === app) ?? [],
    /** Every toolkit the person has an account on, in the order they connected them. */
    connectedToolkits: () => [...new Set(state?.accounts.map(account => account.toolkit) ?? [])],
    connect: (app: string) => startLink(app, { toolkit: app }),
    reconnect: (accountId: string) => startLink(accountId, { accountId }),
    setEnabled, makeDefault, rename, disconnect,
  }
}

export type ConnectedApps = ReturnType<typeof useConnectedApps>

/** A disabled button takes no pointer events, so its reason sits on a wrapper. */
function WhyDisabled({ reason, fill = false, children }: { reason?: string; fill?: boolean; children: ReactNode }) {
  if (!reason) return children
  return <span title={reason} className={cn('inline-flex', fill && 'w-full')}>{children}</span>
}

/**
 * Setup and result lines above the list or the detail page. Loading is read out only:
 * a visible line would push the list down and then let it jump up when the accounts arrive.
 */
export function ConnectedAppsStatus({ apps }: { apps: ConnectedApps }) {
  const t = useTranslations('Settings.integrations')
  const { error, notice } = apps
  return <>
    {apps.loading && <span role="status" className="sr-only">{t('loading')}</span>}
    {error && <FieldError>{error}</FieldError>}
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

/** A plain click opens the app's page in place; a modified click keeps the link's own behaviour. */
function openInPlace(event: MouseEvent<HTMLAnchorElement>, onOpen: (() => void) | undefined) {
  if (!onOpen || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
  event.preventDefault()
  onOpen()
}

/**
 * One row of the 插件 list: icon, name, then the row's control and a chevron.
 * The whole row is the link into the app's page (its hover covers the row edge
 * to edge); the control sits above the link and stays separately clickable.
 */
export function PluginRow({ app, iconUrl, name, href, onOpen, dim = false, badge, children }: { app: string; iconUrl?: string | null; name: string; href: string; onOpen?: () => void; dim?: boolean; badge?: ReactNode; children?: ReactNode }) {
  const t = useTranslations('Settings.integrations')
  return <div className="relative flex items-center gap-3 py-3 pr-4 pl-5 transition-colors hover:bg-muted/50">
    <a href={href} aria-label={t('openApp', { name })} onClick={event => openInPlace(event, onOpen)} className="flex min-w-0 flex-1 items-center gap-3 outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/40 focus-visible:after:ring-inset">
      <AppTile app={app} iconUrl={iconUrl} dim={dim} />
      <span className={cn('truncate text-sm font-medium', dim && 'text-muted-foreground')}>{name}</span>
      {badge}
    </a>
    {children && <div className="relative z-10 flex shrink-0 items-center gap-2">{children}</div>}
    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
  </div>
}

/** A Composio app's row: 连接 until an account exists, then the on/off switch. */
export function ConnectedAppRow({ apps, app, href, onOpen }: { apps: ConnectedApps; app: string; href: string; onOpen?: () => void }) {
  const t = useTranslations('Settings.integrations')
  const accounts = apps.accountsFor(app)
  const { name, iconUrl } = useAppInfo()(app)
  const { usable, expired, on, off } = appState(accounts)
  return <PluginRow app={app} iconUrl={iconUrl} name={name} href={href} onOpen={onOpen} dim={off || expired} badge={<>
    {off && <Badge variant="secondary">{t('statusDisabled')}</Badge>}
    {/* On a phone the 重新连接 button beside the row says it. */}
    {expired && <Badge tone="destructive" className="hidden sm:inline-flex">{t('needsReconnect')}</Badge>}
  </>}>
    {/* One account to reconnect: right here. Several: the app's page, where each has its own. */}
    {expired && (accounts.length === 1
      ? <Button type="button" variant="secondary" size="sm" disabled={!apps.canLink || Boolean(apps.pending)} onClick={() => void apps.reconnect(accounts[0].id)}>{apps.pending === accounts[0].id ? t('working') : t('reconnect')}</Button>
      : <Button variant="secondary" size="sm" nativeButton={false} role="link" render={<a href={href} onClick={event => openInPlace(event, onOpen)} />}>{t('reconnect')}</Button>)}
    {/* Until the accounts arrive the trailing slot holds the 连接 button's size, so the row does not shift. */}
    {apps.loading ? <Skeleton data-slot="app-row-pending" aria-hidden="true" className="h-7 w-12 rounded-[min(var(--radius-md),12px)]" />
      : accounts.length
      ? <Switch aria-label={t('enableApp', { name })} checked={on} disabled={expired} onCheckedChange={checked => {
        void apps.setEnabled(usable.filter(account => account.enabled !== checked).map(account => account.id), checked).then(ok => {
          if (ok && !checked) toast.success(t('turnedOff', { name }), { description: t('takeoverNone', { name }) })
        })
      }} />
      : <WhyDisabled reason={apps.unavailable}><Button type="button" variant="secondary" size="sm" disabled={!apps.canLink || Boolean(apps.pending)} onClick={() => void apps.connect(app)}>{apps.pending === app ? t('working') : t('connect')}</Button></WhyDisabled>}
  </PluginRow>
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
    <span className="shrink-0 text-muted-foreground">{label}</span>
    <span className="min-w-0 text-right">{children}</span>
  </div>
}

/** 工具: Composio's tools for the app, 写入 and 读取 (by its readOnlyHint), each group collapsible and scrolling inside. */
function AppTools({ tools }: { tools: AppDetail['tools'] }) {
  const t = useTranslations('Settings.integrations')
  const total = tools.write.length + tools.read.length
  return <section aria-labelledby="app-tools-heading" className="flex flex-col gap-3">
    <div className="flex flex-col gap-0.5">
      <h2 id="app-tools-heading" className="text-sm font-medium">{t('toolsHeading')}</h2>
      <p className="text-xs text-muted-foreground">{t('toolsSummary', { count: total, write: tools.write.length, read: tools.read.length })}</p>
    </div>
    {([['write', tools.write], ['read', tools.read]] as const).filter(([, list]) => list.length).map(([kind, list]) => <ToolGroup key={kind} label={t(kind === 'write' ? 'writeTools' : 'readTools', { count: list.length })} tools={list} />)}
  </section>
}

function ToolGroup({ label, tools }: { label: string; tools: AppTool[] }) {
  const [open, setOpen] = useState(true)
  return <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/5">
    <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-auto w-full justify-between rounded-none px-5 py-3 font-medium hover:bg-muted/50" />}>
      {label}<ChevronDown data-icon="inline-end" aria-hidden="true" className={cn('text-muted-foreground transition-transform', !open && '-rotate-90')} />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto pb-3">
        {tools.map(tool => <li key={tool.slug} className="flex flex-col gap-0.5 px-5 py-1.5">
          <span className="text-sm">{tool.name}</span>
          {tool.description && <span className="text-xs text-muted-foreground">{tool.description}</span>}
        </li>)}
      </ul>
    </CollapsibleContent>
  </Collapsible>
}

/** The way back from an app's page to the list. */
export function PluginBreadcrumb({ rootLabel, rootHref, onBack, name }: { rootLabel: string; rootHref: string; onBack: () => void; name: string }) {
  return <Breadcrumb>
    <BreadcrumbList>
      <BreadcrumbItem><BreadcrumbLink href={rootHref} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); onBack() }}>{rootLabel}</BreadcrumbLink></BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem><BreadcrumbPage>{name}</BreadcrumbPage></BreadcrumbItem>
    </BreadcrumbList>
  </Breadcrumb>
}

/** One app: header, its connected accounts with their actions, and 关于. */
export function ConnectedAppDetail({ apps, app, rootLabel, rootHref, onBack }: { apps: ConnectedApps; app: string; rootLabel: string; rootHref: string; onBack: () => void }) {
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
  const { name, iconUrl } = useAppInfo()(app)
  // Composio's own page data, for everyone, connected or not.
  const detail = useAppDetail(app)
  // 开发者 only where Mikka already knows it; Composio does not say.
  const about = isComposioAppId(app) ? APP_ABOUT[app] : null
  const website = detail.data?.website ?? about?.website ?? null
  const busy = Boolean(apps.pending)
  const accountName = useAccountName()
  const takeoverText = useTakeoverText()
  const statusLabel = (account: ConnectedAccountView) => account.status === 'EXPIRED' ? t('statusExpired')
    : account.status === 'FAILED' ? t('statusFailed') : account.status !== 'ACTIVE' ? t('statusInactive') : null
  const closeRename = () => { setRenaming(null); setDialogError('') }
  const closeConfirm = () => { setConfirming(null); setDialogError('') }

  return <div className="flex flex-col gap-8">
    <PluginBreadcrumb rootLabel={rootLabel} rootHref={rootHref} onBack={onBack} name={name} />

    <header className="flex flex-wrap items-center gap-4">
      <AppTile app={app} iconUrl={iconUrl} size="xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-xl font-semibold">{name}</h2>
      </div>
      {!accounts.length && !apps.loading && <WhyDisabled reason={apps.unavailable}><Button type="button" disabled={!apps.canLink || busy} onClick={() => void apps.connect(app)}>{apps.pending === app ? t('working') : t('connect')}</Button></WhyDisabled>}
    </header>

    {detail.data?.description ? <p className="max-w-prose text-sm leading-6 text-muted-foreground">{detail.data.description}</p>
      : detail.isLoading && <div aria-hidden="true" className="flex flex-col gap-2"><Skeleton className="h-4 w-full max-w-prose" /><Skeleton className="h-4 w-2/3 max-w-prose" /></div>}
    {detail.error && !detail.data && <div role="alert" className="flex items-center gap-2 text-sm text-muted-foreground">{t('detailLoadFailed')}<Button type="button" variant="ghost" size="sm" onClick={() => void detail.mutate()}>{common('retry')}</Button></div>}

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
          <AppTile app={app} iconUrl={iconUrl} dim={off || broken} />
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
      <WhyDisabled reason={apps.unavailable} fill><Button type="button" variant="ghost" disabled={!apps.canLink || busy} onClick={() => void apps.connect(app)} className="h-auto w-full justify-start gap-3 rounded-none py-2 pr-3 pl-5 font-normal text-muted-foreground hover:bg-transparent hover:text-foreground">
        <span className="flex size-10 items-center justify-center"><Plus data-icon="inline-start" aria-hidden="true" /></span>
        {apps.pending === app ? t('working') : t('connectAnotherAccount')}
      </Button></WhyDisabled>
    </SettingsSection>}

    {detail.data && detail.data.tools.write.length + detail.data.tools.read.length > 0 && <AppTools tools={detail.data.tools} />}

    {(detail.data?.categories.length || about || website || detail.data?.version) ? <SettingsSection id="app-about-heading" title={t('info')}>
      {detail.data?.categories.length ? <InfoRow label={t('category')}>{detail.data.categories.map(category => category.name).join(' · ')}</InfoRow> : null}
      {about && <InfoRow label={t('developer')}>{about.developer}</InfoRow>}
      {website && <InfoRow label={t('website')}><a href={website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">{new URL(website).hostname}<ArrowUpRight className="size-3.5" aria-hidden="true" /></a></InfoRow>}
      {detail.data?.version && <InfoRow label={t('version')}>{detail.data.version}</InfoRow>}
    </SettingsSection> : null}

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
        {dialogError && <FieldError className="text-xs">{dialogError}</FieldError>}
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
