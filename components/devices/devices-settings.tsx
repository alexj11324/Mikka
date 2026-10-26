'use client'

import { Fragment, useEffect, useState } from 'react'
import useSWR from 'swr'
import { MoreHorizontal, Plus, RefreshCw } from 'lucide-react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { listDevices, setDeviceEnabled, type DeviceView } from '@/app/actions/agents'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuGroup, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemGroup, ItemSeparator } from '@/components/ui/item'
import { IconTile } from '@/components/reui/icon-tile'
import { useActionError } from '@/lib/use-action-error'
import { AddDeviceDialog } from './add-device-dialog'
import { DeviceIcon } from './device-icon'
import { DeviceSetupDialog } from './device-setup-dialog'

/** Personal computers count as 本机; servers reached over SSH or Tailnet are the rest. */
const isPersonal = (device: DeviceView) => device.platform === 'darwin' || device.platform === 'win32'

function DeviceRow({ device, onChanged, onReconnect }: { device: DeviceView; onChanged: () => void; onReconnect: (host: string) => void }) {
  const t = useTranslations('Devices')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const host = device.hostname ?? device.name
  const [setup, setSetup] = useState(false)
  const translateError = useActionError()
  async function toggle(enabled: boolean) {
    try {
      const result = await setDeviceEnabled({ deviceId: device.id, enabled })
      if ('error' in result) { toast.error(translateError(result.error)); return }
      onChanged()
    } catch { toast.error(translateError('deviceSaveFailed')) }
  }
  return <Item role="listitem" className="gap-3 rounded-none px-3.5 py-3">
    <IconTile size="sm" variant="elevated"><DeviceIcon kind={isPersonal(device) ? 'personal' : 'server'} state={device.online ? 'online' : 'offline'} label={device.online ? t('online') : t('offline')} surface="muted" /></IconTile>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-sm font-medium">{device.name}</span>
      {!device.online && <span className="truncate text-xs text-muted-foreground">{device.lastSeenAt ? t('lastOnline', { time: format.relativeTime(new Date(device.lastSeenAt), now) }) : t('neverOnline')}</span>}
    </span>
    {/* A server is set up again over SSH; a personal computer comes back when Mikka runs on it. */}
    {!device.online && !isPersonal(device) && <Button variant="outline" size="sm" onClick={() => onReconnect(host)}><RefreshCw data-icon="inline-start" />{t('reconnect')}</Button>}
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('menu', { name: device.name })} />}><MoreHorizontal data-icon="inline-start" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuGroup>
        <DropdownMenuItem disabled={!device.online || !device.enabled} onClick={() => setSetup(true)}>{t('setup')}</DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={device.enabled} onCheckedChange={checked => { void toggle(checked) }}>{t('allowScheduling')}</DropdownMenuCheckboxItem>
      </DropdownMenuGroup></DropdownMenuContent>
    </DropdownMenu>
    <DeviceSetupDialog device={device} open={setup} onOpenChange={setSetup} onChanged={onChanged} />
  </Item>
}

function DeviceGroup({ title, devices, onChanged, onReconnect }: { title: string; devices: DeviceView[]; onChanged: () => void; onReconnect: (host: string) => void }) {
  return devices.length > 0 && <section aria-label={title} className="flex flex-col gap-2">
    <h2 className="px-1 text-xs font-medium text-muted-foreground">{title}</h2>
    <ItemGroup className="gap-0! overflow-hidden rounded-xl border bg-card">{devices.map((device, index) => <Fragment key={device.id}>{index > 0 && <ItemSeparator className="my-0" />}<DeviceRow device={device} onChanged={onChanged} onReconnect={onReconnect} /></Fragment>)}</ItemGroup>
  </section>
}

/**
 * 设置 › 设备 (Figma 108:563): only machines the user connected. The bots'
 * cloud computer is ours and never listed here.
 */
export function DevicesSettings() {
  const t = useTranslations('Devices')
  const { data: devices = [], error, mutate } = useSWR('devices', listDevices, { refreshInterval: 5000 })
  const [adding, setAdding] = useState(false)
  const [reconnecting, setReconnecting] = useState('')
  const reconnect = (host: string) => { setReconnecting(host); setAdding(true) }
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !event.shiftKey && !event.altKey) { event.preventDefault(); setAdding(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const own = devices.filter(device => (device as DeviceView & { kind?: string }).kind !== 'cloud')
  return <div className="flex flex-col gap-6">
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <Button size="sm" aria-keyshortcuts="Meta+N Control+N" className="bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" onClick={() => { setReconnecting(''); setAdding(true) }}><Plus data-icon="inline-start" />{t('add.trigger')}</Button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{t('listError')}</p>}
    {own.length === 0 ? <Empty className="rounded-xl border"><EmptyHeader><EmptyTitle>{t('emptyTitle')}</EmptyTitle><EmptyDescription>{t('add.emptyDescription')}</EmptyDescription></EmptyHeader></Empty> : <>
      <DeviceGroup title={t('thisMachine')} devices={own.filter(isPersonal)} onChanged={() => { void mutate() }} onReconnect={reconnect} />
      <DeviceGroup title={t('otherDevices')} devices={own.filter(device => !isPersonal(device))} onChanged={() => { void mutate() }} onReconnect={reconnect} />
    </>}
    <AddDeviceDialog open={adding} initialHost={reconnecting} onOpenChange={open => { setAdding(open); if (!open) setReconnecting('') }} onAdded={() => { void mutate() }} />
  </div>
}
