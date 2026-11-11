'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress, ProgressTrack } from '@/components/ui/progress'
import type { ConversationUsage } from '@/lib/coordinator/context-usage'

/** 23.4K: a size at a glance, never a figure that reads like a bill. */
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/**
 * How full the Coordinator's conversation is: one button reading
 * `上下文 23.4K/100K`, opening what the number means.
 *
 * Every figure is an estimate from stored text (lib/coordinator/
 * context-usage.ts), and the fold threshold is a real constant rather than a
 * stored model window, so the panel says so instead of implying a provider
 * measurement. Mikka has no context window to divide by, and none is invented
 * (ALE-43): a made-up denominator would be worse than showing none.
 */
export function CoordinatorContextUsage({ usage }: { usage: ConversationUsage }) {
  const t = useTranslations('Coordinator')
  const used = compact.format(usage.used)
  const compactAt = compact.format(usage.compactAt)
  return <Popover>
    <PopoverTrigger render={<Button variant="ghost" size="xs" data-slot="coordinator-context-usage"
      aria-label={t('contextUsage', { used, compactAt })}
      className="shrink-0 gap-1 px-1.5 text-xs tabular-nums text-muted-foreground" />}>
      {t('context')} {used}<span aria-hidden="true">/</span>{compactAt}
    </PopoverTrigger>
    <PopoverContent align="end" className="flex w-64 flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{t('context')}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{usage.share}%</span>
      </div>
      <Progress value={usage.share} aria-label={t('context')}><ProgressTrack className="h-1.5" /></Progress>
      <dl className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <dt className="text-muted-foreground">{t('contextHeld')}</dt>
          <dd className="tabular-nums">{used}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <dt className="text-muted-foreground">{t('contextCompactAt')}</dt>
          <dd className="tabular-nums">{compactAt}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <dt className="text-muted-foreground">{t('contextKeepRecent')}</dt>
          <dd className="tabular-nums">{compact.format(usage.keepRecent)}</dd>
        </div>
      </dl>
      {usage.compactsNextTurn && <p className="text-xs">{t('contextNearFold')}</p>}
      <p className="text-xs text-muted-foreground">{t('contextEstimated')}</p>
      <p className="text-xs text-muted-foreground">{t('contextNoWindow')}</p>
    </PopoverContent>
  </Popover>
}
