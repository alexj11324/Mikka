'use client'

import { Fragment, useEffect, useState } from 'react'
import useSWR from 'swr'
import { Laptop, MoreHorizontal, Plus, Terminal } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { listDevices, setDeviceEnabled, type DeviceView } from '@/app/actions/agents'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemGroup, ItemSeparator } from '@/components/ui/item'
import { Badge } from '@/components/reui/badge'
import { IconTile } from '@/components/reui/icon-tile'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'
import { AddDeviceDialog } from './add-device-dialog'

/** Personal computers count as 本机; servers reached over SSH or Tailnet are the rest. */
const isPersonal = (device: DeviceView) => device.platform === 'darwin' || device.platform === 'win32'

function DeviceRow({ device, onChanged }: { device: DeviceView; onChanged: () => void }) {
  const t = useTranslations('Devices')
  const translateError = useActionError()
  async function toggle(enabled: boolean) {
    try {
      const result = await setDeviceEnabled({ deviceId: device.id, enabled })
      if ('error' in result) { toast.error(translateError(result.error)); return }
      onChanged()
    } catch { toast.error(translateError('deviceSaveFailed')) }
  }
  return <Item role="listitem" className="gap-3 rounded-none px-3.5 py-3">
    <IconTile size="sm" variant="elevated" aria-hidden="true">{isPersonal(device) ? <Laptop /> : <Terminal />}</IconTile>
    <span className="min-w-0 flex-1 truncate text-sm font-medium">{device.name}</span>
    <Badge radius="full" size="lg" variant="outline" className={cn('border-transparent font-normal', device.online ? 'bg-success/10 text-success-foreground' : 'bg-muted text-muted-foreground')}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{device.online ? t('online') : t('offline')}
    </Badge>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('menu', { name: device.name })} />}><MoreHorizontal data-icon="inline-start" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem checked={device.enabled} onCheckedChange={checked => { void toggle(checked) }}>{t('allowScheduling')}</DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </Item>
}

function DeviceGroup({ title, devices, onChanged }: { title: string; devices: DeviceView[]; onChanged: () => void }) {
  return devices.length > 0 && <section aria-label={title} className="flex flex-col gap-2">
    <h2 className="px-1 text-xs font-medium text-muted-foreground">{title}</h2>
    <ItemGroup className="gap-0! overflow-hidden rounded-xl border bg-card">{devices.map((device, index) => <Fragment key={device.id}>{index > 0 && <ItemSeparator className="my-0" />}<DeviceRow device={device} onChanged={onChanged} /></Fragment>)}</ItemGroup>
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
      <Button size="sm" aria-keyshortcuts="Meta+N Control+N" className="bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" onClick={() => setAdding(true)}><Plus data-icon="inline-start" />{t('add.trigger')}</Button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{t('listError')}</p>}
    {own.length === 0 ? <Empty className="rounded-xl border"><EmptyHeader><EmptyTitle>{t('emptyTitle')}</EmptyTitle><EmptyDescription>{t('add.emptyDescription')}</EmptyDescription></EmptyHeader></Empty> : <>
      <DeviceGroup title={t('thisMachine')} devices={own.filter(isPersonal)} onChanged={() => { void mutate() }} />
      <DeviceGroup title={t('otherDevices')} devices={own.filter(device => !isPersonal(device))} onChanged={() => { void mutate() }} />
    </>}
    <AddDeviceDialog open={adding} onOpenChange={setAdding} onAdded={() => { void mutate() }} />
  </div>
}
