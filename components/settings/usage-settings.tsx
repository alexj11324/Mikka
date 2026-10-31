'use client'

import { useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import { Bar, BarChart, XAxis } from 'recharts'
import { getUsage } from '@/app/actions/usage'
import { creditBillingKey } from '@/components/billing/balance-section'
import { getCreditBilling } from '@/lib/billing/verification-client'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { SettingsLoading } from '@/components/settings/primitives'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { csvField } from '@/lib/audit/cursor'
import { currentMonth, recentMonths } from '@/lib/usage/month'
import type { BotUsageRow, UsageRow } from '@/lib/usage/read'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'
import { FieldError } from '@/components/ui/field'

type View = 'bots' | 'members'

/** V14 用量 (admins) and S-A (members: their own bots). Threads and run time per month; there is no point meter yet. */
export function UsageSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.usage')
  const locale = useLocale()
  const actionError = useActionError()
  const [month, setMonth] = useState(currentMonth())
  const [view, setView] = useState<View>('bots')
  const downloadRef = useRef<HTMLAnchorElement>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>()
  const usage = useSWR(['settings:usage', workspaceId, month], () => getUsage(month, workspaceId), { keepPreviousData: true })
  const data = usage.data && !usage.data.error ? usage.data : null
  // 余额 in points, the card-verification $1 included (#559, Figma ALW-4 `709:28418`). Admins only, as 计费 is.
  const credits = useSWR(creditBillingKey(workspaceId), () => getCreditBilling(workspaceId))
  const balance = credits.data && !credits.data.error ? credits.data.balancePoints : null
  const months = useMemo(() => recentMonths(6).map(value => ({ value, label: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${value}-01T00:00:00Z`)) })), [locale])
  const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const number = new Intl.NumberFormat(locale)
  const duration = (seconds: number) => seconds < 3600 ? t('minutes', { count: Math.round(seconds / 60) }) : t('hours', { count: number.format(Math.round(seconds / 360) / 10) })
  const chartConfig = { threads: { label: t('threads'), color: 'var(--foreground)' } } satisfies ChartConfig
  const admin = data?.scope === 'workspace'
  const rows: Array<UsageRow | BotUsageRow> = data ? admin && view === 'members' ? data.members : data.bots : []

  function exportCsv() {
    if (!data) return
    const header = [view === 'members' ? t('member') : t('bot'), t('threads'), t('runSeconds')]
    const lines = rows.map(row => [row.name, String(row.threads), String(row.seconds)].map(csvField).join(','))
    const link = downloadRef.current
    if (!link) return
    const url = URL.createObjectURL(new Blob([`\uFEFF${[header.map(csvField).join(','), ...lines].join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }))
    setDownloadUrl(url)
    link.href = url
    link.download = `usage-${data.month}-${view}.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-2">
      <Select value={month} items={months} onValueChange={value => { if (value) setMonth(value) }}>
        <SelectTrigger size="sm" aria-label={t('month')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>{months.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>
      {admin && <ToggleGroup aria-label={t('groupBy')} variant="outline" size="sm" spacing={0} value={[view]} onValueChange={values => { const next = values[0]; if (next === 'bots' || next === 'members') setView(next) }}>
        <ToggleGroupItem value="bots">{t('byBot')}</ToggleGroupItem>
        <ToggleGroupItem value="members">{t('byMember')}</ToggleGroupItem>
      </ToggleGroup>}
      {admin && <Button variant="secondary" size="sm" className="ml-auto" disabled={!data} onClick={exportCsv}><Download data-icon="inline-start" />{t('exportCsv')}</Button>}
      <a ref={downloadRef} href={downloadUrl} download="usage.csv" className="hidden" tabIndex={-1} aria-hidden="true">{t('exportCsv')}</a>
    </div>

    {!usage.data && !usage.error && <SettingsLoading label={t('loading')} rows={3} />}
    {(usage.error || usage.data?.error) && <FieldError>{actionError(usage.data?.error)}</FieldError>}
    {data && <>
      {!admin && <h2 className="pl-1 text-sm font-medium">{t('yours')}</h2>}
      <dl className={cn('grid grid-cols-2 gap-4', balance !== null && 'sm:grid-cols-3')}>
        <div className="flex flex-col gap-0.5 pl-1"><dd className="text-xl font-semibold">{number.format(data.totals.threads)}</dd><dt className="text-xs text-muted-foreground">{t('threads')}</dt></div>
        <div className="flex flex-col gap-0.5 pl-1"><dd className="text-xl font-semibold">{duration(data.totals.seconds)}</dd><dt className="text-xs text-muted-foreground">{t('runTime')}</dt></div>
        {balance !== null && <div data-slot="balance" className="flex flex-col gap-0.5 pl-1"><dd className="text-xl font-semibold tabular-nums">{t('points', { points: number.format(balance) })}</dd><dt className="text-xs text-muted-foreground">{t('balance')}</dt></div>}
      </dl>
      <div data-settings-card className="rounded-2xl border bg-card p-4">
        <ChartContainer config={chartConfig} className="aspect-auto h-44 w-full" aria-label={t('chartLabel')}>
          <BarChart data={data.daily} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <XAxis dataKey="date" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} tickFormatter={value => day.format(new Date(`${value}T00:00:00Z`))} />
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
            {rows.map(row => <TableRow key={row.id}>
              <TableCell className="pl-5"><span className="flex items-center gap-2">{'color' in row && <BotAvatar size="row" color={row.color} shape={row.shape} />}{row.name}</span></TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{number.format(row.threads)}</TableCell>
              <TableCell className="pr-5 text-right tabular-nums">{duration(row.seconds)}</TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </div>
    </>}
  </div>
}
