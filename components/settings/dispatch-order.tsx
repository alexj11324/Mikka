'use client'

import { Fragment } from 'react'
import Link from 'next/link'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { ChevronRight, Cloud, Laptop, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { harnessName } from '@/components/labels/entity-labels'
import type { OrderView } from '@/lib/model-order'
import { DEVICE_STAGES, type DeviceStage } from '@/lib/model-order-plan'
import { settingsHref } from '@/lib/settings-sections'
import { cn } from '@/lib/utils'

type Place = OrderView['places']['devices'][number]
type Dot = 'ready' | 'idle' | 'attention'

/** The dot on a place (R-24): green when it can take a run, grey when off or offline, amber when it needs something. */
const dotOf = (stage: DeviceStage): Dot => stage === 'ready' ? 'ready' : stage === 'off' || stage === 'offline' ? 'idle' : 'attention'

function StatusDot({ dot, corner }: { dot: Dot; corner?: boolean }) {
  return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full bg-muted-foreground/50', dot === 'ready' && 'bg-success', dot === 'attention' && 'bg-warning',
    corner && 'absolute -top-0.5 -right-0.5 ring-2 ring-card')} />
}

/**
 * 运行位置 as the order dispatch tries (Alex, 2026-11-06: 「云 → 服务器 → 电脑」 instead of a
 * sentence): 云端 only when it is the location, then servers, then computers
 * (lib/model-order-plan.ts planDispatch). Each place carries a dot; hovering names
 * its devices and why each cannot take a run, with a way to 设置 › 设备. The place a
 * new run would go now (会先用) has a fill.
 */
export function DispatchOrder({ data, workspaceId, e2bConfigured }: { data: Pick<OrderView, 'places' | 'first' | 'preferredHarness'>; workspaceId: string; e2bConfigured?: boolean }) {
  const t = useTranslations('Settings.modelOrder')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const agent = harnessName(data.preferredHarness)
  const stageWord = (place: Place) => place.stage === 'offline' && place.lastSeenAt ? t('stage.offlineSince', { time: format.relativeTime(new Date(place.lastSeenAt), now) })
    : t(`stage.${place.stage}`, { agent })
  const best = (places: Place[]): DeviceStage => places.reduce<DeviceStage>((top, place) => DEVICE_STAGES.indexOf(place.stage) > DEVICE_STAGES.indexOf(top) ? place.stage : top, 'off')
  const tiers: { key: string; label: string; Icon: typeof Cloud; dot: Dot; first: boolean; state: string; devices: Place[] | null; empty?: string }[] = []
  if (data.places.cloud) {
    const ready = data.places.cloud === 'ready'
    tiers.push({ key: 'cloud', label: t('cloud'), Icon: Cloud, dot: ready ? 'ready' : 'attention', first: data.first?.kind === 'cloud', devices: null,
      state: ready ? t('stage.ready') : e2bConfigured === false ? t('cloudNoKey') : t('cloudUnavailable') })
  }
  for (const server of [true, false]) {
    const devices = data.places.devices.filter(place => place.server === server)
    const stage = best(devices)
    tiers.push({ key: server ? 'servers' : 'computers', label: t(server ? 'placeServers' : 'placeComputers'), Icon: server ? Server : Laptop,
      dot: devices.length ? dotOf(stage) : 'idle', devices, empty: t(server ? 'noServers' : 'noComputers'),
      first: data.first?.kind === 'device' && data.first.server === server,
      state: devices.length ? t(`stage.${stage}`, { agent }) : t(server ? 'noServers' : 'noComputers') })
  }
  return <span role="list" aria-label={t('placesLabel')} className="mt-1 flex flex-wrap items-center gap-0.5" data-slot="dispatch-order">
    {tiers.map((tier, index) => <Fragment key={tier.key}>
      {index > 0 && <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" />}
      <span role="listitem">
        <HoverCard>
          <HoverCardTrigger render={<Button variant="ghost" size="sm" className={cn('h-7 gap-1.5 px-2 font-normal text-muted-foreground', tier.first && 'bg-muted font-medium text-foreground')}
            aria-label={`${tier.label} · ${tier.state}${tier.first ? ` · ${t('firstHere')}` : ''}`} />}>
            <span className="relative inline-flex"><tier.Icon aria-hidden="true" className="size-4" /><StatusDot dot={tier.dot} corner /></span>
            {tier.label}
          </HoverCardTrigger>
          <HoverCardContent align="start" className="flex w-72 flex-col gap-2.5 p-3">
            <span className="text-xs font-medium text-muted-foreground">{tier.first ? `${tier.label} · ${t('firstHere')}` : tier.label}</span>
            {tier.devices === null
              ? <span className="flex items-center gap-2 text-sm"><StatusDot dot={tier.dot} /><span>{tier.state}</span></span>
              : tier.devices.length === 0 ? <span className="text-sm text-muted-foreground">{tier.empty}</span>
              : <ul className="flex flex-col gap-1.5">{tier.devices.map(place => <li key={place.id} className="flex min-w-0 items-center gap-2 text-sm">
                <span className="relative inline-flex"><tier.Icon aria-hidden="true" className="size-4" /><StatusDot dot={dotOf(place.stage)} corner /></span>
                <span className="min-w-0 flex-1 truncate font-medium">{place.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{stageWord(place)}</span>
              </li>)}</ul>}
            {tier.devices !== null && <Button nativeButton={false} variant="ghost" size="sm" className="self-start" render={<Link href={settingsHref('computers', workspaceId)} />}>{t('openDevices')}</Button>}
          </HoverCardContent>
        </HoverCard>
      </span>
    </Fragment>)}
  </span>
}
