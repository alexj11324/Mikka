'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { listActivity } from '@/app/actions/settings-activity'
import type { ActivityFilter } from '@/lib/settings/activity-cursor'
import type { ActivityItem, ActivitySummary } from '@/lib/settings/activity'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingsLoading } from '@/components/settings/primitives'
import { dayLabel, relativeTime } from '@/lib/relative-time'
import { httpUrl } from '@/lib/safe-url'

/** V08: what Bots did with my accounts and what the Coordinator told me. */
export function ActivitySettings() {
  const t = useTranslations('Settings.activity')
  const locale = useLocale()
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [items, setItems] = useState<ActivityItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (next: ActivityFilter, after: string | null, replace: boolean) => {
    if (replace) { setLoading(true); setFailed(false) } else setLoadingMore(true)
    try {
      const result = await listActivity({ filter: next, cursor: after })
      if ('error' in result) { setFailed(true); return }
      setItems(current => replace ? result.items : [...current, ...result.items])
      setCursor(result.nextCursor)
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => { void load(filter, null, true) }, [filter, load])

  function summary(item: ActivityItem): { title: string; detail: string | null } {
    const s: ActivitySummary = item.summary
    const bot = item.botName ?? t('someBot')
    if (s.kind === 'credential_use') return {
      title: t('credentialUse', { bot, site: withoutScheme(s.site) }),
      detail: t(`result.${s.result}`),
    }
    if (s.kind === 'external_action') return {
      title: s.decision === 'approved' ? t('approved', { action: s.action }) : t('declined', { action: s.action }),
      detail: s.site ?? s.repository,
    }
    return { title: t('reminder', { title: s.title }), detail: s.reason ?? s.source }
  }

  let lastDay = ''
  return <div className="flex flex-col gap-4">
    <ToggleGroup aria-label={t('filtersLabel')} variant="outline" spacing={0} value={[filter]} onValueChange={values => {
      const next = values[0]
      if (next === 'all' || next === 'accounts' || next === 'reminders') setFilter(next)
    }}>
      <ToggleGroupItem value="all">{t('filters.all')}</ToggleGroupItem>
      <ToggleGroupItem value="accounts">{t('filters.accounts')}</ToggleGroupItem>
      <ToggleGroupItem value="reminders">{t('filters.reminders')}</ToggleGroupItem>
    </ToggleGroup>

    {loading && <SettingsLoading label={t('loading')} rows={4} />}
    {!loading && failed && <p role="alert" className="text-sm text-destructive">{t('loadError')}</p>}
    {!loading && !failed && items.length === 0 && <p className="py-6 text-sm text-muted-foreground">{t('empty')}</p>}

    <div className="flex flex-col gap-1">
      {items.map(item => {
        const day = dayLabel(item.at, locale)
        const heading = day === lastDay ? null : (lastDay = day)
        const { title, detail } = summary(item)
        return <div key={item.id} className="flex flex-col">
          {heading && <h2 className="px-1 pt-3 pb-1 text-xs font-medium text-muted-foreground">{heading}</h2>}
          <div className="flex items-center justify-between gap-3 rounded-xl border bg-card px-5 py-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">{title}</span>
              <span className="text-xs text-muted-foreground">
                {[relativeTime(item.at, locale), detail].filter(Boolean).join(' · ')}
              </span>
            </div>
            {httpUrl(item.target.url) && <a className="text-sm text-primary underline-offset-4 hover:underline" href={httpUrl(item.target.url)!} target="_blank" rel="noreferrer">{t('view')}</a>}
          </div>
        </div>
      })}
    </div>

    {cursor && !loading && <Button variant="secondary" disabled={loadingMore} onClick={() => { void load(filter, cursor, false) }}>
      {loadingMore ? t('loadingMore') : t('loadMore')}
    </Button>}
  </div>
}

function withoutScheme(site: string): string {
  return site.replace(/^https?:\/\//, '')
}
