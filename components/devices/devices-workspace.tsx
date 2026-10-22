'use client'

import { useState, useTransition } from 'react'
import useSWR from 'swr'
import { useRouter } from '@/i18n/navigation'
import { Laptop, RefreshCw, Sparkles, Terminal } from 'lucide-react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { SignOutBoundary } from '@/components/app-shell'
import { listDevices, setDeviceEnabled, type DeviceView } from '@/app/actions/agents'
import { useActionError } from '@/lib/use-action-error'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Switch } from '@/components/ui/switch'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Badge } from '@/components/reui/badge'
import { IconTile } from '@/components/reui/icon-tile'
import { ConnectDeviceDialog } from './connect-device-dialog'
import { DevicesSidebar } from './devices-sidebar'
import { SUPPORTED_HARNESSES, type SupportedHarness } from '@/lib/db/schema'
import { WORKSPACE_NAME } from '@/components/workspace/issue-properties'

const HARNESS_LABELS: Record<SupportedHarness, string> = { claude_code: 'Claude Code', codex: 'Codex' }

/** The version out of a CLI's `--version` line, which varies by tool. */
function versionOf(version: string | null): string {
  if (!version) return ''
  const parts = version.trim().split(/\s+/)
  return parts.find(part => /^\d/.test(part)) ?? parts[0]
}

function relativeTime(value: Date | null, format: ReturnType<typeof useFormatter>, now: Date, neverLabel: string): string {
  if (!value) return neverLabel
  return format.relativeTime(new Date(value), now)
}

/** One harness on this device: installed or not, and the version it reported. */
function HarnessRow({ harness, installed, version }: { harness: SupportedHarness; installed: boolean; version: string | null }) {
  const t = useTranslations('Devices')
  const shown = versionOf(version)
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <span className="flex min-w-0 items-center gap-2.5">
        <IconTile size="sm" variant="elevated" aria-hidden="true">
          {harness === 'claude_code' ? <Sparkles /> : <Terminal />}
        </IconTile>
        <span className="truncate text-sm font-medium">{HARNESS_LABELS[harness]}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {installed ? (shown ? t('installedWithVersion', { version: shown }) : t('installed')) : t('notInstalled')}
      </span>
    </div>
  )
}

/** One machine: what it is, whether it is online, and what it reports. */
function DeviceCard({ device, localHostname, onChanged }: { device: DeviceView; localHostname: string; onChanged: () => void }) {
  const t = useTranslations('Devices')
  const format = useFormatter()
  const now = useNow()
  const translateError = useActionError()
  const relative = relativeTime(device.lastSeenAt, format, now, t('neverOnline'))
  const meta = [device.platform, device.arch, device.hostname, t('lastHeartbeat', { time: relative })].filter(Boolean).join(' · ')
  const harnesses = SUPPORTED_HARNESSES.map(harness => ({
    harness,
    info: device.harnesses.find(item => item.harness === harness),
  }))
  const installedCount = harnesses.filter(item => item.info?.installed).length
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState('')
  function setEnabled(next: boolean) {
    setError('')
    startTransition(async () => {
      try {
        const result = await setDeviceEnabled({ deviceId: device.id, enabled: next })
        if ('error' in result) { setError(translateError(result.error)); return }
        onChanged()
      } catch {
        setError(translateError('deviceSaveFailed'))
      }
    })
  }
  return (
    <div className="rounded-xl border">
      <div className="flex items-start gap-3 p-5">
        <IconTile variant="elevated" aria-hidden="true"><Laptop /></IconTile>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{device.name}</span>
            <Badge variant={device.online ? 'success-light' : 'outline'} size="sm">
              {device.online ? t('online') : t('offline')}
            </Badge>
            {device.hostname && device.hostname === localHostname && <Badge variant="secondary" size="sm">{t('thisMachine')}</Badge>}
          </span>
          <span className="truncate text-xs text-muted-foreground">{meta}</span>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <Label htmlFor={`device-enabled-${device.id}`} className="text-xs font-normal text-muted-foreground">{t('allowScheduling')}</Label>
          <Switch
            id={`device-enabled-${device.id}`}
            checked={device.enabled}
            disabled={pending}
            aria-label={t('allowSchedulingTo', { name: device.name })}
            onCheckedChange={next => setEnabled(next)}
          />
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <span className="text-xs font-medium text-muted-foreground">{t('agent')}</span>
        <span className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">{installedCount} / {harnesses.length}</span>
          <Button size="xs" variant="ghost" onClick={onChanged}>
            <RefreshCw data-icon="inline-start" />
            {t('recheck')}
          </Button>
        </span>
      </div>
      {error && <p role="alert" className="px-5 pb-3 text-xs text-destructive">{error}</p>}
      {harnesses.map(item => (
        <HarnessRow key={item.harness} harness={item.harness} installed={Boolean(item.info?.installed)} version={item.info?.version ?? null} />
      ))}
    </div>
  )
}

