'use client'

import { settingsKeys } from '@/lib/swr/keys'
import { useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import type { getUsage } from '@/app/actions/usage'
import { settingsRead } from '@/lib/settings-read'
import { ReadResponseError } from '@/lib/swr/retry'
import { creditBillingKey } from '@/components/billing/balance-section'
import { getCreditBilling } from '@/lib/billing/verification-client'
import { usageRows } from '@/components/settings/usage-view'
import type { UsageView } from '@/components/slots/settings-usage-contract'
import { UsagePage } from '@ui-slot/settings-usage'
import { csvField } from '@/lib/audit/cursor'
import { currentMonth, recentMonths } from '@/lib/usage/month'
import type { BotUsageRow, UsageRow } from '@/lib/usage/read'
import { useActionError } from '@/lib/use-action-error'

/** V14 用量 (admins) and S-A (members: their own bots). Threads and run time per month; there is no point meter yet. Reads here; the page is the settings-usage slot. */
export function UsageSettings({ workspaceId, personal = false }: { workspaceId: string; /** A personal workspace has one member: no 按成员 grouping. */ personal?: boolean }) {
  const t = useTranslations('Settings.usage')
  const locale = useLocale()
  const actionError = useActionError()
  const [month, setMonth] = useState(currentMonth())
  const [view, setView] = useState<UsageView>('bots')
  const downloadRef = useRef<HTMLAnchorElement>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>()
  const usage = useSWR(settingsKeys.usage(workspaceId, month), () => settingsRead<Awaited<ReturnType<typeof getUsage>>>('usage', { month, workspace: workspaceId }), { keepPreviousData: true })
  const data = usage.data && !usage.data.error ? usage.data : null
  // 余额 in points, the card-verification $1 included (#559, Figma ALW-4 `709:28418`). Admins only, as 计费 is.
  const credits = useSWR(creditBillingKey(workspaceId), () => getCreditBilling(workspaceId))
  const balance = credits.data && !credits.data.error ? credits.data.balancePoints : null
  const months = useMemo(() => recentMonths(6).map(value => ({ value, label: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${value}-01T00:00:00Z`)) })), [locale])
  const rows = usageRows(data ?? undefined, view)

  const rowName = (row: UsageRow | BotUsageRow) => row.awaitingTakeover ? t('awaitingTakeover') : row.name

  function exportCsv() {
    if (!data) return
    const header = [view === 'members' ? t('member') : t('bot'), t('runs'), t('runSeconds')]
    const lines = rows.map(row => [rowName(row), String(row.threads), String(row.seconds)].map(csvField).join(','))
    const link = downloadRef.current
    if (!link) return
    const url = URL.createObjectURL(new Blob([`\uFEFF${[header.map(csvField).join(','), ...lines].join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }))
    setDownloadUrl(url)
    link.href = url
    link.download = `usage-${data.month}-${view}.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const errorCode = usage.data?.error ?? (usage.error ? `usage_read_failed (${usage.error instanceof ReadResponseError ? `http_${usage.error.status}` : usage.error instanceof Error ? usage.error.name : 'unknown'})` : null)

  return <>
    <UsagePage month={month} months={months} onMonthChange={setMonth} view={view} onViewChange={setView} usage={data ?? undefined}
      error={errorCode ? actionError(usage.data?.error) : null} errorCode={errorCode} balancePoints={balance} personal={personal} onExport={exportCsv} />
    <a ref={downloadRef} href={downloadUrl} download="usage.csv" className="hidden" tabIndex={-1} aria-hidden="true">{t('exportCsv')}</a>
  </>
}
