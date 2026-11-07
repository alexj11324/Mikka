'use client'

import { Cloud, Laptop, Server } from 'lucide-react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { harnessName } from '@/components/labels/entity-labels'
import type { OrderView } from '@/lib/model-order'
import { DEVICE_STAGES, type DeviceStage } from '@/lib/model-order-plan'

export type DispatchPlace = OrderView['places']['devices'][number]
export type DispatchDot = 'ready' | 'idle' | 'attention'
type Place = DispatchPlace
type Dot = DispatchDot

/** The dot on a place (R-24): green when it can take a run, grey when off or offline, amber when it needs something. */
export const dispatchDotOf = (stage: DeviceStage): Dot => stage === 'ready' ? 'ready' : stage === 'off' || stage === 'offline' ? 'idle' : 'attention'
const dotOf = dispatchDotOf

/**
 * 运行位置 as the order dispatch tries (Alex, 2026-11-06): 云端 only when it is
 * the location, then servers, then computers (lib/model-order-plan.ts
 * planDispatch); each tier with its dot, its state, its devices and whether a
 * new run would go there now (会先用). The open-source chain and the hosted
 * layer draw these each in their own look (docs/ui-overlay.md).
 */
export function useDispatchTiers({ data, e2bConfigured }: { data: Pick<OrderView, 'places' | 'first' | 'preferredHarness'>; e2bConfigured?: boolean }) {
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
  return { tiers, stageWord }
}
