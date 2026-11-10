'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import { SettingsSection } from '@/components/settings/primitives'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { POINTS_PER_USD, POINTS_PURCHASE_AMOUNTS, type CreditTransaction } from '@/lib/billing/verification-client'
import type { CreditBalanceState } from '@/hooks/settings/use-billing'

export { creditBillingKey } from '@/hooks/settings/use-billing'

const STATUS: Record<CreditTransaction['type'], 'paid' | 'credited' | 'refunded'> = { topup: 'paid', verification: 'credited', refund: 'refunded', subscription: 'paid' }

/**
 * 计费 › 余额 and 账单记录 (Figma BIL-1 `708:26856`, BIL-3 `708:27372`). One balance
 * in points, the card-verification $1 included at 100 points per dollar (#559).
 * 充值 goes to Stripe Checkout in payment mode (`useCreditBalance`). With billing
 * not set up (`purchasable={false}`) there is no 充值, and an empty balance with no
 * history is not shown at all.
 */
export function BalanceSection({ balance, purchasable = true }: { balance: CreditBalanceState; purchasable?: boolean }) {
  const t = useTranslations('Billing.balance')
  const locale = useLocale()
  const { redirecting, topUp } = balance
  const number = new Intl.NumberFormat(locale)
  const usd = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' })
  const day = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' })

  const data = balance.credits
  if (!data || (!purchasable && data.balancePoints === 0 && data.transactions.length === 0)) return null
  return <>
    <SettingsSection id="billing-balance" title={t('section')}>
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <span data-slot="balance" className="text-2xl font-semibold tabular-nums">{t('points', { points: number.format(data.balancePoints) })}</span>
        {purchasable && <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" size="sm" disabled={redirecting} />}>{t('topUp')}</DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-max"><DropdownMenuGroup>
            {POINTS_PURCHASE_AMOUNTS.map(amount => <DropdownMenuItem key={amount} onClick={() => topUp(amount)}>
              {t('amount', { amount: usd.format(amount), points: number.format(amount * POINTS_PER_USD) })}
            </DropdownMenuItem>)}
          </DropdownMenuGroup></DropdownMenuContent>
        </DropdownMenu>}
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
