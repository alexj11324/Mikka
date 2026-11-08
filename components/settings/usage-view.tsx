'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { SettingsLoading } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FieldError } from '@/components/ui/field'
import type { SettingsUsageProps } from '@/components/slots/settings-usage-contract'
import type { BotUsageRow, UsageRow } from '@/lib/usage/read'
import { cn } from '@/lib/utils'

/** The rows a usage page lists for its grouping: members for admins grouping by member, otherwise bots. */
export function usageRows(usage: SettingsUsageProps['usage'], view: SettingsUsageProps['view']): Array<UsageRow | BotUsageRow> {
  if (!usage) return []
  return usage.scope === 'workspace' && view === 'members' ? usage.members : usage.bots
}

/** Run time in minutes below an hour, else hours to one decimal. */
export function useUsageDuration() {
  const t = useTranslations('Settings.usage')
  const number = new Intl.NumberFormat(useLocale())
  return (seconds: number) => seconds < 3600 ? t('minutes', { count: Math.round(seconds / 60) }) : t('hours', { count: number.format(Math.round(seconds / 360) / 10) })
}

/** The open-source 用量 page (V14 for admins, S-A for members: their own bots). */
export function UsagePageView({ month, months, onMonthChange, view, onViewChange, usage: data, error, balancePoints: balance, personal, onExport: exportCsv }: SettingsUsageProps) {
  const t = useTranslations('Settings.usage')
  const locale = useLocale()
  const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const number = new Intl.NumberFormat(locale)
  const duration = useUsageDuration()
  // The one accent (R-30), on data.
  const chartConfig = { threads: { label: t('threads'), color: 'var(--sidebar-primary)' } } satisfies ChartConfig
  const admin = data?.scope === 'workspace'
  const rows = usageRows(data, view)
  const rowName = (row: UsageRow | BotUsageRow) => row.awaitingTakeover ? t('awaitingTakeover') : row.name

  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2">
      <Select value={month} items={months} onValueChange={value => { if (value) onMonthChange(value) }}>
        <SelectTrigger size="sm" aria-label={t('month')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>{months.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>
      {admin && !personal && <ToggleGroup aria-label={t('groupBy')} variant="segment" size="sm" spacing={0.5} value={[view]} onValueChange={values => { const next = values[0]; if (next === 'bots' || next === 'members') onViewChange(next) }}>
        <ToggleGroupItem value="bots">{t('byBot')}</ToggleGroupItem>
        <ToggleGroupItem value="members">{t('byMember')}</ToggleGroupItem>
      </ToggleGroup>}
      {admin && <Button variant="secondary" size="sm" className="ml-auto" disabled={!data} onClick={exportCsv}><Download data-icon="inline-start" />{t('exportCsv')}</Button>}
    </div>

    {!data && !error && <SettingsLoading label={t('loading')} rows={3} />}
    {error && <FieldError>{error}</FieldError>}
    {data && <>
      {!admin && <h2 className="pl-1 text-sm font-medium">{t('yours')}</h2>}
      <dl className={cn('grid grid-cols-2 gap-4', balance !== null && 'sm:grid-cols-3')}>
        <div className="flex flex-col gap-0.5 pl-1"><dd className="text-xl font-semibold">{number.format(data.totals.threads)}</dd><dt className="text-xs text-muted-foreground">{t('threads')}</dt></div>
        <div className="flex flex-col gap-0.5 pl-1"><dd className="text-xl font-semibold">{duration(data.totals.seconds)}</dd><dt className="text-xs text-muted-foreground">{t('runTime')}</dt></div>
        {balance !== null && <div data-slot="balance" className="flex flex-col gap-0.5 pl-1"><dd className="text-xl font-semibold tabular-nums">{t('points', { points: number.format(balance) })}</dd><dt className="text-xs text-muted-foreground">{t('balance')}</dt></div>}
      </dl>
      <div data-settings-card className="rounded-2xl border bg-card p-4">
        <ChartContainer config={chartConfig} className="aspect-auto h-44 w-full" aria-label={t('chartLabel')}>
          {/* Weekly ticks (days 1, 8, 15, 22, 29) so the axis is evenly spaced; a y axis with grid lines gives the bars a scale. */}
          <BarChart data={data.daily} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <CartesianGrid vertical={false} />
            <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} tickFormatter={value => number.format(Number(value))} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} interval={0} ticks={data.daily.filter((_, index) => index % 7 === 0).map(item => item.date)} tickFormatter={value => day.format(new Date(`${value}T00:00:00Z`))} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={value => day.format(new Date(`${String(value)}T00:00:00Z`))} />} />
            <Bar dataKey="threads" fill="var(--color-threads)" radius={2} />
          </BarChart>
        </ChartContainer>
      </div>
      <div data-settings-card className="overflow-hidden rounded-2xl border bg-card">
        <Table>
          <TableHeader><TableRow>
            <TableHead className="pl-5">{admin ? view === 'members' ? t('member') : t('bot') : t('yourBots')}</TableHead>
            <TableHead className="text-right">{t('threads')}</TableHead>
            <TableHead className="pr-5 text-right">{t('runTime')}</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 && <TableRow><TableCell colSpan={3} className="pl-5 text-muted-foreground">{t('empty')}</TableCell></TableRow>}
            {rows.map(row => <TableRow key={row.id || 'awaiting-takeover'}>
              <TableCell className="pl-5"><span className="flex items-center gap-2">{'color' in row && <BotAvatar size="row" color={row.color} shape={row.shape} />}{rowName(row)}</span></TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{number.format(row.threads)}</TableCell>
              <TableCell className="pr-5 text-right tabular-nums">{duration(row.seconds)}</TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </div>
      {Boolean(data.executionAccounts?.length) && <section data-settings-card className="overflow-hidden rounded-2xl border bg-card">
        <h2 className="px-5 pt-4 text-sm font-medium">{t('executionAccounts')}</h2>
        <Table className="table-fixed"><TableHeader><TableRow><TableHead className="w-1/3 whitespace-normal pl-5">{t('accountKind')}</TableHead><TableHead className="w-1/4 whitespace-normal">{t('accountPayer')}</TableHead><TableHead className="pr-5">{t('accountBilling')}</TableHead></TableRow></TableHeader>
          <TableBody>{data.executionAccounts!.map(account => <TableRow key={account.id}>
            <TableCell className="wrap-break-word whitespace-normal pl-5">{t(`accountKinds.${account.kind}`)}</TableCell><TableCell className="wrap-break-word whitespace-normal">{account.ownerName}</TableCell>
            <TableCell className="wrap-break-word whitespace-normal pr-5 text-muted-foreground">{t(`accountAmounts.${account.amount}`)}</TableCell>
          </TableRow>)}</TableBody></Table>
      </section>}
    </>}
  </div>
}