/**
 * The Device page: the machines that run agents. Everything shown here comes
 * from the daemon's own detection — this app never guesses what a machine has.
 */
export function DevicesWorkspace({ user, localHostname, initialDevices }: {
  user: { id: string; name: string; email: string }
  localHostname: string
  initialDevices: DeviceView[]
}) {
  const t = useTranslations('Devices')
  const tAccount = useTranslations('Workspace')
  const router = useRouter()
  const { data: devices = [], mutate, error } = useSWR('devices', listDevices, { fallbackData: initialDevices, refreshInterval: 5000 })
  const [signingOut, setSigningOut] = useState(false)
  const [accountError, setAccountError] = useState('')

  async function signOut() {
    if (signingOut) return
    setSigningOut(true)
    setAccountError('')
    try {
      const result = await authClient.signOut()
      if (result.error) throw new Error('sign out failed')
      router.replace('/sign-in?login=1'); router.refresh()
    } catch { setAccountError(tAccount('signOutFailed')); setSigningOut(false) }
  }

  const online = devices.filter(device => device.online).length

  return (
    <SignOutBoundary pending={signingOut}><TooltipProvider>
      <SidebarProvider>
        <DevicesSidebar user={user} onSignOut={signOut} signingOut={signingOut} />
        <SidebarInset className="min-w-0">
          <header className="flex h-12 shrink-0 items-center justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-2">
              <SidebarTrigger className="-ml-1" aria-label={t('toggleSidebar')} />
              <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
              <Breadcrumb aria-label={t('breadcrumb')}>
                <BreadcrumbList>
                  <BreadcrumbItem className="hidden sm:inline-flex"><span>{WORKSPACE_NAME}</span></BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden sm:block" />
                  <BreadcrumbItem><BreadcrumbPage>{t('title')}</BreadcrumbPage></BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
          </header>
          <div className="flex flex-col gap-6 px-4 py-6 sm:px-6">
            {accountError && <p role="alert" className="text-sm text-destructive">{accountError}</p>}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <h1 className="text-sm font-semibold tracking-tight">{t('title')}</h1>
                <p className="text-xs text-muted-foreground">{t('description')}</p>
              </div>
              <ConnectDeviceDialog />
            </div>

            {devices.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('summary', { total: devices.length, online })}
              </p>
            )}

            {error && <p role="alert" className="text-xs text-destructive">{t('listError')}</p>}
            {devices.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Laptop aria-hidden="true" /></EmptyMedia>
                  <EmptyTitle>{t('emptyTitle')}</EmptyTitle>
                  <EmptyDescription>{t('emptyDescription')}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent><ConnectDeviceDialog /></EmptyContent>
              </Empty>
            ) : (
              <div className="flex flex-col gap-3">
                {devices.map(device => (
                  <DeviceCard key={device.id} device={device} localHostname={localHostname} onChanged={() => { void mutate() }} />
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {t('footer')}
            </p>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider></SignOutBoundary>
  )
}
