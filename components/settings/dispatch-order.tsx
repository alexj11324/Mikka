'use client'

import { Fragment } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import type { OrderView } from '@/lib/model-order'
import { dispatchDotOf, useDispatchTiers, type DispatchDot } from '@/hooks/settings/use-dispatch-tiers'
import { settingsHref } from '@/lib/settings-sections'
import { cn } from '@/lib/utils'

type Dot = DispatchDot
const dotOf = dispatchDotOf

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
  const { tiers, stageWord } = useDispatchTiers({ data, e2bConfigured })
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
