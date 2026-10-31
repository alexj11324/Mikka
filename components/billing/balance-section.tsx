'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { SettingsSection } from '@/components/settings/primitives'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getCreditBilling, POINTS_PER_USD, POINTS_PURCHASE_AMOUNTS, startPointsPurchase, type CreditTransaction } from '@/lib/billing/verification-client'
import { useActionError } from '@/lib/use-action-error'

export function creditBillingKey(workspaceId: string) {
  return ['credit-billing', workspaceId] as const
}

const STATUS: Record<CreditTransaction['type'], 'paid' | 'credited' | 'refunded'> = { topup: 'paid', verification: 'credited', refund: 'refunded' }

/**
 * 计费 › 余额 and 账单记录 (Figma BIL-1 `708:26856`, BIL-3 `708:27372`). One balance
 * in points, the card-verification $1 included at 100 points per dollar (#559).
 * 充值 goes to Stripe Checkout in payment mode; on `?topup=` the balance and
 * history reload.
 */
export function BalanceSection({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Billing.balance')
  const locale = useLocale()
  const actionError = useActionError()
  const billing = useSWR(creditBillingKey(workspaceId), () => getCreditBilling(workspaceId))
  const { mutate } = billing
  const [redirecting, setRedirecting] = useState(false)
  const number = new Intl.NumberFormat(locale)
  const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' })
  const day = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' })

  useEffect(() => {
    const url = new URL(window.location.href)
    const topup = url.searchParams.get('topup')
    if (topup === null) return
    url.searchParams.delete('topup')
    url.searchParams.delete('session_id')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    if (topup === 'success') { toast.success(t('paid')); void mutate() }
  }, [mutate, t])

  async function topUp(amount: number) {
    setRedirecting(true)
    try {
      const result = await startPointsPurchase(workspaceId, amount)
      if (result.error) { setRedirecting(false); toast.error(result.error === 'billingNotConfigured' ? t('unavailable') : actionError(result.error)); return }
      window.location.assign(result.url)
    } catch {
      setRedirecting(false)
      toast.error(actionError('billingProviderFailed'))
    }
  }

  const data = billing.data && !billing.data.error ? billing.data : null
  if (!data) return null
  return <>
    <SettingsSection id="billing-balance" title={t('section')}>
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <span data-slot="balance" className="text-2xl font-semibold tabular-nums">{t('points', { points: number.format(data.balancePoints) })}</span>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" size="sm" disabled={redirecting} />}>{t('topUp')}</DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-max"><DropdownMenuGroup>
            {POINTS_PURCHASE_AMOUNTS.map(amount => <DropdownMenuItem key={amount} onClick={() => { void topUp(amount) }}>
              {t('amount', { amount: usd.format(amount), points: number.format(amount * POINTS_PER_USD) })}
            </DropdownMenuItem>)}
          </DropdownMenuGroup></DropdownMenuContent>
        </DropdownMenu>
      </div>
    </SettingsSection>
    {data.transactions.length > 0 && <SettingsSection id="billing-history" title={t('history')}>
      <Table>
        <TableHeader><TableRow>
          <TableHead className="pl-5">{t('date')}</TableHead>
          <TableHead>{t('type')}</TableHead>
          <TableHead>{t('pointsColumn')}</TableHead>
          <TableHead>{t('amountColumn')}</TableHead>
          <TableHead>{t('fee')}</TableHead>
          <TableHead>{t('status')}</TableHead>
          <TableHead className="pr-5">{t('receipt')}</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {data.transactions.map(row => <TableRow key={row.id}>
            <TableCell className="pl-5 tabular-nums">{day.format(new Date(row.date))}</TableCell>
            <TableCell>{t(`types.${row.type}`)}</TableCell>
            <TableCell className="tabular-nums">{t('points', { points: `${row.type === 'refund' ? '' : '+'}${number.format(row.points)}` })}</TableCell>
            <TableCell className="tabular-nums">{row.amountCents ? usd.format(row.amountCents / 100) : '—'}</TableCell>
            <TableCell className="tabular-nums">{row.stripeFeeCents ? usd.format(row.stripeFeeCents / 100) : '—'}</TableCell>
            <TableCell><Badge tone={STATUS[row.type] === 'refunded' ? 'neutral' : 'success'}>{t(`statuses.${STATUS[row.type]}`)}</Badge></TableCell>
            <TableCell className="pr-5">{row.receiptUrl && <Button variant="ghost" size="icon-sm" nativeButton={false} aria-label={t('receipt')} render={<a href={row.receiptUrl} target="_blank" rel="noreferrer" />}><Download /></Button>}</TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </SettingsSection>}
  </>
}
