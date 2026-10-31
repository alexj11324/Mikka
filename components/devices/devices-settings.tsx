'use client'

import { Fragment, useEffect, useState } from 'react'
import useSWR from 'swr'
import { MoreHorizontal, Plus, RefreshCw } from 'lucide-react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { listDevices, setDeviceEnabled, type DeviceView } from '@/app/actions/agents'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemGroup, ItemSeparator } from '@/components/ui/item'
import { IconTile } from '@/components/reui/icon-tile'
import { useActionError } from '@/lib/use-action-error'
import { ConnectDeviceDialog } from './connect-device-dialog'
import { DeviceIcon } from './device-icon'
import { FieldError } from '@/components/ui/field'

function DeviceRow({ device, onChanged, onReconnect }: { device: DeviceView; onChanged: () => void; onReconnect: () => void }) {
  const t = useTranslations('Devices')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const translateError = useActionError()
  async function toggle(enabled: boolean) {
    try {
      const result = await setDeviceEnabled({ deviceId: device.id, enabled })
      if ('error' in result) { toast.error(translateError(result.error)); return }
      onChanged()
    } catch { toast.error(translateError('deviceSaveFailed')) }
  }
  return <Item role="listitem" className="gap-3 rounded-none px-3.5 py-3">
    <IconTile size="sm" variant="elevated"><DeviceIcon kind="personal" state={device.online ? 'online' : 'offline'} label={device.online ? t('online') : t('offline')} surface="muted" /></IconTile>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-sm font-medium">{device.name}</span>
      {!device.online && <span className="truncate text-xs text-muted-foreground">{device.lastSeenAt ? t('lastOnline', { time: format.relativeTime(new Date(device.lastSeenAt), now) }) : t('neverOnline')}</span>}
    </span>
    {!device.online && <Button variant="outline" size="sm" onClick={onReconnect}><RefreshCw data-icon="inline-start" />{t('reconnect')}</Button>}
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('menu', { name: device.name })} />}><MoreHorizontal data-icon="inline-start" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem checked={device.enabled} onCheckedChange={checked => { void toggle(checked) }}>{t('allowScheduling')}</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </Item>
}

function DeviceGroup({ title, devices, onChanged, onReconnect }: { title: string; devices: DeviceView[]; onChanged: () => void; onReconnect: () => void }) {
  return devices.length > 0 && <section aria-label={title} className="flex flex-col gap-2">
    <h2 className="px-1 text-xs font-medium text-muted-foreground">{title}</h2>
    <ItemGroup className="gap-0! overflow-hidden rounded-xl border bg-card">{devices.map((device, index) => <Fragment key={device.id}>{index > 0 && <ItemSeparator className="my-0" />}<DeviceRow device={device} onChanged={onChanged} onReconnect={onReconnect} /></Fragment>)}</ItemGroup>
  </section>
}

/**
 * 设置 › 设备 (Figma 503:7105): only machines the user connected. The bots'
 * cloud computer is ours and never listed here. The retired standalone
 * /devices page redirects here.
 */
export function DevicesSettings() {
  const t = useTranslations('Devices')
  const { data: devices = [], error, mutate } = useSWR('devices', listDevices, { refreshInterval: 5000 })
  const [adding, setAdding] = useState(false)
  const reconnect = () => setAdding(true)
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !event.shiftKey && !event.altKey) { event.preventDefault(); setAdding(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return <div className="flex flex-col gap-6">
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <Button size="sm" aria-keyshortcuts="Meta+N Control+N" className="bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" onClick={() => setAdding(true)}><Plus data-icon="inline-start" />{t('connect.trigger')}</Button>
    </div>
    {error && <FieldError className="text-xs">{t('listError')}</FieldError>}
    {devices.length === 0 ? <Empty className="rounded-xl border"><EmptyHeader><EmptyTitle>{t('emptyTitle')}</EmptyTitle></EmptyHeader></Empty> :
      <DeviceGroup title={t('thisMachine')} devices={devices} onChanged={() => { void mutate() }} onReconnect={reconnect} />}
    <ConnectDeviceDialog open={adding} onOpenChange={setAdding} hideTrigger />
  </div>
}
