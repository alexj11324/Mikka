'use client'

import { useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import * as auditSlot from '@ui-slot/settings-audit'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingsLoading, SettingsSection } from '@/components/settings/primitives'
import { FieldError } from '@/components/ui/field'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { useAuditLog, type AuditLogState } from '@/hooks/settings/use-audit-log'

/** N6 审计日志: admins only, the last 90 days, grouped by day. Reads in useAuditLog; a UI layer may draw the page (settings-audit slot). */
export function AuditLogSettings({ workspaceId }: { workspaceId: string }) {
  const log = useAuditLog(workspaceId)
  const Page = auditSlot.AuditLogPage ?? null
  return Page ? <Page workspaceId={workspaceId} {...log} /> : <AuditLogList log={log} />
}

function AuditLogList({ log }: { log: AuditLogState }) {
  const t = useTranslations('Settings.audit')
  return <>
    {/* A toolbar over the list, as Linear's: the filter and export act on the log, they are not settings rows. */}
    <div role="toolbar" aria-label={t('filter')} className="flex flex-wrap items-center justify-between gap-2">
      <ToggleGroup aria-label={t('filter')} variant="segment" size="sm" spacing={0.5} value={[log.filter]} onValueChange={values => { const next = values[0]; if (next === 'all' || next === 'security') log.setFilter(next) }}>
        <ToggleGroupItem value="all">{t('filters.all')}</ToggleGroupItem>
        <ToggleGroupItem value="security">{t('filters.security')}</ToggleGroupItem>
      </ToggleGroup>
      {/* Nothing to export while the log is empty. */}
      {!log.empty && !log.error && <Button variant="secondary" size="sm" nativeButton={false} role="link" render={<a href={log.exportHref} download />}><Download data-icon="inline-start" />{t('exportCsv')}</Button>}
    </div>
    {log.loading && <SettingsLoading label={t('loading')} rows={3} />}
    {log.error && <FieldError className="px-1">{log.error}</FieldError>}
    {log.empty && <Empty className="min-h-48"><EmptyHeader><EmptyTitle>{t('empty')}</EmptyTitle></EmptyHeader></Empty>}
    {log.days.map(([label, rows]) => <SettingsSection key={label} id={`audit-${label}`} title={label}>
      {rows.map(event => <div key={event.id} className="flex items-center gap-3 px-5 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            <span>{event.actorName}</span>
            {log.actorType(event) && <Badge variant="secondary">{log.actorType(event)}</Badge>}
            <span>{log.sentence(event)}</span>
          </p>
          <p className="text-xs text-muted-foreground">{[log.time(event), event.ip, event.geoCity].filter(Boolean).join(' · ')}</p>
        </div>
        <span className="shrink-0 text-sm text-muted-foreground">{log.category(event)}</span>
      </div>)}
    </SettingsSection>)}
    {log.more && <Button variant="secondary" size="sm" className="self-start" disabled={log.loadingMore} onClick={log.loadMore}>{t('loadMore')}</Button>}
  </>
}
