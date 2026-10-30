'use client'

import { useState } from 'react'
import useSWRInfinite from 'swr/infinite'
import { useLocale, useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import { listAuditLog } from '@/app/actions/audit-log'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingRow, SettingsLoading, SettingsSection } from '@/components/settings/primitives'
import type { AuditFilter } from '@/lib/audit/cursor'
import type { AuditEventView } from '@/lib/audit/query'
import { withBasePath } from '@/lib/base-path'
import { dayLabel } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'

/** Scalar metadata only: the ICU templates take named string params. Roles and access levels are words, not codes. */
function params(event: AuditEventView, word: (key: string) => string | null) {
  const values: Record<string, string> = { target: event.targetLabel ?? '' }
  for (const [key, value] of Object.entries(event.metadata ?? {})) if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[key] = String(value)
  if (event.action === 'member.role_changed' && values.newRole) values.newRole = word(`roles.${values.newRole}`) ?? values.newRole
  if (event.action === 'integration.permission_changed' && values.to) values.to = word(`access.${values.to}`) ?? values.to
  return values
}

/** N6 审计日志: admins only, the last 90 days, grouped by day. */
export function AuditLogSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.audit')
  const locale = useLocale()
  const actionError = useActionError()
  const [filter, setFilter] = useState<AuditFilter>('all')
  const pages = useSWRInfinite(
    (index, previous: Awaited<ReturnType<typeof listAuditLog>> | null) => {
      if (previous && (previous.error || !previous.nextCursor)) return null
      return ['settings:audit', workspaceId, filter, index === 0 ? null : previous && !previous.error ? previous.nextCursor : null] as const
    },
    ([, id, segment, cursor]) => listAuditLog({ filter: segment, cursor }, id),
    { revalidateFirstPage: false },
  )
  const failure = pages.data?.find(page => page.error)
  const events = (pages.data ?? []).flatMap(page => page.error ? [] : page.events)
  const last = pages.data?.at(-1)
  const more = Boolean(last && !last.error && last.nextCursor)
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
  const days: Array<[string, AuditEventView[]]> = []
  for (const event of events) {
    const label = dayLabel(event.createdAt, locale)
    if (days.at(-1)?.[0] === label) days.at(-1)![1].push(event)
    else days.push([label, [event]])
  }
  const exportHref = withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/audit-log?filter=${filter}`)

  function sentence(event: AuditEventView) {
    const key = `actions.${event.action}`
    const word = (path: string) => t.has(path as never) ? t(path as never) : null
    return t.has(key as never) ? t(key as never, params(event, word) as never) : event.action
  }

  return <>
    <SettingsSection id="audit-controls">
      <SettingRow title={t('filter')}>
        <ToggleGroup aria-label={t('filter')} variant="outline" spacing={0} value={[filter]} onValueChange={values => { const next = values[0]; if (next === 'all' || next === 'security') setFilter(next) }}>
          <ToggleGroupItem value="all">{t('filters.all')}</ToggleGroupItem>
          <ToggleGroupItem value="security">{t('filters.security')}</ToggleGroupItem>
        </ToggleGroup>
      </SettingRow>
      <SettingRow title={t('export')}>
        <Button variant="secondary" size="sm" nativeButton={false} role="link" render={<a href={exportHref} download />}><Download data-icon="inline-start" />{t('exportCsv')}</Button>
      </SettingRow>
    </SettingsSection>
    {pages.isLoading && <SettingsLoading label={t('loading')} rows={3} />}
    {(pages.error || failure) && <p role="alert" className="px-1 text-sm text-destructive">{actionError(failure?.error)}</p>}
    {!pages.isLoading && !failure && !pages.error && events.length === 0 && <p className="px-1 text-sm text-muted-foreground">{t('empty')}</p>}
    {days.map(([label, rows]) => <SettingsSection key={label} id={`audit-${label}`} title={label}>
      {rows.map(event => <div key={event.id} className="flex items-center gap-3 px-5 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            <span>{event.actorName}</span>
            {(event.actorType === 'bot' || event.actorType === 'token') && <Badge variant="secondary">{t(`actorTypes.${event.actorType}`)}</Badge>}
            <span>{sentence(event)}</span>
          </p>
          <p className="text-xs text-muted-foreground">{[time.format(new Date(event.createdAt)), event.ip, event.geoCity].filter(Boolean).join(' · ')}</p>
        </div>
        <span className="shrink-0 text-sm text-muted-foreground">{t(`categories.${event.category}`)}</span>
      </div>)}
    </SettingsSection>)}
    {more && <Button variant="secondary" size="sm" className="self-start" disabled={pages.isValidating} onClick={() => void pages.setSize(pages.size + 1)}>{t('loadMore')}</Button>}
  </>
}
