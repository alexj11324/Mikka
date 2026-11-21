'use client'

import { useFormatter, useTranslations } from '@/lib/intl/i18n-client'
import { InlineLoadError } from '@/components/load-error'
import { SettingsSection } from '@/components/settings/primitives'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useAutomationUsage } from '@/hooks/use-automations'

/** 用量: the last 30 days in the automation's own time zone. Spend shows only for the creator and owners/admins. */
export function AutomationUsagePanel({ workspaceId, id }: { workspaceId: string | null; id: string }) {
  const t = useTranslations('Automations.usage')
  const tAll = useTranslations('Automations')
  const tCommon = useTranslations('Common')
  const format = useFormatter()
  const usage = useAutomationUsage(workspaceId, id)
  const days = usage.data?.days ?? []
  const spend = days.some(day => day.costMicroUsd !== null)
  return <SettingsSection id="automation-usage" title={t('title')}>
    {usage.error && !usage.data ? <div className="p-4"><InlineLoadError message={tAll('loadError')} retryLabel={tCommon('retry')} onRetry={() => { void usage.mutate() }} /></div>
      : !usage.data ? <div className="p-4"><Skeleton className="h-10 w-full" /></div>
        : !days.length ? <p className="px-5 py-4 text-sm text-muted-foreground">{t('empty')}</p>
          : <div className="overflow-x-auto px-2 pb-2">
            <Table>
              <TableHeader><TableRow>
                <TableHead>{t('day')}</TableHead><TableHead className="text-end">{t('runs')}</TableHead><TableHead className="text-end">{t('skipped')}</TableHead>
                <TableHead className="text-end">{t('tasks')}</TableHead>{spend && <TableHead className="text-end">{t('cost')}</TableHead>}
              </TableRow></TableHeader>
              <TableBody>{days.map(day => <TableRow key={day.day}>
                <TableCell>{format.dateTime(new Date(`${day.day}T12:00:00Z`), { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' })}</TableCell>
                <TableCell className="text-end tabular-nums">{usage.data!.maxRunsPerDay ? t('ofCap', { runs: day.runs, cap: usage.data!.maxRunsPerDay }) : day.runs}</TableCell>
                <TableCell className="text-end tabular-nums">{day.skipped}</TableCell>
                <TableCell className="text-end tabular-nums">{day.tasks}</TableCell>
                {spend && <TableCell className="text-end tabular-nums">{day.costMicroUsd === null ? '' : format.number(day.costMicroUsd / 1e6, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })}</TableCell>}
              </TableRow>)}</TableBody>
            </Table>
          </div>}
  </SettingsSection>
}
