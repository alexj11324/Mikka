'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress, ProgressTrack } from '@/components/ui/progress'
import type { ContextSegmentKey, ContextUsage } from '@/lib/context-usage'

/** 12.1k: a count at a glance, never a figure a person could mistake for a bill. */
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/**
 * What the run holds, in the thread's status line: one button reading
 * `上下文 23.4k / 25k` for the brief, opening the measured segments.
 *
 * Every figure is an estimate from stored text (lib/context-usage.ts), so the
 * panel says 估算, and the segments this host cannot read are named rather than
 * drawn as zero: a person comparing this with a bill must not read silence as
 * a measurement.
 */
export function ThreadContextUsage({ usage }: { usage: ContextUsage }) {
  const t = useTranslations('IssueThreads')
  const label = (key: ContextSegmentKey) => t(`contextSegments.${key}`)
  // The brief's share of its own cap is the one ratio this host can state.
  const share = usage.promptBudget > 0 ? Math.min(100, Math.round(usage.promptUsed / usage.promptBudget * 100)) : 0
  const used = compact.format(usage.promptUsed), budget = compact.format(usage.promptBudget)
  return <Popover>
    <PopoverTrigger render={<Button variant="ghost" size="xs" data-slot="thread-context-usage"
      aria-label={t('contextUsage', { used, budget })}
      className="shrink-0 gap-1 px-1.5 text-xs tabular-nums text-muted-foreground" />}>
      {t('context')} {used}<span aria-hidden="true">/</span>{budget}
    </PopoverTrigger>
    <PopoverContent align="end" className="flex w-64 flex-col gap-2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{t('context')}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{share}%</span>
      </div>
      <Progress value={share} aria-label={t('context')}><ProgressTrack className="h-1.5" /></Progress>
      <dl className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <dt className="text-muted-foreground">{t('contextBrief')}</dt>
          <dd className="tabular-nums">{used} / {budget}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <dt className="text-muted-foreground">{t('contextHeld')}</dt>
          <dd className="tabular-nums">{compact.format(usage.used)}</dd>
        </div>
      </dl>
      {usage.segments.length > 0 && <ul className="flex flex-col gap-1 pt-1">
        {usage.segments.map(segment => <li key={segment.key} className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted-foreground">{label(segment.key)}</span>
          <span className="tabular-nums">{compact.format(segment.tokens)}</span>
        </li>)}
      </ul>}
      {usage.unmeasured.length > 0 && <p className="pt-1 text-xs text-muted-foreground">
        {t('contextUnmeasured', { segments: usage.unmeasured.map(label).join(t('contextListSeparator')) })}
      </p>}
      <p className="text-xs text-muted-foreground">{t('contextEstimated')}</p>
    </PopoverContent>
  </Popover>
}
